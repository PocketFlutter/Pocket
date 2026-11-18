// dart format width=100
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart' show showcaseConfig;
import 'package:pocket_sdk/pocket_sdk.dart';

import '../tool/hybrid_tab_demo.dart';
import 'guest_interaction_test.dart' as guest;

const _showcase = 'pocket.host.demo';
const _profile = 'pocket.demo.profile';
const _lobby = 'pocket.demo.lobby';

late PocketBundledApplicationCatalog _bundledApplications;

void _ensureResumedLifecycle(IntegrationTestWidgetsFlutterBinding binding) {
  if (binding.lifecycleState != AppLifecycleState.resumed) {
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  }
}

Future<PocketSystemInstanceSnapshot> _instance(
  WidgetTester tester,
  PocketSystemHostController host,
  String appId, {
  bool? presented,
}) async {
  final binding = IntegrationTestWidgetsFlutterBinding.instance;
  for (var attempt = 0; attempt < 200; attempt++) {
    _ensureResumedLifecycle(binding);
    await tester.pump(const Duration(milliseconds: 30));
    final matches = host.instances.where(
      (entry) =>
          entry.appId == appId &&
          entry.firstFrameReady &&
          (presented == null || entry.isPresented == presented),
    );
    if (matches.isNotEmpty) return matches.single;
  }
  fail(
    'No ready instance $appId; facts=${host.instances.map((e) => '${e.appId}:${e.instanceId}:${e.ready}:${e.firstFrameReady}:${e.isPresented}:foreground=${e.foreground}:error=${e.session.lastError}:failure=${e.session.failure}').toList()}; texts=${guest.texts(tester)}; Flutter=${tester.widgetList<Text>(find.byType(Text)).map((e) => e.data).toList()}',
  );
}

Future<({PocketSystemInstanceSnapshot root, PocketSystemInstanceSnapshot child})>
_waitForPresentedChildSurface(
  WidgetTester tester,
  IntegrationTestWidgetsFlutterBinding binding,
  PocketSystemHostController host,
  String appId,
) async {
  String lastDiagnostics = 'none';
  for (var attempt = 0; attempt < 200; attempt++) {
    _ensureResumedLifecycle(binding);
    await tester.pump(const Duration(milliseconds: 25));
    final rootMatches = host.instances.where(
      (e) => e.isSystemUI && e.firstFrameReady && e.foreground,
    );
    final childMatches = host.instances.where(
      (e) =>
          e.appId == appId &&
          e.firstFrameReady &&
          e.isPresented &&
          e.compositorFocused &&
          e.foreground,
    );
    if (rootMatches.isNotEmpty && childMatches.isNotEmpty) {
      final root = rootMatches.single;
      final child = childMatches.single;
      final rootFinder = find.byWidgetPredicate(
        (widget) => widget is PocketView && identical(widget.controller, root.session.controller),
      );
      final childFinder = find.byWidgetPredicate(
        (widget) => widget is PocketView && identical(widget.controller, child.session.controller),
      );
      if (rootFinder.evaluate().isNotEmpty && childFinder.evaluate().isNotEmpty) {
        final childWidget = tester.widget<PocketView>(childFinder);
        final routeCompleted = ModalRoute.of(tester.element(childFinder))?.animation?.isCompleted;
        final rootOrigin = tester.renderObject<RenderBox>(rootFinder).localToGlobal(Offset.zero);
        final childOrigin = tester.renderObject<RenderBox>(childFinder).localToGlobal(Offset.zero);
        final distance = (childOrigin - rootOrigin).distance;
        lastDiagnostics =
            'inputEnabled=${childWidget.inputEnabled}, routeCompleted=$routeCompleted, rootOrigin=$rootOrigin, childOrigin=$childOrigin, distance=$distance';
        if (childWidget.inputEnabled && routeCompleted != false && distance < 2.0) {
          return (root: root, child: child);
        }
      } else {
        lastDiagnostics =
            'rootFound=${rootFinder.evaluate().isNotEmpty}, childFound=${childFinder.evaluate().isNotEmpty}';
      }
    }
  }
  fail(
    'Timed out waiting for presented child surface $appId; diagnostics=$lastDiagnostics; facts=${host.instances.map((e) => '${e.appId}:${e.instanceId}:ready=${e.ready}:firstFrame=${e.firstFrameReady}:presented=${e.isPresented}:focused=${e.compositorFocused}:foreground=${e.foreground}').toList()}; texts=${guest.texts(tester)}',
  );
}

