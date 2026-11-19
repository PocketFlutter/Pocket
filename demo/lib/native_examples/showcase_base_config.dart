import 'package:pocket_audio/pocket_audio.dart';
import 'package:pocket_hardware/pocket_hardware.dart';
import 'package:pocket_platform/pocket_platform.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

/// The Showcase's ordinary native policy, without its JS-to-native route
/// bridge. Hybrid Flutter embedders can reuse this configuration unchanged.
final showcaseBaseConfig = PocketAppConfig(
  appId: 'pocket.host.demo',
  updates: const PocketUpdateConfig.fromEnvironment(),
  pluginFactories: [
    HardwarePlugin.forPocketViewController,
    (_) => PocketPlatformPlugin(),
  ],
  allowedPermissions: HardwarePermissions.all,
  additionalCapabilities: {'ui.compositor-surfaces'},
  memoryLimits: PocketMemoryLimits(
    heapLimitBytes: 128 * 1024 * 1024,
    maxPakBytes: 8 * 1024 * 1024,
  ),
);

final showcaseNativePolicies = <String, PocketAppConfig>{
  'dev.pocket-nexus.worker-http': PocketAppConfig(
    appId: 'dev.pocket-nexus.worker-http',
    workerHttpOrigins: {'https://example.com'},
  ),
  'pocket.demo.profile': PocketAppConfig(
    appId: 'pocket.demo.profile',
    memoryLimits: PocketMemoryLimits(heapLimitBytes: 128 * 1024 * 1024),
  ),
  'pocket.demo.lobby': PocketAppConfig(
    appId: 'pocket.demo.lobby',
    memoryLimits: PocketMemoryLimits(maxPakBytes: 8 * 1024 * 1024),
  ),
};

PocketPlugin createLanternAudioPlugin(PocketViewController controller) =>
    PocketAudioPlugin.forPocketViewController(
      controller,
      assetPrefix: 'assets/apps/lantern/',
    );
