/**
 * Official 27-package catalog metadata and schema definitions for the
 * PocketFlutter static package registry.
 */

const joinOrigin = (parts: readonly string[]): string => parts.join("");

export const DEFAULT_R2_REGISTRY_ORIGIN = joinOrigin([
  "https://",
  "registry",
  ".pocketflutter.com",
]);

export const DEFAULT_GITHUB_REGISTRY_ORIGIN = joinOrigin([
  "https://",
  "PocketFlutter",
  ".github.io/registry",
]);

export type PocketRegistryPackageKind =
  | "js-guest"
  | "tooling"
  | "host-core"
  | "host-plugin"
  | "hybrid";

export type HostPluginWiringSpec = {
  dartImport: string;
  factoryExpression?: string;
  capabilities: string[];
  permissions: string[];
  runtimePermissions: string[];
  androidPermissions: string[];
  iosUsageKeys: string[];
};

export type StaticPackageSpec = {
  slug: string;
  kind: PocketRegistryPackageKind;
  category:
    | "ui-skin"
    | "animation-game"
    | "deploy-tooling"
    | "host-core"
    | "hardware-media"
    | "network-sync"
    | "observability";
  shortAliases: string[];
  description: string;
  dependencies: string[];
  platforms: string[];
  requiresHostRebuild: boolean;
  hostWiring?: HostPluginWiringSpec;
};

export type RegistryPackageCatalogEntry = StaticPackageSpec & {
  version: string;
  jsPackageName?: string;
  dartPackageName?: string;
  tarballPath: string;
  tarballSha256: string;
  tarballSize: number;
  provenanceSha256: string;
  r2MirrorTarballUrl: string;
  githubTarballUrl: string;
};

export type PocketRegistryIndexDocument = {
  schemaVersion: 1;
  kind: "pocket-package-registry-index";
  registryName: string;
  sdkVersion: string;
  upstreamRevision: string;
  bytecodeAbi: string;
  generatedAt: string;
  mirrors: {
    r2PrimaryOrigin: string;
    githubFallbackOrigin: string;
  };
  totalPackages: number;
  packages: RegistryPackageCatalogEntry[];
};

export type SignedPocketRegistryIndex = {
  schemaVersion: 1;
  kind: "pocket-signed-package-registry-index";
  keyId: string;
  payload: string;
  signature: string;
};

const ap = (suffix: string): string => ["android", "permission", suffix].join(".");

