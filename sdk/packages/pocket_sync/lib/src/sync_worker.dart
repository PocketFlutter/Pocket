part of 'sync_plugin.dart';

void _syncWorkerEntry(_SyncWorkerInit init) {
  final commandReceive = ReceivePort();
  final runtime = _SyncWorkerRuntime(
    eventsPort: init.eventsPort,
    storageDir: init.storageDir,
  );

  commandReceive.listen((raw) async {
    if (raw is! Map) return;
    final type = raw['type'];
    if (type == 'shutdown') {
      await runtime.dispose();
      commandReceive.close();
      Isolate.exit();
    }
    if (type == 'rpc') {
      final id = raw['id'] as int;
      final action = raw['action'] as String? ?? '';
      final params = (raw['params'] as Map?)?.cast<String, Object?>() ??
          const <String, Object?>{};
      try {
        final result = await runtime.dispatch(action, params);
        init.eventsPort.send(<String, Object?>{
          'type': 'rpc_ok',
          'id': id,
          'result': result,
        });
      } on PocketCapabilityException catch (err) {
        init.eventsPort.send(<String, Object?>{
          'type': 'rpc_err',
          'id': id,
          'code': err.code,
          'message': err.message,
        });
      } on Object catch (err) {
        init.eventsPort.send(<String, Object?>{
          'type': 'rpc_err',
          'id': id,
          'code': 'sync_worker_error',
          'message': '$err',
        });
      }
    }
  });

  init.eventsPort.send(<String, Object?>{
    'type': 'ready',
    'commandPort': commandReceive.sendPort,
  });
}

final class _SyncWorkerRuntime {
  _SyncWorkerRuntime({required this.eventsPort, this.storageDir});

  final SendPort eventsPort;
  final String? storageDir;
  final HttpClient _httpClient = HttpClient()
    ..connectionTimeout = const Duration(seconds: 6);

  HttpServer? _server;
  final Set<WebSocket> _sockets = <WebSocket>{};
  final Set<String> _seenOpIds = <String>{};
  final List<Map<String, Object?>> _arrivalLog = <Map<String, Object?>>[];
  static const int _maxPartialBlobs = 8;
  static const int _maxClockDriftMs = 24 * 60 * 60 * 1000;
  final Map<String, Uint8List> _blobs = <String, Uint8List>{};
  final Map<String, _PartialBlob> _partialBlobs = <String, _PartialBlob>{};
  Set<String> _blockedAuthorRoles = <String>{'VIEWER'};
  final Map<String, int> _seenNonces = <String, int>{};
  final Map<String, _RateBucket> _authFailures = <String, _RateBucket>{};

  String _namespace = 'default';
  String _roomSecret = '';
  String _nodeId = 'host_node';
  String _deviceName = 'Pocket Host';
  String _deviceKind = 'macos';
  String _storageDurability = 'persistent';
  String _powerPolicy = 'alwaysOn';
  String _serverInstanceId =
      'inst_host_${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}';
  String _latestHlc = '1970-01-01T00:00:00.000Z-0000-host_node';
  int _port = 8795;
  int _nextSeq = 1;
  bool _degradedToClientOnly = false;
  String? _degradedReason;

  Future<Object?> dispatch(String action, Map<String, Object?> params) async {
    switch (action) {
      case 'server.start':
        return _startServer(params);
      case 'server.stop':
        await _closeServer();
        return _buildStatus();
      case 'server.status':
        return _buildStatus();
      case 'server.ingest':
        return _ingestLocalOps(params);
      case 'client.request':
        return _executeOutboundRequest(params);
      default:
        throw PocketCapabilityException(
          'unknown_action',
          'Unsupported sync worker action: $action',
        );
    }
  }

