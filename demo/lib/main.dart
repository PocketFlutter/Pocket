import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'native_examples/showcase_config.dart' show pocketHostApp;

export 'native_examples/showcase_config.dart'
    show
        createLanternAudioPlugin,
        pocketHostApp,
        showcaseConfig,
        showcaseNativePolicies;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final diagnostics = PocketHostDiagnostics(
    captureFlutterErrors: true,
    capturePlatformDispatcherErrors: true,
  );
  await diagnostics
      .ensureCollector()
      .then<void>((_) {})
      .catchError(
        (Object error) =>
            debugPrint('Pocket diagnostics initialization failed: $error'),
      );
  runApp(pocketHostApp(diagnostics: diagnostics));
}