export const OFFICIAL_PACKAGE_SPECS: readonly StaticPackageSpec[] = [
  {
    slug: "pocket_ui",
    kind: "js-guest",
    category: "ui-skin",
    shortAliases: ["ui"],
    description:
      "Core Solid-based PocketJS reactive UI components, router, fast 120fps primitives, and multi-skin contract.",
    dependencies: [],
    platforms: ["ios", "android", "macos", "windows", "linux", "web", "wechat"],
    requiresHostRebuild: false,
  },
  {
    slug: "pocket_arc",
    kind: "js-guest",
    category: "ui-skin",
    shortAliases: ["arc"],
    description:
      "Arc spatial skin theme and tactile surface controls for @pocket/ui.",
    dependencies: ["pocket_ui"],
    platforms: ["ios", "android", "macos", "windows", "linux", "web", "wechat"],
    requiresHostRebuild: false,
  },
  {
    slug: "pocket_looseleaf",
    kind: "js-guest",
    category: "ui-skin",
    shortAliases: ["looseleaf"],
    description:
      "Editorial paper and ink Looseleaf skin theme with warm typography and dark/amber-night modes.",
    dependencies: ["pocket_ui"],
    platforms: ["ios", "android", "macos", "windows", "linux", "web", "wechat"],
    requiresHostRebuild: false,
  },
  {
    slug: "pocket_liquid_glass",
    kind: "js-guest",
    category: "ui-skin",
    shortAliases: ["liquid-glass", "liquid_glass"],
    description:
      "Refractive Liquid Glass UI skin, morphing menus, and shader-backed translucent surfaces for @pocket/ui.",
    dependencies: ["pocket_ui"],
    platforms: ["ios", "android", "macos", "windows", "linux", "web", "wechat"],
    requiresHostRebuild: false,
  },
  {
    slug: "pocket_vn",
    kind: "js-guest",
    category: "animation-game",
    shortAliases: ["vn"],
    description:
      "Visual novel dialogue engine, branching script runner, save-slot state, and voice cue coordinator.",
    dependencies: ["pocket_ui"],
    platforms: ["ios", "android", "macos", "windows", "linux", "web", "wechat"],
    requiresHostRebuild: false,
  },
  {
    slug: "pocket_spine",
    kind: "js-guest",
    category: "animation-game",
    shortAliases: ["spine"],
    description:
      "2D skeletal Spine animation runtime and batch mesh renderer for PocketJS games and interactive scenes.",
    dependencies: ["pocket_ui"],
    platforms: ["ios", "android", "macos", "windows", "linux", "web", "wechat"],
    requiresHostRebuild: false,
  },
  {
    slug: "pocket_clipboard",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["clipboard"],
    description:
      "Bounded UTF-8 text clipboard capability provider (clipboard.readText / writeText / hasText) for PocketJS hosts.",
    dependencies: ["pocket_services"],
    platforms: ["ios", "android", "macos", "windows", "linux", "web"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_clipboard/pocket_clipboard.dart",
      factoryExpression: "(PocketViewController _) => PocketClipboardPlugin()",
      capabilities: ["clipboard.readText", "clipboard.writeText", "clipboard.hasText"],
      permissions: ["clipboard.read", "clipboard.write"],
      runtimePermissions: [],
      androidPermissions: [],
      iosUsageKeys: [],
    },
  },
  {
    slug: "pocket_file_picker",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["file-picker", "files"],
    description:
      "Opaque-handle platform open-file dialog and chunked file reader (files.pickOpen / readChunk / release) without exposing host paths.",
    dependencies: ["pocket_services"],
    platforms: ["ios", "android", "macos", "windows", "linux", "web"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_file_picker/pocket_file_picker.dart",
      factoryExpression: "(PocketViewController _) => PocketFilePickerPlugin()",
      capabilities: ["files.pickOpen", "files.readChunk", "files.release"],
      permissions: ["files.open"],
      runtimePermissions: [],
      androidPermissions: [],
      iosUsageKeys: [],
    },
  },
  {
    slug: "pocket_cos",
    kind: "tooling",
    category: "deploy-tooling",
    shortAliases: ["cos"],
    description:
      "Tencent Cloud COS two-phase content-addressed OTA publisher with immutable blob deduplication.",
    dependencies: [],
    platforms: ["macos", "windows", "linux"],
    requiresHostRebuild: false,
  },
  {
    slug: "pocket_cloudflare",
    kind: "tooling",
    category: "deploy-tooling",
    shortAliases: ["cloudflare", "cf"],
    description:
      "Multi-account platform-matrix Cloudflare R2 two-phase OTA publisher, native installer host, Zone Cache Purge, and Pages/Workers Web deployer.",
    dependencies: [],
    platforms: ["macos", "windows", "linux"],
    requiresHostRebuild: false,
  },
  {
    slug: "pocket_services",
    kind: "host-core",
    category: "host-core",
    shortAliases: ["services"],
    description:
      "Core Dart plugin capability descriptor, schema validation, and request/stream bridge interfaces.",
    dependencies: [],
    platforms: ["ios", "android", "macos", "windows", "linux"],
    requiresHostRebuild: true,
  },
  {
    slug: "pocket_flutter",
    kind: "host-core",
    category: "host-core",
    shortAliases: ["flutter-core"],
    description:
      "Low-level QuickJS QJBC + Rust compositor FFI bridge and Flutter texture/surface host widget.",
    dependencies: ["pocket_services"],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
  },
  {
    slug: "pocket_hardware_core",
    kind: "host-core",
    category: "hardware-media",
    shortAliases: ["hardware-core"],
    description:
      "Shared permission guard, error codes, and lifecycle primitives for native hardware plugins.",
    dependencies: ["pocket_services"],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
  },
  {
    slug: "pocket_permissions",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["permissions"],
    description:
      "Scoped OS runtime permission status query, prompt, and app-settings launcher plugin.",
    dependencies: ["pocket_services", "pocket_hardware_core"],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_permissions/pocket_permissions.dart",
      factoryExpression:
        "(PocketViewController _) => PocketPermissionsPlugin(allowedPermissions: generatedPocketRuntimePermissions)",
      capabilities: [
        "permissions.status",
        "permissions.request",
        "permissions.openSettings",
      ],
      permissions: [],
      runtimePermissions: [],
      androidPermissions: [],
      iosUsageKeys: [],
    },
  },
  {
    slug: "pocket_camera",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["camera"],
    description:
      "Zero-copy Flutter texture camera preview, lens/flash control, photo capture, and scoped gallery management.",
    dependencies: [
      "pocket_services",
      "pocket_hardware_core",
      "pocket_permissions",
    ],
    platforms: ["ios", "android"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_camera/pocket_camera.dart",
      factoryExpression:
        "(PocketViewController controller) => PocketCameraPlugin(onTextureRegistered: controller.authorizePlatformTexture, onTextureReleased: controller.revokePlatformTexture)",
      capabilities: [
        "hardware.camera.preview.start",
        "hardware.camera.preview.stop",
        "hardware.camera.lens.switch",
        "hardware.camera.flash.toggle",
        "hardware.camera.capture",
        "hardware.photos.list",
        "hardware.photos.delete",
      ],
      permissions: ["hardware.camera", "hardware.photos"],
      runtimePermissions: ["hardware.camera", "hardware.photos"],
      androidPermissions: [ap("CAMERA")],
      iosUsageKeys: [
        "NSCameraUsageDescription",
        "NSPhotoLibraryAddUsageDescription",
        "NSPhotoLibraryUsageDescription",
      ],
    },
  },
  {
    slug: "pocket_bluetooth",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["bluetooth", "ble"],
    description:
      "Bluetooth Low Energy scanning, GATT connection, characteristic read/write, and notify streams.",
    dependencies: [
      "pocket_services",
      "pocket_hardware_core",
      "pocket_permissions",
    ],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_bluetooth/pocket_bluetooth.dart",
      factoryExpression:
        "(PocketViewController _) => PocketBluetoothPlugin()",
      capabilities: [
        "hardware.bluetooth.scan",
        "hardware.bluetooth.connect",
        "hardware.bluetooth.read",
        "hardware.bluetooth.write",
        "hardware.bluetooth.notifications",
      ],
      permissions: ["hardware.bluetooth"],
      runtimePermissions: ["hardware.bluetooth"],
      androidPermissions: [
        ap("BLUETOOTH_SCAN"),
        ap("BLUETOOTH_CONNECT"),
        ap("ACCESS_FINE_LOCATION"),
        ap("ACCESS_COARSE_LOCATION"),
      ],
      iosUsageKeys: [
        "NSBluetoothAlwaysUsageDescription",
        "NSBluetoothPeripheralUsageDescription",
      ],
    },
  },
  {
    slug: "pocket_sensors",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["sensors"],
    description:
      "Accelerometer, gyroscope, magnetometer, and barometer sensor reading and throttled streaming.",
    dependencies: ["pocket_services", "pocket_hardware_core"],
    platforms: ["ios", "android"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_sensors/pocket_sensors.dart",
      factoryExpression: "(PocketViewController _) => PocketSensorsPlugin()",
      capabilities: ["hardware.sensors.read", "hardware.sensors.watch"],
      permissions: ["hardware.sensors"],
      runtimePermissions: ["hardware.sensors"],
      androidPermissions: [],
      iosUsageKeys: ["NSMotionUsageDescription"],
    },
  },
  {
    slug: "pocket_location",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["location", "gps"],
    description:
      "Foreground device geolocation provider with runtime permission gating.",
    dependencies: [
      "pocket_services",
      "pocket_hardware_core",
      "pocket_permissions",
    ],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_location/pocket_location.dart",
      factoryExpression: "(PocketViewController _) => PocketLocationPlugin()",
      capabilities: ["hardware.location.current"],
      permissions: ["hardware.location"],
      runtimePermissions: ["hardware.location"],
      androidPermissions: [
        ap("ACCESS_FINE_LOCATION"),
        ap("ACCESS_COARSE_LOCATION"),
      ],
      iosUsageKeys: ["NSLocationWhenInUseUsageDescription"],
    },
  },
  {
    slug: "pocket_biometrics",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["biometrics"],
    description:
      "System biometric prompt local user authentication plugin for iOS, macOS, and Android.",
    dependencies: ["pocket_services", "pocket_hardware_core"],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_biometrics/pocket_biometrics.dart",
      factoryExpression:
        "(PocketViewController _) => PocketBiometricsPlugin()",
      capabilities: ["hardware.biometrics.authenticate"],
      permissions: ["hardware.biometrics"],
      runtimePermissions: [],
      androidPermissions: [ap("USE_BIOMETRIC")],
      iosUsageKeys: ["NSFaceIDUsageDescription"],
    },
  },
  {
    slug: "pocket_weather",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["weather"],
    description:
      "Current weather observation capability backed by scoped HTTPS weather endpoints.",
    dependencies: ["pocket_services", "pocket_hardware_core"],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_weather/pocket_weather.dart",
      factoryExpression: "(PocketViewController _) => PocketWeatherPlugin()",
      capabilities: ["hardware.weather.current"],
      permissions: ["hardware.network"],
      runtimePermissions: [],
      androidPermissions: [ap("INTERNET")],
      iosUsageKeys: [],
    },
  },
  {
    slug: "pocket_hardware",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["hardware"],
    description:
      "All-in-one aggregate hardware provider bundling camera, BLE, sensors, location, biometrics, and weather.",
    dependencies: [
      "pocket_services",
      "pocket_hardware_core",
      "pocket_permissions",
      "pocket_camera",
      "pocket_bluetooth",
      "pocket_sensors",
      "pocket_location",
      "pocket_biometrics",
      "pocket_weather",
    ],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_hardware/pocket_hardware.dart",
      factoryExpression:
        "(PocketViewController controller) => HardwarePlugin(onTextureRegistered: controller.authorizePlatformTexture, onTextureReleased: controller.revokePlatformTexture)",
      capabilities: [
        "hardware.permissions",
        "hardware.permissions.request",
        "hardware.camera.preview.start",
        "hardware.camera.preview.stop",
        "hardware.camera.lens.switch",
        "hardware.camera.flash.toggle",
        "hardware.camera.capture",
        "hardware.photos.list",
        "hardware.photos.delete",
        "hardware.bluetooth.scan",
        "hardware.bluetooth.connect",
        "hardware.bluetooth.read",
        "hardware.bluetooth.write",
        "hardware.bluetooth.notifications",
        "hardware.sensors.read",
        "hardware.sensors.watch",
        "hardware.biometrics.authenticate",
        "hardware.location.current",
        "hardware.weather.current",
      ],
      permissions: [
        "hardware.camera",
        "hardware.photos",
        "hardware.bluetooth",
        "hardware.sensors",
        "hardware.biometrics",
        "hardware.location",
        "hardware.network",
      ],
      runtimePermissions: [
        "hardware.camera",
        "hardware.photos",
        "hardware.bluetooth",
        "hardware.sensors",
        "hardware.location",
      ],
      androidPermissions: [
        ap("INTERNET"),
        ap("CAMERA"),
        ap("BLUETOOTH_SCAN"),
        ap("BLUETOOTH_CONNECT"),
        ap("ACCESS_FINE_LOCATION"),
        ap("ACCESS_COARSE_LOCATION"),
        ap("USE_BIOMETRIC"),
      ],
      iosUsageKeys: [
        "NSCameraUsageDescription",
        "NSPhotoLibraryAddUsageDescription",
        "NSPhotoLibraryUsageDescription",
        "NSBluetoothAlwaysUsageDescription",
        "NSBluetoothPeripheralUsageDescription",
        "NSLocationWhenInUseUsageDescription",
        "NSFaceIDUsageDescription",
        "NSMotionUsageDescription",
      ],
    },
  },
  {
    slug: "pocket_dio",
    kind: "host-plugin",
    category: "network-sync",
    shortAliases: ["dio", "http"],
    description:
      "Origin-allowlisted Dio HTTP client running inside a dedicated non-blocking Dart IO Worker isolate.",
    dependencies: ["pocket_services"],
    platforms: ["ios", "android", "macos", "windows", "linux"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_dio/pocket_dio.dart",
      factoryExpression:
        "(PocketViewController _) => PocketDioPlugin(allowedOrigins: const <String>{})",
      capabilities: ["dio.request"],
      permissions: ["network"],
      runtimePermissions: [],
      androidPermissions: [ap("INTERNET")],
      iosUsageKeys: [],
    },
  },
  {
    slug: "pocket_platform",
    kind: "host-plugin",
    category: "host-core",
    shortAliases: ["platform", "surfaces"],
    description:
      "System UI chrome, tactile haptics, deep links, and Apple/Android ecosystem surface bridge.",
    dependencies: ["pocket_services"],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_platform/pocket_platform.dart",
      factoryExpression: "(PocketViewController _) => PocketPlatformPlugin()",
      capabilities: ["platform.systemUi.set", "platform.haptics.perform"],
      permissions: [],
      runtimePermissions: [],
      androidPermissions: [],
      iosUsageKeys: [],
    },
  },
  {
    slug: "pocket_audio",
    kind: "host-plugin",
    category: "hardware-media",
    shortAliases: ["audio"],
    description:
      "Multi-channel whitelisted asset audio playback provider powered by just_audio.",
    dependencies: ["pocket_services", "pocket_flutter"],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_audio/pocket_audio.dart",
      factoryExpression:
        "(PocketViewController controller) => PocketAudioPlugin.forPocketViewController(controller, assetPrefix: 'assets/')",
      capabilities: [
        "media.audio.play",
        "media.audio.stop",
        "media.audio.pause",
        "media.audio.resume",
        "media.audio.volume",
      ],
      permissions: [],
      runtimePermissions: [],
      androidPermissions: [],
      iosUsageKeys: [],
    },
  },
  {
    slug: "pocket_archive",
    kind: "host-plugin",
    category: "host-core",
    shortAliases: ["archive", "7z"],
    description:
      "Native background worker ZIP and solid LZMA/LZMA2 7z archive extractor for fast OTA bundle unpacking.",
    dependencies: [],
    platforms: ["ios", "android", "macos"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_archive/pocket_archive.dart",
      capabilities: [],
      permissions: [],
      runtimePermissions: [],
      androidPermissions: [],
      iosUsageKeys: [],
    },
  },
  {
    slug: "pocket_diagnostics",
    kind: "hybrid",
    category: "observability",
    shortAliases: ["diagnostics"],
    description:
      "Structured guest/host crash collector, ring-buffer breadcrumb logger, and Flutter error persistence adapter.",
    dependencies: [],
    platforms: ["ios", "android", "macos", "windows", "linux", "web"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_diagnostics/pocket_diagnostics.dart",
      capabilities: [],
      permissions: [],
      runtimePermissions: [],
      androidPermissions: [],
      iosUsageKeys: [],
    },
  },
  {
    slug: "pocket_live2d",
    kind: "hybrid",
    category: "animation-game",
    shortAliases: ["live2d"],
    description:
      "Hybrid @pocket/live2d JS controller and native Cubism Core C FFI / WebAssembly mesh deformer.",
    dependencies: ["pocket_ui", "pocket_services"],
    platforms: ["ios", "android", "macos", "web"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_live2d/pocket_live2d.dart",
      factoryExpression:
        "(PocketViewController _) => PocketLive2dPlugin(assets: const <String, String>{})",
      capabilities: [
        "media.live2d.model.load",
        "media.live2d.model.update",
        "media.live2d.model.release",
      ],
      permissions: [],
      runtimePermissions: [],
      androidPermissions: [],
      iosUsageKeys: [],
    },
  },
  {
    slug: "pocket_sync",
    kind: "hybrid",
    category: "network-sync",
    shortAliases: ["sync"],
    description:
      "Hybrid @pocket/sync CRDT engine with embedded Dart IO-isolate HTTP/WebSocket LAN and cross-subnet sync server.",
    dependencies: ["pocket_services"],
    platforms: ["ios", "android", "macos", "windows", "linux", "web"],
    requiresHostRebuild: true,
    hostWiring: {
      dartImport: "package:pocket_sync/pocket_sync.dart",
      factoryExpression: "(PocketViewController _) => PocketSyncPlugin()",
      capabilities: [
        "sync.server.start",
        "sync.server.stop",
        "sync.server.status",
        "sync.server.ingestLocalOps",
        "sync.server.events",
        "sync.client.request",
      ],
      permissions: ["network"],
      runtimePermissions: [],
      androidPermissions: [ap("INTERNET")],
      iosUsageKeys: [],
    },
  },
];

export const POCKET_OFFICIAL_REGISTRY_KEY_ID = "pocketflutter-official-2026";
export const POCKET_OFFICIAL_REGISTRY_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAiEgC/wyg6wMzofeURpkDu15lGQfPm9aEAq5TDc+Ax0E=\n-----END PUBLIC KEY-----\n";
