import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:pocket_services/pocket_services.dart';

import 'sync_crypto.dart';

part 'sync_worker.dart';

const String pocketSyncPluginId = 'dart.pocket_sync';
const String pocketSyncNetworkPermission = 'network';

const String pocketSyncServerStartCapability = 'sync.server.start';
const String pocketSyncServerStopCapability = 'sync.server.stop';
const String pocketSyncServerStatusCapability = 'sync.server.status';
const String pocketSyncServerIngestCapability = 'sync.server.ingestLocalOps';
const String pocketSyncServerEventsCapability = 'sync.server.events';
const String pocketSyncClientRequestCapability = 'sync.client.request';

const int _hardMaxBridgeBytes = 256 * 1024;
const int _maxBlobChunkBytes = 128 * 1024;
const int _maxOpsPerPage = 128;
const int _maxStreamOpsBatch = 48;

/// Optional embedded HTTP/WebSocket sync server and cross-subnet outbound client
/// plugin for PocketJS applications.
///
/// Set [allowBackgroundServer] to `true` (default) on macOS / TV / MenuBar / Hub
/// hosts so the embedded sync server remains online while the window is unfocused.
final class PocketSyncPlugin extends PocketPlugin {
  PocketSyncPlugin({
    this.allowBackgroundServer = true,
    this.storageDirectoryPath,
    this.requestTimeout = const Duration(seconds: 12),
  });

  final bool allowBackgroundServer;
  final String? storageDirectoryPath;
  final Duration requestTimeout;

  final Map<int, Completer<Object?>> _pending = <int, Completer<Object?>>{};
  final StreamController<Map<String, Object?>> _serverEvents =
      StreamController<Map<String, Object?>>.broadcast();

  _SyncWorkerHandle? _worker;
  Future<void>? _disposeFuture;
  int _nextRequestId = 1;
  bool _disposed = false;

  @override
  bool get backgroundSafe => allowBackgroundServer;

  static const PocketPluginDescriptor pluginDescriptor = PocketPluginDescriptor(
    id: pocketSyncPluginId,
    version: '0.1.0',
    description:
        'Embedded HTTP/WebSocket CRDT sync server and multi-endpoint cross-subnet client',
    permissions: <String>{pocketSyncNetworkPermission},
    limits: PocketPluginLimits(
      maxConcurrentRequests: 8,
      maxActiveStreams: 4,
      maxResponseBytes: _hardMaxBridgeBytes,
      maxStreamEventBytes: _hardMaxBridgeBytes,
    ),
    capabilities: <String, PocketPluginCapability>{
      pocketSyncServerStartCapability: PocketPluginCapability(
        name: pocketSyncServerStartCapability,
        kind: PocketCapabilityKind.request,
        description: 'Start or reconfigure embedded sync server',
      ),
      pocketSyncServerStopCapability: PocketPluginCapability(
        name: pocketSyncServerStopCapability,
        kind: PocketCapabilityKind.request,
        description: 'Stop embedded sync server',
      ),
      pocketSyncServerStatusCapability: PocketPluginCapability(
        name: pocketSyncServerStatusCapability,
        kind: PocketCapabilityKind.request,
        description: 'Query embedded sync server status and LAN/Overlay URLs',
      ),
      pocketSyncServerIngestCapability: PocketPluginCapability(
        name: pocketSyncServerIngestCapability,
        kind: PocketCapabilityKind.request,
        description: 'Ingest locally authored CRDT operations into embedded server',
      ),
      pocketSyncServerEventsCapability: PocketPluginCapability(
        name: pocketSyncServerEventsCapability,
        kind: PocketCapabilityKind.stream,
        description: 'Stream remotely ingested CRDT operations to guest runtime',
      ),
      pocketSyncClientRequestCapability: PocketPluginCapability(
        name: pocketSyncClientRequestCapability,
        kind: PocketCapabilityKind.request,
        description:
            'Execute bounded sync protocol request to LAN, Tailscale/WireGuard Overlay, or HTTPS WAN endpoint',
      ),
    },
  );

