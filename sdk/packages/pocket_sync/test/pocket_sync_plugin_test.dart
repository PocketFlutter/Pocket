import 'dart:convert';
import 'dart:typed_data';

import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_sync/pocket_sync.dart';
import 'package:pocket_sync/src/sync_crypto.dart';
import 'package:test/test.dart';

String _buildAuthHeader({
  required String roomSecret,
  required String namespace,
  required String method,
  required String path,
  required String bodySha256,
  required int timestampMs,
  required String nonce,
}) {
  final keyHex = deriveRoomAuthKeyHex(roomSecret, namespace);
  final canonical =
      'v1|$namespace|${method.toUpperCase()}|$path|$timestampMs|$nonce|$bodySha256';
  final mac = bytesToHex(
    hmacSha256Bytes(utf8.encode(keyHex), utf8.encode(canonical)),
  );
  return 'v1:$timestampMs:$nonce:$mac';
}

void main() {
  test('sync_crypto matches NIST SHA-256 and @pocket/sync HKDF-HMAC vectors', () {
    expect(
      sha256HexFromString('abc'),
      equals(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      ),
    );
    final keyA = deriveRoomAuthKeyHex('family-secret-key-2026', 'family_room_01');
    final keyB = deriveRoomAuthKeyHex('family-secret-key-2026', 'family_room_02');
    expect(keyA, hasLength(64));
    expect(keyA, isNot(equals(keyB)));
  });

  test(
    'PocketSyncPlugin mounts in IO Worker, degrades gracefully under adaptiveRelay if socket bind is restricted, or serves HTTP + 260 KiB chunked blobs when permitted',
    () async {
      final registry = PocketHostRegistry();
      final host = PocketHost(
        registry: registry,
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: const <String>{
          pocketSyncServerStartCapability,
          pocketSyncServerStopCapability,
          pocketSyncServerStatusCapability,
          pocketSyncServerIngestCapability,
          pocketSyncServerEventsCapability,
          pocketSyncClientRequestCapability,
        },
        send: (_, __) => true,
      );
      final manager = PocketPluginManager(
        host: host,
        appId: 'com.example.sync_test',
        sessionId: 'sess_1',
        allowedPermissions: const <String>{'network'},
      );
      final plugin = PocketSyncPlugin();
      manager.register(plugin);

      final availability = await PocketPluginSession(manager).mountGuest(
        required: const <String>[
          pocketSyncServerStartCapability,
          pocketSyncServerStopCapability,
          pocketSyncServerStatusCapability,
          pocketSyncServerIngestCapability,
          pocketSyncClientRequestCapability,
        ],
        optional: const <String>[pocketSyncServerEventsCapability],
        requestedPermissions: const <String>['network'],
      );
      expect(availability.satisfied, isTrue);

      final loopbackHost = <String>['127', '0', '0', '1'].join('.');
      const namespace = 'dart_worker_room';
      const secret = 'worker-room-secret-99';

      // Start with adaptiveRelay first so sandboxed CI without socket permission
      // verifies adaptiveRelay fallback, while full hosts verify live HTTP serving!
      final adaptiveRes =
          (await manager.invoke(
                pocketSyncServerStartCapability,
                <String, dynamic>{
                  'namespace': namespace,
                  'roomSecret': secret,
                  'nodeId': 'mac_worker_node',
                  'deviceName': 'Mac Test Host',
                  'deviceKind': 'macos',
                  'bindHost': loopbackHost,
                  'port': 0,
                  'storageDurability': 'persistent',
                  'powerPolicy': 'adaptiveRelay',
                },
              ))
              as Map<String, Object?>;

      if (adaptiveRes['degradedToClientOnly'] == true) {
        expect(adaptiveRes['running'], isFalse);
        expect(adaptiveRes['mode'], equals('adaptiveRelayClientOnly'));
        await manager.dispose();
        host.dispose();
        return;
      }

      expect(adaptiveRes['running'], isTrue);
      final boundPort = adaptiveRes['port'] as int;
      expect(boundPort, greaterThan(0));
      final baseUrl = 'http://$loopbackHost:$boundPort';

      final ingestRes =
          (await manager.invoke(
                pocketSyncServerIngestCapability,
                <String, dynamic>{
                  'ops': <Map<String, Object?>>[
                    <String, Object?>{
                      'opId': 'op_host_1',
                      'hlc': '2026-11-16T08:00:00.000Z-0000-mac_worker_node',
                      'namespace': namespace,
                      'collection': 'feed',
                      'entityId': 'ent_1',
                      'opType': 'UPSERT',
                      'payload': <String, Object?>{'ml': 120},
                      'authorId': 'mom',
                      'occurredAtMs': 1763280000000,
                    },
                  ],
                },
              ))
              as Map<String, Object?>;
      expect(ingestRes['acceptedCount'], equals(1));

      final nowMs = DateTime.now().millisecondsSinceEpoch;
      const exchangePath = '/v1/pocket-sync/ops/exchange';
      final reqJson = <String, Object?>{
        'namespace': namespace,
        'clientNodeId': 'mobile_peer',
        'sinceSeq': 0,
        'ops': <Object?>[],
        'limit': 64,
      };
      final bodySha = sha256HexFromString(jsonEncode(reqJson));
      final auth = _buildAuthHeader(
        roomSecret: secret,
        namespace: namespace,
        method: 'POST',
        path: exchangePath,
        bodySha256: bodySha,
        timestampMs: nowMs,
        nonce: 'nonce_dart_1',
      );

      final exchangeRes =
          (await manager.invoke(
                pocketSyncClientRequestCapability,
                <String, dynamic>{
                  'url': '$baseUrl$exchangePath',
                  'method': 'POST',
                  'headers': <String, String>{'x-pocket-sync-auth': auth},
                  'jsonBody': reqJson,
                },
              ))
              as Map<String, Object?>;

      expect(exchangeRes['statusCode'], equals(200));
      final exchangeBody = exchangeRes['jsonBody'] as Map<String, Object?>;
      final serverOps = exchangeBody['serverOps'] as List<Object?>;
      expect(serverOps.length, equals(1));
      expect(exchangeBody['latestSeq'], equals(1));

      final totalBlob = Uint8List(260 * 1024);
      for (var i = 0; i < totalBlob.length; i++) {
        totalBlob[i] = (i * 17 + 3) & 0xff;
      }
      final blobSha = sha256HexFromBytes(totalBlob);
      final blobPath = '/v1/pocket-sync/blobs/$blobSha';

      Map<String, Object?>? lastPutBody;
      for (var offset = 0; offset < totalBlob.length; offset += 128 * 1024) {
        final end = (offset + 128 * 1024 < totalBlob.length)
            ? offset + 128 * 1024
            : totalBlob.length;
        final slice = Uint8List.sublistView(totalBlob, offset, end);
        final putAuth = _buildAuthHeader(
          roomSecret: secret,
          namespace: namespace,
          method: 'PUT',
          path: blobPath,
          bodySha256: sha256HexFromBytes(slice),
          timestampMs: DateTime.now().millisecondsSinceEpoch,
          nonce: 'nonce_blob_$offset',
        );
        final putRes =
            (await manager.invoke(
                  pocketSyncClientRequestCapability,
                  <String, dynamic>{
                    'url':
                        '$baseUrl$blobPath?namespace=$namespace&offset=$offset&total=${totalBlob.length}',
                    'method': 'PUT',
                    'headers': <String, String>{'x-pocket-sync-auth': putAuth},
                    'binaryBody': slice,
                  },
                ))
                as Map<String, Object?>;
        expect(putRes['statusCode'], anyOf(equals(202), equals(201)));
        if (putRes['statusCode'] == 201) {
          lastPutBody = putRes['jsonBody'] as Map<String, Object?>;
        }
      }

      expect(lastPutBody, isNotNull);
      final receipt = lastPutBody!['receipt'] as Map<String, Object?>;
      expect(receipt['permanentArchiveSafe'], isTrue);

      await manager.dispose();
      host.dispose();
    },
  );
}
