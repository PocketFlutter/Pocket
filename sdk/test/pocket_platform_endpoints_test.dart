import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

Map<String, dynamic> _hostDocument({
  required String baseUrl,
  String appId = 'com.demo.multiaccount',
  String hostVersion = '0.1.22',
  String keyId = 'cf-shared-key',
  String pubKeyBase64 = 'AA==',
  required List<int> metadataBytes,
  required List<int> manifestBytes,
}) {
  return <String, dynamic>{
    'kind': 'pocket-editor-app-host',
    'schemaVersion': 1,
    'systemUI': appId,
    'updates': <String, dynamic>{
      'baseUrl': baseUrl,
      'hostVersion': hostVersion,
      'packageVersion': '1.0.0',
      'keyId': keyId,
      'publicKey': pubKeyBase64,
      'namespace': 'cf_ota',
      'debugHttpHosts': <String>['127.0.0.1'],
    },
    'release': <String, dynamic>{
      'appId': appId,
      'version': '1.0.0',
      'build': 1,
      'channel': 'stable',
      'routeVersion': '1.0.0',
    },
    'applications': <String, dynamic>{
      appId: <String, dynamic>{
        'appId': appId,
        'payloadSha256': 'a' * 64,
        'bootstrapAssets': <String, dynamic>{
          'assets/app.bytecode.json': <String, dynamic>{
            'url': '$baseUrl/bootstrap/metadata',
            'sha256': sha256.convert(metadataBytes).toString(),
            'size': metadataBytes.length,
          },
          'assets/guest-manifest.json': <String, dynamic>{
            'url': '$baseUrl/bootstrap/manifest',
            'sha256': sha256.convert(manifestBytes).toString(),
            'size': manifestBytes.length,
          },
        },
      },
    },
  };
}

