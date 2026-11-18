import 'package:flutter/services.dart';
import 'package:pocket_audio/pocket_audio.dart';
import 'package:pocket_hardware/pocket_hardware.dart';
import 'package:pocket_live2d/pocket_live2d.dart';
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
  'pocket.demo.lantern': PocketAppConfig(
    appId: 'pocket.demo.lantern',
    pluginFactories: [
      createLanternAudioPlugin,
      (_) => PocketLive2dPlugin.fromBundledCatalog(
        catalogAsset: 'assets/apps/lantern/novel.native-assets.json',
        assetPrefix: 'assets/apps/lantern/',
      ),
    ],
    keyboardInputEnabled: true,
    keyboardAutofocus: true,
    keyboardButtonMap: {
      LogicalKeyboardKey.space: 0x2000,
      LogicalKeyboardKey.enter: 0x2000,
      LogicalKeyboardKey.numpadEnter: 0x2000,
      LogicalKeyboardKey.escape: 0x4000,
    },
    memoryLimits: PocketMemoryLimits(
      heapLimitBytes: 128 * 1024 * 1024,
      // The high-resolution model pages and transparent depth plane use a
      // 69,193,344-byte PAK. Keep this consumer's allowance explicitly bounded.
      maxPakBytes: 72 * 1024 * 1024,
    ),
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