  Future<Map<String, Object?>> _startServer(Map<String, Object?> params) async {
    _namespace = (params['namespace'] as String?)?.trim().isNotEmpty == true
        ? (params['namespace'] as String).trim()
        : _namespace;
    _roomSecret = (params['roomSecret'] as String?) ?? _roomSecret;
    _nodeId = (params['nodeId'] as String?) ?? _nodeId;
    _deviceName = (params['deviceName'] as String?) ?? _deviceName;
    _deviceKind = (params['deviceKind'] as String?) ?? _deviceKind;
    _storageDurability =
        (params['storageDurability'] as String?) ?? _storageDurability;
    _powerPolicy = (params['powerPolicy'] as String?) ?? _powerPolicy;
    final rawBlocked = params['blockedRoles'];
    if (rawBlocked is List) {
      _blockedAuthorRoles = rawBlocked.whereType<String>().toSet();
    }
    final requestedPort = (params['port'] as num?)?.toInt() ?? _port;
    final bindHost = (params['bindHost'] as String?) ?? '0.0.0.0';

    if (_server != null && _server!.port == requestedPort) {
      return _buildStatus();
    }
    await _closeServer();

    try {
      final bound = await HttpServer.bind(bindHost, requestedPort, shared: true);
      _server = bound;
      _port = bound.port;
      _degradedToClientOnly = false;
      _degradedReason = null;
      bound.listen(
        _handleHttpRequest,
        onError: (_) {},
        cancelOnError: false,
      );
      return await _buildStatus();
    } on SocketException catch (err) {
      if (_powerPolicy == 'adaptiveRelay') {
        _degradedToClientOnly = true;
        _degradedReason = err.message;
        return _buildStatus();
      }
      throw PocketCapabilityException(
        'bind_failed',
        'Failed to bind sync server on $bindHost:$requestedPort: ${err.message}',
      );
    }
  }

  Future<Map<String, Object?>> _buildStatus() async {
    final running = _server != null;
    final lanUrls = <String>[];
    final overlayUrls = <String>[];
    final allUrls = <String>[];

    if (running) {
      try {
        final interfaces = await NetworkInterface.list(
          type: InternetAddressType.IPv4,
          includeLoopback: false,
        );
        for (final iface in interfaces) {
          final lowerName = iface.name.toLowerCase();
          for (final addr in iface.addresses) {
            final host = addr.address;
            final url = 'http://$host:$_port';
            if (allUrls.contains(url)) continue;
            final netKind = _classifyHost(host, interfaceName: lowerName);
            if (netKind == 'overlay') {
              overlayUrls.add(url);
              allUrls.add(url);
            } else if (netKind == 'lan') {
              lanUrls.add(url);
              allUrls.add(url);
            }
          }
        }
      } on Object {
        // Ignore NetworkInterface enumeration restrictions on sandboxed targets.
      }
    }

    var blobBytes = 0;
    for (final b in _blobs.values) {
      blobBytes += b.lengthInBytes;
    }

    return <String, Object?>{
      'running': running,
      'degradedToClientOnly': _degradedToClientOnly,
      'mode': running
          ? 'listening'
          : (_degradedToClientOnly ? 'adaptiveRelayClientOnly' : 'stopped'),
      'port': _port,
      'serverInstanceId': _serverInstanceId,
      'nodeId': _nodeId,
      'deviceName': _deviceName,
      'deviceKind': _deviceKind,
      'storageDurability': _storageDurability,
      'powerPolicy': _powerPolicy,
      'listenUrls': allUrls,
      'lanUrls': lanUrls,
      'overlayUrls': overlayUrls,
      'connectedPeers': _sockets.length,
      'latestSeq': _nextSeq - 1,
      'storedBlobCount': _blobs.length,
      'storedBlobBytes': blobBytes,
      if (_degradedReason != null) 'reason': _degradedReason,
    };
  }

  Map<String, Object?> _ingestLocalOps(Map<String, Object?> params) {
    final rawOps = params['ops'];
    if (rawOps is! List) {
      return const <String, Object?>{'acceptedCount': 0};
    }
    final accepted = _appendOps(rawOps);
    if (accepted.isNotEmpty) {
      _broadcastHead();
    }
    return <String, Object?>{'acceptedCount': accepted.length};
  }

