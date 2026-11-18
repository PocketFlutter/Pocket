import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'package:pocket_host/flutter_frame_monitor.dart';
import 'hybrid_flutter_host_plugin.dart';
import 'hybrid_tab_app.dart';
import 'showcase_base_config.dart';

export 'showcase_base_config.dart'
    show showcaseNativePolicies, createLanternAudioPlugin;

/// Navigator deliberately sits outside PocketSystemHostApplication's nested
/// MaterialApp, so capability requests can open native Flutter routes.
final showcaseNavigatorKey = GlobalKey<NavigatorState>();

final PocketAppConfig showcaseConfig = showcaseBaseConfig.copyWith(
  pluginFactories: <PocketPluginFactory>[
    ...showcaseBaseConfig.pluginFactories,
    (_) => DemoHybridFlutterHostPlugin(
      navigatorKey: showcaseNavigatorKey,
      buildHost: (onClose) => PocketHybridTabDemoApp(
        onClose: onClose,
        systemUI: showcaseConfig,
        nativePolicies: showcaseNativePolicies,
      ),
    ),
  ],
);

Widget pocketHostApp({
  PocketSystemHostController? systemController,
  PocketRecordingLibrary? recordings,
  PocketHostDiagnostics? diagnostics,
  PocketBundledApplicationCatalog? bundledApplications,
  Map<String, PocketAppConfig>? nativePolicies,
  FlutterFrameMonitorController? frameMonitorController,
  bool showFlutterFps = const bool.fromEnvironment('FLUTTER_FPS'),
}) => MaterialApp(
  navigatorKey: showcaseNavigatorKey,
  debugShowCheckedModeBanner: false,
  home: PocketSystemHostApplication.fromBundledAssets(
    catalogAsset: 'assets/apps/official/catalog.json',
    assetPrefix: 'assets/',
    firstCompositorHandle: 4,
    lastCompositorHandle: 62,
    systemUI: showcaseConfig,
    nativePolicies: nativePolicies ?? showcaseNativePolicies,
    keyboardInputAppIdPrefixes: const {'dev.pocket-nexus.'},
    initialBundledApplications: bundledApplications,
    controller: systemController,
    recordings: recordings,
    diagnostics: diagnostics,
    appBuilder: (context, child) => FlutterFrameMonitor(
      enabled: showFlutterFps,
      controller: frameMonitorController,
      child: child,
    ),
    showPerformanceOverlay: const bool.fromEnvironment(
      'FLUTTER_PERFORMANCE_OVERLAY',
    ),
  ),
);
