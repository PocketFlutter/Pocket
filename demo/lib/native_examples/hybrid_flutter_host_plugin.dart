import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'dart:async';

const String hybridFlutterOpenCapability = 'demo.hybridFlutter.open';
const String hybridFlutterOpenModeCapability = 'demo.hybridFlutter.openMode';
const String hybridFlutterOpenMiniAppCapability =
    'demo.hybridFlutter.openMiniApp';
const String hybridFlutterCancelMiniAppCapability =
    'demo.hybridFlutter.cancelMiniApp';
const String hybridFlutterMiniAppResultEvent = 'demo.hybridFlutter.result';

typedef HybridMiniAppStarter =
    Future<DemoHybridMiniAppRoute> Function(Map<String, dynamic> request);

/// Native route handle. The request RPC only waits until the route is accepted;
/// [result] completes later when the route closes.
final class DemoHybridMiniAppRoute {
  const DemoHybridMiniAppRoute({required this.result, required this.cancel});

  final Future<PocketSystemLaunchResult?> result;
  final Future<void> Function() cancel;
}

/// Bridges an authorized JS app open to an embedding-owned fullscreen Flutter
/// route. App policy and the open/result token remain owned by the JS kernel.
final class DemoHybridFlutterMiniAppPlugin extends PocketPlugin {
  DemoHybridFlutterMiniAppPlugin({
    required this.controller,
    required this.startMiniApp,
  });

  final PocketViewController controller;
  final HybridMiniAppStarter startMiniApp;
  final Map<String, DemoHybridMiniAppRoute> _routes =
      <String, DemoHybridMiniAppRoute>{};

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'pocket.demo.hybrid-flutter-mini-apps',
    version: '1.0.0',
    description:
        'Opens authorized Pocket MiniApps in fullscreen Flutter routes.',
    limits: PocketPluginLimits(
      maxConcurrentRequests: 8,
      maxResponseBytes: 2048,
    ),
    capabilities: <String, PocketPluginCapability>{
      hybridFlutterOpenModeCapability: PocketPluginCapability(
        name: hybridFlutterOpenModeCapability,
        kind: PocketCapabilityKind.request,
        description: 'Reports the supported outer MiniApp presentation mode.',
      ),
      hybridFlutterOpenMiniAppCapability: PocketPluginCapability(
        name: hybridFlutterOpenMiniAppCapability,
        kind: PocketCapabilityKind.request,
        description:
            'Accepts a JS-authorized MiniApp launch into a Flutter route.',
      ),
      hybridFlutterCancelMiniAppCapability: PocketPluginCapability(
        name: hybridFlutterCancelMiniAppCapability,
        kind: PocketCapabilityKind.request,
        description: 'Cancels a pending fullscreen MiniApp route.',
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(hybridFlutterOpenModeCapability, (params) {
      if (params.isNotEmpty) {
        throw ArgumentError.value(params, 'params', 'must be an empty object');
      }
      return const <String, Object?>{
        'defaultMode': 'fullscreen',
        'fullscreenAvailable': true,
      };
    });
    context.registerRequest(hybridFlutterOpenMiniAppCapability, (params) async {
      final requestId = params['requestId'];
      final appId = params['appId'];
      if (requestId is! String ||
          requestId.isEmpty ||
          appId is! String ||
          appId.isEmpty) {
        throw ArgumentError.value(
          params,
          'params',
          'requires non-empty requestId and appId',
        );
      }
      if (_routes.containsKey(requestId)) {
        throw StateError('The MiniApp launch request is already active.');
      }

      // startMiniApp returns as soon as Navigator accepted the route. Keep the
      // request RPC short; long browsing completes through the event lane.
      final route = await startMiniApp(
        Map<String, dynamic>.unmodifiable(params),
      );
      _routes[requestId] = route;
      unawaited(_sendResultWhenClosed(requestId, appId, route));
      return <String, Object?>{
        'accepted': true,
        'requestId': requestId,
        'appId': appId,
      };
    });
    context.registerRequest(hybridFlutterCancelMiniAppCapability, (
      params,
    ) async {
      final requestId = params['requestId'];
      if (requestId is! String || requestId.isEmpty) {
        throw ArgumentError.value(
          params,
          'params',
          'requires a non-empty requestId',
        );
      }
      final route = _routes[requestId];
      if (route == null) {
        throw StateError('The MiniApp launch is no longer active.');
      }
      await route.cancel();
      return <String, Object?>{'accepted': true, 'requestId': requestId};
    });
  }

  Future<void> _sendResultWhenClosed(
    String requestId,
    String appId,
    DemoHybridMiniAppRoute route,
  ) async {
    try {
      final result = await route.result;
      if (!identical(_routes[requestId], route)) return;
      _routes.remove(requestId);
      controller.send(
        method: hybridFlutterMiniAppResultEvent,
        params: <String, dynamic>{
          'requestId': requestId,
          'appId': result?.appId ?? appId,
          'cancelled': result?.cancelled ?? true,
          'value': result?.value,
          if (result?.reason != null) 'reason': result!.reason,
        },
      );
    } on Object {
      if (!identical(_routes[requestId], route)) return;
      _routes.remove(requestId);
      controller.send(
        method: hybridFlutterMiniAppResultEvent,
        params: <String, dynamic>{
          'requestId': requestId,
          'appId': appId,
          'cancelled': true,
          'value': null,
          'reason': 'native_route_error',
        },
      );
    }
  }

  @override
  Future<void> dispose() async {
    final routes = _routes.values.toList(growable: false);
    _routes.clear();
    await Future.wait<void>(routes.map((route) => route.cancel()));
  }
}

typedef HybridFlutterHostBuilder = Widget Function(VoidCallback onClose);

/// Opens the existing native-tab demo over the Pocket container through the
/// embedding app's Navigator. This plugin only transports the route request;
/// tab content and mini-app routing remain in their existing owners.
final class DemoHybridFlutterHostPlugin extends PocketPlugin {
  static bool _routeOpen = false;