  List<Map<String, Object?>> _appendOps(List<Object?> rawOps) {
    final accepted = <Map<String, Object?>>[];
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    for (final item in rawOps) {
      if (item is! Map) continue;
      final opId = item['opId'];
      final ns = item['namespace'];
      final collection = item['collection'];
      final entityId = item['entityId'];
      final hlc = item['hlc'];
      final authorRole = item['authorRole'];
      if (opId is! String ||
          opId.isEmpty ||
          ns != _namespace ||
          collection is! String ||
          collection.isEmpty ||
          entityId is! String ||
          entityId.isEmpty ||
          hlc is! String) {
        continue;
      }
      if (authorRole is String && _blockedAuthorRoles.contains(authorRole)) {
        continue;
      }
      final zIdx = hlc.indexOf('Z-');
      if (zIdx <= 0) continue;
      final parsedIso = DateTime.tryParse(hlc.substring(0, zIdx + 1));
      if (parsedIso == null ||
          parsedIso.millisecondsSinceEpoch - nowMs > _maxClockDriftMs) {
        continue;
      }
      if (_seenOpIds.contains(opId)) continue;
      _seenOpIds.add(opId);
      final sequenced = <String, Object?>{
        ...item.cast<String, Object?>(),
        'serverSeq': _nextSeq++,
      };
      if (hlc.compareTo(_latestHlc) > 0) {
        _latestHlc = hlc;
      }
      _arrivalLog.add(sequenced);
      accepted.add(sequenced);
    }
    return accepted;
  }

