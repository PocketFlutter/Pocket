import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_studio/pocket_studio.dart';
import 'package:pocket_studio_app/main.dart';

/// M1 exit test: "the Studio window lists the files of demo/js using
/// capabilities only". Everything is real: the native QuickJS runtime, the
/// Studio bytecode built by the pinned buildGuest, the host's own
/// `studioSystemUI` configuration (grants, plugins), `PocketStudioPlugin` and a
/// real editor service started by `PocketStudioService` with `--project-root`
/// pointing at the demo's JS project. The guest can reach the service only
/// through studio.* capabilities.
/// POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure instead of a skip.
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
  final projectRoot = <String>[repo, 'demo', 'js'].join('/');
  final skip = nativeLibrary == null
      ? 'POCKET_NATIVE_LIBRARY is not set'
      : !File(bun).existsSync()
      ? 'bun executable not found (set POCKET_BUN)'
      : !Directory(projectRoot).existsSync()
      ? 'sample project is missing'
      : false;
  requireReal(skip);

  late Directory work;
  late Directory multiPreviewProject;
  late PocketStudioConfig config;
  late PocketStudioService service;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('studio-host-');
    multiPreviewProject = Directory('${work.path}/multi-preview-demo')..createSync();
    File('${multiPreviewProject.path}/pocket.json').writeAsStringSync(
      jsonEncode({'app': {'entry': 'app.tsx'}, 'version': '1.0.0', 'build': 1}),
    );
    File('${multiPreviewProject.path}/editor.json').writeAsStringSync(
      jsonEncode({
        'id': 'multi-preview-demo',
        'appId': 'pocket.multipreview',
        'name': 'Multi-Surface Preview Showcase',
        'title': 'Multi-Surface Preview Showcase',
        'version': '1.0.0',
        'build': 1,
        'tickHz': 60,
        'entry': 'app.tsx',
        'output': 'app',
        'framework': 'solid',
      }),
    );
    File('${multiPreviewProject.path}/manifest.json').writeAsStringSync('{"capabilities":{"requires":[],"optional":["camera.capture"]},"permissions":{"requires":[],"optional":["hardware.camera","hardware.microphone"]}}');
    File('${multiPreviewProject.path}/app.tsx').writeAsStringSync(_multiPreviewSource());

    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    config = PocketStudioConfig(
      port: port,
      sdkRoot: '$repo/sdk',
      projectRoot: projectRoot,
      extraProjectRoots: <String>[multiPreviewProject.path],
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

  test('preview children get no studio, clipboard or file grants; Studio registers all 5 preview compositor surfaces', () {
    final studio = studioSystemUI(PocketStudioConfig(port: 1));
    final child = studioPreviewChild(PocketStudioConfig(port: 1));
    final children = studioPreviewChildren(PocketStudioConfig(port: 1));
    expect(studio.appId, 'dev.pocket.studio');
    expect(studio.compositorSurfaces, PocketStudioConfig.previewCompositorSurfaces);
    expect(studio.allowedPermissions, {...PocketStudioPermissions.all, 'clipboard.read', 'clipboard.write', 'files.open'});
    expect(studio.allowedPermissions, PocketStudioConfig.hostPermissions);
    expect([for (final f in studio.pluginFactories) f(PocketViewController()).descriptor.id], ['pocket.studio', 'flutter.clipboard', 'flutter.files']);
    expect(studio.rawTextInputEnabled, isTrue);
    expect(studio.textLayoutCacheCapacity, 2048);
    expect(child.textLayoutCacheCapacity, 256, reason: 'the preview child keeps the default');
    expect(studio.memoryLimits.heapLimitBytes, PocketMemoryLimits.maximumHeapBytes);
    expect(child.appId, PocketStudioConfig.previewAppId);
    expect(children.keys.toList(), PocketStudioConfig.allPreviewAppIds);
    for (final entry in children.entries) {
      expect(entry.value.appId, entry.key);
      expect(entry.value.allowedPermissions, isEmpty);
      expect(entry.value.pluginFactories, isEmpty);
      expect(entry.value.additionalCapabilities, isEmpty);
    }
  });

  test('Studio window lists the files of demo/js using capabilities only', () async {
    final ui = studioSystemUI(config);
    final assets = '$repo/studio/assets';
    final entry = Uint8List.fromList(await File('$assets/app.qjbc').readAsBytes());
    final pak = Uint8List.fromList(await File('$assets/app.pak').readAsBytes());
    final metadata = jsonDecode(await File('$assets/app.bytecode.json').readAsString()) as Map;
    final manifest = PocketGuestManifest.fromJsonString(await File('$assets/guest-manifest.json').readAsString());

    final runtime = FfiPocketRuntime.open(width: 900, height: 1400);
    expect(syncPocketHostFonts(runtime), isTrue); // the view installs host font metrics before load
    final requested = <String>[];
    // The same wiring PocketSession uses: PocketHost + PocketPluginManager
    // admission with the host's allowedPermissions and the guest's manifest.
    late PocketHost host;
    bool send(String method, Map<String, dynamic> params) {
      runtime.send(<String, dynamic>{'type': 'event', 'name': method, 'payload': params});
      return true;
    }

    final registry = PocketHostRegistry();
    final providers = [for (final factory in ui.pluginFactories) factory(PocketViewController())];
    host = PocketHost(
      registry: registry,
      streams: PocketStreamBridge(send: send),
      allowedCapabilities: {for (final p in providers) ...p.descriptor.capabilities.keys},
      send: send,
    );
    final manager = PocketPluginManager(
      host: host,
      appId: ui.appId,
      sessionId: 'studio-test',
      allowedPermissions: ui.allowedPermissions,
    );
    for (final provider in providers) {
      manager.register(provider);
    }
    final negotiated = manager.negotiate(
      required: manifest.requiredCapabilities.where((c) => c.startsWith('studio.')),
      optional: manifest.optionalCapabilities,
      requestedPermissions: manifest.declaredPermissions,
    );
    await manager.activate(negotiated);

    var frame = runtime.loadBytecode(entry, pak, expectedRuntimeAbi: metadata['runtimeAbi'] as String);
    Future<PocketFrame> pump([int count = 1]) async {
      for (var i = 0; i < count; i++) {
        for (final event in frame.events) {
          if (event.method == 'host.request') requested.add('${event.params['capability']}');
          unawaited(host.handle(event));
        }
        await Future<void>.delayed(const Duration(milliseconds: 4));
        frame = runtime.frame(16);
      }
      return frame;
    }

    String textOf() => frame.ops.whereType<PocketTextOp>().map((op) => op.text).join('\n');
    Future<void> until(bool Function() ok, String what) async {
      for (var i = 0; i < 1500 && !ok(); i++) {
        await pump();
      }
      expect(ok(), isTrue, reason: 'timed out waiting for $what\nrequested=$requested\n${textOf()}');
    }

    Future<void> tap(String label) async {
      final op = frame.ops.whereType<PocketTextOp>().firstWhere((o) => o.text == label, orElse: () => throw StateError('no "$label" in\n${textOf()}'));
      final point = {'id': 0, 'x': op.x + op.width / 2, 'y': op.y + op.height / 2};
      for (final phase in const ['down', 'up']) {
        runtime.send({'type': 'event', 'name': 'input.pointer', 'payload': {...point, 'phase': phase}});
        await pump();
      }
    }

    // The Studio's default editor is the CodeView (M4); these M2 tests drive the multi-line InputField, so pick it in Settings.
    Future<void> useInputFieldEditor() async {
      await tap('设置');
      await until(() => textOf().contains('多行输入框（备用）'), 'settings page');
      await tap('多行输入框（备用）');
      await pump(10);
      await tap('源码');
      await until(() => textOf().contains('+ 文件'), 'source page');
    }

    try {
      // 1. The project list comes from studio.project.list on the real service.
      await until(() => textOf().contains('PocketJS Flutter host showcase'), 'project list');
      final before = textOf();
      expect(before, contains('项目'));

      // 2. Tapping the project loads the file tree through studio.fs.tree.
      await tap('PocketJS Flutter host showcase');
      await until(() => textOf().contains('manifest.json'), 'file tree');
      final tree = textOf();
      expect(tree, isNot(before), reason: 'tapping a project must change the frame');
      expect(tree, contains('app.tsx'));
      expect(tree, contains('manifest.json'));

      // The expected names come from the real files on disk.
      final onDisk = projectFileNames(projectRoot);
      const protected = {'pocket.json', 'pocket.system.json', 'editor.json'}; // service policy hides these
      for (final name in onDisk.where((n) => !n.contains('/') && !protected.contains(n))) {
        expect(tree, contains(name.split('/').last), reason: '$name should be listed');
      }

      // 3. Tapping a folder expands it and reveals its children.
      final folders = RegExp(r'^▸ (.+)$', multiLine: true).allMatches(tree).map((m) => m[1]!).toList();
      expect(folders, isNotEmpty, reason: 'demo/js has source folders\n$tree');
      final folder = folders.firstWhere((f) => onDisk.any((n) => n.startsWith('$f/') && n.split('/').length == 2));
      await tap('▸ $folder');
      final child = onDisk.firstWhere((n) => n.startsWith('$folder/') && n.split('/').length == 2).split('/').last;
      await until(() => textOf().contains('▾ $folder') && textOf().contains(child), 'expanded folder');

      // 4. Tapping a file shows its real text in the read-only viewer.
      await useInputFieldEditor();
      await pump(10);
      await tap('manifest.json');
      final firstLine = File('$projectRoot/manifest.json').readAsLinesSync().firstWhere((l) => l.trim().length > 8).trim();
      await until(() => textOf().contains(firstLine.length > 60 ? firstLine.substring(0, 60) : firstLine), 'editor text');

      // 5. Capabilities only: every request the guest made was a studio.* call.
      expect(requested, isNotEmpty);
      final studioCalls = requested.where((c) => c.startsWith('studio.')).toSet();
      expect(studioCalls.difference(pocketStudioCapabilityNames), isEmpty, reason: requested.toString());
      expect(requested.where((c) => !c.startsWith('studio.') && !c.startsWith('system.') && !c.startsWith('updates.')), isEmpty, reason: requested.toString());
      expect(requested, containsAll(<String>['studio.project.list', 'studio.fs.tree', 'studio.fs.read']));
      // 6. Nothing absolute reached the guest.
      expect(textOf(), isNot(contains(projectRoot)));
      expect(textOf(), isNot(contains(work.path)));
    } finally {
      await manager.dispose();
      runtime.dispose();
    }
  }, skip: skip, timeout: const Timeout(Duration(minutes: 3)));

  testWidgets('PocketSystemHost boots the Studio 1440x900 5-zone desktop workbench and runs 4 simultaneous native preview sandboxes', (tester) async {
    tester.view.physicalSize = const Size(2880, 1800);
    tester.view.devicePixelRatio = 2.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final support = (await tester.runAsync(() => Directory.systemTemp.createTemp('studio-support-')))!;
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => support.path,
    );

    var latestTexts = <PocketTextOp>[];
    debugPocketFrameDeltaAtOverride = (runtime, delta) {
      final frame = pocketFrameDeltaAt(runtime, delta);
      if (frame != null) {
        final texts = frame.ops.whereType<PocketTextOp>().toList();
        if (texts.any((t) => t.text == 'POCKET STUDIO')) latestTexts = texts;
      }
      return frame;
    };
    addTearDown(() => debugPocketFrameDeltaAtOverride = null);

    final studioMetadata = File('$repo/studio/assets/app.bytecode.json').readAsStringSync();
    final boundaryKey = GlobalKey();
    final controller = PocketSystemHostController();
    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: RepaintBoundary(
          key: boundaryKey,
          child: studioApp(
            config,
            controller: controller,
            previewBootstrapMetadata: previewBootstrap(studioMetadata),
          ),
        ),
      ),
    );

    Future<void> pumpFor(int turns) async {
      for (var i = 0; i < turns; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 15)));
        await tester.pump(const Duration(milliseconds: 16));
      }
    }

    final shotDir = Platform.environment['STUDIO_SHOT_DIR'];
    Future<void> saveShot(String name) async {
      if (shotDir == null) return;
      await tester.runAsync(() async {
        final boundary = boundaryKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 2.0);
        final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!;
        Directory(shotDir).createSync(recursive: true);
        File('$shotDir/$name.png').writeAsBytesSync(bytes.buffer.asUint8List());
        image.dispose();
      });
    }

    Future<void> tapOp(PocketSession studioSession, PocketTextOp op) async {
      for (final phase in const ['down', 'up']) {
        studioSession.controller.send(
          method: 'input.pointer',
          params: {'phase': phase, 'id': 0, 'x': op.x + op.width / 2, 'y': op.y + op.height / 2},
        );
        await pumpFor(4);
      }
    }

    await pumpFor(80);
    final studio = controller.instances.singleWhere((i) => i.appId == 'dev.pocket.studio');
    expect(studio.firstFrameReady, isTrue);
    expect(studio.session.failure, isNull);
    expect(studio.session.active, isNull, reason: 'embedded bytecode, no remote package');
    expect(latestTexts.any((t) => t.text == '立即构建'), isTrue);
    expect(latestTexts.any((t) => t.text == '包资源'), isTrue);
    await saveShot('01-studio-1440x900-welcome');

    // Open demo/js first to verify full 5-zone split view on large project tree.
    final showcaseOp = latestTexts.where((t) => t.text == 'PocketJS Flutter host showcase').firstOrNull;
    expect(showcaseOp, isNotNull);
    await tapOp(studio.session, showcaseOp!);
    await pumpFor(50);
    final demoAppTsx = latestTexts.where((t) => t.text == 'app.tsx').firstOrNull;
    if (demoAppTsx != null) {
      await tapOp(studio.session, demoAppTsx);
      await pumpFor(50);
    }
    await saveShot('02-studio-1440x900-workbench-split');

    // Switch via top command bar project pill to Multi-Surface Preview Showcase and launch 4 simultaneous previews!
    final topProjectPill = latestTexts.where((t) => t.text == 'PocketJS Flutter host showcase').firstOrNull;
    expect(topProjectPill, isNotNull);
    await tapOp(studio.session, topProjectPill!);
    await pumpFor(20);
    final multiProjOp = latestTexts.where((t) => t.text == 'Multi-Surface Preview Showcase').firstOrNull;
    expect(multiProjOp, isNotNull);
    await tapOp(studio.session, multiProjOp!);
    await pumpFor(45);

    final multiAppTsx = latestTexts.where((t) => t.text == 'app.tsx').firstOrNull;
    if (multiAppTsx != null) {
      await tapOp(studio.session, multiAppTsx);
      await pumpFor(30);
    }

    final fourUp = latestTexts.where((t) => t.text == '四端同屏').firstOrNull;
    expect(fourUp, isNotNull);
    await tapOp(studio.session, fourUp!);
    await pumpFor(20);

    final buildPreview = latestTexts.where((t) => t.text == '构建并刷新预览').firstOrNull;
    expect(buildPreview, isNotNull);
    await tapOp(studio.session, buildPreview!);

    for (var i = 0; i < 360; i++) {
      final readyChildren = controller.instances
          .where((inst) => inst.appId.startsWith('dev.pocket.studio.preview') && inst.firstFrameReady)
          .length;
      final runningChip = latestTexts.any((t) => t.text == '运行中');
      if (readyChildren >= 4 && runningChip) break;
      await pumpFor(5);
    }
    await pumpFor(35);

    expect(
      controller.instances
          .where((inst) => inst.appId.startsWith('dev.pocket.studio.preview') && inst.firstFrameReady)
          .length,
      4,
      reason:
          'Flutter, Web, WeChat Mini Program, and Widget preview sandboxes must all render first frames simultaneously: '
          '${controller.instances.map((i) => "${i.appId}:ready=${i.firstFrameReady}:fail=${i.session.failure}").toList()}',
    );
    await saveShot('03-studio-1440x900-multi-preview');

    // Enable 5th simultaneous preview slot (灵动岛/穿戴) to verify maxInstances: 12 headroom without rebuilding!
    final fifthSlotOp = latestTexts.where((t) => t.text == '灵动岛/穿戴').firstOrNull;
    expect(fifthSlotOp, isNotNull);
    await tapOp(studio.session, fifthSlotOp!);
    for (var i = 0; i < 200; i++) {
      final readyChildren = controller.instances
          .where((inst) => inst.appId.startsWith('dev.pocket.studio.preview') && inst.firstFrameReady)
          .length;
      if (readyChildren >= 5) break;
      await pumpFor(5);
    }
    expect(
      controller.instances
          .where((inst) => inst.appId.startsWith('dev.pocket.studio.preview') && inst.firstFrameReady)
          .length,
      5,
      reason: 'All 5 simultaneous preview slots must run under maxInstances: 12',
    );

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 100));
    binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), null);
  }, skip: skip != false, timeout: const Timeout(Duration(minutes: 3)));
}

