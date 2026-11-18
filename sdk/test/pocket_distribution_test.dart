import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_sdk/src/pocket_update_factory.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const remote = PocketUpdateConfig(
    url: 'https://updates.example.test/latest.json',
    keyId: 'test-key',
    publicKey: 'AA==',
  );

  test('embedded configuration remains usable in either distribution', () {
    const config = PocketAppConfig(appId: 'test.bundled');
    expect(config.validate, returnsNormally);
    final session = PocketSession(config: config);
    expect(session.capabilities.contains('updates.status'), isTrue);
    expect((session.runtimeInfo()['features'] as Map)['recording'], isFalse);
    expect(
      session.capabilities.contains('updates.apply'),
      pocketRemoteCodeEnabled,
    );
    session.dispose();
  });

  test('remote loading changes only with the explicit bundled-code flag', () {
    expect(pocketRemoteCodeEnabled, !pocketAppStoreDistribution);
    const config = PocketAppConfig(appId: 'test.remote', updates: remote);
    expect(
      config.validate,
      pocketRemoteCodeEnabled ? returnsNormally : throwsStateError,
    );
    const download = PocketAppConfig(
      appId: 'test.download',
      updates: remote,
      downloadOnOpen: true,
    );
    expect(
      download.validate,
      pocketRemoteCodeEnabled ? returnsNormally : throwsStateError,
    );
  });

  test('bundled profile rejects host fetch before any HTTP request', () async {
    if (pocketRemoteCodeEnabled) return;
    final overrides = _RejectHttp();
    await HttpOverrides.runWithHttpOverrides(() async {
      await expectLater(
        PocketHostConfig.load(
          Uri.parse('https://updates.example.test/host.json'),
        ),
        throwsStateError,
      );
    }, overrides);
    expect(overrides.created, isFalse);
    expect(() => PocketHostConfig.fromJson(const {}), throwsStateError);
    await expectLater(
      createPocketUpdateCoordinator(
        config: const PocketAppConfig(appId: 'test.remote', updates: remote),
        metadata: const {},
        manifest: null,
      ),
      throwsStateError,
    );
  });

  test('custom capabilities cannot advertise disabled SDK features', () {
    for (final capability in const [
      'updates.check',
      'updates.apply',
      'updates.rollback',
      'diagnostics.recording.start',
    ]) {
      final config = PocketAppConfig(
        appId: 'test.capabilities',
        additionalCapabilities: {capability},
      );
      final enabled = capability.startsWith('updates.')
          ? pocketRemoteCodeEnabled
          : pocketSessionRecordingEnabled;
      expect(config.validate, enabled ? returnsNormally : throwsStateError);
    }
    const incompleteDownload = PocketAppConfig(
      appId: 'test.incomplete',
      downloadOnOpen: true,
    );
    expect(
      incompleteDownload.validate,
      pocketRemoteCodeEnabled ? throwsFormatException : throwsStateError,
    );
  });

  test('recording is unavailable in production and the bundled profile', () {
    expect(
      pocketSessionRecordingEnabled,
      !kReleaseMode && !pocketAppStoreDistribution,
    );
    final library = PocketRecordingLibrary();
    if (pocketSessionRecordingEnabled) {
      expect(library.start, returnsNormally);
      expect(library.stop, returnsNormally);
    } else {
      expect(library.start, throwsStateError);
      expect(
        () => PocketRecordingLibrary(recordOnStart: true),
        throwsStateError,
      );
      expect(
        () => library.attach(const PocketAppConfig(appId: 'test.recording')),
        throwsStateError,
      );
      final config = PocketAppConfig(
        appId: 'test.custom-recording',
        recordingFactory: () => PocketRecordingController(enabled: false),
      );
      expect(config.validate, throwsStateError);
      expect(library.isRecording, isFalse);
    }
  });
}

class _RejectHttp extends HttpOverrides {
  bool created = false;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    created = true;
    throw StateError('No HTTP client should be created');
  }
}
