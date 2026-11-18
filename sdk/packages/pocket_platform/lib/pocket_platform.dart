/// Compiled-in platform experience provider for trusted PocketJS hosts.
///
/// [PocketPlatformPlugin] exposes foreground system UI and haptics. URL
/// ingress is a separate [PocketDeepLinkPlugin] with background-safe stream
/// lifecycle, and [PocketSurfaceBridgePlugin] provides opt-in bi-directional
/// synchronization with iOS WidgetKit / Live Activity / WatchConnectivity and
/// Android AppWidget / Live Update extensions.
library;

export 'src/platform_plugin.dart';
export 'src/surface_bridge_plugin.dart';
