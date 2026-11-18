// dart format width=100
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:pocket_clipboard/pocket_clipboard.dart';
import 'package:pocket_file_picker/pocket_file_picker.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_studio/pocket_studio.dart';

const studioAppId = 'dev.pocket.studio';

/// Trusted build/run configuration (dart-define); the guest never supplies it.
final studioConfig = PocketStudioConfig.fromEnvironment();
final studioService = PocketStudioService(studioConfig);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await studioService.start(); // attach to a healthy service or spawn one; stops on exit
  // The service creates the preview signing key at startup, so the preview child is fully
  // configured before the first publish. Its bootstrap carries only the runtime ABI of this host.
  final bootstrap = previewBootstrap(await rootBundle.loadString('assets/app.bytecode.json'));
  runApp(studioApp(studioConfig, previewBootstrapMetadata: bootstrap));
}

/// Only the Studio guest gets studio.*, clipboard and file-open grants (`PocketStudioConfig.hostPermissions`). Its signed
/// update slot uses the key the service provisions at startup; the bundled bytecode stays the fallback.
PocketAppConfig studioSystemUI(PocketStudioConfig config) {
  final key = config.readUpdateKey();
  return PocketAppConfig(
    appId: studioAppId,
    allowedPermissions: PocketStudioConfig.hostPermissions,
    pluginFactories: [
      (_) => PocketStudioPlugin(config: config),
      (_) => PocketClipboardPlugin(),
      (_) => PocketFilePickerPlugin(),
    ],
    additionalCapabilities: {'ui.compositor-surfaces'},
    compositorSurfaces: {PocketStudioConfig.previewAppId: 4},
    rawTextInputEnabled: true, // guest-requested raw key/IME sessions for the M4 code editor
    textLayoutCacheCapacity: 2048, // CodeView measured 256 thrashing and 2,048 fine
    memoryLimits: PocketMemoryLimits(
      heapLimitBytes: PocketMemoryLimits.maximumHeapBytes, // top QuickJS tier (2 GiB ceiling)
      maxPakBytes: 32 * 1024 * 1024,
    ),
    updates: key == null
        ? null
        : PocketUpdateConfig(
            indexUrl: config.selfUpdateUrl,
            keyId: key.keyId,
            publicKey: key.publicKey,
            namespace: 'studio-self',
            debugHttpHosts: const ['127.0.0.1'],
          ),
  );
}

/// Preview child: signed update slot only. No grants and no plugins: it never reaches studio.*, clipboard or files.
PocketAppConfig studioPreviewChild(PocketStudioConfig config, {String? previewBootstrapMetadata}) {
  final key = config.readPreviewKey();
  return PocketAppConfig(
    appId: PocketStudioConfig.previewAppId,
    bootstrapMetadataJson: previewBootstrapMetadata,
    bootstrapManifestJson: previewBootstrapMetadata == null ? null : _previewBootstrapManifest,
    downloadOnOpen: key != null,
    updates: key == null
        ? null
        : PocketUpdateConfig(
            url: config.previewUpdateUrl,
            keyId: key.keyId,
            publicKey: key.publicKey,
            namespace: config.previewNamespace(key.publicKey),
            debugHttpHosts: const ['127.0.0.1'],
          ),
  );
}

const _previewBootstrapManifest =
    '{"protocolVersion":1,"capabilities":{"requires":[],"optional":[]}}';

/// Bootstrap metadata of the preview child (this host's runtime ABI, build floor 1); see pocket_studio.
String previewBootstrap(String studioMetadataJson) =>
    PocketStudioConfig.previewBootstrap(studioMetadataJson);

Widget studioApp(
  PocketStudioConfig config, {
  PocketSystemHostController? controller,
  String? previewBootstrapMetadata,
}) => MaterialApp(
  debugShowCheckedModeBanner: false,
  title: 'Pocket Studio',
  home: PocketSystemHost(
    systemUI: studioSystemUI(config),
    applications: {
      PocketStudioConfig.previewAppId: studioPreviewChild(
        config,
        previewBootstrapMetadata: previewBootstrapMetadata,
      ),
    },
    controller: controller,
  ),
);
