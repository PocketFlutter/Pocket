import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart'
    show
        PocketHost,
        PocketHostRegistry,
        PocketPluginContext,
        PocketStreamBridge;

import 'package:pocket_host/native_examples/hybrid_flutter_host_plugin.dart';

void main() {
  test(
    'fullscreen MiniApp capability returns accepted handle and cancels its route',
    () async {
      final controller = PocketViewController();
      final result = Completer<PocketSystemLaunchResult?>();
      var routeCancelled = false;
      Map<String, dynamic>? startedRequest;
      final route = DemoHybridMiniAppRoute(
        result: result.future,
        cancel: () async {
          routeCancelled = true;
          if (!result.isCompleted) {
            result.complete(
              const PocketSystemLaunchResult(
                appId: 'pocket.demo.lobby',
                cancelled: true,
                reason: 'cancelled',
              ),
            );
          }
        },
      );
      final plugin = DemoHybridFlutterMiniAppPlugin(
        controller: controller,
        startMiniApp: (request) async {
          startedRequest = request;
          return route;
        },
      );
      final registry = PocketHostRegistry();
      final context = PocketPluginContext(
        plugin: plugin.descriptor,
        appId: 'pocket.host.demo',
        sessionId: 'hybrid-open-test',
        registry: registry,
      )..restore();
      plugin.register(context);
      final responses = <Map<String, dynamic>>[];
      final host = PocketHost(
        registry: registry,
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: plugin.descriptor.capabilities.keys.toSet(),
        send: (method, params) {
          if (method == 'host.response') responses.add(params);
          return true;
        },
      );
      host.configureGuestCapabilities(
        required: const <String>[],
        optional: plugin.descriptor.capabilities.keys,
      );

      Future<Map<String, dynamic>> call(
        String requestId,
        String capability,
        Map<String, dynamic> params,
      ) async {
        await host.handle(
          PocketEvent(
            id: requestId,
            method: 'host.request',
            params: <String, dynamic>{
              'requestId': requestId,
              'capability': capability,
              'params': params,
            },
          ),
        );
        return responses.last;
      }

      expect(plugin.backgroundSafe, isTrue);
      final mode = await call(
        'mode',
        hybridFlutterOpenModeCapability,
        const {},
      );
      expect(mode['ok'], isTrue);
      expect(mode['result'], {
        'defaultMode': 'fullscreen',
        'fullscreenAvailable': true,
      });

      final opened = await call('open', hybridFlutterOpenMiniAppCapability, {
        'requestId': 'launch-42',
        'appId': 'pocket.demo.lobby',
        'arguments': {'source': 'plaza'},
        'presentationStyle': 'sheet',
      });
      expect(opened['ok'], isTrue);
      expect(opened['result'], {
        'accepted': true,
        'requestId': 'launch-42',
        'appId': 'pocket.demo.lobby',
      });
      expect(startedRequest, containsPair('presentationStyle', 'sheet'));
      expect(
        result.isCompleted,
        isFalse,
        reason: 'route lifetime is not held in the open RPC',
      );

      final cancelled = await call(
        'cancel',
        hybridFlutterCancelMiniAppCapability,
        {'requestId': 'launch-42'},
      );
      expect(cancelled['ok'], isTrue);
      expect(cancelled['result'], {'accepted': true, 'requestId': 'launch-42'});
      expect(routeCancelled, isTrue);
      expect((await result.future)?.cancelled, isTrue);

      context.dispose();
      await plugin.dispose();
      host.dispose();
    },
  );

  testWidgets(
    'registered hybrid host capability opens and closes an outer route',
    (tester) async {
      final navigatorKey = GlobalKey<NavigatorState>();
      final plugin = DemoHybridFlutterHostPlugin(
        navigatorKey: navigatorKey,
        buildHost: (onClose) => Scaffold(
          appBar: AppBar(
            title: const Text('混合 Flutter 宿主'),
            leading: IconButton(
              key: const Key('hybrid-host-close'),
              onPressed: onClose,
              icon: const Icon(Icons.close),
            ),
          ),
        ),
      );
      final registry = PocketHostRegistry();
      final context = PocketPluginContext(
        plugin: plugin.descriptor,
        appId: 'pocket.host.demo',
        sessionId: 'hybrid-host-test',
        registry: registry,
      );
      context.restore();
      plugin.register(context);

      expect(plugin.backgroundSafe, isTrue);
      expect(
        plugin.descriptor.capabilities,
        contains(hybridFlutterOpenCapability),
      );
      expect(
        context.registeredCapabilities,
        contains(hybridFlutterOpenCapability),
      );
      expect(registry.contains(hybridFlutterOpenCapability), isTrue);

      await tester.pumpWidget(
        MaterialApp(
          navigatorKey: navigatorKey,
          home: const Scaffold(body: Text('Host page')),
        ),
      );
      final opened = plugin.openHost();
      await tester.pumpAndSettle();
      expect(find.text('混合 Flutter 宿主'), findsOneWidget);

      await tester.tap(find.byKey(const Key('hybrid-host-close')));
      await tester.pumpAndSettle();
      await opened;
      expect(find.text('Host page'), findsOneWidget);

      context.dispose();
      expect(registry.contains(hybridFlutterOpenCapability), isFalse);
    },
  );
}
