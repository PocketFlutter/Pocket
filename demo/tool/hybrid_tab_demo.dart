import 'package:flutter/material.dart';

import 'package:pocket_host/native_examples/hybrid_tab_app.dart';
import 'package:pocket_host/native_examples/showcase_config.dart'
    show showcaseConfig, showcaseNativePolicies, showcaseNavigatorKey;

export 'package:pocket_host/native_examples/hybrid_tab_app.dart'
    show PocketHybridTabDemoApp;

/// Keep the retained standalone `flutter run -t tool/hybrid_tab_demo.dart`
/// entry while using the same app and host configuration as the JS route.
void main() => runApp(
  MaterialApp(
    navigatorKey: showcaseNavigatorKey,
    debugShowCheckedModeBanner: false,
    home: PocketHybridTabDemoApp(
      systemUI: showcaseConfig,
      nativePolicies: showcaseNativePolicies,
    ),
  ),
);
