import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';

String _sha256Hex(List<int> bytes) => sha256.convert(bytes).toString();

void main() {
  late Directory tempDir;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('pocket-cos-prefix-test-');
  });

  tearDown(() async {
    if (tempDir.existsSync()) {
      await tempDir.delete(recursive: true);
    }
  });

  test(
    'COS-prefixed package index (apps/demo-cos) resolves relative ../../../pocket/... URLs, preserves prefix across root & child apps, and PocketUpdateCoordinator prepares & assembles verified PAK',
    () async {
      final ed25519 = Ed25519();
      final keyPair = await ed25519.newKeyPair();
      final publicKey = await keyPair.extractPublicKey();
      final publicKeyBytes = Uint8List.fromList(publicKey.bytes);
      final publicKeyBase64 = base64Encode(publicKeyBytes);
      const keyId = 'cos-test-ed25519-key';

      const cosPrefix = 'apps/demo-cos';
      const hostVersion = '0.1.0';
      const rootAppId = 'pocket.host.demo';
      const childAppId = 'pocket.demo.profile';
      const releaseId = 'cos-test-rel-1';

      final entryBytes = Uint8List.fromList(
        utf8.encode('PJBC_COS_TEST_BYTECODE_V1'),
      );
      final entrySha = _sha256Hex(entryBytes);

      final heroImageBytes = Uint8List.fromList(<int>[
        137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      final bgImageBytes = Uint8List.fromList(<int>[
        10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120,
      ]);

      final canonicalPakBytes = encodePocketPak(<PocketPakBlobEntry>[
        PocketPakBlobEntry(key: 'ui:img.bg', data: bgImageBytes, dtype: 0),
        PocketPakBlobEntry(key: 'ui:img.hero', data: heroImageBytes, dtype: 0),
      ]);
      final pakSha = _sha256Hex(canonicalPakBytes);

      // Parse PAK header offsets to split into metadata + blob parts matching packageArtifacts
      final pakView = ByteData.sublistView(canonicalPakBytes);
      final blobsOffset = pakView.getUint32(20, Endian.little);
      final metadataSlice = Uint8List.sublistView(
        canonicalPakBytes,
        0,
        blobsOffset,
      );
      final blobsSlice = Uint8List.sublistView(
        canonicalPakBytes,
        blobsOffset,
        canonicalPakBytes.length,
      );
      final metadataPartSha = _sha256Hex(metadataSlice);
      final blobsPartSha = _sha256Hex(blobsSlice);

      final looseAssetBytes = Uint8List.fromList(
        utf8.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      );
      final looseAssetSha = _sha256Hex(looseAssetBytes);

      // Bundle ZIP containing entry + metadataSlice + hero slice, while loose asset is fetched via blobs/<sha256>
      final zipBytes = encodePocketZip(<String, List<int>>{
        'blobs/$entrySha': entryBytes,
        'blobs/$metadataPartSha': metadataSlice,
        'blobs/$blobsPartSha': blobsSlice,
      });
      final zipSha = _sha256Hex(zipBytes);
      final bundleRelUrl = 'bundles/bundle-$zipSha.zip';

      final payloadMap = <String, dynamic>{
        'schemaVersion': 1,
        'appId': rootAppId,
        'version': '0.1.0-test.1',
        'build': 1,
        'protocol': 1,
        'minHostVersion': 1,
        'entry': <String, dynamic>{
          'sha256': entrySha,
          'size': entryBytes.length,
        },
        'entryFormat': 'quickjs-bytecode',
        'runtimeAbi': 'quickjs-bytecode-v1',
        'pak': <String, dynamic>{
          'sha256': pakSha,
          'size': canonicalPakBytes.length,
          'parts': <Map<String, dynamic>>[
            <String, dynamic>{
              'offset': 0,
              'size': metadataSlice.length,
              'sha256': metadataPartSha,
            },
            <String, dynamic>{
              'offset': blobsOffset,
              'size': blobsSlice.length,
              'sha256': blobsPartSha,
            },
          ],
        },
        'files': <Map<String, dynamic>>[
          <String, dynamic>{
            'sha256': entrySha,
            'size': entryBytes.length,
            'url': 'blobs/$entrySha',
          },
          <String, dynamic>{
            'sha256': metadataPartSha,
            'size': metadataSlice.length,
            'url': 'blobs/$metadataPartSha',
          },
          <String, dynamic>{
            'sha256': blobsPartSha,
            'size': blobsSlice.length,
            'url': 'blobs/$blobsPartSha',
          },
          <String, dynamic>{
            'sha256': looseAssetSha,
            'size': looseAssetBytes.length,
            'url': 'blobs/$looseAssetSha',
          },
        ],
        'bundle': <String, dynamic>{
          'format': 'zip',
          'sha256': zipSha,
          'size': zipBytes.length,
          'url': bundleRelUrl,
          'blobs': <String>[entrySha, metadataPartSha, blobsPartSha],
        },
        'assets': <String, dynamic>{
          'assets/cloud.svg': <String, dynamic>{
            'sha256': looseAssetSha,
            'size': looseAssetBytes.length,
          },
        },
        'capabilities': <String, dynamic>{
          'requires': <String>[],
          'optional': <String>[],
        },
        'permissions': <String, dynamic>{
          'optional': <String>[],
        },
      };

      final payloadBytes = Uint8List.fromList(
        utf8.encode(jsonEncode(payloadMap)),
      );
      final payloadSha = _sha256Hex(payloadBytes);
      final signature = await ed25519.sign(payloadBytes, keyPair: keyPair);

      final signedEnvelopeBytes = Uint8List.fromList(
        utf8.encode(
          jsonEncode(<String, dynamic>{
            'keyId': keyId,
            'payload': base64Encode(payloadBytes),
            'signature': base64Encode(signature.bytes),
          }),
        ),
      );

      final bootstrapMetadataBytes = Uint8List.fromList(
        utf8.encode(
          '{"entryFormat":"quickjs-bytecode","runtimeAbi":"quickjs-bytecode-v1","bytecodeBytes":${entryBytes.length},"build":1}',
        ),
      );
      final bootstrapManifestBytes = Uint8List.fromList(
        utf8.encode('{"protocolVersion":1,"requires":[],"optional":[],"build":1}'),
      );

      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final baseOrigin = 'http://127.0.0.1:${server.port}';
      final publicBaseUrl = '$baseOrigin/$cosPrefix';

      final immutablePrefix =
          '/$cosPrefix/pocket/$hostVersion/$rootAppId/$releaseId';
      final childImmutablePrefix =
          '/$cosPrefix/pocket/$hostVersion/$childAppId/$releaseId';

      final rebasedHostDescriptor = <String, dynamic>{
        'schemaVersion': 1,
        'kind': 'pocket-editor-app-host',
        'systemUI': rootAppId,
        'POCKET_UPDATE_BASE_URL': '$publicBaseUrl/test',
        'POCKET_HOST_VERSION': hostVersion,
        'POCKET_PACKAGE_VERSION': releaseId,
        'POCKET_UPDATE_KEY_ID': keyId,
        'POCKET_UPDATE_PUBLIC_KEY': publicKeyBase64,
        'POCKET_STORE_NAMESPACE': 'cos_store_ns',
        'release': <String, dynamic>{
          'appId': rootAppId,
          'version': '0.1.0-test.1',
          'build': 1,
          'rootPayloadSha256': payloadSha,
          'compatVersion': '0.1.0',
          'channel': 'test',
          'slot': 'test',
          'routeVersion': '0.1.0-test.1',
          'releaseId': releaseId,
        },
        'updates': <String, dynamic>{
          'baseUrl': '$publicBaseUrl/test',
          'hostVersion': hostVersion,
          'packageVersion': releaseId,
          'keyId': keyId,
          'publicKey': publicKeyBase64,
          'namespace': 'cos_store_ns',
          'debugHttpHosts': <String>['127.0.0.1'],
        },
        'applications': <String, dynamic>{
          rootAppId: <String, dynamic>{
            'id': rootAppId,
            'appId': rootAppId,
            'role': 'systemUI',
            'version': '0.1.0-test.1',
            'build': 1,
            'packageVersion': releaseId,
            'keyId': keyId,
            'publicKey': publicKeyBase64,
            'payloadSha256': payloadSha,
            'rootPayloadSha256': payloadSha,
            'updateUrl': '$baseOrigin$immutablePrefix/latest.json',
            'manifestUrl': '$baseOrigin$immutablePrefix/latest.json',
            'hostConfigUrl': '$baseOrigin$immutablePrefix/host.json',
            'bootstrapAssets': <String, dynamic>{
              'assets/apps/$rootAppId/app.bytecode.json': <String, dynamic>{
                'url': '$baseOrigin$immutablePrefix/bootstrap/app.bytecode.json',
                'sha256': _sha256Hex(bootstrapMetadataBytes),
                'size': bootstrapMetadataBytes.length,
              },
              'assets/apps/$rootAppId/guest-manifest.json': <String, dynamic>{
                'url': '$baseOrigin$immutablePrefix/bootstrap/guest-manifest.json',
                'sha256': _sha256Hex(bootstrapManifestBytes),
                'size': bootstrapManifestBytes.length,
              },
            },
          },
          childAppId: <String, dynamic>{
            'id': childAppId,
            'appId': childAppId,
            'role': 'miniapp',
            'version': '0.1.0-test.1',
            'build': 1,
            'packageVersion': releaseId,
            'keyId': keyId,
            'publicKey': publicKeyBase64,
            'updateUrl': '$baseOrigin$childImmutablePrefix/latest.json',
            'manifestUrl': '$baseOrigin$childImmutablePrefix/latest.json',
            'hostConfigUrl': '$baseOrigin$childImmutablePrefix/host.json',
            'bootstrapAssets': <String, dynamic>{
              'assets/apps/$childAppId/app.bytecode.json': <String, dynamic>{
                'url':
                    '$baseOrigin$childImmutablePrefix/bootstrap/app.bytecode.json',
                'sha256': _sha256Hex(bootstrapMetadataBytes),
                'size': bootstrapMetadataBytes.length,
              },
              'assets/apps/$childAppId/guest-manifest.json': <String, dynamic>{
                'url':
                    '$baseOrigin$childImmutablePrefix/bootstrap/guest-manifest.json',
                'sha256': _sha256Hex(bootstrapManifestBytes),
                'size': bootstrapManifestBytes.length,
              },
            },
          },
        },
      };

      // Static package index emitted by publishStudioVersionToCos with relative ../../../../pocket/... links
      final packageIndex = <String, dynamic>{
        'schemaVersion': 1,
        'kind': 'pocket-editor-package-index',
        'projectId': 'demo',
        'hostVersion': hostVersion,
        'rootAppId': rootAppId,
        'systemUI': rootAppId,
        'packageId': rootAppId,
        'slot': 'test',
        'channel': 'test',
        'compatVersion': '0.1.0',
        'latest': <String, dynamic>{
          'id': rootAppId,
          'version': '0.1.0-test.1',
          'build': 1,
          'releaseId': releaseId,
          'channel': 'test',
          'slot': 'test',
          'compatVersion': '0.1.0',
          'routeVersion': '0.1.0-test.1',
          'packageVersion': releaseId,
          'publishedAt': '2026-11-16T08:00:00.000Z',
          'manifestUrl':
              '../../../../pocket/$hostVersion/$rootAppId/$releaseId/latest.json',
          'hostConfigUrl':
              '../../../../pocket/$hostVersion/$rootAppId/$releaseId/host.json',
          'archiveUrl': null,
          'payloadSha256': payloadSha,
          'rootPayloadSha256': payloadSha,
        },
        'versions': <Map<String, dynamic>>[
          <String, dynamic>{
            'id': rootAppId,
            'version': '0.1.0-test.1',
            'build': 1,
            'releaseId': releaseId,
            'channel': 'test',
            'slot': 'test',
            'compatVersion': '0.1.0',
            'routeVersion': '0.1.0-test.1',
            'packageVersion': releaseId,
            'publishedAt': '2026-11-16T08:00:00.000Z',
            'manifestUrl':
                '../../../../pocket/$hostVersion/$rootAppId/$releaseId/latest.json',
            'hostConfigUrl':
                '../../../../pocket/$hostVersion/$rootAppId/$releaseId/host.json',
            'archiveUrl': null,
            'payloadSha256': payloadSha,
            'rootPayloadSha256': payloadSha,
          },
        ],
      };

      final requestedPaths = <String>[];
      final blobsMap = <String, Uint8List>{
        '$immutablePrefix/blobs/$entrySha': entryBytes,
        '$immutablePrefix/blobs/$metadataPartSha': metadataSlice,
        '$immutablePrefix/blobs/$blobsPartSha': blobsSlice,
        '$immutablePrefix/blobs/$looseAssetSha': looseAssetBytes,
      };

      server.listen((request) {
        final reqPath = request.uri.path;
        requestedPaths.add(reqPath);

        if (reqPath == '/$cosPrefix/test/pocket/$hostVersion/$rootAppId/latest.json') {
          final bytes = utf8.encode(jsonEncode(packageIndex));
          request.response
            ..headers.contentType = ContentType.json
            ..contentLength = bytes.length
            ..add(bytes)
            ..close();
          return;
        }
        if (reqPath == '$immutablePrefix/host.json') {
          final bytes = utf8.encode(jsonEncode(rebasedHostDescriptor));
          request.response
            ..headers.contentType = ContentType.json
            ..contentLength = bytes.length
            ..add(bytes)
            ..close();
          return;
        }
        if (reqPath == '$immutablePrefix/latest.json') {
          request.response
            ..headers.contentType = ContentType.json
            ..contentLength = signedEnvelopeBytes.length
            ..add(signedEnvelopeBytes)
            ..close();
          return;
        }
        if (reqPath == '$immutablePrefix/$bundleRelUrl') {
          request.response
            ..headers.contentType = ContentType.binary
            ..contentLength = zipBytes.length
            ..add(zipBytes)
            ..close();
          return;
        }
        if (reqPath.endsWith('/bootstrap/app.bytecode.json')) {
          request.response
            ..headers.contentType = ContentType.json
            ..contentLength = bootstrapMetadataBytes.length
            ..add(bootstrapMetadataBytes)
            ..close();
          return;
        }
        if (reqPath.endsWith('/bootstrap/guest-manifest.json')) {
          request.response
            ..headers.contentType = ContentType.json
            ..contentLength = bootstrapManifestBytes.length
            ..add(bootstrapManifestBytes)
            ..close();
          return;
        }
        final blobBytes = blobsMap[reqPath];
        if (blobBytes != null) {
          request.response
            ..headers.contentType = ContentType.binary
            ..contentLength = blobBytes.length
            ..add(blobBytes)
            ..close();
          return;
        }
        request.response
          ..statusCode = HttpStatus.notFound
          ..close();
      });

      final trustDir = Directory('${tempDir.path}/trust');
      final storeDir = Directory('${tempDir.path}/store');
      final indexUri = Uri.parse(
        '$publicBaseUrl/test/pocket/$hostVersion/$rootAppId/latest.json',
      );

      // 1. Load PocketHostConfig from the COS-prefixed package index URL
      final hostConfig = await PocketHostConfig.load(
        indexUri,
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        trustAnchorDirectory: trustDir,
      );

      expect(hostConfig.systemUI.appId, rootAppId);
      expect(hostConfig.rootPayloadSha256, payloadSha);
      expect(
        hostConfig.systemUI.updates!.indexUrl,
        '$publicBaseUrl/test/pocket/$hostVersion/$rootAppId/latest.json',
      );
      expect(
        hostConfig.systemUI.updates!.manifestUri(rootAppId).toString(),
        '$publicBaseUrl/test/pocket/$hostVersion/$rootAppId/latest.json',
      );
      expect(
        hostConfig.applications[childAppId]!.updates!.indexUrl,
        '$publicBaseUrl/test/pocket/$hostVersion/$childAppId/latest.json',
      );
      expect(
        hostConfig.applications[childAppId]!.updates!
            .manifestUri(childAppId)
            .toString(),
        '$publicBaseUrl/test/pocket/$hostVersion/$childAppId/latest.json',
      );

      // 2. Run PocketUpdateCoordinator.prepare() against the resolved manifestUri
      final coordinator = PocketUpdateCoordinator(
        manifestUri: hostConfig.systemUI.updates!.manifestUri(rootAppId),
        appId: rootAppId,
        trustedKeys: <String, List<int>>{
          hostConfig.systemUI.updates!.keyId: base64Decode(
            hostConfig.systemUI.updates!.publicKey,
          ),
        },
        store: PocketPackageStore(storeDir),
        debugHttpHosts: hostConfig.systemUI.updates!.debugHttpHosts,
        expectedRuntimeAbi: 'quickjs-bytecode-v1',
        requireBytecode: true,
      );
      addTearDown(coordinator.dispose);

      final prepared = await coordinator.prepare();
      expect(prepared.version, '0.1.0-test.1');
      expect(prepared.build, 1);
      expect(prepared.deliveryMode, PocketUpdateMode.zip);
      // 1 zip bundle + 1 loose network asset downloaded
      expect(prepared.downloadedFiles, 2);

      // Verify requests hit the COS-prefixed bundle and loose blob paths
      expect(
        requestedPaths,
        contains('/$cosPrefix/test/pocket/$hostVersion/$rootAppId/latest.json'),
      );
      expect(requestedPaths, contains('$immutablePrefix/host.json'));
      expect(requestedPaths, contains('$immutablePrefix/latest.json'));
      expect(requestedPaths, contains('$immutablePrefix/$bundleRelUrl'));
      expect(
        requestedPaths,
        contains('$immutablePrefix/blobs/$looseAssetSha'),
      );

      // Verify assembled PAK and bytecode entry match byte-for-byte
      final artifact = await prepared.readArtifact();
      expect(artifact.entryBytes, orderedEquals(entryBytes));
      expect(artifact.pakBytes, orderedEquals(canonicalPakBytes));
      expect(
        File(prepared.source.assetPaths['assets/cloud.svg']!).readAsBytesSync(),
        orderedEquals(looseAssetBytes),
      );
    },
  );
}