/// Editable source files of a project directory, as the service lists them.
List<String> projectFileNames(String root) {
  const editable = {'ts', 'tsx', 'js', 'jsx', 'json', 'svg', 'css', 'md'};
  const ignored = {'node_modules', '.git', '.pocket-build', '.pocket-editor', 'assets', 'builds', 'updates', 'keys', 'build', 'dist', 'out', 'generated'};
  final result = <String>[];
  for (final entity in Directory(root).listSync(recursive: true, followLinks: false)) {
    if (entity is! File) continue;
    final relative = entity.path.substring(root.length + 1);
    final parts = relative.split('/');
    if (parts.any((p) => p.startsWith('.') || ignored.contains(p))) continue;
    if (editable.contains(relative.split('.').last)) result.add(relative);
  }
  return result;
}

String _multiPreviewSource() => '''
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";

mount(() => (
  <Screen class="w-full h-full flex-col bg-[#0F172A] p-3">
    <View class="flex-col gap-1.5 p-2.5 rounded-xl bg-[#1E293B] flex-1 justify-between">
      <View class="flex-row items-center justify-between">
        <Text class="text-xs font-bold text-[#60A5FA]">POCKET LIVE</Text>
        <Text class="text-xs font-bold text-[#34D399]">60 FPS</Text>
      </View>
      <Text class="text-sm font-bold text-[#F8FAFC]">多端实时同屏预览</Text>
      <Text class="text-xs text-[#94A3B8]">Flutter · Web · 微信小程序 · 小组件</Text>
    </View>
  </Screen>
));
''';
