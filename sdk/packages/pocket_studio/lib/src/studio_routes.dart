import 'dart:convert';

import 'package:pocket_services/pocket_services.dart';

import 'studio_image.dart' show pocketStudioDecodableImageExtensions;
import 'studio_paths.dart';

/// Permissions granted by the trusted host (host scope) and declared by the
/// Studio guest manifest. Reads and writes are separate grants.
abstract final class PocketStudioPermissions {
  static const String read = 'studio.read';
  static const String write = 'studio.write';
  static const String build = 'studio.build';
  static const String deploy = 'studio.deploy';
  static const String publish = 'studio.publish';
  static const Set<String> all = <String>{read, write, build, deploy, publish};
}

/// Largest raw payload per transfer chunk (service limit; keeps every control
/// message below 256 KiB once base64 encoded).
const int pocketStudioChunkBytes = 128 * 1024;

/// Largest request/response result the provider returns in one capability
/// call (framework quota is 256 KiB; leave headroom).
const int pocketStudioMaxResultBytes = 240 * 1024;

/// Largest asset the service accepts (multipart and chunked upload alike).
const int pocketStudioMaxAssetBytes = 32 * 1024 * 1024;

const Set<String> _configKeys = <String>{
  'name', 'title', 'appId', 'version', 'tickHz', 'reusePublishedPackages',
};

final RegExp _ecosystemModuleId = RegExp(r'^[a-z0-9-]{1,64}$');

List<String> _ecosystemModules(Object? value, [String name = 'ecosystemModules', int max = 64]) {
  if (value is! List || value.length > max) {
    throw PocketCapabilityException('invalid_params', '$name must be an array of at most $max module ids');
  }
  return <String>[
    for (final item in value)
      if (item is String && _ecosystemModuleId.hasMatch(item))
        item
      else
        throw PocketCapabilityException('invalid_params', '$name entries must match [a-z0-9-]{1,64}'),
  ];
}

/// One service request derived from validated guest params.
final class StudioRequest {
  const StudioRequest(
    this.method,
    this.segments, {
    this.query,
    this.body,
    this.write = false,
    this.timeout,
  });
  final String method;
  final List<String> segments;
  final Map<String, String>? query;
  final Object? body;
  final bool write;
  final Duration? timeout;
}

typedef StudioRequestBuilder = StudioRequest Function(Map<String, dynamic> params);

/// A fixed allowlist entry: capability name -> (method, route template).
final class StudioCall {
  const StudioCall(
    this.name,
    this.permission,
    this.description,
    this.params,
    this.required,
    this.build, {
    this.stream = false,
    this.assets = false,
    this.image = false,
    this.verbatimKeys = const <String>{},
  });
  final String name;
  final String permission;
  final String description;
  final Map<String, PocketPluginSchema> params;
  final Set<String> required;
  final StudioRequestBuilder build;
  final bool stream;
  final bool assets;

  /// The response is an image the provider decodes into a bounded IMG entry (studio_image.dart).
  final bool image;

  /// Top-level string fields of a successful response that are file payloads: they are returned byte-exact
  /// (never path-scrubbed), since rewriting them would corrupt file content or base64 checksums. Every other
  /// field, error and stream event is still scrubbed.
  final Set<String> verbatimKeys;
}

const PocketPluginSchema _s = PocketPluginSchema.string();
const PocketPluginSchema _i = PocketPluginSchema.integer();
const PocketPluginSchema _b = PocketPluginSchema.boolean();
const PocketPluginSchema _o = PocketPluginSchema.unknown();

List<String> _project(Map<String, dynamic> p) => <String>['api', 'projects', studioProjectId(p['project'])];
List<String> _file(Map<String, dynamic> p, String route, [String key = 'path']) =>
    <String>[..._project(p), route, ...studioRelativePath(p[key], key)];

int _nonNegative(Object? v, String name) {
  if (v is! int || v < 0) throw PocketCapabilityException('invalid_params', '$name must be a non-negative integer');
  return v;
}

String _channel(Object? v) {
  if (v == null) return 'test';
  if (v != 'test' && v != 'release') throw const PocketCapabilityException('invalid_params', 'channel must be test or release');
  return v as String;
}