  @override
  PocketPluginDescriptor get descriptor => pluginDescriptor;

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(
      pocketSyncServerStartCapability,
      (params) => _callWorker('server.start', params),
    );
    context.registerRequest(
      pocketSyncServerStopCapability,
      (params) => _callWorker('server.stop', params),
    );
    context.registerRequest(
      pocketSyncServerStatusCapability,
      (params) => _callWorker('server.status', params),
    );
    context.registerRequest(
      pocketSyncServerIngestCapability,
      (params) => _callWorker('server.ingest', params),
    );
    context.registerRequest(
      pocketSyncClientRequestCapability,
      (params) => _callWorker('client.request', params),
    );
    context.registerStream(
      pocketSyncServerEventsCapability,
      (_) => _serverEvents.stream,
    );
  }

  @override
  Future<void> deactivate(PocketPluginContext context) async {
    if (!allowBackgroundServer) {
      await _stopWorker();
    }
  }

  @override
  Future<void> dispose() => _disposeFuture ??= _disposeImpl();

  Future<void> _disposeImpl() async {
    if (_disposed) return;
    _disposed = true;
    await _stopWorker();
    await _serverEvents.close();
  }

  Future<Object?> _callWorker(String action, Map<String, dynamic> params) async {
    if (_disposed) {
      throw const PocketCapabilityException(
        'plugin_disposed',
        'PocketSyncPlugin is disposed',
      );
    }
    final worker = await _ensureWorker();
    final id = _nextRequestId++;
    final completer = Completer<Object?>();
    _pending[id] = completer;

    final commandPort = worker.commandPort;
    if (commandPort == null) {
      _pending.remove(id);
      throw const PocketCapabilityException(
        'worker_unavailable',
        'PocketSync IO worker is not ready',
      );
    }

    commandPort.send(<String, Object?>{
      'type': 'rpc',
      'id': id,
      'action': action,
      'params': Map<String, Object?>.from(params),
    });

    return completer.future.timeout(
      requestTimeout,
      onTimeout: () {
        _pending.remove(id);
        throw const PocketCapabilityException(
          'request_timeout',
          'PocketSync worker call timed out',
        );
      },
    );
  }

  Future<_SyncWorkerHandle> _ensureWorker() async {
    final existing = _worker;
    if (existing != null) {
      await existing.ready.future;
      return existing;
    }
    final handle = _SyncWorkerHandle(
      events: ReceivePort(),
      errors: ReceivePort(),
      exits: ReceivePort(),
    );
    _worker = handle;
    handle.events.listen((msg) => _onWorkerEvent(handle, msg));
    handle.errors.listen((err) => _onWorkerFailure(handle, '$err'));
    handle.exits.listen((_) => _onWorkerFailure(handle, 'worker exited'));

    try {
      handle.isolate = await Isolate.spawn<_SyncWorkerInit>(
        _syncWorkerEntry,
        _SyncWorkerInit(
          eventsPort: handle.events.sendPort,
          storageDir: storageDirectoryPath,
        ),
        onError: handle.errors.sendPort,
        onExit: handle.exits.sendPort,
        debugName: 'PocketSync IO Worker',
      );
      await handle.ready.future;
      return handle;
    } on Object catch (err) {
      _onWorkerFailure(handle, '$err');
      rethrow;
    }
  }

  void _onWorkerEvent(_SyncWorkerHandle handle, Object? message) {
    if (!identical(_worker, handle) || message is! Map) return;
    final kind = message['type'];
    if (kind == 'ready') {
      final port = message['commandPort'];
      if (port is SendPort) {
        handle.commandPort = port;
        if (!handle.ready.isCompleted) handle.ready.complete();
      }
      return;
    }
    if (kind == 'stream_event') {
      final payload = message['payload'];
      if (payload is Map && !_serverEvents.isClosed) {
        _serverEvents.add(Map<String, Object?>.from(payload));
      }
      return;
    }
    if (kind == 'rpc_ok' || kind == 'rpc_err') {
      final id = message['id'];
      if (id is! int) return;
      final completer = _pending.remove(id);
      if (completer == null || completer.isCompleted) return;
      if (kind == 'rpc_ok') {
        completer.complete(message['result']);
      } else {
        completer.completeError(
          PocketCapabilityException(
            (message['code'] as String?) ?? 'sync_error',
            (message['message'] as String?) ?? 'PocketSync worker error',
          ),
        );
      }
    }
  }

  void _onWorkerFailure(_SyncWorkerHandle handle, String reason) {
    if (!identical(_worker, handle)) return;
    _worker = null;
    if (!handle.ready.isCompleted) {
      handle.ready.completeError(
        PocketCapabilityException('worker_failed', reason),
      );
    }
    for (final c in _pending.values.toList(growable: false)) {
      if (!c.isCompleted) {
        c.completeError(PocketCapabilityException('worker_failed', reason));
      }
    }
    _pending.clear();
    handle.isolate?.kill(priority: Isolate.immediate);
    handle.closePorts();
  }

  Future<void> _stopWorker() async {
    final handle = _worker;
    if (handle == null) return;
    _worker = null;
    handle.commandPort?.send(const <String, Object?>{'type': 'shutdown'});
    for (final c in _pending.values.toList(growable: false)) {
      if (!c.isCompleted) {
        c.completeError(
          const PocketCapabilityException('cancelled', 'PocketSync stopped'),
        );
      }
    }
    _pending.clear();
    await Future<void>.delayed(const Duration(milliseconds: 50));
    handle.isolate?.kill(priority: Isolate.immediate);
    handle.closePorts();
  }
}

final class _SyncWorkerHandle {
  _SyncWorkerHandle({
    required this.events,
    required this.errors,
    required this.exits,
  });

  final ReceivePort events;
  final ReceivePort errors;
  final ReceivePort exits;
  final Completer<void> ready = Completer<void>();
  Isolate? isolate;
  SendPort? commandPort;

  void closePorts() {
    events.close();
    errors.close();
    exits.close();
  }
}

final class _SyncWorkerInit {
  const _SyncWorkerInit({required this.eventsPort, this.storageDir});
  final SendPort eventsPort;
  final String? storageDir;
}