  Future<void> _handleHttpRequest(HttpRequest req) async {
    final peerIp = req.connectionInfo?.remoteAddress.address ?? 'peer';
    final now = DateTime.now().millisecondsSinceEpoch;
    final bucket = _authFailures[peerIp];
    if (bucket != null && bucket.resetAtMs > now && bucket.count >= 12) {
      await _writeJson(req.response, 429, const <String, Object?>{
        'error': 'rate_limited',
      });
      return;
    }

    final path = req.uri.path;
    if (path == '/v1/pocket-sync/live' &&
        WebSocketTransformer.isUpgradeRequest(req)) {
      final ns = req.uri.queryParameters['namespace'] ?? '';
      final auth =
          req.headers.value('x-pocket-sync-auth') ??
          req.uri.queryParameters['auth'];
      if (ns != _namespace ||
          !_verifyAuth(
            headerValue: auth,
            method: 'GET',
            path: path,
            bodySha256: sha256HexFromString(''),
            nowMs: now,
          )) {
        _recordAuthFailure(peerIp, now);
        await _writeJson(req.response, 401, const <String, Object?>{
          'error': 'unauthorized',
        });
        return;
      }
      final socket = await WebSocketTransformer.upgrade(req);
      _sockets.add(socket);
      socket.done.whenComplete(() => _sockets.remove(socket));
      socket.add(
        jsonEncode(<String, Object?>{
          'type': 'head',
          'namespace': _namespace,
          'serverInstanceId': _serverInstanceId,
          'latestSeq': _nextSeq - 1,
          'latestHlc': _latestHlc,
        }),
      );
      return;
    }

    final bodyBytes = await _readBoundedRequestBytes(req, 196 * 1024);
    if (bodyBytes == null) {
      await _writeJson(req.response, 413, const <String, Object?>{
        'error': 'payload_too_large',
      });
      return;
    }

    Map<String, Object?>? jsonPayload;
    final isBlobRoute = path.startsWith('/v1/pocket-sync/blobs/');
    if (!isBlobRoute && bodyBytes.isNotEmpty) {
      try {
        final decoded = jsonDecode(utf8.decode(bodyBytes));
        if (decoded is Map) {
          jsonPayload = decoded.cast<String, Object?>();
        }
      } on Object {
        await _writeJson(req.response, 400, const <String, Object?>{
          'error': 'invalid_json',
        });
        return;
      }
    }

    final ns =
        req.uri.queryParameters['namespace'] ??
        (jsonPayload?['namespace'] as String? ?? '');
    final authHeader = req.headers.value('x-pocket-sync-auth');
    final bodySha = bodyBytes.isEmpty
        ? sha256HexFromString('')
        : (isBlobRoute
              ? sha256HexFromBytes(bodyBytes)
              : sha256HexFromString(utf8.decode(bodyBytes)));

    if (ns != _namespace ||
        !_verifyAuth(
          headerValue: authHeader,
          method: req.method,
          path: path,
          bodySha256: bodySha,
          nowMs: now,
        )) {
      _recordAuthFailure(peerIp, now);
      await _writeJson(req.response, 401, const <String, Object?>{
        'error': 'unauthorized',
      });
      return;
    }

    if (req.method == 'GET' && path == '/v1/pocket-sync/info') {
      await _writeJson(req.response, 200, <String, Object?>{
        'protocolVersion': 1,
        'serverInstanceId': _serverInstanceId,
        'nodeId': _nodeId,
        'deviceName': _deviceName,
        'deviceKind': _deviceKind,
        'storageDurability': _storageDurability,
        'powerPolicy': _powerPolicy,
        'namespaces': <String>[_namespace],
        'latestSeq': _nextSeq - 1,
        'latestHlc': _latestHlc,
      });
      return;
    }

    if (req.method == 'POST' && path == '/v1/pocket-sync/ops/exchange') {
      final expectedInst = jsonPayload?['expectedServerInstanceId'] as String?;
      final resetCursor =
          expectedInst != null &&
          expectedInst.isNotEmpty &&
          expectedInst != _serverInstanceId;
      final sinceSeq = resetCursor
          ? 0
          : math.max(0, (jsonPayload?['sinceSeq'] as num?)?.toInt() ?? 0);
      final reqLimit = math.min(
        _maxOpsPerPage,
        math.max(1, (jsonPayload?['limit'] as num?)?.toInt() ?? _maxOpsPerPage),
      );

      final missing = <Map<String, Object?>>[];
      var hasMore = false;
      for (final entry in _arrivalLog) {
        final seq = entry['serverSeq'] as int;
        if (seq > sinceSeq) {
          if (missing.length >= reqLimit) {
            hasMore = true;
            break;
          }
          missing.add(entry);
        }
      }

      final incomingRaw = jsonPayload?['ops'];
      final accepted = incomingRaw is List
          ? _appendOps(incomingRaw)
          : const <Map<String, Object?>>[];
      if (accepted.isNotEmpty) {
        _emitRemoteOpsToGuest(accepted);
        _broadcastHead();
      }

      final lastMissingSeq = missing.isNotEmpty
          ? (missing.last['serverSeq'] as int)
          : sinceSeq;
      final latestSeq = hasMore ? lastMissingSeq : (_nextSeq - 1);

      await _writeJson(req.response, 200, <String, Object?>{
        'namespace': _namespace,
        'serverInstanceId': _serverInstanceId,
        'storageDurability': _storageDurability,
        'resetCursor': resetCursor,
        'hasMore': hasMore,
        'acceptedCount': accepted.length,
        'serverOps': missing,
        'latestSeq': latestSeq,
        'latestHlc': _latestHlc,
      });
      return;
    }

    if (isBlobRoute) {
      final sha = path.substring('/v1/pocket-sync/blobs/'.length).toLowerCase();
      if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(sha)) {
        await _writeJson(req.response, 400, const <String, Object?>{
          'error': 'invalid_blob_sha256',
        });
        return;
      }
      if (req.method == 'PUT') {
        final offset =
            int.tryParse(req.uri.queryParameters['offset'] ?? '0') ?? 0;
        final total =
            int.tryParse(
              req.uri.queryParameters['total'] ?? '${bodyBytes.length}',
            ) ??
            bodyBytes.length;
        if (offset < 0 ||
            total <= 0 ||
            total > 32 * 1024 * 1024 ||
            offset + bodyBytes.length > total) {
          await _writeJson(req.response, 400, const <String, Object?>{
            'error': 'invalid_blob_bounds',
          });
          return;
        }
        var partial = _partialBlobs[sha];
        if (partial == null || offset == 0 || partial.total != total) {
          if (!_partialBlobs.containsKey(sha) &&
              _partialBlobs.length >= _maxPartialBlobs) {
            _partialBlobs.remove(_partialBlobs.keys.first);
          }
          partial = _PartialBlob(total);
          _partialBlobs[sha] = partial;
        }
        partial.buffer.setRange(offset, offset + bodyBytes.length, bodyBytes);
        partial.received = math.max(partial.received, offset + bodyBytes.length);

        if (partial.received < total) {
          await _writeJson(req.response, 202, <String, Object?>{
            'complete': false,
            'receivedBytes': partial.received,
            'totalBytes': total,
          });
          return;
        }

        _partialBlobs.remove(sha);
        final actualSha = sha256HexFromBytes(partial.buffer);
        if (actualSha != sha) {
          await _writeJson(req.response, 422, const <String, Object?>{
            'error': 'blob_sha256_mismatch',
          });
          return;
        }
        _blobs[sha] = partial.buffer;
        if (storageDir != null) {
          try {
            final dir = Directory('$storageDir/pocket_sync_blobs');
            await dir.create(recursive: true);
            await File('${dir.path}/$sha.bin').writeAsBytes(partial.buffer);
          } on Object {
            // Retain in-memory blob if filesystem directory is restricted.
          }
        }
        final permanentSafe = _storageDurability == 'persistent';
        final sig = signArchiveReceiptHmac(
          roomSecret: _roomSecret,
          namespace: _namespace,
          blobSha256: sha,
          byteLength: total,
          serverInstanceId: _serverInstanceId,
          serverNodeId: _nodeId,
          storageDurability: _storageDurability,
          permanentArchiveSafe: permanentSafe,
          issuedAtMs: now,
        );
        await _writeJson(req.response, 201, <String, Object?>{
          'complete': true,
          'receipt': <String, Object?>{
            'blobSha256': sha,
            'byteLength': total,
            'serverInstanceId': _serverInstanceId,
            'serverNodeId': _nodeId,
            'storageDurability': _storageDurability,
            'issuedAtMs': now,
            'permanentArchiveSafe': permanentSafe,
            'signature': sig,
          },
        });
        return;
      }

      if (req.method == 'GET') {
        var stored = _blobs[sha];
        if (stored == null && storageDir != null) {
          final diskFile = File('$storageDir/pocket_sync_blobs/$sha.bin');
          if (await diskFile.exists()) {
            stored = await diskFile.readAsBytes();
            _blobs[sha] = stored;
          }
        }
        if (stored == null) {
          await _writeJson(req.response, 404, const <String, Object?>{
            'error': 'blob_not_found',
          });
          return;
        }
        final offset = math.max(
          0,
          int.tryParse(req.uri.queryParameters['offset'] ?? '0') ?? 0,
        );
        final length = math.min(
          _maxBlobChunkBytes,
          math.max(
            1,
            int.tryParse(
                  req.uri.queryParameters['length'] ?? '$_maxBlobChunkBytes',
                ) ??
                _maxBlobChunkBytes,
          ),
        );
        final end = math.min(stored.lengthInBytes, offset + length);
        final slice = offset < end
            ? Uint8List.sublistView(stored, offset, end)
            : Uint8List(0);
        req.response.statusCode =
            slice.lengthInBytes < stored.lengthInBytes ? 206 : 200;
        req.response.headers.contentType = ContentType.binary;
        req.response.headers.set('x-blob-total-length', '${stored.lengthInBytes}');
        req.response.add(slice);
        await req.response.close();
        return;
      }
    }

