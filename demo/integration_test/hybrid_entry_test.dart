// dart format width=100
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'guest_interaction_test.dart' as guest;

Future<void> _until(WidgetTester tester, bool Function() condition, String message) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    if (condition()) return;
  }
  fail(message);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets(
    'default Host opens the existing hybrid Flutter demo and returns without restarting JS',
    (tester) async {
      final controller = PocketSystemHostController();
      try {
        await tester.pumpWidget(pocketHostApp(systemController: controller));
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '+1');
        await guest.waitFor(tester, '01');
        await guest.tapGuest(tester, 'Host');
        await guest.waitFor(tester, '混合 Flutter 宿主');
        final instance = controller.instances.singleWhere(
          (entry) => entry.appId == showcaseConfig.appId,
        );
        final originalId = instance.instanceId;

        await guest.tapGuest(tester, '打开混合 Flutter 宿主');
        await _until(
          tester,
          () => find.text('原生计数器: 0').evaluate().isNotEmpty,
          'Hybrid native home did not open',
        );
        await _until(
          tester,
          () => controller.instances.any(
            (entry) => entry.instanceId == originalId && !entry.foreground,
          ),
          'Covered Showcase was not suspended',
        );
        await tester.tap(find.byKey(const ValueKey<String>('native-counter-increment')));
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.text('原生计数器: 1'), findsOneWidget);

        await tester.tap(find.text('Pocket 广场'));
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '+1');
        await guest.waitFor(tester, '01');
        await tester.tap(find.byKey(const ValueKey<String>('hybrid-host-close')));
        await _until(
          tester,
          () => find.byKey(const ValueKey<String>('hybrid-host-close')).evaluate().isEmpty,
          'Hybrid close did not return to default Host',
        );
        await guest.waitFor(tester, '混合 Flutter 宿主');
        await _until(
          tester,
          () => controller.instances.any(
            (entry) => entry.instanceId == originalId && entry.foreground,
          ),
          'Original Showcase did not resume',
        );
        await guest.tapGuest(tester, 'Home');
        await guest.waitFor(tester, '01');
        expect(
          controller.instances
              .singleWhere((entry) => entry.appId == showcaseConfig.appId)
              .instanceId,
          originalId,
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
  );
}
