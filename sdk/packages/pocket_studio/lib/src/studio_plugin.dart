import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pocket_services/pocket_services.dart';

import 'studio_client.dart';
import 'studio_config.dart';
import 'studio_image.dart';
import 'studio_routes.dart';
import 'studio_scrub.dart';

export 'studio_routes.dart'
    show
        PocketStudioPermissions,
        pocketStudioCapabilityNames,
        pocketStudioChunkBytes,
        pocketStudioMaxAssetBytes,
        pocketStudioMaxResultBytes;

const String pocketStudioPluginId = 'pocket.studio';

const int _maxQueuedEvents = 1024;
const int _maxQueuedBytes = 512 * 1024;
const int _maxBatchEvents = 200;
const int _maxBatchBytes = 128 * 1024;
const int _maxDiagnosticBytes = 160 * 1024;
// The service exports up to 2,000 records in one document; the provider reads that and returns the newest ones.
const int _maxDiagnosticSourceBytes = 16 * 1024 * 1024;

/// Stateless `studio.*` capability provider.
///
/// It maps a fixed allowlist of capabilities onto the loopback editor service
/// (see [studioCalls]), injects the CSRF credential, scrubs absolute paths
/// from every result and stream event, and maps service failures to structured
/// capability errors. It owns no project, build or transfer state: polling,
/// retries, chunk loops and orchestration live in the guest's JS.
final class PocketStudioPlugin extends PocketPlugin {
  PocketStudioPlugin({
    required PocketStudioConfig config,
    Iterable<String> extraScrubRoots = const <String>[],
    this.flushInterval = const Duration(milliseconds: 25),
  }) : scrubber = StudioPathScrubber() {
    final sdk = config.sdkRoot;
    if (sdk != null) scrubber.addRoot(sdk, '<sdk>');
    final project = config.projectRoot;
    if (project != null) scrubber.addRoot(project, '<project>');
    final workspace = config.effectiveWorkspace;
    if (workspace != null) scrubber.addRoot(workspace, '<workspace>');
    for (final root in config.extraProjectRoots) {
      if (root.isNotEmpty) scrubber.addRoot(root, '<project>');
    }
    for (final root in extraScrubRoots) {
      scrubber.addRoot(root, '<tmp>');
    }
    client = StudioServiceClient(origin: config.origin, scrubber: scrubber);
    _origin = config.origin;
  }

  late final Uri _origin;

