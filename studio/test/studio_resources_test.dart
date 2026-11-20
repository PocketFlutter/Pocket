import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_studio/pocket_studio.dart';
import 'package:pocket_studio_app/main.dart';

/// The 资源 page end to end on the real stack (Linux): the native runtime runs the Studio bytecode; the host's own grants and
/// plugins (studio.*, clipboard and the new file picker) are registered exactly as `studioSystemUI` declares them; a real editor
/// service runs on a TEMP project. Only the platform file dialog is a stand-in (the `file_selector` method channel returns
/// a temp file), because the real dialog needs a desktop. The guest is driven by pointer taps on labels it draws.
///
/// Facts observed: the bytes that land in the project's `assets/` (equal to the picked file, uploaded in 128 KiB chunks
/// through files.readChunk -> studio.fs.upload.*), the unsafe name that never reaches the service, the real host-decoded PNG
/// drawn as an image op with a texture, SVG reported as unsupported, the placement save that rewrites pocket.resources.json,
/// and a stale revision refused by the real service. Not covered: the real macOS NSOpenPanel.
void requireReal(Object? skipReason) {
  if (skipReason != null && skipReason != false && Platform.environment['POCKET_REQUIRE_REAL'] == '1') {
    fail('POCKET_REQUIRE_REAL=1: $skipReason');
  }
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final bun = Platform.environment['POCKET_BUN'] ?? '${Platform.environment['HOME']}/.bun/bin/bun';
  final repo = Directory.current.parent.path;
  final skip = nativeLibrary == null
      ? 'POCKET_NATIVE_LIBRARY is not set'
      : !File(bun).existsSync()
      ? 'bun executable not found (set POCKET_BUN)'
      : false;
  requireReal(skip);

  late Directory work;
  late Directory project;
  late PocketStudioConfig config;
  late PocketStudioService service;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('studio-resources-');
    project = Directory('${work.path}/res-app')..createSync();
    File('${project.path}/pocket.json').writeAsStringSync(jsonEncode({'app': {'entry': 'app.tsx'}, 'version': '1.0.0', 'build': 1}));
    File('${project.path}/editor.json').writeAsStringSync(jsonEncode({
      'id': 'res-app', 'appId': 'pocket.res', 'name': 'Res App', 'title': 'Res App',
      'version': '1.0.0', 'build': 1, 'tickHz': 60, 'entry': 'app.tsx', 'output': 'app', 'framework': 'solid',
    }));
    File('${project.path}/manifest.json').writeAsStringSync('{"capabilities":{"requires":[]}}');
    File('${project.path}/app.tsx').writeAsStringSync(_source);
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    config = PocketStudioConfig(
      port: port,
      sdkRoot: '$repo/sdk',
      projectRoot: project.path,
      workspace: '${work.path}/ws',
      bunExecutable: bun,
      environment: {...Platform.environment, 'POCKET_SOURCE_BUILD': '1', 'TMPDIR': '/tmp'},
    );
    service = PocketStudioService(config, stopOnExit: false);
    await service.start();
  });

  tearDownAll(() async {
    if (skip != false) return;
    await service.stop();
    await work.delete(recursive: true);
  });

  test('upload an image through the file dialog capability, preview it, and edit placements; stale saves are refused', () async {
    final messenger = binding.defaultBinaryMessenger;
    final picked = Directory('${work.path}/picked')..createSync();

    // A real PNG (300 x 200, left half green) plus trailing zero bytes so the file is > 1 chunk and not UTF-8.
    final recorder = ui.PictureRecorder();
    ui.Canvas(recorder)
      ..drawRect(const ui.Rect.fromLTWH(0, 0, 150, 200), ui.Paint()..color = const ui.Color(0xFF00AA00))
      ..drawRect(const ui.Rect.fromLTWH(150, 0, 150, 200), ui.Paint()..color = const ui.Color(0xFF0000FF));
    final image = await recorder.endRecording().toImage(300, 200);
    final png = (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
    image.dispose();
    final artBytes = Uint8List.fromList([...png, ...List<int>.filled(200 * 1024, 0)]);
    final art = File('${picked.path}/art.png')..writeAsBytesSync(artBytes);
    final unsafe = File('${picked.path}/bad name.png')..writeAsBytesSync(png);
    final icon = File('${picked.path}/icon.svg')..writeAsStringSync('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
    var dialogCalls = 0;
    messenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/file_selector'), (call) async {
      dialogCalls++;
      expect(call.method, 'openFile');
      final args = call.arguments as Map;
      expect(args['multiple'], isTrue);
      expect(((args['acceptedTypeGroups'] as List).single as Map)['extensions'], containsAll(['png', 'wav', 'ttf']));
      return [art.path, unsafe.path, icon.path];
    });
    addTearDown(() => messenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/file_selector'), null));

    final ui0 = studioSystemUI(config);
    expect(ui0.allowedPermissions, contains('files.open'));
    final assets = '$repo/studio/assets';
    final entry = Uint8List.fromList(await File('$assets/app.qjbc').readAsBytes());
    final pak = Uint8List.fromList(await File('$assets/app.pak').readAsBytes());
    final metadata = jsonDecode(await File('$assets/app.bytecode.json').readAsString()) as Map;
    final manifest = PocketGuestManifest.fromJsonString(await File('$assets/guest-manifest.json').readAsString());
    expect(manifest.declaredPermissions, contains('files.open'));
    expect(manifest.optionalCapabilities, containsAll(['files.pickOpen', 'files.readChunk', 'studio.assets.preview', 'studio.project.resources.set']));

    final runtime = FfiPocketRuntime.open(width: 960, height: 700);
    expect(syncPocketHostFonts(runtime), isTrue);
    final toGuest = <String>[];
    bool send(String method, Map<String, dynamic> params) {
      toGuest.add(params.toString());
      runtime.send(<String, dynamic>{'type': 'event', 'name': method, 'payload': params});
      return true;
    }

    final providers = [for (final factory in ui0.pluginFactories) factory(PocketViewController())];
    final host = PocketHost(
      registry: PocketHostRegistry(),
      streams: PocketStreamBridge(send: send),
      allowedCapabilities: {for (final p in providers) ...p.descriptor.capabilities.keys},
      send: send,
    );
    final manager = PocketPluginManager(host: host, appId: ui0.appId, sessionId: 'studio-resources', allowedPermissions: ui0.allowedPermissions);
    for (final provider in providers) {
      manager.register(provider);
    }
    await manager.activate(manager.negotiate(
      required: manifest.requiredCapabilities.where((c) => c.startsWith('studio.')),
      optional: manifest.optionalCapabilities,
      requestedPermissions: manifest.declaredPermissions,
    ));

    var frame = runtime.loadBytecode(entry, pak, expectedRuntimeAbi: metadata['runtimeAbi'] as String);
    Future<void> pump([int count = 1]) async {
      for (var i = 0; i < count; i++) {
        for (final event in frame.events) {
          if (event.method == 'host.request' || event.method.startsWith('stream.')) unawaited(host.handle(event));
        }
        await Future<void>.delayed(const Duration(milliseconds: 4));
        frame = runtime.frame(16);
      }
    }

    String textOf() => frame.ops.whereType<PocketTextOp>().map((op) => op.text).join('\n');
    Future<void> until(bool Function() ok, String what, {Duration timeout = const Duration(seconds: 90)}) async {
      final clock = Stopwatch()..start();
      while (clock.elapsed < timeout && !ok()) {
        await pump();
      }
      if (!ok()) fail('timed out waiting for $what\n${textOf()}');
    }

    Future<void> tap(String label, {int nth = 0}) async {
      await pump(10);
      final ops = frame.ops.whereType<PocketTextOp>().where((o) => o.text == label).toList();
      if (ops.length <= nth) throw StateError('no "$label" #$nth in\n${textOf()}');
      final op = ops[nth];
      final point = {'id': 0, 'x': op.x + (op.width / 2 < 60 ? op.width / 2 : 40), 'y': op.y + (op.height / 2 < 20 ? op.height / 2 : 10)};
      for (final phase in const ['down', 'up']) {
        runtime.send({'type': 'event', 'name': 'input.pointer', 'payload': {...point, 'phase': phase}});
        await pump(2);
      }
    }

    int imageOps() => frame.ops.whereType<PocketImageOp>().length;

    try {
      await until(() => textOf().contains('Res App'), 'project list');
      await tap('Res App');
      await until(() => textOf().contains('app.tsx'), 'file tree');
      await tap('资源');
      await until(() => textOf().contains('上传资源…'), 'the resources page');
      expect(textOf(), contains('assets/ 中还没有资源。'));

      // ---- upload ----------------------------------------------------------------------------------------------
      final imagesBefore = imageOps();
      await tap('上传资源…');
      await until(() => textOf().contains('art.png · ') && textOf().contains('已拒绝') && textOf().contains('不支持') == false && textOf().contains('清除记录') && File('${project.path}/assets/icon.svg').existsSync(), 'the uploads to finish');
      expect(dialogCalls, 1);
      expect(File('${project.path}/assets/art.png').readAsBytesSync(), artBytes, reason: 'the exact picked bytes landed in assets/');
      expect(File('${project.path}/assets/bad name.png').existsSync(), isFalse, reason: 'an unsafe name never reaches the service');
      expect(Directory('${project.path}/assets').listSync().map((e) => e.uri.pathSegments.last).toSet(), {'art.png', 'icon.svg'});
      expect(textOf(), contains('文件名不安全'));
      await until(() => textOf().contains('art.png') && textOf().contains('图片'), 'the asset list to refresh');

      // ---- preview: a real host-decoded texture --------------------------------------------------------------
      await tap('art.png', nth: 0);
      await until(() => textOf().contains('预览（宿主解码') && imageOps() > imagesBefore, 'the decoded preview drawn as an image');
      expect(textOf(), contains('原图 300×200'));
      await tap('icon.svg');
      await until(() => textOf().contains('SVG 无法由宿主解码，没有预览。'), 'the SVG message');
      expect(textOf(), isNot(contains('预览（宿主解码')));

      // ---- placement editor on the real service ----------------------------------------------------------------
      await tap('包资源策略');
      await until(() => textOf().contains('还没有成功的构建'), 'the unbuilt note');
      final plugin = PocketStudioPlugin(config: config);
      addTearDown(plugin.dispose);
      await plugin.invoke('studio.build.start', {'project': 'res-app'});
      Map status = {};
      for (var i = 0; i < 400; i++) {
        status = await plugin.invoke('studio.build.status', {'project': 'res-app'}) as Map;
        if (status['busy'] != true && status['builtRevision'] == status['revision']) break;
        await pump();
      }
      expect(status['error'], isNull, reason: '${status['logs']}');
      await until(() => textOf().contains('asset:assets/art.png'), 'the built inventory after the build finished (refreshed by the guest)');
      await tap('asset:assets/art.png');
      await until(() => textOf().contains('资产文件'), 'the resource detail');
      await until(() => textOf().contains('预览（宿主解码'), 'the resource thumbnail');
      await tap('网络');
      await until(() => textOf().contains('1 项修改未保存'), 'the unsaved count');
      await tap('保存资源策略');
      await until(() => textOf().contains('资源策略已保存'), 'the placement save');
      final policy = jsonDecode(File('${project.path}/pocket.resources.json').readAsStringSync()) as Map;
      expect(jsonEncode(policy), contains('asset:assets/art.png'));
      expect(jsonEncode((policy['packages'] as Map).values.first), contains('"network"'));

      // A change behind the guest's back makes the next save stale: the real service answers 409 and the page prompts a reload.
      await plugin.invoke('studio.fs.write', {'project': 'res-app', 'path': 'notes.ts', 'content': 'export const n = 1;\n'});
      await tap('资源策略已保存。请构建项目以应用。', nth: 0).catchError((_) {}); // dismiss the toast over the save button when present
      await until(() => !textOf().contains('资源策略已保存'), 'the toast to go');
      await tap('基础包');
      await until(() => textOf().contains('1 项修改未保存'), 'the second draft');
      await tap('保存资源策略');
      await until(() => textOf().contains('修订号过期'), 'the stale prompt from the real service');
      expect(textOf(), contains('重新加载'));

      // No absolute path or secret ever reached the guest.
      final everything = toGuest.join('\n');
      expect(everything, isNot(contains(work.path)));
      expect(everything, isNot(contains(picked.path)), reason: 'the picked file path stays on the host');
    } finally {
      await manager.dispose();
      runtime.dispose();
    }
  }, skip: skip != false, timeout: const Timeout(Duration(minutes: 8)));
}

const String _source = '''
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";

mount(() => <Screen class="w-full h-full flex-col bg-white"><View class="p-4"><Text class="text-base text-black">res app</Text></View></Screen>);
''';