void main() {
  late Directory trustDirectory;

  setUp(() async {
    trustDirectory = Directory(
      '${Directory.current.path}/.pocket-build/dart-endpoint-test-${DateTime.now().microsecondsSinceEpoch}',
    )..createSync(recursive: true);
  });

  tearDown(() async {
    if (trustDirectory.existsSync()) {
      await trustDirectory.delete(recursive: true);
    }
  });

  test('resolves exact platform routes, merges global wildcard fallbacks, and builds PocketUpdateConfig', () {
    final endpoints = PocketPlatformEndpoints.fromJson(<String, dynamic>{
      'schemaVersion': 1,
      'kind': 'pocket-platform-endpoints',
      'appId': 'com.demo.multiaccount',
      'hostVersion': '0.1.22',
      'slot': 'stable',
      'keyId': 'cf-shared-key',
      'publicKey': 'AA==',
      'routes': <String, dynamic>{
        'ios': <String, dynamic>{
          'primaryUrl': 'https://ota-apple.test/stable/pocket/0.1.22/com.demo.multiaccount/latest.json',
          'fallbackUrls': <String>[
            'https://ota-apple-bak.test/stable/pocket/0.1.22/com.demo.multiaccount/latest.json',
          ],
        },
        'android': <String, dynamic>{
          'primaryUrl': 'https://ota-android.test/stable/pocket/0.1.22/com.demo.multiaccount/latest.json',
          'fallbackUrls': <String>[],
        },
        '*': <String, dynamic>{
          'primaryUrl': 'https://ota-global.test/stable/pocket/0.1.22/com.demo.multiaccount/latest.json',
          'fallbackUrls': <String>[
            'https://ota-mirror.test/stable/pocket/0.1.22/com.demo.multiaccount/latest.json',
          ],
        },
      },
    });

    final iosRoute = endpoints.resolveRoute(platform: TargetPlatform.iOS, isWeb: false);
    expect(
      iosRoute.primaryUri.toString(),
      'https://ota-apple.test/stable/pocket/0.1.22/com.demo.multiaccount/latest.json',
    );
    expect(iosRoute.fallbackUris.map((u) => u.toString()).toList(), <String>[
      'https://ota-apple-bak.test/stable/pocket/0.1.22/com.demo.multiaccount/latest.json',
      'https://ota-mirror.test/stable/pocket/0.1.22/com.demo.multiaccount/latest.json',
    ]);

    final macRoute = endpoints.resolveRoute(platform: TargetPlatform.macOS, isWeb: false);
    expect(
      macRoute.primaryUri.toString(),
      'https://ota-global.test/stable/pocket/0.1.22/com.demo.multiaccount/latest.json',
    );

    final webUpdateCfg = endpoints.toUpdateConfig(isWeb: true);
    expect(
      webUpdateCfg.indexUrl,
      'https://ota-global.test/stable/pocket/0.1.22/com.demo.multiaccount/latest.json',
    );
    expect(webUpdateCfg.configured, isTrue);
  });

  test('fails over from primary account 503 to fallback account while keeping same-origin and fail-closed on tampering', () async {
    final metadataBytes = utf8.encode('{"runtimeAbi":"quickjs-bytecode-v1","bytecodeBytes":1,"build":1}');
    final manifestBytes = utf8.encode('{"requires":[],"optional":[],"build":1}');

    final primaryServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final fallbackServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() async {
      await primaryServer.close(force: true);
      await fallbackServer.close(force: true);
    });

    var primaryMode = '503';
    var primaryHits = 0;
    var fallbackHits = 0;

    final primaryBase = 'http://127.0.0.1:${primaryServer.port}';
    final fallbackBase = 'http://127.0.0.1:${fallbackServer.port}';

    primaryServer.listen((request) {
      primaryHits++;
      if (primaryMode == '503') {
        request.response
          ..statusCode = HttpStatus.serviceUnavailable
          ..write('Account A rate limited')
          ..close();
        return;
      }
      if (primaryMode == 'wrong-key') {
        if (request.uri.path.endsWith('/host.json')) {
          request.response
            ..headers.contentType = ContentType.json
            ..write(
              jsonEncode(
                _hostDocument(
                  baseUrl: primaryBase,
                  keyId: 'unexpected-attacker-key',
                  metadataBytes: metadataBytes,
                  manifestBytes: manifestBytes,
                ),
              ),
            )
            ..close();
          return;
        }
      }
      if (request.uri.path == '/bootstrap/metadata') {
        request.response
          ..headers.contentType = ContentType.json
          ..add(metadataBytes)
          ..close();
        return;
      }
      if (request.uri.path == '/bootstrap/manifest') {
        request.response
          ..headers.contentType = ContentType.json
          ..add(manifestBytes)
          ..close();
        return;
      }
      request.response.statusCode = HttpStatus.notFound;
      request.response.close();
    });

    fallbackServer.listen((request) {
      fallbackHits++;
      if (request.uri.path.endsWith('/host.json')) {
        request.response
          ..headers.contentType = ContentType.json
          ..write(
            jsonEncode(
              _hostDocument(
                baseUrl: fallbackBase,
                metadataBytes: metadataBytes,
                manifestBytes: manifestBytes,
              ),
            ),
          )
          ..close();
        return;
      }
      if (request.uri.path == '/bootstrap/metadata') {
        request.response
          ..headers.contentType = ContentType.json
          ..add(metadataBytes)
          ..close();
        return;
      }
      if (request.uri.path == '/bootstrap/manifest') {
        request.response
          ..headers.contentType = ContentType.json
          ..add(manifestBytes)
          ..close();
        return;
      }
      request.response.statusCode = HttpStatus.notFound;
      request.response.close();
    });

    final endpoints = PocketPlatformEndpoints.fromJson(
      <String, dynamic>{
        'schemaVersion': 1,
        'kind': 'pocket-platform-endpoints',
        'appId': 'com.demo.multiaccount',
        'hostVersion': '0.1.22',
        'keyId': 'cf-shared-key',
        'publicKey': 'AA==',
        'routes': <String, dynamic>{
          'ios': <String, dynamic>{
            'primaryUrl': '$primaryBase/host.json',
            'fallbackUrls': <String>['$fallbackBase/host.json'],
          },
        },
      },
      allowInsecureHttpHosts: const <String>{'127.0.0.1'},
    );

    // 1. Primary returns 503 -> automatically fails over to fallback account and verifies bootstrap!
    final loaded = await endpoints.loadHostConfig(
      platform: TargetPlatform.iOS,
      isWeb: false,
      allowInsecureHttpHosts: const <String>{'127.0.0.1'},
      trustAnchorDirectory: trustDirectory,
    );
    expect(primaryHits, 1);
    expect(fallbackHits, greaterThan(0));
    expect(loaded.source.port, fallbackServer.port);
    expect(loaded.systemUI.appId, 'com.demo.multiaccount');

    // 2. Primary returns wrong keyId (security FormatException) -> MUST fail closed immediately WITHOUT failing over!
    primaryMode = 'wrong-key';
    final fallbackHitsBeforeSecurityFailure = fallbackHits;
    await expectLater(
      endpoints.loadHostConfig(
        platform: TargetPlatform.iOS,
        isWeb: false,
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        trustAnchorDirectory: trustDirectory,
      ),
      throwsA(isA<FormatException>()),
    );
    expect(fallbackHits, fallbackHitsBeforeSecurityFailure);
  });
}