  final StudioPathScrubber scrubber;
  late final StudioServiceClient client;
  final Duration flushInterval;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: pocketStudioPluginId,
    version: '0.1.0',
    description: 'Stateless Pocket Studio editor-service capabilities',
    optionalPermissions: PocketStudioPermissions.all,
    limits: const PocketPluginLimits(
      maxConcurrentRequests: 8,
      maxActiveStreams: 4,
      maxResponseBytes: 256 * 1024,
      maxStreamEventBytes: 256 * 1024,
    ),
    capabilities: <String, PocketPluginCapability>{
      for (final call in studioCalls)
        call.name: PocketPluginCapability(
          name: call.name,
          kind: call.stream ? PocketCapabilityKind.stream : PocketCapabilityKind.request,
          description: call.description,
          permissions: <String>{call.permission},
          schema: PocketPluginCapabilitySchema(
            parameters: PocketPluginSchema.object(properties: call.params, required: call.required),
          ),
        ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    for (final call in studioCalls) {
      if (call.stream) {
        context.registerStream(call.name, (remote) => openStream(call.name, remote.params));
      } else {
        context.registerRequest(call.name, (params) => invoke(call.name, params));
      }
    }
  }

  @override
  Future<void> dispose() async => client.close();

  /// Executes one request capability. Also used directly by tests.
  Future<Object?> invoke(String name, Map<String, dynamic> params) async {
    final call = studioCallsByName[name];
    if (call == null || call.stream) {
      throw PocketCapabilityException('capability_not_found', 'unknown studio capability $name');
    }
    for (final key in call.required) {
      if (!params.containsKey(key)) {
        throw PocketCapabilityException('invalid_params', '$key is required');
      }
    }
    final request = call.build(params);
    if (name == 'studio.project.openLocal') {
      return _openLocalProject();
    }
    if (name == 'studio.project.create' && params['pickParentDirectory'] == true) {
      return _createProjectInPickedDirectory(request, params['id'] as String);
    }
    if (call.image) return _preview(name, request, params);
    final result = name == 'studio.artifacts.inspect'
        ? await _inspect(request, params['name'] as String)
        : _shape(
            name,
            (await client.send(
              request.method,
              request.segments,
              query: request.query,
              body: request.body,
              write: request.write,
              verbatimKeys: call.verbatimKeys,
              maxBytes: name == 'studio.logs.diagnostics' ? _maxDiagnosticSourceBytes : null,
              timeout: request.timeout,
            )).json,
            params,
          );
    final extra = call.assets && params['assets'] == true
        ? await _assets(request.segments.sublist(0, 3))
        : null;
    final shaped = extra == null ? result : <String, Object?>{...(result as Map), 'assets': extra};
    final size = utf8.encode(jsonEncode(shaped)).length;
    if (size > pocketStudioMaxResultBytes) {
      throw PocketCapabilityException('too_large',
          'result is $size bytes; use studio.fs.readChunk for large files');
    }
    return shaped;
  }

  Future<Object?> _openLocalProject() async {
    final picked = await client.sendInternalJson(
      'POST',
      const <String>['api', 'projects', 'pick-directory'],
      write: true,
      timeout: const Duration(seconds: 130),
    );
    final path = picked is Map ? picked['path'] : null;
    if (path is! String || path.trim().isEmpty) {
      return const <String, Object?>{'cancelled': true};
    }
    scrubber.addRoot(path, '<project>');
    final response = await client.send(
      'POST',
      const <String>['api', 'projects', 'open'],
      write: true,
      body: <String, Object?>{'path': path},
    );
    return <String, Object?>{
      'cancelled': false,
      'project': _slimProject(response.json),
    };
  }

  Future<Object?> _createProjectInPickedDirectory(StudioRequest request, String id) async {
    final picked = await client.sendInternalJson(
      'POST',
      const <String>['api', 'projects', 'pick-directory'],
      write: true,
      timeout: const Duration(seconds: 130),
    );
    final rawParent = picked is Map ? picked['path'] : null;
    if (rawParent is! String || rawParent.trim().isEmpty) {
      return const <String, Object?>{'cancelled': true};
    }
    var parentPath = rawParent.trim();
    while (parentPath.length > 1 && (parentPath.endsWith('/') || parentPath.endsWith(r'\'))) {
      parentPath = parentPath.substring(0, parentPath.length - 1);
    }
    final separator = parentPath.contains(r'\') && !parentPath.contains('/')
        ? r'\'
        : Platform.pathSeparator;
    final destination = (parentPath == '/' || parentPath == r'\')
        ? '$parentPath$id'
        : '$parentPath$separator$id';
    scrubber.addRoot(destination, '<project>');
    final body = <String, Object?>{
      ...(request.body as Map).cast<String, Object?>(),
      'directory': destination,
    };
    final response = await client.send(
      request.method,
      request.segments,
      write: true,
      body: body,
    );
    return _slimProject(response.json);
  }

  /// Fetches one image from the service and decodes it on the host (the guest has no PNG/JPEG decoder).
  /// The result is a bounded IMG entry as a binary value, so it skips the JSON size accounting; the
  /// framework charges it as bytes (<= 65,544 for the 128 px envelope).
  Future<Object?> _preview(String name, StudioRequest request, Map<String, dynamic> params) async {
    final response = await client.send('GET', request.segments,
        query: request.query, raw: true, maxBytes: pocketStudioMaxAssetBytes + 1024);
    if (response.contentType == 'image/svg+xml') {
      throw const PocketCapabilityException('unsupported_format', 'SVG cannot be decoded by the Studio host');
    }
    final preview = await decodeStudioImagePreview(response.bytes ?? Uint8List(0));
    return preview.toResult(<String, Object?>{
      if (name == 'studio.assets.preview') 'name': params['name'] else 'key': params['key'],
    });
  }

  Future<Object?> _assets(List<String> project) async {
    final response = await client.send('GET', <String>[...project, 'assets']);
    final json = response.json;
    return json is Map ? json['assets'] : const <Object?>[];
  }

  Future<Object?> _inspect(StudioRequest request, String name) async {
    final response = await client.send('GET', request.segments, raw: true);
    final bytes = response.bytes ?? const <int>[];
    final text = name.endsWith('.js') || name.endsWith('.json');
    if (!text) {
      return <String, Object?>{'name': name, 'bytes': bytes.length, 'encoding': 'binary'};
    }
    const limit = 128 * 1024;
    var view = bytes;
    if (name.endsWith('.json') && bytes.length > limit) {
      // Pretty-printed snapshots (resources.json) carry mostly whitespace: re-encode compactly so the guest
      // can still parse the whole document. `bytes` stays the artifact's real size.
      try {
        final compact = utf8.encode(jsonEncode(jsonDecode(utf8.decode(bytes))));
        if (compact.length <= limit) view = compact;
      } on FormatException {
        // not valid JSON: fall through to the byte cut
      }
    }
    final cut = view.length > limit ? limit : view.length;
    return <String, Object?>{
      'name': name,
      'bytes': bytes.length,
      'encoding': 'utf8',
      'truncated': cut < view.length,
      'data': scrubber.scrubString(utf8.decode(view.sublist(0, cut), allowMalformed: true)),
    };
  }

  Object? _shape(String name, Object? json, [Map<String, dynamic> params = const <String, dynamic>{}]) {
    switch (name) {
      case 'studio.project.list':
        final list = json is List ? json : const <Object?>[];
        return <String, Object?>{'projects': [for (final p in list) _slimProject(p)]};
      case 'studio.project.open':
      case 'studio.project.create':
        return _slimProject(json);
      case 'studio.build.start':
        // The service wraps the status as {status:{...}}; the contract is the flat status.
        final inner = json is Map ? json['status'] : null;
        return _capLogs(inner is Map ? inner : json);
      case 'studio.build.status':
        return _capLogs(json);
      case 'studio.logs.tail':
        return _capLogs(json, key: 'logs');
      case 'studio.artifacts.list':
        final map = json is Map ? json : const <String, Object?>{};
        return <String, Object?>{
          'revision': map['revision'],
          'builtRevision': map['builtRevision'],
          'artifacts': map['artifacts'],
        };
      case 'studio.ecosystem.set':
      case 'studio.cos.publish':
        if (json is Map && json['status'] is Map) {
          return <String, Object?>{
            ...json.cast<String, Object?>(),
            'status': _capLogs(json['status']),
          };
        }
        return json;
      case 'studio.publish.publish':
        // The signed envelope carries the whole base64 payload (every blob URL), which can exceed the 256 KiB
        // result quota for large projects and would fail an already completed publish. Keep the public
        // identity (keyId, signature, size) and drop the payload body; the signed bytes are served at
        // `manifestUrl` for anything that needs them.
        if (json is Map) {
          final shaped = <String, Object?>{...json.cast<String, Object?>()};
          if (shaped['status'] is Map) {
            shaped['status'] = _capLogs(shaped['status']);
          }
          if (shaped['manifest'] is Map) {
            final manifest = shaped['manifest'] as Map;
            final payload = manifest['payload'];
            shaped['manifest'] = <String, Object?>{
              for (final e in manifest.entries)
                if (e.key != 'payload') '${e.key}': e.value,
              if (payload is String) 'payloadBase64Bytes': payload.length,
            };
          }
          return shaped;
        }
        return json;
      case 'studio.logs.diagnostics':
        return _diagnostics(json, params);
      case 'studio.project.resources.get':
      case 'studio.project.resources.set':
        return _resources(json);
      case 'studio.service.health':
        final map = json is Map ? json : const <String, Object?>{};
        return <String, Object?>{
          for (final k in const ['ok', 'service', 'version', 'projectId', 'updatePackageVersion', 'bluetooth'])
            if (map.containsKey(k)) k: map[k],
        };
      default:
        return json;
    }
  }

  /// Resource inventory for the guest. The service's `previewUrl` is a relative route the guest cannot fetch;
  /// it becomes `preview: true`, and the thumbnail is read with `studio.project.resources.preview`.
  static Object? _resources(Object? json) {
    if (json is! Map) return json;
    final packages = json['packages'];
    return <String, Object?>{
      for (final e in json.entries) '${e.key}': e.key == 'packages' && packages is List ? _packages(packages) : e.value,
    };
  }

  static List<Object?> _packages(List<Object?> packages) => <Object?>[
    for (final pkg in packages)
      if (pkg is Map)
        <String, Object?>{
          for (final e in pkg.entries)
            '${e.key}': e.key == 'resources' && e.value is List
                ? <Object?>[
                    for (final resource in e.value as List)
                      if (resource is Map)
                        <String, Object?>{
                          for (final field in resource.entries)
                            if (field.key != 'previewUrl') '${field.key}': field.value,
                          if (resource['previewUrl'] != null) 'preview': true,
                        }
                      else
                        resource,
                  ]
                : e.value,
        }
      else
        pkg,
  ];

  /// The diagnostics bundle (already scrubbed by the client) bounded to the result budget: newest records first,
  /// whole records only. `exportId` is derived (project + export time), not stored; `downloadUrl` is the
  /// service's own `?download=1` URL (loopback, no secret) for the full file.
  Object? _diagnostics(Object? json, Map<String, dynamic> params) {
    final map = json is Map ? json : const <String, Object?>{};
    final project = params['project'] as String;
    final all = map['records'] is List ? map['records'] as List : const <Object?>[];
    var used = 0;
    final kept = <Object?>[];
    for (final record in all) {
      used += utf8.encode(jsonEncode(record)).length + 1;
      if (used > _maxDiagnosticBytes) break;
      kept.add(record);
    }
    final exportedAt = map['exportedAt'] is String ? map['exportedAt'] as String : '';
    final stamp = exportedAt.replaceAll(RegExp(r'[^0-9]'), '');
    final kind = params['kind'];
    return <String, Object?>{
      'exportId': 'diag-$project-${stamp.isEmpty ? 'now' : stamp}',
      'project': project,
      if (kind != null) 'kind': kind,
      for (final k in const ['format', 'schemaVersion', 'exportedAt', 'totalRecords', 'logCount', 'crashCount', 'context'])
        if (map.containsKey(k)) k: map[k],
      'keptRecords': kept.length,
      'omitted': all.length - kept.length,
      'truncated': kept.length < all.length,
      'records': kept,
      'downloadUrl': _origin
          .replace(path: '/api/projects/$project/diagnostics', query: 'download=1${kind == null ? '' : '&kind=$kind'}')
          .toString(),
    };
  }

  static Object? _slimProject(Object? project) {
    if (project is! Map) return project;
    final copy = <String, Object?>{for (final e in project.entries) '${e.key}': e.value};
    final status = copy['status'];
    if (status is Map) copy['status'] = _capLogs(<String, Object?>{...status, 'logs': const <Object?>[]});
    return copy;
  }

  /// Keeps the newest log lines whose encoded size fits the result budget.
  static Object? _capLogs(Object? json, {String key = 'logs'}) {
    if (json is! Map) return json;
    final copy = <String, Object?>{for (final e in json.entries) '${e.key}': e.value};
    final logs = copy[key];
    if (logs is List) {
      var used = 0;
      final kept = <Object?>[];
      for (final line in logs.reversed) {
        used += utf8.encode(jsonEncode(line)).length + 1;
        if (used > 100 * 1024) break;
        kept.add(line);
      }
      copy[key] = kept.reversed.toList();
    }
    return copy;
  }

  /// SSE route -> capability stream. Events are scrubbed, queued, and sent as
  /// `{events:[...]}` batches (<=200 events / 128 KiB) so the guest receives at
  /// most one message per flush interval. When the queue overflows the oldest
  /// `log` events (then oldest others) are dropped and a
  /// `{type:"gap", dropped:n}` event is placed first in the next batch: the
  /// guest must re-list/re-read status.
  Stream<Object?> openStream(String name, Map<String, dynamic> params) {
    final call = studioCallsByName[name];
    if (call == null || !call.stream) {
      throw PocketCapabilityException('capability_not_found', 'unknown studio stream $name');
    }
    final request = call.build(params);
    final source = client.sse(request.segments);
    final queue = <Object?>[];
    final sizes = <int>[];
    var queuedBytes = 0;
    var dropped = 0;
    Timer? timer;
    StreamSubscription<Object?>? subscription;
    late StreamController<Object?> controller;

    bool isLog(Object? e) => e is Map && e['type'] == 'log';

    void dropOldest() {
      var index = queue.indexWhere(isLog);
      if (index < 0) index = 0;
      queuedBytes -= sizes.removeAt(index);
      queue.removeAt(index);
      dropped++;
    }

    void flush() {
      timer = null;
      if (controller.isClosed || (queue.isEmpty && dropped == 0)) return;
      final batch = <Object?>[];
      if (dropped > 0) {
        batch.add(<String, Object?>{'type': 'gap', 'dropped': dropped});
        dropped = 0;
      }
      var bytes = 0;
      while (queue.isNotEmpty && batch.length < _maxBatchEvents && bytes + sizes.first <= _maxBatchBytes) {
        bytes += sizes.first;
        queuedBytes -= sizes.removeAt(0);
        batch.add(queue.removeAt(0));
      }
      if (batch.isEmpty && queue.isNotEmpty) {
        queuedBytes -= sizes.removeAt(0);
        queue.removeAt(0);
        batch.add(<String, Object?>{'type': 'gap', 'dropped': 1});
      }
      controller.add(<String, Object?>{'events': batch});
      if (queue.isNotEmpty) timer = Timer(flushInterval, flush);
    }

    controller = StreamController<Object?>(
      onListen: () {
        subscription = source.listen(
          (event) {
            final size = utf8.encode(jsonEncode(event)).length;
            queue.add(event);
            sizes.add(size);
            queuedBytes += size;
            while (queue.length > _maxQueuedEvents || queuedBytes > _maxQueuedBytes) {
              dropOldest();
            }
            timer ??= Timer(flushInterval, flush);
          },
          onError: (Object error, StackTrace stack) {
            timer?.cancel();
            controller.addError(error, stack);
            controller.close();
          },
          onDone: () {
            timer?.cancel();
            while (queue.isNotEmpty || dropped > 0) {
              flush();
              timer?.cancel();
            }
            controller.close();
          },
          cancelOnError: true,
        );
      },
      onCancel: () async {
        timer?.cancel();
        await subscription?.cancel();
      },
    );
    return controller.stream;
  }
}