Map<String, Object?> _config(Object? source, {required bool create}) {
  if (source is! Map) throw const PocketCapabilityException('invalid_params', 'settings must be an object');
  final body = <String, Object?>{};
  for (final entry in source.entries) {
    final key = '${entry.key}';
    if (_configKeys.contains(key)) {
      body[key] = entry.value;
    } else if (create && key == 'ecosystemModules') {
      body['ecosystemModules'] = _ecosystemModules(entry.value, 'ecosystemModules', 32);
    } else if (!(create && (key == 'id' || key == 'template'))) {
      throw PocketCapabilityException('invalid_params', 'unknown setting: $key');
    }
  }
  return body;
}

Map<String, Object?> _cosCredentials(Object? value) {
  if (value is! Map) {
    throw const PocketCapabilityException('invalid_params', 'credentials must be an object or null');
  }
  final secretId = value['secretId'];
  final secretKey = value['secretKey'];
  final securityToken = value['securityToken'];
  if (secretId is! String || secretId.trim().isEmpty || secretId.length > 256) {
    throw const PocketCapabilityException('invalid_params', 'credentials.secretId must be a non-empty string');
  }
  if (secretKey is! String || secretKey.trim().isEmpty || secretKey.length > 256) {
    throw const PocketCapabilityException('invalid_params', 'credentials.secretKey must be a non-empty string');
  }
  if (securityToken != null && (securityToken is! String || securityToken.length > 4096)) {
    throw const PocketCapabilityException('invalid_params', 'credentials.securityToken must be a string');
  }
  return <String, Object?>{
    'secretId': secretId.trim(),
    'secretKey': secretKey.trim(),
    if (securityToken is String && securityToken.trim().isNotEmpty) 'securityToken': securityToken.trim(),
  };
}

String _optionalBoundedString(Object? v, String name, int max) {
  if (v is! String || v.length > max) {
    throw PocketCapabilityException('invalid_params', '$name must be a string of at most $max characters');
  }
  return v;
}

int _base64RawLength(String data) {
  var padding = 0;
  if (data.endsWith('==')) {
    padding = 2;
  } else if (data.endsWith('=')) {
    padding = 1;
  }
  return data.length * 3 ~/ 4 - padding;
}

/// Names that are not decodable images fail before any request: SVG is reported as such, never faked.
void _decodableImage(String name) {
  final dot = name.lastIndexOf('.');
  final extension = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  if (extension == 'svg') {
    throw const PocketCapabilityException('unsupported_format', 'SVG cannot be decoded by the Studio host');
  }
  if (!pocketStudioDecodableImageExtensions.contains(extension)) {
    throw const PocketCapabilityException('not_an_image', 'only png, jpg, gif, webp and bmp files can be previewed');
  }
}

final RegExp _assetName = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');

/// Flat asset file name, the service's own pattern (checked before any URL is built).
String studioAssetName(Object? value, [String name = 'name']) {
  if (value is! String || !_assetName.hasMatch(value)) {
    throw PocketCapabilityException('invalid_params', '$name must be a flat safe file name (A-Z a-z 0-9 . _ -)');
  }
  return value;
}

const int _maxPlacements = 20000;

List<Map<String, Object?>> _placements(Object? value) {
  if (value is! List || value.length > _maxPlacements) {
    throw const PocketCapabilityException('invalid_params', 'placements must be an array');
  }
  final seen = <String>{};
  return <Map<String, Object?>>[
    for (final raw in value)
      () {
        if (raw is! Map || raw['key'] is! String || (raw['key'] as String).isEmpty || (raw['key'] as String).length > 1024 ||
            (raw['placement'] != 'pak' && raw['placement'] != 'network')) {
          throw const PocketCapabilityException('invalid_params', 'each placement needs a key and placement pak|network');
        }
        if (!seen.add(raw['key'] as String)) {
          throw const PocketCapabilityException('invalid_params', 'duplicate placement key');
        }
        return <String, Object?>{'key': raw['key'], 'placement': raw['placement']};
      }(),
  ];
}

