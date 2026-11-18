import 'package:flutter/foundation.dart';

/// Compile with `--dart-define=POCKET_APP_STORE=true` for the bundled-code
/// distribution. This explicit profile also disables session recording and
/// gives the compiler a fixed branch for unused update paths.
const bool pocketAppStoreDistribution = bool.fromEnvironment(
  'POCKET_APP_STORE',
);

/// Remote loading keeps its existing behavior unless the host explicitly
/// selects bundled-code distribution. This is not an App Store approval.
const bool pocketRemoteCodeEnabled = !pocketAppStoreDistribution;

/// Session replay is a development facility. Production recording needs a
/// separately designed consent, indication and sensitive-data policy.
const bool pocketSessionRecordingEnabled =
    !pocketAppStoreDistribution && !kReleaseMode;

void requirePocketRemoteCode(String operation) {
  if (!pocketRemoteCodeEnabled) {
    throw StateError(
      '$operation is disabled for bundled-code distribution. '
      'Ship QJBC/PAK in the app bundle and update through the App Store.',
    );
  }
}

void requirePocketSessionRecording() {
  if (!pocketSessionRecordingEnabled) {
    throw StateError('Session recording is disabled for this distribution.');
  }
}
