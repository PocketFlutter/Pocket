/// Independently selected location capabilities using the retained hardware adapter.
library;

import 'package:pocket_hardware_core/pocket_hardware_core.dart';
export 'package:pocket_hardware_core/pocket_hardware_core.dart'
    show
        HardwarePlatform,
        HardwareStreamingPlatform,
        HardwarePlatformException,
        HardwareCapabilities,
        HardwarePermissions,
        HardwareTextureCallback,
        HardwareWeatherFetcher;

final class PocketLocationPlugin extends HardwareCapabilityPlugin {
  static PocketPluginDescriptor get pluginDescriptor =>
      HardwareCapabilityPlugin.descriptorFor(
        features: const {HardwareFeature.location},
        pluginId: 'flutter.location',
      );

  PocketLocationPlugin({
    HardwarePlatform? platform,
    Duration requestTimeout = const Duration(seconds: 16),
  }) : super(
         platform: platform,
         requestTimeout: requestTimeout,
         features: const {HardwareFeature.location},
         pluginId: 'flutter.location',
         includeLegacyPermissions: false,
       );
}
