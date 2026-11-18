import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_studio/pocket_studio.dart';

import 'fake_service.dart';

/// A real PNG made by the engine: left half opaque red, right half opaque blue.
Future<Uint8List> makePng(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(ui.Rect.fromLTWH(0, 0, width / 2, height.toDouble()), ui.Paint()..color = const ui.Color(0xFFFF0000));
  canvas.drawRect(ui.Rect.fromLTWH(width / 2, 0, width / 2, height.toDouble()), ui.Paint()..color = const ui.Color(0xFF0000FF));
  final image = await recorder.endRecording().toImage(width, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null; // the real loopback FakeService, not the test binding's 400 client
  late FakeService service;
  late PocketStudioPlugin plugin;

  setUp(() async {
    service = await FakeService.start();
    plugin = PocketStudioPlugin(config: PocketStudioConfig(port: service.port, sdkRoot: '/opt/pocket/sdk'));
  });
  tearDown(() async {
    await plugin.dispose();
    await service.close();
  });

  Future<Object?> call(String name, [Map<String, dynamic> params = const {}]) => plugin.invoke(name, params);
  Future<PocketCapabilityException> failure(String name, Map<String, dynamic> params) async {
    try {
      await call(name, params);
    } on PocketCapabilityException catch (error) {
      return error;
    }
    fail('$name should have failed');
  }

  List<FakeRequest> served() => service.requests.where((r) => r.uri.path != '/health').toList();

  group('chunked asset upload', () {
    test('begin maps to the uploads route with target asset and a flat name', () async {
      service.handler = (r) async => const FakeReply(201, {'uploadId': 'u-1', 'chunkBytes': 131072, 'expiresInMs': 600000});
      final result = await call('studio.assets.upload.begin', {'project': 'demo', 'name': 'logo.png', 'totalBytes': 12, 'sha256': 'A' * 64}) as Map;
      expect(result['uploadId'], 'u-1');
      final request = served().single;
      expect(request.method, 'POST');
      expect(request.uri.path, '/api/projects/demo/uploads');
      expect(request.headers.value('x-pocket-csrf'), isNotNull);
      expect(request.json, {'target': 'asset', 'name': 'logo.png', 'totalBytes': 12, 'sha256': 'A' * 64});
    });

    test('unsafe names, bad hashes and oversized assets never reach the service', () async {
      for (final name in ['../x.png', 'a/b.png', '.hidden', 'a\\b.png', '', 'x' * 129, 'a b.png', 'a\u0000.png', '%2e%2e']) {
        expect((await failure('studio.assets.upload.begin', {'project': 'demo', 'name': name, 'totalBytes': 1, 'sha256': 'a' * 64})).code, 'invalid_params', reason: name);
      }
      expect((await failure('studio.assets.upload.begin', {'project': 'demo', 'name': 'a.png', 'totalBytes': 1, 'sha256': 'zz'})).code, 'invalid_params');
      expect((await failure('studio.assets.upload.begin', {'project': 'demo', 'name': 'a.png', 'totalBytes': -1, 'sha256': 'a' * 64})).code, 'invalid_params');
      expect((await failure('studio.assets.upload.begin', {'project': 'demo', 'name': 'a.png', 'totalBytes': pocketStudioMaxAssetBytes + 1, 'sha256': 'a' * 64})).code, 'too_large');
      expect(served(), isEmpty);
      service.handler = (r) async => const FakeReply(201, {'uploadId': 'u-2'});
      await call('studio.assets.upload.begin', {'project': 'demo', 'name': 'a.png', 'totalBytes': pocketStudioMaxAssetBytes, 'sha256': 'a' * 64});
      expect(served(), hasLength(1));
    });

    test('service refusals map to structured errors', () async {
      service.handler = (r) async => const FakeReply(413, {'error': 'upload exceeds 33554432 bytes'});
      expect((await failure('studio.assets.upload.begin', {'project': 'demo', 'name': 'a.png', 'totalBytes': 1, 'sha256': 'a' * 64})).code, 'too_large');
    });
  });

  group('resources', () {
    final inventory = <String, Object?>{
      'revision': 7,
      'builtRevision': 6,
      'packages': [
        {
          'id': 'dev.demo', 'title': 'Demo', 'manifest': 'pocket.json', 'updateUrl': 'http://127.0.0.1:9/u',
          'resources': [
            {'key': 'asset:assets/logo.png', 'kind': 'asset', 'bytes': 10, 'placement': 'pak',
             'previewUrl': '/api/projects/demo/resources/preview?revision=6&package=dev.demo&key=asset%3Aassets%2Flogo.png'},
            {'key': 'pak:ui:font.1', 'kind': 'pak', 'bytes': 20, 'placement': 'pak', 'locked': true, 'reason': '/Users/dev/ws/projects/demo/x'},
          ],
        },
      ],
    };

    test('get keeps revisions and flags previews instead of leaking the relative route; paths are scrubbed', () async {
      service.handler = (r) async => FakeReply(200, inventory);
      final result = await call('studio.project.resources.get', {'project': 'demo'}) as Map;
      expect(result['revision'], 7);
      expect(result['builtRevision'], 6);
      final resources = ((result['packages'] as List).single as Map)['resources'] as List;
      expect(resources.first, {'key': 'asset:assets/logo.png', 'kind': 'asset', 'bytes': 10, 'placement': 'pak', 'preview': true});
      expect((resources.last as Map).containsKey('preview'), isFalse);
      expect(jsonEncode(result), isNot(contains('/Users/dev')));
      expect(jsonEncode(result), isNot(contains('previewUrl')));
      expect(served().single.uri.path, '/api/projects/demo/resources');
    });

    test('set sends revision, package and validated placements; a stale revision is a conflict', () async {
      service.handler = (r) async => FakeReply(200, inventory);
      await call('studio.project.resources.set', {
        'project': 'demo', 'revision': 7, 'packageId': 'dev.demo',
        'placements': [{'key': 'asset:assets/logo.png', 'placement': 'network', 'extra': 1}],
      });
      final request = served().last;
      expect(request.method, 'PUT');
      expect(request.uri.path, '/api/projects/demo/resources');
      expect(request.json, {'revision': 7, 'packageId': 'dev.demo', 'placements': [{'key': 'asset:assets/logo.png', 'placement': 'network'}]});
      expect(request.headers.value('x-pocket-csrf'), isNotNull);
      service.handler = (r) async => const FakeReply(409, {'error': 'resource revision is stale; reload the project and retry'});
      expect((await failure('studio.project.resources.set', {'project': 'demo', 'revision': 1, 'packageId': 'dev.demo', 'placements': <Object>[]})).code, 'conflict');
    });

    test('set validation: placement values, duplicates, shapes', () async {
      service.requests.clear();
      Map<String, dynamic> p(Object? placements, {Object? revision = 1, Object? pkg = 'dev.demo'}) =>
          {'project': 'demo', 'revision': revision, 'packageId': pkg, 'placements': placements};
      for (final bad in [
        p('nope'),
        p([{'key': 'a', 'placement': 'cloud'}]),
        p([{'key': '', 'placement': 'pak'}]),
        p([{'key': 'a'}]),
        p([{'key': 'a', 'placement': 'pak'}, {'key': 'a', 'placement': 'network'}]),
        p([], revision: -1),
        p([], revision: 1.5),
        p([], pkg: ''),
        p([], pkg: 'x' * 129),
      ]) {
        expect((await failure('studio.project.resources.set', bad)).code, 'invalid_params');
      }
      expect(served(), isEmpty);
    });
  });

  group('image previews (host-side decode)', () {
    testWidgets('asset preview decodes a real PNG into a bounded IMG entry the guest can upload', (tester) async {
      await tester.runAsync(() async {
        final png = await makePng(40, 20);
        service.handler = (r) async => FakeReply(200, null, raw: png, contentType: 'image/png');
        final result = await call('studio.assets.preview', {'project': 'demo', 'name': 'logo.png'}) as Map;
        expect(served().single.uri.path, '/api/projects/demo/assets/logo.png');
        expect(result['name'], 'logo.png');
        expect([result['width'], result['height']], [40, 20]);
        expect([result['textureWidth'], result['textureHeight']], [64, 32]);
        expect([result['sourceWidth'], result['sourceHeight']], [40, 20]);
        final img = result['img'] as Uint8List;
        expect(img.length, 8 + 64 * 32 * 4);
        final header = ByteData.sublistView(img);
        expect([header.getUint16(0, Endian.little), header.getUint16(2, Endian.little), img[4], img[5], header.getUint16(6, Endian.little)], [64, 32, 3, 2, 0]);
        int pixel(int x, int y) => 8 + (y * 64 + x) * 4;
        expect(img.sublist(pixel(2, 2), pixel(2, 2) + 4), [255, 0, 0, 255], reason: 'left half is red');
        expect(img.sublist(pixel(30, 2), pixel(30, 2) + 4), [0, 0, 255, 255], reason: 'right half is blue');
        expect(img.sublist(pixel(50, 2), pixel(50, 2) + 4), [0, 0, 0, 0], reason: 'envelope padding is transparent');
        expect(img.sublist(pixel(2, 25), pixel(2, 25) + 4), [0, 0, 0, 0]);
      });
    });

    testWidgets('a large image is scaled down so the envelope stays within 128 px and the response quota', (tester) async {
      await tester.runAsync(() async {
        final png = await makePng(1000, 300);
        service.handler = (r) async => FakeReply(200, null, raw: png, contentType: 'image/png');
        final result = await call('studio.assets.preview', {'project': 'demo', 'name': 'wide.png'}) as Map;
        expect([result['sourceWidth'], result['sourceHeight']], [1000, 300]);
        expect(result['width'], 128);
        expect(result['height'], inInclusiveRange(37, 39));
        expect(result['textureWidth'], 128);
        expect(result['textureHeight'], 64);
        expect((result['img'] as Uint8List).length, lessThan(256 * 1024));
      });
    });

    test('svg, non-image names and corrupt bytes fail honestly; nothing is faked', () async {
      expect((await failure('studio.assets.preview', {'project': 'demo', 'name': 'icon.svg'})).code, 'unsupported_format');
      expect((await failure('studio.assets.preview', {'project': 'demo', 'name': 'clip.wav'})).code, 'not_an_image');
      expect((await failure('studio.assets.preview', {'project': 'demo', 'name': 'noext'})).code, 'not_an_image');
      expect((await failure('studio.assets.preview', {'project': 'demo', 'name': '../a.png'})).code, 'invalid_params');
      expect(served(), isEmpty);
      service.handler = (r) async => FakeReply(200, null, raw: utf8.encode('not really a png'), contentType: 'image/png');
      expect((await failure('studio.assets.preview', {'project': 'demo', 'name': 'bad.png'})).code, 'decode_failed');
      service.handler = (r) async => const FakeReply(404, {'error': 'asset not found'});
      expect((await failure('studio.assets.preview', {'project': 'demo', 'name': 'gone.png'})).code, 'not_found');
      service.handler = (r) async => FakeReply(200, null, raw: utf8.encode('<svg/>'), contentType: 'image/svg+xml');
      expect((await failure('studio.project.resources.preview', {'project': 'demo', 'revision': 1, 'package': 'p', 'key': 'asset:assets/a.png'})).code, 'unsupported_format');
    });

    testWidgets('resource preview forwards revision, package and key and decodes the thumbnail', (tester) async {
      await tester.runAsync(() async {
        final png = await makePng(8, 8);
        service.handler = (r) async => FakeReply(200, null, raw: png, contentType: 'image/png');
        final result = await call('studio.project.resources.preview', {'project': 'demo', 'revision': 6, 'package': 'dev.demo', 'key': 'asset:assets/a b.png'}) as Map;
        final request = served().single;
        expect(request.uri.path, '/api/projects/demo/resources/preview');
        expect(request.uri.queryParameters, {'revision': '6', 'package': 'dev.demo', 'key': 'asset:assets/a b.png'});
        expect(result['key'], 'asset:assets/a b.png');
        expect([result['width'], result['height'], result['textureWidth']], [8, 8, 8]);
      });
    });

    test('preview calls need only studio.read and decode through the plugin manager quota', () async {
      final host = PocketHost(
        registry: PocketHostRegistry(),
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: pocketStudioCapabilityNames,
        send: (_, __) => true,
      );
      final manager = PocketPluginManager(host: host, appId: 'dev.pocket.studio', sessionId: '1', allowedPermissions: {'studio.read'});
      manager.register(plugin);
      await manager.activate(manager.negotiate(
        required: const [],
        optional: ['studio.assets.preview', 'studio.assets.upload.begin'],
        requestedPermissions: ['studio.read', 'studio.write'],
      ));
      addTearDown(manager.dispose);
      await expectLater(
        manager.invoke('studio.assets.upload.begin', {'project': 'demo', 'name': 'a.png', 'totalBytes': 1, 'sha256': 'a' * 64}),
        throwsA(isA<PocketCapabilityException>()),
      );
      expect(served(), isEmpty);
    });
  });
}