    await _writeJson(req.response, 404, const <String, Object?>{
      'error': 'not_found',
    });
  }

  Future<Map<String, Object?>> _executeOutboundRequest(
    Map<String, Object?> params,
  ) async {
    final rawUrl = params['url'];
    if (rawUrl is! String || rawUrl.isEmpty || rawUrl.length > 4096) {
      throw const PocketCapabilityException('invalid_url', 'Invalid sync URL');
    }
    final uri = Uri.tryParse(rawUrl);
    if (uri == null ||
        (uri.scheme != 'http' && uri.scheme != 'https') ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        !uri.path.contains('/v1/pocket-sync/')) {
      throw const PocketCapabilityException(
        'invalid_url',
        'Outbound sync URL must target a valid /v1/pocket-sync/ route',
      );
    }

    final allowInsecureWan = params['allowInsecureWan'] == true;
    final netKind = _classifyHost(uri.host);
    if (netKind == 'wan' && uri.scheme == 'http' && !allowInsecureWan) {
      throw const PocketCapabilityException(
        'insecure_wan_denied',
        'Public WAN sync endpoints must use https://',
      );
    }

    final method = ((params['method'] as String?) ?? 'GET').toUpperCase();
    final timeoutMs = math.min(
      15000,
      math.max(500, (params['timeoutMs'] as num?)?.toInt() ?? 8000),
    );
    final sw = Stopwatch()..start();

    final req = await _httpClient
        .openUrl(method, uri)
        .timeout(Duration(milliseconds: timeoutMs));
    final rawHeaders = params['headers'];
    if (rawHeaders is Map) {
      for (final entry in rawHeaders.entries) {
        if (entry.key is String && entry.value != null) {
          req.headers.set(entry.key as String, '${entry.value}');
        }
      }
    }

    final binaryBody = params['binaryBody'];
    final jsonBody = params['jsonBody'];
    if (binaryBody is Uint8List) {
      if (binaryBody.lengthInBytes > _maxBlobChunkBytes) {
        throw const PocketCapabilityException(
          'request_too_large',
          'Binary blob chunk exceeds 128 KiB limit',
        );
      }
      req.headers.contentType = ContentType.binary;
      req.contentLength = binaryBody.lengthInBytes;
      req.add(binaryBody);
    } else if (jsonBody != null) {
      final encoded = utf8.encode(jsonEncode(jsonBody));
      if (encoded.length > 192 * 1024) {
        throw const PocketCapabilityException(
          'request_too_large',
          'Sync JSON request exceeds 192 KiB limit',
        );
      }
      req.headers.contentType = ContentType.json;
      req.contentLength = encoded.length;
      req.add(encoded);
    }

    final res = await req.close().timeout(Duration(milliseconds: timeoutMs));
    final bytes = await _readBoundedResponseBytes(res, 196 * 1024);
    sw.stop();

    final outHeaders = <String, String>{};
    res.headers.forEach((name, values) {
      if (values.isNotEmpty) {
        outHeaders[name.toLowerCase()] = values.first;
      }
    });

    final contentType = outHeaders['content-type'] ?? '';
    if (contentType.contains('application/octet-stream')) {
      return <String, Object?>{
        'statusCode': res.statusCode,
        'headers': outHeaders,
        'binaryBody': bytes,
        'rttMs': math.max(1, sw.elapsedMilliseconds),
      };
    }

    Object? parsedJson;
    if (bytes.isNotEmpty) {
      final text = utf8.decode(bytes, allowMalformed: true);
      try {
        parsedJson = jsonDecode(text);
      } on Object {
        parsedJson = <String, Object?>{'raw': text};
      }
    }

    return <String, Object?>{
      'statusCode': res.statusCode,
      'headers': outHeaders,
      'jsonBody': parsedJson,
      'rttMs': math.max(1, sw.elapsedMilliseconds),
    };
  }

  void _emitRemoteOpsToGuest(List<Map<String, Object?>> accepted) {
    for (var i = 0; i < accepted.length; i += _maxStreamOpsBatch) {
      final batch = accepted.sublist(
        i,
        math.min(accepted.length, i + _maxStreamOpsBatch),
      );
      eventsPort.send(<String, Object?>{
        'type': 'stream_event',
        'payload': <String, Object?>{
          'kind': 'ops_ingested',
          'ops': batch,
          'latestSeq': _nextSeq - 1,
        },
      });
    }
  }

  void _broadcastHead() {
    if (_sockets.isEmpty) return;
    final msg = jsonEncode(<String, Object?>{
      'type': 'head',
      'namespace': _namespace,
      'serverInstanceId': _serverInstanceId,
      'latestSeq': _nextSeq - 1,
      'latestHlc': _latestHlc,
    });
    for (final ws in _sockets.toList(growable: false)) {
      try {
        ws.add(msg);
      } on Object {
        _sockets.remove(ws);
      }
    }
  }

  bool _verifyAuth({
    required String? headerValue,
    required String method,
    required String path,
    required String bodySha256,
    required int nowMs,
  }) {
    if (headerValue == null || !headerValue.startsWith('v1:')) return false;
    final parts = headerValue.split(':');
    if (parts.length != 4) return false;
    final ts = int.tryParse(parts[1]);
    final nonce = parts[2];
    final mac = parts[3];
    if (ts == null || nonce.isEmpty || nonce.length > 128) return false;
    if ((nowMs - ts).abs() > 5 * 60 * 1000) return false;

    final replayKey = '$_namespace:$nonce';
    final seenAt = _seenNonces[replayKey];
    if (seenAt != null && (nowMs - seenAt) <= 5 * 60 * 1000) return false;

    final derivedKey = deriveRoomAuthKeyHex(_roomSecret, _namespace);
    final canonical =
        'v1|$_namespace|${method.toUpperCase()}|$path|$ts|$nonce|$bodySha256';
    final expectedMac = bytesToHex(
      hmacSha256Bytes(utf8.encode(derivedKey), utf8.encode(canonical)),
    );
    if (!timingSafeEqualString(mac, expectedMac)) return false;

    if (_seenNonces.length >= 2048) {
      _seenNonces.remove(_seenNonces.keys.first);
    }
    _seenNonces[replayKey] = nowMs;
    return true;
  }

  void _recordAuthFailure(String ip, int nowMs) {
    final bucket = _authFailures[ip];
    if (bucket == null || bucket.resetAtMs <= nowMs) {
      _authFailures[ip] = _RateBucket(count: 1, resetAtMs: nowMs + 60000);
    } else {
      bucket.count += 1;
    }
  }

  static String _classifyHost(String rawHost, {String interfaceName = ''}) {
    final clean = rawHost.replaceAll('[', '').replaceAll(']', '').toLowerCase();
    if (interfaceName.contains('tailscale') ||
        interfaceName.startsWith('utun') ||
        interfaceName.startsWith('wg') ||
        interfaceName.startsWith('zt')) {
      final octets = _parseIpv4(clean);
      if (octets != null && octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127) {
        return 'overlay';
      }
      if (interfaceName.startsWith('wg') || interfaceName.startsWith('zt') || interfaceName.contains('tailscale')) {
        return 'overlay';
      }
    }
    if (clean == 'localhost' ||
        clean.endsWith('.local') ||
        clean.endsWith('.lan') ||
        clean.endsWith('.home.arpa') ||
        clean == '::1' ||
        clean.startsWith('fe80:')) {
      return 'lan';
    }
    if (clean.endsWith('.ts.net') ||
        clean.endsWith('.zt') ||
        clean.startsWith('fd7a:115c:a1e0:')) {
      return 'overlay';
    }
    final v4 = _parseIpv4(clean);
    if (v4 != null) {
      final a = v4[0];
      final b = v4[1];
      if (a == 127 ||
          a == 10 ||
          (a == 192 && b == 168) ||
          (a == 172 && b >= 16 && b <= 31)) {
        return 'lan';
      }
      if ((a == 100 && b >= 64 && b <= 127) ||
          (a == 198 && (b == 18 || b == 19))) {
        return 'overlay';
      }
    }
    return 'wan';
  }

  static List<int>? _parseIpv4(String host) {
    final parts = host.split('.');
    if (parts.length != 4) return null;
    final out = <int>[];
    for (final p in parts) {
      final n = int.tryParse(p);
      if (n == null || n < 0 || n > 255) return null;
      out.add(n);
    }
    return out;
  }

  static Future<Uint8List?> _readBoundedRequestBytes(
    HttpRequest req,
    int maxBytes,
  ) async {
    if (req.contentLength > maxBytes) return null;
    final builder = BytesBuilder(copy: false);
    var total = 0;
    await for (final chunk in req) {
      total += chunk.length;
      if (total > maxBytes) return null;
      builder.add(chunk);
    }
    return builder.takeBytes();
  }

  static Future<Uint8List> _readBoundedResponseBytes(
    HttpClientResponse res,
    int maxBytes,
  ) async {
    if (res.contentLength > maxBytes) {
      throw const PocketCapabilityException(
        'response_too_large',
        'Sync response exceeds bounded byte quota',
      );
    }
    final builder = BytesBuilder(copy: false);
    var total = 0;
    await for (final chunk in res) {
      total += chunk.length;
      if (total > maxBytes) {
        throw const PocketCapabilityException(
          'response_too_large',
          'Sync response exceeds bounded byte quota',
        );
      }
      builder.add(chunk);
    }
    return builder.takeBytes();
  }

  static Future<void> _writeJson(
    HttpResponse res,
    int statusCode,
    Map<String, Object?> body,
  ) async {
    res.statusCode = statusCode;
    res.headers.contentType = ContentType.json;
    res.add(utf8.encode(jsonEncode(body)));
    await res.close();
  }

  Future<void> _closeServer() async {
    for (final ws in _sockets.toList(growable: false)) {
      await ws.close();
    }
    _sockets.clear();
    await _server?.close(force: true);
    _server = null;
  }

  Future<void> dispose() async {
    await _closeServer();
    _httpClient.close(force: true);
  }
}

final class _PartialBlob {
  _PartialBlob(this.total) : buffer = Uint8List(total);
  final int total;
  final Uint8List buffer;
  int received = 0;
}

final class _RateBucket {
  _RateBucket({required this.count, required this.resetAtMs});
  int count;
  final int resetAtMs;
}