  DemoHybridFlutterHostPlugin({
    required this.navigatorKey,
    required this.buildHost,
  });

  final GlobalKey<NavigatorState> navigatorKey;
  final HybridFlutterHostBuilder buildHost;

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: 'pocket.demo.hybrid-flutter-host',
    version: '1.0.0',
    description: 'Opens the Showcase hybrid Flutter tab host.',
    limits: const PocketPluginLimits(
      maxConcurrentRequests: 1,
      maxResponseBytes: 1024,
    ),
    capabilities: const <String, PocketPluginCapability>{
      hybridFlutterOpenCapability: PocketPluginCapability(
        name: hybridFlutterOpenCapability,
        kind: PocketCapabilityKind.request,
        description: 'Open the hybrid Flutter host and resume when it closes.',
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(hybridFlutterOpenCapability, (params) async {
      if (params.isNotEmpty) {
        throw ArgumentError.value(params, 'params', 'must be an empty object');
      }
      await openHost();
      return const <String, Object?>{'closed': true};
    });
  }

  /// Uses the explicitly owned embedding Navigator instead of trying to
  /// resolve one from PocketSystemHostApplication's outer MaterialApp.builder.
  Future<void> openHost() async {
    if (_routeOpen) {
      throw StateError('The hybrid Flutter route is already open.');
    }
    final navigator = navigatorKey.currentState;
    if (navigator == null || !navigator.mounted) {
      throw StateError('The hybrid Flutter route navigator is not ready.');
    }

    _routeOpen = true;
    try {
      await navigator.push<void>(
        MaterialPageRoute<void>(
          builder: (_) => buildHost(() {
            if (navigator.mounted && navigator.canPop()) navigator.pop();
          }),
        ),
      );
    } finally {
      _routeOpen = false;
    }
  }
}