void _hiddenTickerStopped(WidgetTester tester, PocketSession session) {
  final finder = find.byWidgetPredicate(
    (widget) => widget is PocketView && identical(widget.controller, session.controller),
    skipOffstage: false,
  );
  final dynamic state = tester.state(finder);
  expect(state.isTickerActive, isFalse, reason: 'hidden app must stop its ticker');
  expect(session.foreground, isFalse);
}

Future<void> _tapFlutter(WidgetTester tester, Finder finder) async {
  _ensureResumedLifecycle(IntegrationTestWidgetsFlutterBinding.instance);
  expect(finder, findsOneWidget);
  await tester.tap(finder);
  for (var i = 0; i < 15; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
  _ensureResumedLifecycle(IntegrationTestWidgetsFlutterBinding.instance);
}

Future<void> _waitForFlutterWidget(WidgetTester tester, Finder finder) async {
  for (var attempt = 0; attempt < 150; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    if (finder.evaluate().isNotEmpty) return;
  }
  fail('Timed out waiting for Flutter widget $finder; texts=${guest.texts(tester)}');
}

Future<void> _waitUntilGone(WidgetTester tester, Finder finder) async {
  for (var attempt = 0; attempt < 150; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    if (finder.evaluate().isEmpty) return;
  }
  fail('Timed out waiting for Flutter widget $finder to disappear');
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  setUp(() async {
    _bundledApplications = await PocketBundledApplicationCatalog.loadFromBundle(
      'assets/apps/official/catalog.json',
      assetPrefix: 'assets/',
      firstCompositorHandle: 4,
      lastCompositorHandle: 62,
      reservedAppIds: <String>{showcaseConfig.appId},
    );
  });

  testWidgets(
    'hybrid Flutter TabBar lazy-mounts Pocket tab, suspends offstage tab without blocking native back, launches fullscreen mini-app with result, and shares platform storage across containers',
    (tester) async {
      // Keep route geometry comparable across runs, independently of the last
      // desktop window size left by another Demo/test process.
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 1000);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final tabController = PocketSystemHostController();
      final launchControllers = <PocketSystemHostController>[];
      try {
        await tester.pumpWidget(
          PocketHybridTabDemoApp(
            bundledApplications: _bundledApplications,
            tabSystemController: tabController,
            launchControllerFactory: () {
              final controller = PocketSystemHostController();
              launchControllers.add(controller);
              return controller;
            },
          ),
        );
        _ensureResumedLifecycle(binding);
        await tester.pump(const Duration(milliseconds: 100));

        // 1. Cold start on Tab 0: 0 PocketViews and empty tabController.instances; increment native counter.
        expect(find.byType(PocketView, skipOffstage: false), findsNothing);
        expect(tabController.instances, isEmpty);
        expect(find.text('原生计数器: 0'), findsOneWidget);
        await _tapFlutter(tester, find.byKey(const ValueKey<String>('native-counter-increment')));
        expect(find.text('原生计数器: 1'), findsOneWidget);
        expect(find.byType(PocketView, skipOffstage: false), findsNothing);

        // 2. Switch to Tab 2 ('Pocket 广场'): wait for Showcase QJBC '00', tap '+1' -> '01', foreground == true.
        await _tapFlutter(tester, find.text('Pocket 广场'));
        final tabRoot = await _instance(tester, tabController, _showcase, presented: true);
        await guest.waitFor(tester, '00');
        expect(tabRoot.foreground, isTrue);
        await guest.tapGuest(tester, '+1');
        await guest.waitFor(tester, '01');

        // 3. Switch to Tab 1 ('原生发现'): verify Tab 2 system-ui foreground == false & ticker stopped;
        // push _NativeDetailPage and pop via maybePop() cleanly without being blocked by Tab 2's PopScope.
        await _tapFlutter(tester, find.text('原生发现'));
        for (var i = 0; i < 20; i++) {
          await tester.pump(const Duration(milliseconds: 20));
          if (!tabRoot.session.foreground) break;
        }
        _hiddenTickerStopped(tester, tabRoot.session);
        expect(
          tabController.instances.singleWhere((entry) => entry.isSystemUI).foreground,
          isFalse,
        );

        await _tapFlutter(tester, find.byKey(const Key('open-native-detail-btn')));
        await _waitForFlutterWidget(tester, find.text('原生二级详情页'));
        await _tapFlutter(tester, find.byKey(const Key('native-detail-back-btn')));
        await _waitUntilGone(tester, find.text('原生二级详情页'));
        expect(find.byKey(const Key('open-native-detail-btn')), findsOneWidget);

        // 4. Switch to Tab 0 ('原生首页') and tap Key('launch-profile-btn') ('唤起 Profile 小程序'):
        await _tapFlutter(tester, find.text('原生首页'));
        await _tapFlutter(tester, find.byKey(const Key('launch-profile-btn')));

        expect(launchControllers, hasLength(1));
        final profileLaunchController = launchControllers.last;
        await _waitForPresentedChildSurface(tester, binding, profileLaunchController, _profile);
        await guest.waitFor(tester, 'Pocket Profile');
        await guest.waitFor(tester, 'Lin Mei (VIP 7)');
        expect(find.byType(NavigationBar), findsNothing);
        final directRoot = profileLaunchController.instances.singleWhere(
          (entry) => entry.isSystemUI,
        );
        final directRootFinder = find.byWidgetPredicate(
          (widget) =>
              widget is PocketView && identical(widget.controller, directRoot.session.controller),
        );
        final directFullscreenRect = tester.getRect(directRootFinder);

        // Verify Showcase Home text ('Made to feel native.') is NOT painted during direct launch.
        expect(guest.texts(tester), isNot(contains('Made to feel native.')));
        expect(
          profileLaunchController.instances.map((e) => e.appId).toSet(),
          containsAll(<String>[_showcase, _profile]),
        );

        await guest.tapGuest(tester, 'Lin Mei (VIP 7)');
        await guest.tapGuest(tester, 'Save identity & open Lobby');
        await _waitForPresentedChildSurface(tester, binding, profileLaunchController, _lobby);
        await guest.waitFor(tester, 'Pocket Lobby');
        await guest.waitFor(tester, 'Lin Mei');

        await guest.tapGuest(tester, 'Increment lobby counter');
        await guest.waitForContaining(tester, 'visits=1');
        await guest.tapGuest(tester, 'Return visits to caller');
        await guest.waitFor(tester, 'Pocket Profile');
        await guest.waitForContaining(tester, 'Profile remains available');

        await guest.tapGuest(tester, 'Return to Showcase');
        await _waitForFlutterWidget(tester, find.byKey(const Key('last-launch-result')));
        final homeResultText =
            tester.widget<Text>(find.byKey(const Key('last-launch-result'))).data ?? '';
        expect(homeResultText, contains('appId=pocket.demo.profile'));
        expect(homeResultText, contains('cancelled=false'));
        expect(homeResultText, contains('Lin Mei'));

        // 5. Pocket plaza uses the SAME native fullscreen route as native tabs.
        await _tapFlutter(tester, find.text('Pocket 广场'));
        for (var i = 0; i < 20; i++) {
          await tester.pump(const Duration(milliseconds: 20));
          if (tabRoot.session.foreground) break;
        }
        expect(tabController.instances.singleWhere((entry) => entry.isSystemUI).foreground, isTrue);
        await guest.waitFor(tester, '01');
        expect(find.byType(NavigationBar), findsOneWidget);
        final embeddedRootFinder = find.byWidgetPredicate(
          (widget) =>
              widget is PocketView && identical(widget.controller, tabRoot.session.controller),
        );
        final embeddedRect = tester.getRect(embeddedRootFinder);
        await guest.tapGuest(tester, 'Open lobby app');
        await _waitForFlutterWidget(tester, find.byType(PocketSystemHost).last);
        for (var i = 0; i < 100 && launchControllers.length < 2; i++) {
          await tester.pump(const Duration(milliseconds: 30));
        }
        expect(
          launchControllers,
          hasLength(2),
          reason: 'Plaza must use the same independent native route launcher',
        );
        final plazaLaunchController = launchControllers.last;
        final plazaPresented = await _waitForPresentedChildSurface(
          tester,
          binding,
          plazaLaunchController,
          _lobby,
        );
        expect(
          tabController.instances.where((entry) => !entry.isSystemUI),
          isEmpty,
          reason: 'No duplicate miniapp may be opened in the embedded plaza',
        );
        _hiddenTickerStopped(tester, tabRoot.session);
        expect(find.byType(NavigationBar), findsNothing);
        expect(
          find.byType(NavigationBar, skipOffstage: false),
          findsOneWidget,
          reason:
              'Native tab bar remains in its covered route, rather than being conditionally removed',
        );
        final plazaRootFinder = find.byWidgetPredicate(
          (widget) =>
              widget is PocketView &&
              identical(widget.controller, plazaPresented.root.session.controller),
        );
        final plazaRect = tester.getRect(plazaRootFinder);
        expect(plazaRect.top, closeTo(directFullscreenRect.top, 2));
        expect(plazaRect.bottom, closeTo(directFullscreenRect.bottom, 2));
        await guest.waitFor(tester, 'Pocket Lobby');
        await guest.waitFor(tester, 'Lin Mei');
        await guest.tapGuest(tester, 'Return visits to caller');
        await guest.waitFor(tester, 'Open lobby app');
        await _waitForFlutterWidget(tester, find.byType(NavigationBar));
        expect(tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex, 2);
        expect(tester.getRect(embeddedRootFinder).height, closeTo(embeddedRect.height, 2));
        await guest.waitFor(tester, '01');
        expect(
          tabController.instances.singleWhere((entry) => entry.isSystemUI).instanceId,
          tabRoot.instanceId,
        );

        // The JS preference can keep subsequent launches inside the plaza.
        await guest.tapGuest(tester, '嵌入 Pocket 广场');
        await guest.tapGuest(tester, 'Open lobby app');
        await _instance(tester, tabController, _lobby, presented: true);
        await guest.waitFor(tester, 'Pocket Lobby');
        expect(launchControllers, hasLength(2));
        expect(find.byType(NavigationBar), findsOneWidget);
        expect(tester.getRect(embeddedRootFinder).height, closeTo(embeddedRect.height, 2));
        await guest.tapGuest(tester, 'Return visits to caller');
        await guest.waitFor(tester, 'Open lobby app');
        await guest.tapGuest(tester, '全屏 Flutter 容器');

        // 6. Switch to Tab 1 -> push _NativeDetailPage -> tap Key('detail-launch-lobby-btn'):
        // Wait for 'Pocket Lobby', tap top-right circular close button on root PocketView,
        // verify fullscreen mini-app route pops cleanly back to _NativeDetailPage with cancelled: true.
        await _tapFlutter(tester, find.text('原生发现'));
        await _tapFlutter(tester, find.byKey(const Key('open-native-detail-btn')));
        await _waitForFlutterWidget(tester, find.text('原生二级详情页'));
        await _tapFlutter(tester, find.byKey(const Key('detail-launch-lobby-btn')));

        expect(launchControllers, hasLength(3));
        final detailLaunchController = launchControllers.last;
        final presentedDetail = await _waitForPresentedChildSurface(
          tester,
          binding,
          detailLaunchController,
          _lobby,
        );
        final detailRoot = presentedDetail.root;
        await guest.waitFor(tester, 'Pocket Lobby');
        // Allow a few frames for geometry/close button layout to settle.
        for (var frame = 0; frame < 10; frame++) {
          await tester.pump(const Duration(milliseconds: 16));
        }

        final rootFinder = find.byWidgetPredicate(
          (widget) =>
              widget is PocketView && identical(widget.controller, detailRoot.session.controller),
        );
        final box = tester.renderObject<RenderBox>(rootFinder);
        final closeGesture = await tester.startGesture(
          box.localToGlobal(Offset(box.size.width - 30, 30)),
        );
        await tester.pump(const Duration(milliseconds: 50));
        await closeGesture.up();

        await _waitForFlutterWidget(tester, find.byKey(const Key('detail-launch-result')));
        expect(find.text('原生二级详情页'), findsOneWidget);
        final detailResultText =
            tester.widget<Text>(find.byKey(const Key('detail-launch-result'))).data ?? '';
        expect(detailResultText, contains('appId=pocket.demo.lobby'));
        expect(detailResultText, contains('cancelled=true'));
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        tabController.dispose();
      }
    },
  );
}
