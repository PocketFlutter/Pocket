import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_studio/pocket_studio.dart';

/// Runs the REAL editor service (started by PocketStudioService through
/// `bun pocket.ts editor`) and drives it through the provider. Skips
/// explicitly without bun; a skip is not evidence.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null; // real loopback service, not the test binding's stub client
  final homeBun = '${Platform.environment['HOME']}/.bun/bin/bun';
  final bun = Platform.environment['POCKET_BUN'] ??
      (File(homeBun).existsSync() ? homeBun : '/opt/homebrew/bin/bun');
  final sdkRoot = Directory.current.parent.parent.path;
  final projectRoot = Platform.environment['POCKET_STUDIO_TEST_PROJECT'] ??
      <String>[Directory.current.parent.parent.parent.path, 'demo', 'js'].join('/');
  final studioProject = <String>[Directory.current.parent.parent.parent.path, 'studio', 'js'].join('/');
  final skip = File(bun).existsSync() && Directory(projectRoot).existsSync()
      ? false
      : 'bun or the sample project is not available';
  // POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure (a skip is not evidence).
  final requireReal = Platform.environment['POCKET_REQUIRE_REAL'] == '1';
  if (requireReal && skip != false) {
    test('real service prerequisites are present (POCKET_REQUIRE_REAL=1)', () => fail('$skip'));
  }

  late Directory work;
  late PocketStudioConfig config;
  late PocketStudioService lifecycle;
  late PocketStudioPlugin plugin;
  HttpServer? releases;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('pocket-studio-real-');
    // A local stand-in for the GitHub releases feed (the service only talks to it in the upgrade check).
    releases = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    releases!.listen((request) async {
      final base = 'http://127.0.0.1:${releases!.port}';
      final assets = <Map<String, String>>[
        for (final tuple in const ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64']) ...[
          {'name': 'pocket-web-sdk-tools-$tuple-99.0.0.tgz', 'browser_download_url': '$base/a-$tuple.tgz'},
          {'name': 'pocket-web-sdk-tools-$tuple-99.0.0.tgz.sha256', 'browser_download_url': '$base/a-$tuple.sha256'},
        ],
      ];
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode([
        {'tag_name': 'sdk-v99.0.0', 'draft': false, 'prerelease': false, 'html_url': '$base/release/sdk-v99.0.0', 'assets': assets},
      ]));
      await request.response.close();
    });
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    config = PocketStudioConfig(
      port: port,
      sdkRoot: sdkRoot,
      projectRoot: projectRoot,
      workspace: '${work.path}/ws',
      bunExecutable: bun,
      extraProjectRoots: <String>[studioProject], // the Studio's own guest project: trusted host config
      environment: <String, String>{
        ...Platform.environment,
        'POCKET_SOURCE_BUILD': '1',
        'TMPDIR': '/tmp',
        'POCKET_STUDIO_UPGRADE_RELEASES_URL': 'http://127.0.0.1:${releases!.port}/releases',
        'POCKET_STUDIO_UPGRADE_ALLOW_LOOPBACK': '1',
      },
    );
    lifecycle = PocketStudioService(config, stopOnExit: false);
    await lifecycle.start();
    plugin = PocketStudioPlugin(config: config);
  });

  tearDownAll(() async {
    if (skip != false) return;
    await plugin.dispose();
    await lifecycle.stop();
    await releases?.close(force: true);
    await work.delete(recursive: true);
  });

  Future<Map> call(String name, [Map<String, dynamic> params = const {}]) async =>
      (await plugin.invoke(name, params)) as Map;

  test('lifecycle started and owns the service; a second start attaches', () async {
    expect(lifecycle.ownsProcess, isTrue);
    final second = PocketStudioService(config, stopOnExit: false);
    await second.start();
    expect(second.ownsProcess, isFalse);
  }, skip: skip);

  test('the Studio\'s own guest project is listed through the trusted extra root; the update key exists at startup', () async {
    final list = (await call('studio.project.list'))['projects'] as List;
    final ids = list.map((p) => (p as Map)['id']);
    expect(ids, containsAll(<String>['pocket-host-showcase', 'pocket-studio']));
    final own = list.cast<Map>().firstWhere((p) => p['id'] == 'pocket-studio');
    expect(own['appId'], PocketStudioConfig.studioAppId);
    expect(jsonEncode(list), isNot(contains(studioProject)));
    final key = config.readUpdateKey();
    expect(key, isNotNull, reason: 'the service provisions the update signing key before the first publish');
    expect(File('${work.path}/ws/keys/editor-dev-key.json').readAsStringSync(), contains(key!.publicKey));
    expect(config.selfUpdateUrl, '${config.origin}/test/pocket/studio/dev.pocket.studio/latest.json');
  }, skip: skip);

  test('studio.service.health is scrubbed', () async {
    final health = await call('studio.service.health');
    expect(health['ok'], isTrue);
    final text = jsonEncode(health);
    expect(text, isNot(contains(sdkRoot)));
    expect(text, isNot(contains(projectRoot)));
    expect(text, isNot(contains('csrf')));
  }, skip: skip);

  test('studio.project.list and open list the project root', () async {
    final list = (await call('studio.project.list'))['projects'] as List;
    expect(list.map((p) => (p as Map)['id']), contains('pocket-host-showcase'));
    final open = await call('studio.project.open', {'project': 'pocket-host-showcase'});
    expect(open['id'], 'pocket-host-showcase');
    expect(jsonEncode(list), isNot(contains(projectRoot)));
  }, skip: skip, timeout: const Timeout(Duration(seconds: 60)));

  test('studio.fs.tree and read expose project files without absolute paths', () async {
    final tree = await call('studio.fs.tree', {'project': 'pocket-host-showcase'});
    final paths = (tree['files'] as List).map((f) => (f as Map)['path']).toList();
    expect(paths, containsAll(<String>['app.tsx', 'manifest.json']));
    final manifest = await call('studio.fs.read', {'project': 'pocket-host-showcase', 'path': 'manifest.json'});
    expect(manifest['content'], contains('capabilities'));
    final stat = await call('studio.fs.stat', {'project': 'pocket-host-showcase', 'path': 'app.tsx'});
    expect(stat['kind'], 'file');
    expect(jsonEncode(tree), isNot(contains(projectRoot)));
  }, skip: skip);

  test('file content round-trips byte-identical (verbatim content, no path scrubbing)', () async {
    await call('studio.project.create', {'id': 'studio-verbatim', 'template': 'app'});
    const content = "#!/usr/bin/env bun\nconst p='/tmp/x'; const t={a:/x/};\n-----BEGIN PRIVATE KEY-----\n";
    await call('studio.fs.write', {'project': 'studio-verbatim', 'path': 'v.ts', 'content': content});
    final read = await call('studio.fs.read', {'project': 'studio-verbatim', 'path': 'v.ts'});
    expect(read['content'], content);
    final chunk = await call('studio.fs.readChunk', {'project': 'studio-verbatim', 'path': 'v.ts', 'offset': 0});
    expect(base64Decode(chunk['data'] as String), utf8.encode(content));
    expect(chunk['sha256'], sha256.convert(utf8.encode(content)).toString());
  }, skip: skip);

  test('chunked read of a large file verifies against the whole-file sha256', () async {
    final file = File('$projectRoot/app.tsx');
    final bytes = file.readAsBytesSync();
    final chunk = await call('studio.fs.readChunk', {'project': 'pocket-host-showcase', 'path': 'app.tsx', 'offset': 0, 'length': 1000});
    expect(chunk['sha256'], sha256.convert(bytes).toString());
    expect(base64Decode(chunk['data'] as String), bytes.sublist(0, 1000));
    expect(chunk['totalBytes'], bytes.length);
  }, skip: skip);

  test('write path in a created project: CSRF, mkdir, rename, upload, delete, errors', () async {
    final created = await call('studio.project.create', {'id': 'studio-real', 'template': 'app'});
    expect(created['id'], 'studio-real');
    await call('studio.fs.write', {'project': 'studio-real', 'path': 'notes.ts', 'content': 'export const a = 1;\n'});
    expect((await call('studio.fs.read', {'project': 'studio-real', 'path': 'notes.ts'}))['content'], 'export const a = 1;\n');
    await call('studio.fs.mkdir', {'project': 'studio-real', 'path': 'src'});
    await call('studio.fs.rename', {'project': 'studio-real', 'from': 'notes.ts', 'to': 'src/notes.ts'});
    expect((await call('studio.fs.stat', {'project': 'studio-real', 'path': 'src/notes.ts'}))['kind'], 'file');

    final payload = utf8.encode('// big\n${'x' * 300000}\n');
    final sha = sha256.convert(payload).toString();
    final begin = await call('studio.fs.upload.begin', {'project': 'studio-real', 'path': 'src/big.ts', 'totalBytes': payload.length, 'sha256': sha});
    final id = begin['uploadId'] as String;
    for (var offset = 0; offset < payload.length; offset += pocketStudioChunkBytes) {
      final end = (offset + pocketStudioChunkBytes).clamp(0, payload.length);
      await call('studio.fs.upload.chunk', {'project': 'studio-real', 'uploadId': id, 'offset': offset, 'data': base64Encode(payload.sublist(offset, end))});
    }
    final commit = await call('studio.fs.upload.commit', {'project': 'studio-real', 'uploadId': id});
    expect(commit['sha256'], sha);
    await expectLater(plugin.invoke('studio.fs.read', {'project': 'studio-real', 'path': 'src/big.ts'}),
        throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'too_large')));

    await call('studio.fs.delete', {'project': 'studio-real', 'path': 'src/big.ts'});
    await expectLater(plugin.invoke('studio.fs.read', {'project': 'studio-real', 'path': 'src/big.ts'}),
        throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'not_found')));
    await expectLater(plugin.invoke('studio.fs.read', {'project': 'studio-real', 'path': 'editor.json'}),
        throwsA(isA<PocketCapabilityException>()));
    await expectLater(plugin.invoke('studio.fs.read', {'project': 'no-such-project', 'path': 'a.ts'}),
        throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'not_found')));
  }, skip: skip, timeout: const Timeout(Duration(seconds: 60)));

  test('watch stream reports a real change; build.status is scrubbed', () async {
    final events = <Map>[];
    final seen = <String>[];
    final sub = plugin.openStream('studio.fs.watch', {'project': 'studio-real'}).listen((v) {
      for (final e in (v as Map)['events'] as List) {
        events.add(e as Map);
        seen.add((e)['type'] as String);
      }
    });
    await Future<void>.delayed(const Duration(milliseconds: 800));
    await call('studio.fs.write', {'project': 'studio-real', 'path': 'watched.ts', 'content': 'export {};\n'});
    for (var i = 0; i < 40 && !events.any((e) => e['type'] == 'change' && e['path'] == 'watched.ts'); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    await sub.cancel();
    expect(seen, contains('ready'));
    expect(events.any((e) => e['type'] == 'change' && e['path'] == 'watched.ts'), isTrue);
    final status = await call('studio.build.status', {'project': 'studio-real'});
    expect(jsonEncode(status), isNot(contains(work.path)));
  }, skip: skip, timeout: const Timeout(Duration(seconds: 60)));

  test('signed test publish through the provider: plan, publish, history, offline, artifacts, and no key material', () async {
    final started = await call('studio.build.start', {'project': 'studio-real'});
    expect(started['revision'], isA<int>(), reason: 'build.start returns the flat status');
    Map status = {};
    for (var i = 0; i < 300; i++) {
      status = await call('studio.build.status', {'project': 'studio-real'});
      if (status['busy'] != true && status['builtRevision'] != null) break;
      await Future<void>.delayed(const Duration(milliseconds: 200));
    }
    expect(status['error'], isNull, reason: '${status['logs']}');
    expect(status['builtRevision'], status['revision']);

    final plan = await call('studio.publish.plan', {'project': 'studio-real', 'channel': 'test'});
    final root = (plan['targets'] as List).first as Map;
    expect(root['kind'], 'root');
    expect(root['canPublish'], isTrue);
    final published = await call('studio.publish.publish', {'project': 'studio-real', 'channel': 'test'});
    final publish = (published['status'] as Map)['publish'] as Map;
    expect(publish['channel'], 'test');
    expect(publish['keyId'], isNotEmpty);
    expect(publish['payloadSha256'], hasLength(64));
    expect(published['manifestUrl'], contains('/test/pocket/'));
    expect((published['manifest'] as Map).containsKey('payload'), isFalse);
    final history = await call('studio.publish.history', {'project': 'studio-real'});
    final slots = (history['slots'] as List).cast<Map>();
    expect(slots.firstWhere((slot) => slot['name'] == 'test')['version'], publish['version']);
    expect((history['history'] as List), isNotEmpty);
    final offline = await call('studio.publish.offline', {'project': 'studio-real'});
    expect(offline['archiveUrl'], startsWith('/releases/studio-real/'));
    final list = await call('studio.artifacts.list', {'project': 'studio-real'});
    expect((list['artifacts'] as Map)['bytecode'], contains('app.qjbc'));
    final inspected = <Object?>[
      for (final name in const ['app.bytecode.json', 'guest-manifest.json', 'build.json', 'resources.json', 'app.qjbc', 'app.pak'])
        await call('studio.artifacts.inspect', {'project': 'studio-real', 'name': name}),
    ];
    expect((inspected[0] as Map)['data'], contains('runtimeAbi'));
    expect((inspected[3] as Map)['data'], contains('packages'));
    expect((inspected[4] as Map).containsKey('data'), isFalse);

    // Keys stay in the service: no field of the key file other than the public ones appears in any result.
    final keyFile = File('${work.path}/ws/keys/editor-dev-key.json');
    expect(keyFile.existsSync(), isTrue);
    final key = jsonDecode(keyFile.readAsStringSync()) as Map;
    final secrets = <String>[
      for (final entry in key.entries)
        if (!const {'keyId', 'publicKeyBase64', 'algorithm', 'createdAt'}.contains(entry.key) && entry.value is String && (entry.value as String).length >= 16) entry.value as String,
    ];
    expect(secrets, isNotEmpty, reason: 'the key file must hold private material for this check to mean anything: ${key.keys}');
    final everything = jsonEncode([plan, published, history, offline, list, inspected, status, await call('studio.build.status', {'project': 'studio-real'})]);
    for (final secret in secrets) {
      expect(everything, isNot(contains(secret)));
    }
    expect(everything, isNot(contains(work.path)));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 3)));

  testWidgets('assets: chunked binary upload, host-side preview, resource inventory, placement save and stale revision', (tester) async {
    await tester.runAsync(() async {
      final recorder = ui.PictureRecorder();
      ui.Canvas(recorder).drawRect(const ui.Rect.fromLTWH(0, 0, 300, 200), ui.Paint()..color = const ui.Color(0xFF00AA00));
      final image = await recorder.endRecording().toImage(300, 200);
      final png = (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
      image.dispose();
      expect(png.length, greaterThan(100));
      final padded = Uint8List.fromList([...png, ...List<int>.filled(200 * 1024, 0)]); // > 1 chunk, trailing NULs: not UTF-8
      final sha = sha256.convert(padded).toString();
      final begin = await call('studio.assets.upload.begin', {'project': 'studio-real', 'name': 'logo.png', 'totalBytes': padded.length, 'sha256': sha});
      final id = begin['uploadId'] as String;
      var chunks = 0;
      for (var offset = 0; offset < padded.length; offset += pocketStudioChunkBytes) {
        final end = (offset + pocketStudioChunkBytes).clamp(0, padded.length);
        await call('studio.fs.upload.chunk', {'project': 'studio-real', 'uploadId': id, 'offset': offset, 'data': base64Encode(padded.sublist(offset, end))});
        chunks++;
      }
      expect(chunks, greaterThan(1));
      final commit = await call('studio.fs.upload.commit', {'project': 'studio-real', 'uploadId': id});
      expect(commit['path'], 'assets/logo.png');
      expect(commit['assets'], contains('logo.png'));
      expect((await call('studio.fs.tree', {'project': 'studio-real', 'assets': true}))['assets'], contains('logo.png'));
      expect((await call('studio.fs.stat', {'project': 'studio-real', 'path': 'assets/logo.png'}))['bytes'], padded.length);

      // Unsafe names are refused by the provider and, for anything that slips through, by the service.
      await expectLater(plugin.invoke('studio.assets.upload.begin', {'project': 'studio-real', 'name': '../logo.png', 'totalBytes': 1, 'sha256': sha}),
          throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'invalid_params')));

      final preview = await call('studio.assets.preview', {'project': 'studio-real', 'name': 'logo.png'});
      expect([preview['sourceWidth'], preview['sourceHeight'], preview['width'], preview['height']], [300, 200, 128, 85]);
      expect([preview['textureWidth'], preview['textureHeight']], [128, 128]);
      final img = preview['img'] as Uint8List;
      expect(img.sublist(8, 12), [0, 170, 0, 255]);
      await expectLater(plugin.invoke('studio.assets.preview', {'project': 'studio-real', 'name': 'missing.png'}),
          throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'not_found')));

      final before = await call('studio.project.resources.get', {'project': 'studio-real'});
      expect(before['packages'], isNotEmpty);
      final started = await call('studio.build.start', {'project': 'studio-real'});
      expect(started['revision'], isA<int>());
      Map status = {};
      for (var i = 0; i < 300; i++) {
        status = await call('studio.build.status', {'project': 'studio-real'});
        if (status['busy'] != true && status['builtRevision'] == status['revision']) break;
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
      expect(status['error'], isNull, reason: '${status['logs']}');
      final inventory = await call('studio.project.resources.get', {'project': 'studio-real'});
      expect(inventory['builtRevision'], status['builtRevision']);
      expect(jsonEncode(inventory), isNot(contains('previewUrl')));
      expect(jsonEncode(inventory), isNot(contains(work.path)));
      final pkg = (inventory['packages'] as List).cast<Map>().first;
      final resources = (pkg['resources'] as List).cast<Map>();
      final logo = resources.firstWhere((r) => (r['key'] as String).endsWith('logo.png'), orElse: () => <String, Object?>{});
      expect(logo, isNotEmpty, reason: 'the built asset appears in the inventory: ${resources.map((r) => r['key'])}');
      expect(logo['kind'], 'asset');
      expect(logo['preview'], isTrue);
      final thumb = await call('studio.project.resources.preview', {
        'project': 'studio-real', 'revision': inventory['builtRevision'], 'package': pkg['id'], 'key': logo['key'],
      });
      expect([thumb['sourceWidth'], thumb['sourceHeight']], [300, 200]);

      final saved = await call('studio.project.resources.set', {
        'project': 'studio-real', 'revision': inventory['revision'], 'packageId': pkg['id'],
        'placements': [{'key': logo['key'], 'placement': 'network'}],
      });
      expect(saved['revision'], (inventory['revision'] as int) + 1);
      final savedLogo = (((saved['packages'] as List).cast<Map>().first['resources']) as List).cast<Map>().firstWhere((r) => r['key'] == logo['key']);
      expect(savedLogo['placement'], 'network');
      await expectLater(
        plugin.invoke('studio.project.resources.set', {
          'project': 'studio-real', 'revision': inventory['revision'], 'packageId': pkg['id'],
          'placements': [{'key': logo['key'], 'placement': 'pak'}],
        }),
        throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'conflict')),
      );
      await expectLater(
        plugin.invoke('studio.project.resources.set', {
          'project': 'studio-real', 'revision': saved['revision'], 'packageId': pkg['id'],
          'placements': [{'key': 'asset:assets/nope.png', 'placement': 'network'}],
        }),
        throwsA(isA<PocketCapabilityException>()),
      );
    });
  }, skip: skip != false, timeout: const Timeout(Duration(minutes: 3)));

  test('project settings: get, set (round trip) and service validation errors reach the guest', () async {
    await call('studio.project.create', {'id': 'studio-settings', 'template': 'app'});
    final before = await call('studio.project.settings.get', {'project': 'studio-settings'});
    expect(before['appId'], isNotEmpty);
    expect(before['build'], 1);
    final saved = await call('studio.project.settings.set', {
      'project': 'studio-settings',
      'settings': {'name': 'Settings 应用', 'appId': 'pocket.settings.app', 'version': '1.2.3', 'tickHz': 30},
    });
    expect(saved['title'], 'Settings 应用', reason: 'the service derives the title from the name (as the web Studio relies on)');
    expect(saved['version'], '1.2.3');
    expect(saved['build'], 1, reason: 'build number is authoritative from committed artifacts and starts at 1');
    expect(saved['tickHz'], 30);
    expect(saved['status'], isA<Map>());
    final again = await call('studio.project.settings.get', {'project': 'studio-settings'});
    expect([again['name'], again['appId'], again['version'], again['build'], again['tickHz']], ['Settings 应用', 'pocket.settings.app', '1.2.3', 1, 30]);
    await expectLater(
      plugin.invoke('studio.project.settings.set', {'project': 'studio-settings', 'settings': {'build': 7}}),
      throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'invalid_params')),
    );
    for (final bad in <Map<String, Object?>>[
      {'appId': 'bad id!'}, {'version': 'v 1'}, {'tickHz': 500}, {'name': '  '},
    ]) {
      await expectLater(plugin.invoke('studio.project.settings.set', {'project': 'studio-settings', 'settings': bad}),
          throwsA(isA<PocketCapabilityException>().having((e) => e.message, 'message', isNotEmpty)), reason: '$bad');
    }
    expect((await call('studio.project.settings.get', {'project': 'studio-settings'}))['tickHz'], 30, reason: 'a rejected save changes nothing');
  }, skip: skip, timeout: const Timeout(Duration(seconds: 60)));

  test('ecosystem modules and COS configuration through the real service', () async {
    final catalog = await call('studio.ecosystem.catalog');
    expect(catalog['modules'], isA<List>());
    expect((catalog['modules'] as List), isNotEmpty);
    final firstModId = ((catalog['modules'] as List).first as Map)['id'] as String;

    final initialEco = await call('studio.ecosystem.get', {'project': 'studio-settings'});
    expect(initialEco['modules'], isA<List>());

    final updatedEco = await call('studio.ecosystem.set', {
      'project': 'studio-settings',
      'modules': <String>[firstModId],
    });
    expect(updatedEco['modules'], contains(firstModId));
    expect((await call('studio.ecosystem.get', {'project': 'studio-settings'}))['modules'], contains(firstModId));

    final initialCos = await call('studio.cos.get', {'project': 'studio-settings'});
    expect((initialCos['config'] as Map)['enabled'], isFalse);

    final updatedCos = await call('studio.cos.set', {
      'project': 'studio-settings',
      'enabled': false,
      'syncOnPublish': true,
      'bucket': 'demo-1250000000',
      'region': 'ap-guangzhou',
      'keyPrefix': 'releases/demo',
      'credentials': {
        'secretId': 'AKIDREALTESTSECRET123456',
        'secretKey': 'SUPERSECRETKEYVALUE9876543210',
      },
    });
    expect((updatedCos['config'] as Map)['bucket'], 'demo-1250000000');
    expect((updatedCos['config'] as Map)['region'], 'ap-guangzhou');
    expect((updatedCos['config'] as Map)['syncOnPublish'], isTrue);
    final cosGet = await call('studio.cos.get', {'project': 'studio-settings'});
    final cosJson = jsonEncode([updatedCos, cosGet]);
    expect(cosJson, isNot(contains('SUPERSECRETKEYVALUE9876543210')));
    expect(cosJson, isNot(contains('AKIDREALTESTSECRET123456')));
    expect(cosJson, isNot(contains(work.path)));

    final clearedCos = await call('studio.cos.set', {
      'project': 'studio-settings',
      'credentials': null,
    });
    expect(jsonEncode(clearedCos), isNot(contains('SUPERSECRETKEYVALUE9876543210')));
  }, skip: skip, timeout: const Timeout(Duration(seconds: 60)));

  test('diagnostics export through the real service: bundle summary, derived id, scrubbed, downloadable URL', () async {
    final result = await call('studio.logs.diagnostics', {'project': 'studio-settings'});
    expect(result['format'], 'pocket-diagnostics-export');
    expect(result['exportId'], startsWith('diag-studio-settings-'));
    expect(result['totalRecords'], isA<int>());
    expect(result['records'], isA<List>());
    expect(result['truncated'], isFalse);
    final text = jsonEncode(result);
    expect(text, isNot(contains(work.path)));
    expect(text, isNot(contains(sdkRoot)));
    expect(text, isNot(contains('csrf')));
    await expectLater(plugin.invoke('studio.logs.diagnostics', {'project': 'studio-settings', 'kind': 'nope'}),
        throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'invalid_params')));
    await expectLater(plugin.invoke('studio.logs.diagnostics', {'project': 'no-such-project'}),
        throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'not_found')));
    // The URL the guest shows really serves the full export as a file.
    final client = HttpClient()..findProxy = ((_) => 'DIRECT');
    try {
      final response = await (await client.getUrl(Uri.parse(result['downloadUrl'] as String))).close();
      expect(response.statusCode, 200);
      expect(response.headers.value('content-disposition'), contains('studio-settings-diagnostics.json'));
      await response.drain<void>();
    } finally {
      client.close(force: true);
    }
  }, skip: skip, timeout: const Timeout(Duration(seconds: 60)));

  test('SDK upgrade: status, check against a local releases feed (never applies) and source checkout deferral', () async {
    final status = await call('studio.service.upgrade.status');
    expect(status['mode'], 'source');
    expect(status['autoUpgradeSupported'], isTrue);
    expect(status['upgradeAvailable'], isFalse);
    expect(jsonEncode(status), isNot(contains(sdkRoot)));
    final checked = await call('studio.service.upgrade.check');
    expect(checked['latestVersion'], '99.0.0');
    expect(checked['upgradeAvailable'], isTrue);
    expect(checked['mode'], 'source');
    expect(checked['status'], 'available', reason: 'a source checkout only reports; the check must not have started an apply');
    expect(checked['releaseUrl'], contains('sdk-v99.0.0'));
    expect(jsonEncode(checked), isNot(contains(sdkRoot)));
    try {
      final applied = await call('studio.service.upgrade.apply', const {});
      expect(applied['status'], 'available');
      expect(applied['deferredReason'], isA<String>());
      expect((applied['deferredReason'] as String), isNotEmpty);
    } on PocketCapabilityException catch (e) {
      expect(e.code, 'conflict');
      expect(e.message, contains('HTTP 409'));
    }
    expect((await call('studio.service.upgrade.status'))['mode'], 'source');
  }, skip: skip, timeout: const Timeout(Duration(seconds: 60)));
}
