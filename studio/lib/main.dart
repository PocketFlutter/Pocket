// dart format width=100
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:pocket_clipboard/pocket_clipboard.dart';
import 'package:pocket_file_picker/pocket_file_picker.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_studio/pocket_studio.dart';

const studioAppId = 'dev.pocket.studio';
const _previewBootstrapManifest = '{"protocolVersion":1,"capabilities":{"requires":[],"optional":[]}}';

final studioConfig = PocketStudioConfig.fromEnvironment();
final studioService = PocketStudioService(studioConfig);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await studioService.start();
  final bootstrap = previewBootstrap(await rootBundle.loadString('assets/app.bytecode.json'));
  runApp(studioApp(studioConfig, previewBootstrapMetadata: bootstrap));
}

PocketAppConfig studioSystemUI(PocketStudioConfig config, {Map<String, int>? compositorSurfaces}) {
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
    compositorSurfaces: compositorSurfaces ?? PocketStudioConfig.previewCompositorSurfaces,
    rawTextInputEnabled: true,
    textLayoutCacheCapacity: 2048,
    memoryLimits: PocketMemoryLimits(
      heapLimitBytes: PocketMemoryLimits.maximumHeapBytes,
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

PocketAppConfig studioPreviewChild(
  PocketStudioConfig config, {
  String appId = PocketStudioConfig.previewAppId,
  String? previewBootstrapMetadata,
}) {
  final key = config.readPreviewKey();
  return PocketAppConfig(
    appId: appId,
    bootstrapMetadataJson: previewBootstrapMetadata,
    bootstrapManifestJson: previewBootstrapMetadata == null ? null : _previewBootstrapManifest,
    downloadOnOpen: key != null,
    updates: key == null
        ? null
        : PocketUpdateConfig(
            url: config.previewUpdateUrlFor(appId),
            keyId: key.keyId,
            publicKey: key.publicKey,
            namespace: config.previewNamespaceFor(key.publicKey, appId),
            debugHttpHosts: const ['127.0.0.1'],
          ),
  );
}

Map<String, PocketAppConfig> studioPreviewChildren(PocketStudioConfig config, {String? previewBootstrapMetadata}) => {
  for (final id in PocketStudioConfig.allPreviewAppIds)
    id: studioPreviewChild(config, appId: id, previewBootstrapMetadata: previewBootstrapMetadata),
};

String previewBootstrap(String studioMetadataJson) => PocketStudioConfig.previewBootstrap(studioMetadataJson);

Widget studioApp(PocketStudioConfig config, {PocketSystemHostController? controller, String? previewBootstrapMetadata}) =>
    MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Pocket Studio',
      home: PocketSystemHost(
        systemUI: studioSystemUI(config),
        applications: studioPreviewChildren(config, previewBootstrapMetadata: previewBootstrapMetadata),
        controller: controller,
        maxInstances: 12,
      ),
    );