String _boundedString(Object? v, String name, int max) {
  if (v is! String || v.isEmpty || v.length > max) {
    throw PocketCapabilityException('invalid_params', '$name must be a non-empty string of at most $max characters');
  }
  return v;
}

const Set<String> pocketStudioArtifactNames = <String>{
  'app.js', 'app.qjbc', 'app.bytecode.json', 'app.pak', 'guest-manifest.json',
  'build.json', 'resources.json', 'app.worker.qjbc', 'app.worker.bytecode.json',
};

Map<String, PocketPluginSchema> _p({Map<String, PocketPluginSchema> extra = const {}, bool project = true}) =>
    <String, PocketPluginSchema>{if (project) 'project': _s, ...extra};

/// The frozen capability table. Each entry is a fixed (method, route) pair.
final List<StudioCall> studioCalls = <StudioCall>[
  StudioCall('studio.project.list', PocketStudioPermissions.read, 'List projects',
      _p(project: false), const {}, (p) => const StudioRequest('GET', ['api', 'projects'])),
  StudioCall('studio.project.openLocal', PocketStudioPermissions.write,
      'Pick and open a local Pocket project directory on the host machine',
      _p(project: false), const {}, (p) => const StudioRequest('POST', ['api', 'projects', 'open'], write: true)),
  StudioCall('studio.project.create', PocketStudioPermissions.write, 'Create a project from an SDK template',
      _p(project: false, extra: {
        'id': _s,
        'template': _s,
        'settings': _o,
        'pickParentDirectory': _b,
        'ecosystemModules': _o,
      }), const {'id'}, (p) {
    final id = studioProjectId(p['id'], 'id');
    final template = p['template'] ?? 'app';
    if (template != 'app' && template != 'game') {
      throw const PocketCapabilityException('invalid_params', 'template must be app or game');
    }
    if (p['pickParentDirectory'] != null && p['pickParentDirectory'] is! bool) {
      throw const PocketCapabilityException('invalid_params', 'pickParentDirectory must be a boolean');
    }
    final settings = _config(p['settings'] ?? const <String, Object?>{}, create: true);
    if (p['ecosystemModules'] != null) {
      settings['ecosystemModules'] = _ecosystemModules(p['ecosystemModules'], 'ecosystemModules', 32);
    }
    return StudioRequest('POST', const ['api', 'projects'], write: true, body: <String, Object?>{
      ...settings,
      'id': id,
      'template': template,
    });
  }),
  StudioCall('studio.project.open', PocketStudioPermissions.read, 'Read project configuration and status',
      _p(), const {'project'}, (p) => StudioRequest('GET', _project(p))),
  StudioCall('studio.project.settings.get', PocketStudioPermissions.read, 'Read project settings',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'config'])),
  StudioCall('studio.project.settings.set', PocketStudioPermissions.write, 'Update project settings',
      _p(extra: {'settings': _o}), const {'project', 'settings'},
      (p) => StudioRequest('PUT', [..._project(p), 'config'], write: true, body: _config(p['settings'], create: false))),
  StudioCall('studio.ecosystem.catalog', PocketStudioPermissions.read, 'List on-demand ecosystem modules and profiles',
      _p(project: false), const {}, (p) => const StudioRequest('GET', ['api', 'ecosystem', 'modules'])),
  StudioCall('studio.ecosystem.get', PocketStudioPermissions.read, 'Read enabled ecosystem modules for a project',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'ecosystem'])),
  StudioCall('studio.ecosystem.set', PocketStudioPermissions.write, 'Scaffold and update ecosystem modules for a project',
      _p(extra: {'modules': _o, 'add': _o}), const {'project'}, (p) {
    final hasModules = p['modules'] != null;
    final hasAdd = p['add'] != null;
    if (hasModules == hasAdd) {
      throw const PocketCapabilityException('invalid_params', 'provide either modules or add');
    }
    final body = hasAdd
        ? <String, Object?>{'add': _ecosystemModules(p['add'], 'add', 64)}
        : <String, Object?>{'modules': _ecosystemModules(p['modules'], 'modules', 64)};
    return StudioRequest('POST', [..._project(p), 'ecosystem'], write: true, body: body);
  }),
  StudioCall('studio.cos.get', PocketStudioPermissions.read, 'Read Tencent Cloud COS configuration and credential inspection',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'cos'])),
  StudioCall('studio.cos.set', PocketStudioPermissions.write, 'Save Tencent Cloud COS configuration and optional workspace credentials',
      _p(extra: {
        'enabled': _b,
        'syncOnPublish': _b,
        'bucket': _s,
        'region': _s,
        'keyPrefix': _s,
        'publicBaseUrl': _s,
        'credentials': _o,
      }), const {'project'}, (p) {
    final body = <String, Object?>{};
    if (p.containsKey('enabled')) {
      if (p['enabled'] is! bool) throw const PocketCapabilityException('invalid_params', 'enabled must be a boolean');
      body['enabled'] = p['enabled'];
    }
    if (p.containsKey('syncOnPublish')) {
      if (p['syncOnPublish'] is! bool) throw const PocketCapabilityException('invalid_params', 'syncOnPublish must be a boolean');
      body['syncOnPublish'] = p['syncOnPublish'];
    }
    if (p.containsKey('bucket') && p['bucket'] != null) {
      body['bucket'] = _optionalBoundedString(p['bucket'], 'bucket', 128);
    }
    if (p.containsKey('region') && p['region'] != null) {
      body['region'] = _optionalBoundedString(p['region'], 'region', 64);
    }
    if (p.containsKey('keyPrefix') && p['keyPrefix'] != null) {
      body['keyPrefix'] = _optionalBoundedString(p['keyPrefix'], 'keyPrefix', 256);
    }
    if (p.containsKey('publicBaseUrl') && p['publicBaseUrl'] != null) {
      body['publicBaseUrl'] = _optionalBoundedString(p['publicBaseUrl'], 'publicBaseUrl', 512);
    }
    if (p.containsKey('credentials')) {
      final raw = p['credentials'];
      body['credentials'] = raw == null ? null : _cosCredentials(raw);
    }
    return StudioRequest('PUT', [..._project(p), 'cos'], write: true, body: body);
  }),
  StudioCall('studio.cos.check', PocketStudioPermissions.write, 'Check Tencent Cloud COS bucket connectivity and credentials',
      _p(extra: {
        'bucket': _s,
        'region': _s,
        'keyPrefix': _s,
        'publicBaseUrl': _s,
      }), const {'project'}, (p) {
    final body = <String, Object?>{
      if (p['bucket'] != null) 'bucket': _optionalBoundedString(p['bucket'], 'bucket', 128),
      if (p['region'] != null) 'region': _optionalBoundedString(p['region'], 'region', 64),
      if (p['keyPrefix'] != null) 'keyPrefix': _optionalBoundedString(p['keyPrefix'], 'keyPrefix', 256),
      if (p['publicBaseUrl'] != null) 'publicBaseUrl': _optionalBoundedString(p['publicBaseUrl'], 'publicBaseUrl', 512),
    };
    return StudioRequest(
      'POST',
      [..._project(p), 'cos', 'check'],
      write: true,
      body: body,
      timeout: const Duration(seconds: 60),
    );
  }),
  StudioCall('studio.cos.publish', PocketStudioPermissions.publish, 'Publish a signed package to Tencent Cloud COS',
      _p(extra: {'channel': _s}), const {'project'}, (p) {
    return StudioRequest(
      'POST',
      [..._project(p), 'cos', 'publish'],
      write: true,
      body: <String, Object?>{'channel': _channel(p['channel'])},
      timeout: const Duration(seconds: 130),
    );
  }),
  StudioCall('studio.fs.tree', PocketStudioPermissions.read, 'List editable files (flat)',
      _p(extra: {'assets': _b}), const {'project'},
      (p) => StudioRequest('GET', [..._project(p), 'files']), assets: true),
  StudioCall('studio.fs.read', PocketStudioPermissions.read, 'Read a small UTF-8 file',
      _p(extra: {'path': _s}), const {'project', 'path'}, (p) => StudioRequest('GET', _file(p, 'files')),
      verbatimKeys: const {'content'}),
  StudioCall('studio.fs.write', PocketStudioPermissions.write, 'Write a small UTF-8 file',
      _p(extra: {'path': _s, 'content': _s}), const {'project', 'path', 'content'}, (p) {
    final content = p['content'];
    if (content is! String) throw const PocketCapabilityException('invalid_params', 'content must be a string');
    if (utf8.encode(content).length > 192 * 1024) {
      throw const PocketCapabilityException('too_large', 'content exceeds 192 KiB; use studio.fs.upload.*');
    }
    return StudioRequest('PUT', _file(p, 'files'), write: true, body: <String, Object?>{'content': content});
  }),
  StudioCall('studio.fs.rename', PocketStudioPermissions.write, 'Move or rename a file',
      _p(extra: {'from': _s, 'to': _s, 'overwrite': _b}), const {'project', 'from', 'to'}, (p) {
    studioRelativePath(p['from'], 'from');
    studioRelativePath(p['to'], 'to');
    return StudioRequest('POST', [..._project(p), 'files-move'], write: true, body: <String, Object?>{
      'from': p['from'], 'to': p['to'], if (p['overwrite'] == true) 'overwrite': true,
    });
  }),
  StudioCall('studio.fs.delete', PocketStudioPermissions.write, 'Delete a file',
      _p(extra: {'path': _s}), const {'project', 'path'}, (p) => StudioRequest('DELETE', _file(p, 'files'), write: true)),
  StudioCall('studio.fs.stat', PocketStudioPermissions.read, 'Stat a file or directory',
      _p(extra: {'path': _s}), const {'project', 'path'}, (p) => StudioRequest('GET', _file(p, 'stat'))),
  StudioCall('studio.fs.mkdir', PocketStudioPermissions.write, 'Create a folder',
      _p(extra: {'path': _s}), const {'project', 'path'}, (p) {
    studioRelativePath(p['path']);
    return StudioRequest('POST', [..._project(p), 'folders'], write: true, body: <String, Object?>{'path': p['path']});
  }),
  StudioCall('studio.fs.rmdir', PocketStudioPermissions.write, 'Remove an empty folder',
      _p(extra: {'path': _s}), const {'project', 'path'}, (p) => StudioRequest('DELETE', _file(p, 'folders'), write: true)),
  StudioCall('studio.fs.readChunk', PocketStudioPermissions.read, 'Read a base64 chunk (<=128 KiB)',
      _p(extra: {'path': _s, 'offset': _i, 'length': _i}), const {'project', 'path', 'offset'}, (p) {
    final offset = _nonNegative(p['offset'], 'offset');
    final length = p['length'] == null ? pocketStudioChunkBytes : _nonNegative(p['length'], 'length');
    if (length < 1) throw const PocketCapabilityException('invalid_params', 'length must be positive');
    return StudioRequest('GET', _file(p, 'chunks'), query: <String, String>{
      'offset': '$offset',
      'length': '${length > pocketStudioChunkBytes ? pocketStudioChunkBytes : length}',
    });
  }, verbatimKeys: const {'data'}),
  StudioCall('studio.fs.upload.begin', PocketStudioPermissions.write, 'Begin a chunked upload',
      _p(extra: {'path': _s, 'totalBytes': _i, 'sha256': _s}), const {'project', 'path', 'totalBytes', 'sha256'}, (p) {
    studioRelativePath(p['path']);
    final sha = p['sha256'];
    if (sha is! String || !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(sha)) {
      throw const PocketCapabilityException('invalid_params', 'sha256 must be 64 hex characters');
    }
    return StudioRequest('POST', [..._project(p), 'uploads'], write: true, body: <String, Object?>{
      'path': p['path'], 'totalBytes': _nonNegative(p['totalBytes'], 'totalBytes'), 'sha256': sha,
    });
  }),
  StudioCall('studio.fs.upload.chunk', PocketStudioPermissions.write, 'Upload one base64 chunk (<=128 KiB raw)',
      _p(extra: {'uploadId': _s, 'offset': _i, 'data': _s}), const {'project', 'uploadId', 'offset', 'data'}, (p) {
    final data = p['data'];
    if (data is! String || data.isEmpty) throw const PocketCapabilityException('invalid_params', 'data must be base64');
    if (_base64RawLength(data) > pocketStudioChunkBytes) {
      throw const PocketCapabilityException('too_large', 'chunk exceeds 131072 raw bytes');
    }
    return StudioRequest('PUT', [..._project(p), 'uploads', studioOpaqueId(p['uploadId'], 'uploadId')],
        write: true, body: <String, Object?>{'offset': _nonNegative(p['offset'], 'offset'), 'data': data});
  }),
  StudioCall('studio.fs.upload.commit', PocketStudioPermissions.write, 'Commit an upload',
      _p(extra: {'uploadId': _s}), const {'project', 'uploadId'},
      (p) => StudioRequest('POST', [..._project(p), 'uploads', studioOpaqueId(p['uploadId'], 'uploadId'), 'commit'],
          write: true, body: const <String, Object?>{})),
  StudioCall('studio.fs.upload.abort', PocketStudioPermissions.write, 'Abort an upload',
      _p(extra: {'uploadId': _s}), const {'project', 'uploadId'},
      (p) => StudioRequest('DELETE', [..._project(p), 'uploads', studioOpaqueId(p['uploadId'], 'uploadId')], write: true)),
  StudioCall('studio.assets.upload.begin', PocketStudioPermissions.write,
      'Begin a chunked asset upload into assets/ (images, audio, fonts; <= 32 MiB). Use studio.fs.upload.chunk/commit/abort',
      _p(extra: {'name': _s, 'totalBytes': _i, 'sha256': _s}), const {'project', 'name', 'totalBytes', 'sha256'}, (p) {
    final sha = p['sha256'];
    if (sha is! String || !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(sha)) {
      throw const PocketCapabilityException('invalid_params', 'sha256 must be 64 hex characters');
    }
    final total = _nonNegative(p['totalBytes'], 'totalBytes');
    if (total > pocketStudioMaxAssetBytes) {
      throw const PocketCapabilityException('too_large', 'asset exceeds 32 MiB');
    }
    return StudioRequest('POST', [..._project(p), 'uploads'], write: true, body: <String, Object?>{
      'target': 'asset', 'name': studioAssetName(p['name']), 'totalBytes': total, 'sha256': sha,
    });
  }),
  StudioCall('studio.assets.preview', PocketStudioPermissions.read,
      'Decode one image asset into a bounded RGBA IMG entry (png, jpeg, gif, webp, bmp; max edge 128)',
      _p(extra: {'name': _s}), const {'project', 'name'}, (p) {
    final name = studioAssetName(p['name']);
    _decodableImage(name);
    return StudioRequest('GET', [..._project(p), 'assets', name]);
  }, image: true),
  StudioCall('studio.project.resources.get', PocketStudioPermissions.read, 'Resource packages with per-resource placement',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'resources'])),
  StudioCall('studio.project.resources.set', PocketStudioPermissions.write,
      'Save the placements of one resource package (409 when the revision is stale)',
      _p(extra: {'revision': _i, 'packageId': _s, 'placements': _o}), const {'project', 'revision', 'packageId', 'placements'}, (p) {
    return StudioRequest('PUT', [..._project(p), 'resources'], write: true, body: <String, Object?>{
      'revision': _nonNegative(p['revision'], 'revision'),
      'packageId': _boundedString(p['packageId'], 'packageId', 128),
      'placements': _placements(p['placements']),
    });
  }),
  StudioCall('studio.project.resources.preview', PocketStudioPermissions.read,
      'Decode the thumbnail of one built resource into a bounded RGBA IMG entry',
      _p(extra: {'revision': _i, 'package': _s, 'key': _s}), const {'project', 'revision', 'package', 'key'}, (p) {
    return StudioRequest('GET', [..._project(p), 'resources', 'preview'], query: <String, String>{
      'revision': '${_nonNegative(p['revision'], 'revision')}',
      'package': _boundedString(p['package'], 'package', 128),
      'key': _boundedString(p['key'], 'key', 1024),
    });
  }, image: true),
  StudioCall('studio.fs.watch', PocketStudioPermissions.read, 'Stream file changes',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'watch']), stream: true),
  StudioCall('studio.build.start', PocketStudioPermissions.build, 'Queue a build',
      _p(), const {'project'}, (p) => StudioRequest('POST', [..._project(p), 'build'], write: true, body: const <String, Object?>{})),
  StudioCall('studio.build.cancel', PocketStudioPermissions.build, 'Cancel the running build',
      _p(), const {'project'}, (p) => StudioRequest('POST', [..._project(p), 'build', 'cancel'], write: true, body: const <String, Object?>{})),
  StudioCall('studio.build.status', PocketStudioPermissions.read, 'Build status',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'status'])),
  StudioCall('studio.build.events', PocketStudioPermissions.read, 'Stream build events',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'build', 'events']), stream: true),
  StudioCall('studio.logs.tail', PocketStudioPermissions.read, 'Recent build log lines',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'logs'])),
  StudioCall('studio.logs.diagnostics', PocketStudioPermissions.read, 'Export the project diagnostics bundle (scrubbed, bounded)',
      _p(extra: {'kind': _s}), const {'project'}, (p) {
    final kind = p['kind'];
    if (kind != null && kind != 'log' && kind != 'crash') {
      throw const PocketCapabilityException('invalid_params', 'kind must be log or crash');
    }
    return StudioRequest('GET', [..._project(p), 'diagnostics'],
        query: kind == null ? null : <String, String>{'kind': kind as String});
  }),
  StudioCall('studio.preview.publish', PocketStudioPermissions.build, 'Publish the current build to one or more signed preview slots',
      _p(extra: {'previewAppId': _s, 'previewAppIds': _o}), const {'project'}, (p) {
    final slotPattern = RegExp(r'^dev\.pocket\.studio\.preview(?:\.[a-z][a-z0-9-]{0,31})?$');
    final body = <String, Object?>{};
    if (p['previewAppIds'] != null) {
      final rawList = p['previewAppIds'];
      if (rawList is! List || rawList.length > 8 || rawList.isEmpty) {
        throw const PocketCapabilityException('invalid_params', 'previewAppIds must be an array of 1..8 slot ids');
      }
      final ids = <String>[];
      for (final item in rawList) {
        if (item is! String || !slotPattern.hasMatch(item)) {
          throw const PocketCapabilityException('invalid_params', 'previewAppIds entries must match dev.pocket.studio.preview[.<slot>]');
        }
        if (!ids.contains(item)) ids.add(item);
      }
      body['previewAppIds'] = ids;
    } else if (p['previewAppId'] != null) {
      final rawId = p['previewAppId'];
      if (rawId is! String || !slotPattern.hasMatch(rawId)) {
        throw const PocketCapabilityException('invalid_params', 'previewAppId must match dev.pocket.studio.preview[.<slot>]');
      }
      body['previewAppId'] = rawId;
    }
    return StudioRequest('POST', [..._project(p), 'preview-publish'], write: true, body: body);
  }),
  StudioCall('studio.wechat.status', PocketStudioPermissions.read, 'Read WeChat Mini Program & Web loopback preview status',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'wechat'])),
  StudioCall('studio.wechat.start', PocketStudioPermissions.build, 'Start WeChat Mini Program preview server for a project',
      _p(extra: {'targetId': _s}), const {'project'}, (p) {
    final targetId = p['targetId'] == null ? 'main' : _boundedString(p['targetId'], 'targetId', 200);
    return StudioRequest('POST', [..._project(p), 'wechat'], write: true, body: <String, Object?>{'targetId': targetId});
  }),
  StudioCall('studio.wechat.stop', PocketStudioPermissions.build, 'Stop WeChat Mini Program preview server for a project',
      _p(), const {'project'}, (p) => StudioRequest('DELETE', [..._project(p), 'wechat'], write: true)),
  StudioCall('studio.preview.devices', PocketStudioPermissions.read, 'List deployment devices',
      _p(project: false), const {}, (p) => const StudioRequest('GET', ['api', 'devices'])),
  StudioCall('studio.preview.deploy', PocketStudioPermissions.deploy, 'Start a device deployment',
      _p(extra: {'deviceId': _s}), const {'project', 'deviceId'}, (p) {
    final device = p['deviceId'];
    if (device is! String || device.isEmpty || device.length > 200) {
      throw const PocketCapabilityException('invalid_params', 'deviceId must be a non-empty string');
    }
    return StudioRequest('POST', [..._project(p), 'deploy'], write: true, body: <String, Object?>{'deviceId': device});
  }),
  StudioCall('studio.preview.deployStatus', PocketStudioPermissions.read, 'Deployment job status',
      _p(extra: {'job': _s}), const {'project', 'job'},
      (p) => StudioRequest('GET', [..._project(p), 'deploy', studioOpaqueId(p['job'], 'job')])),
  StudioCall('studio.preview.deployCancel', PocketStudioPermissions.deploy, 'Cancel a deployment job',
      _p(extra: {'job': _s}), const {'project', 'job'},
      (p) => StudioRequest('DELETE', [..._project(p), 'deploy', studioOpaqueId(p['job'], 'job')], write: true)),
  StudioCall('studio.publish.plan', PocketStudioPermissions.read, 'Publish target summary',
      _p(extra: {'channel': _s}), const {'project'},
      (p) => StudioRequest('GET', [..._project(p), 'publish-targets'], query: <String, String>{'channel': _channel(p['channel'])})),
  StudioCall('studio.publish.publish', PocketStudioPermissions.publish, 'Publish a signed package',
      _p(extra: {'channel': _s}), const {'project'},
      (p) => StudioRequest('POST', [..._project(p), 'publish'], write: true, body: <String, Object?>{'channel': _channel(p['channel'])})),
  StudioCall('studio.publish.history', PocketStudioPermissions.read, 'Version backend snapshot',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'versions'])),
  StudioCall('studio.publish.offline', PocketStudioPermissions.publish, 'Build an offline package',
      _p(), const {'project'}, (p) => StudioRequest('POST', [..._project(p), 'package-offline'], write: true, body: const <String, Object?>{})),
  StudioCall('studio.artifacts.list', PocketStudioPermissions.read, 'List build artifacts',
      _p(), const {'project'}, (p) => StudioRequest('GET', [..._project(p), 'status'])),
  StudioCall('studio.artifacts.inspect', PocketStudioPermissions.read, 'Inspect one build artifact (text only)',
      _p(extra: {'name': _s}), const {'project', 'name'}, (p) {
    final name = p['name'];
    if (name is! String || !pocketStudioArtifactNames.contains(name)) {
      throw const PocketCapabilityException('invalid_params', 'unknown artifact name');
    }
    return StudioRequest('GET', [..._project(p), 'artifacts', name]);
  }),
  StudioCall('studio.service.health', PocketStudioPermissions.read, 'Service health (scrubbed)',
      _p(project: false), const {}, (p) => const StudioRequest('GET', ['health'])),
  StudioCall('studio.service.upgrade.status', PocketStudioPermissions.read, 'Studio self-upgrade status',
      _p(project: false), const {}, (p) => const StudioRequest('GET', ['api', 'studio', 'upgrade'])),
  // Never auto-applies: the guest asks for the check, shows the result and applies only after a confirmation.
  StudioCall('studio.service.upgrade.check', PocketStudioPermissions.write, 'Check GitHub for a newer SDK release (never applies it)',
      _p(project: false), const {}, (p) => const StudioRequest('POST', ['api', 'studio', 'upgrade', 'check'],
          write: true, body: <String, Object?>{'autoApply': false})),
  StudioCall('studio.service.upgrade.apply', PocketStudioPermissions.deploy, 'Apply the available SDK upgrade (409 in a source checkout)',
      _p(project: false), const {}, (p) => const StudioRequest('POST', ['api', 'studio', 'upgrade', 'apply'],
          write: true, body: <String, Object?>{})),
];

final Map<String, StudioCall> studioCallsByName = <String, StudioCall>{
  for (final call in studioCalls) call.name: call,
};

/// Every capability name of the frozen table.
final Set<String> pocketStudioCapabilityNames = studioCallsByName.keys.toSet();
