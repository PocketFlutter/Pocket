// dart format width=100
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart'
    show
        PocketBytecodeRuntime,
        PocketCompositorRuntime,
        PocketEvent,
        PocketFrame,
        PocketImageResource,
        PocketOp,
        PocketRectOp,
        PocketRuntime,
        PocketView,
        debugPocketSelfOwnedRuntimeFactory;
import 'package:pocket_host/main.dart' show showcaseConfig;
import 'package:pocket_sdk/pocket_sdk.dart';

import '../tool/hybrid_tab_demo.dart';

final class _ProbeHybridRuntime
    implements PocketRuntime, PocketCompositorRuntime, PocketBytecodeRuntime {
  _ProbeHybridRuntime(this.actualAbi);

  @override
  final String? actualAbi;

  int frameCalls = 0;
  final List<Map<String, dynamic>> sentMessages = <Map<String, dynamic>>[];
  Map<String, dynamic>? launchBeforeFirstFrame;

  static const PocketFrame _frame = PocketFrame(
    width: 240,
    height: 320,
    ops: <PocketOp>[PocketRectOp(x: 0, y: 0, width: 240, height: 320, color: 0xff101827)],
    events: <PocketEvent>[],
    resources: <PocketImageResource>[],
  );

  @override
  void configureCompositor(Map<String, int> applications) {}

  @override
  PocketFrame loadBytecode(
    Uint8List bytecode,
    Uint8List pak, {
    String? expectedRuntimeAbi,
  }) => _frame;

  @override
  PocketFrame eval(String source) => _frame;

  @override
  PocketFrame load(String source, Uint8List pak) => _frame;

  @override
  PocketFrame frame(int deltaMilliseconds) {
    frameCalls += 1;
    return _frame;
  }

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {
    final copy = Map<String, dynamic>.from(message);
    sentMessages.add(copy);
    if (frameCalls == 0 &&
        copy['name'] == 'system.host.launch' &&
        copy['payload'] is Map<String, dynamic>) {
      launchBeforeFirstFrame = Map<String, dynamic>.from(copy['payload'] as Map<String, dynamic>);
    }
  }

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  late Directory supportDirectory;
  late String runtimeAbi;
  late PocketBundledApplicationCatalog bundledCatalog;

  setUpAll(() async {
    final metadataJson =
        jsonDecode(await rootBundle.loadString(showcaseConfig.metadataAsset))
            as Map<String, Object?>;
    runtimeAbi = metadataJson['runtimeAbi'] as String;
    bundledCatalog = await PocketBundledApplicationCatalog.loadFromBundle(
      'assets/apps/official/catalog.json',
      assetPrefix: 'assets/',
      firstCompositorHandle: 4,
      lastCompositorHandle: 62,
      reservedAppIds: <String>{showcaseConfig.appId},
    );
  });

  setUp(() async {
    supportDirectory = await Directory.systemTemp.createTemp('pocket-hybrid-tab-test-');
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => supportDirectory.path,
    );
  });

  tearDown(() async {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    if (await supportDirectory.exists()) {
      await supportDirectory.delete(recursive: true);
    }
  });

  Future<PocketSystemInstanceSnapshot> waitForInstance(
    WidgetTester tester,
    PocketSystemHostController controller,
    bool Function(PocketSystemInstanceSnapshot) predicate,
  ) async {
    for (var attempt = 0; attempt < 80; attempt++) {
      for (final instance in controller.instances) {
        if (predicate(instance)) return instance;
      }
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 2)));
      await tester.pump(const Duration(milliseconds: 16));
    }
    fail('Timed out waiting for PocketSystemHost instance: ${controller.instances}');
  }

  Future<void> pumpRealTime(WidgetTester tester, [int steps = 10]) async {
    for (var i = 0; i < steps; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 2)));
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  testWidgets(
    'cold start mounts 0 PocketViews, lazy-mounts Tab 2, suspends hidden tab without hijacking PopScope, and launches fullscreen mini-app with result',
    (tester) async {
      final previousFactory = debugPocketSelfOwnedRuntimeFactory;
      final runtimes = <_ProbeHybridRuntime>[];
      debugPocketSelfOwnedRuntimeFactory = (_) {
        final runtime = _ProbeHybridRuntime(runtimeAbi);
        runtimes.add(runtime);
        return runtime;
      };

      final tabController = PocketSystemHostController();
      final launchControllers = <PocketSystemHostController>[];

      try {
        await tester.pumpWidget(
          PocketHybridTabDemoApp(
            bundledApplications: bundledCatalog,
            systemUI: showcaseConfig.copyWith(memoryLimits: const PocketMemoryLimits()),
            nativePolicies: const <String, PocketAppConfig>{},
            tabSystemController: tabController,
            launchControllerFactory: () {
              final controller = PocketSystemHostController();
              launchControllers.add(controller);
              return controller;
            },
          ),
        );
        await pumpRealTime(tester, 5);

        // (a) Cold start on Tab 0 mounts 0 PocketViews and increments native counter.
        expect(find.byType(PocketView, skipOffstage: false), findsNothing);
        expect(find.byType(PocketSystemHost, skipOffstage: false), findsNothing);
        expect(tabController.instances, isEmpty);
        expect(find.text('原生计数器: 0'), findsOneWidget);
        expect(find.text('尚未唤起外部小程序'), findsOneWidget);

        await tester.tap(find.byKey(const ValueKey<String>('native-counter-increment')));
        await tester.pump();
        expect(find.text('原生计数器: 1'), findsOneWidget);
        expect(find.byType(PocketView, skipOffstage: false), findsNothing);

        // (b) Switching to Tab 2 ('Pocket 广场') lazy-mounts PocketSystemHost with foreground == true.
        await tester.tap(find.text('Pocket 广场'));
        await tester.pump();
        expect(find.byType(PocketSystemHost, skipOffstage: false), findsOneWidget);

        final tabRoot = await waitForInstance(
          tester,
          tabController,
          (entry) => entry.isSystemUI && entry.ready && entry.firstFrameReady,
        );
        expect(tabRoot.foreground, isTrue);
        expect(runtimes, hasLength(1));

        // (c) Switching to Tab 1 ('原生发现') suspends Tab 2 (foreground == false)
        // and pushing/popping _NativeDetailPage via maybePop() is never hijacked by Tab 2's PopScope.
        await tester.tap(find.text('原生发现'));
        await pumpRealTime(tester, 5);
        expect(
          tabController.instances.singleWhere((entry) => entry.isSystemUI).foreground,
          isFalse,
        );

        await tester.tap(find.byKey(const Key('open-native-detail-btn')));
        await tester.pumpAndSettle();
        expect(find.text('原生二级详情页'), findsOneWidget);

        await tester.tap(find.byKey(const Key('native-detail-back-btn')));
        await tester.pumpAndSettle();
        expect(find.text('原生二级详情页'), findsNothing);
        expect(find.byKey(const Key('open-native-detail-btn')), findsOneWidget);

        // (d) From Tab 0, tapping Key('launch-profile-btn') pushes a second PocketSystemHost
        // with initialLaunch.appId == 'pocket.demo.profile', sends system.host.launch at t=0,
        // and when system.container.close is invoked, pops back to Tab 0 with the result.
        await tester.tap(find.text('原生首页'));
        await tester.pump();

        await tester.tap(find.byKey(const Key('launch-profile-btn')));
        await pumpRealTime(tester, 10);

        expect(find.byType(PocketSystemHost, skipOffstage: false), findsNWidgets(2));
        final pushedHost = tester
            .widgetList<PocketSystemHost>(find.byType(PocketSystemHost, skipOffstage: false))
            .last;
        expect(pushedHost.initialLaunch?.appId, 'pocket.demo.profile');
        expect(launchControllers, hasLength(1));

        final launchController = launchControllers.single;
        final launchRoot = await waitForInstance(
          tester,
          launchController,
          (entry) => entry.isSystemUI && entry.ready && entry.firstFrameReady,
        );
        expect(runtimes, hasLength(2));
        final launchRuntime = runtimes.last;
        expect(
          launchRuntime.launchBeforeFirstFrame,
          equals(<String, dynamic>{
            'appId': 'pocket.demo.profile',
            'arguments': <String, dynamic>{'source': 'native-home'},
            'closeContainerWhenEmpty': true,
          }),
        );

        // Invoke system.container.close through the real host capability boundary.
        launchRoot.session.onEvent(
          const PocketEvent(
            id: 'close-req-1',
            method: 'host.request',
            params: <String, Object?>{
              'requestId': 'close-req-1',
              'capability': 'system.container.close',
              'params': <String, Object?>{
                'result': <String, Object?>{
                  'appId': 'pocket.demo.profile',
                  'cancelled': false,
                  'value': <String, Object?>{'ok': true},
                },
              },
            },
          ),
        );
        await pumpRealTime(tester, 10);
        await tester.pumpAndSettle();

        expect(find.byType(PocketSystemHost, skipOffstage: false), findsOneWidget);
        final resultFinder = find.byKey(const Key('last-launch-result'));
        expect(resultFinder, findsOneWidget);
        final resultText = tester.widget<Text>(resultFinder).data ?? '';
        expect(resultText, contains('appId=pocket.demo.profile'));
        expect(resultText, contains('cancelled=false'));
        expect(resultText, contains('{ok: true}'));
      } finally {
        debugPocketSelfOwnedRuntimeFactory = previousFactory;
        await tester.pumpWidget(const SizedBox.shrink());
        await pumpRealTime(tester, 5);
        tabController.dispose();
      }
    },
  );
}
