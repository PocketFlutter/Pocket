import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart'
    show MethodChannel, MissingPluginException, PlatformException;
import 'package:path_provider/path_provider.dart';
import 'package:pocket_services/pocket_services.dart';

import 'pocket_config.dart';
import 'pocket_distribution.dart';

const MethodChannel _pocketNativeArchiveChannel = MethodChannel(
  'dev.pocketjs/pocket_archive',
);

/// Invokes the optional `pocket_archive` native 7z extractor when linked by
/// the host app. Standard `.zip` and granular OTA bundles already decode in a
/// pure-Dart isolate inside `PocketPackageStore` with zero native C plugin.
Future<void> extractPocketNativeArchive({
  required String archivePath,
  required String destinationPath,
  required int maxOutputBytes,
}) async {
  if (archivePath.isEmpty || destinationPath.isEmpty) {
    throw ArgumentError('Archive and destination paths must not be empty.');
  }
  if (maxOutputBytes <= 0) {
    throw ArgumentError.value(
      maxOutputBytes,
      'maxOutputBytes',
      'Must be greater than zero.',
    );
  }
  try {
    await _pocketNativeArchiveChannel.invokeMethod<void>(
      'extract',
      <String, Object?>{
        'archivePath': archivePath,
        'destinationPath': destinationPath,
        'maxOutputBytes': maxOutputBytes,
      },
    );
  } on MissingPluginException catch (error) {
    throw PocketPackageException(
      error.message ?? 'native archive extraction plugin is unavailable',
      code: 'native-archive-unavailable',
    );
  } on PlatformException catch (error) {
    throw PocketPackageException(
      error.message ?? 'native archive extraction failed (${error.code})',
      code: 'bundle-format',
    );
  }
}

int resolvePocketEmbeddedBuild(
  Map<String, dynamic> metadata,
  Object? manifest, {
  required bool requireBuild,
}) {
  // Legacy artifacts may carry their release floor only in the manifest.
  // An explicitly invalid metadata build must not be hidden by that fallback.
  final value = metadata.containsKey('build')
      ? metadata['build']
      : manifest is Map && manifest.containsKey('build')
      ? manifest['build']
      : null;
  if (value == null && !requireBuild) return 0;
  if (value is! num ||
      !value.isFinite ||
      value < 1 ||
      value > 9007199254740991 ||
      value != value.truncateToDouble()) {
    throw const FormatException(
      'A positive integer embedded build is required in app.bytecode.json '
      'or guest-manifest.json before enabling updates',
    );
  }
  return value.toInt();
}

Future<PocketUpdateCoordinator?> createPocketUpdateCoordinator({
  required PocketAppConfig config,
  required Map<String, dynamic> metadata,
  required Object? manifest,
}) async {
  final updateConfig = config.updates;
  if (updateConfig == null || !updateConfig.configured) return null;
  requirePocketRemoteCode('Signed package updates');
  final embeddedBuild = resolvePocketEmbeddedBuild(
    metadata,
    manifest,
    requireBuild: true,
  );
  final directory = await getApplicationSupportDirectory();
  final packageRoot = Directory(
    '${directory.path}/pocket-packages/${config.appId}/${updateConfig.namespace}',
  );
  final trustStore = updateConfig.trustPolicyConfigured
      ? PocketTrustStore(
          directory: packageRoot,
          appId: config.appId,
          rootKeyId: updateConfig.trustRootKeyId!,
          rootPublicKey: base64Decode(updateConfig.trustRootPublicKey!),
        )
      : null;
  return PocketUpdateCoordinator(
    manifestUri: updateConfig.manifestUri(config.appId),
    appId: config.appId,
    trustedKeys: updateConfig.trustPolicyConfigured
        ? const <String, List<int>>{}
        : <String, List<int>>{
            updateConfig.keyId: base64Decode(updateConfig.publicKey),
          },
    store: PocketPackageStore(
      packageRoot,
      archiveExtractor: extractPocketNativeArchive,
    ),
    expectedRuntimeAbi: metadata['runtimeAbi'] as String,
    requireBytecode: true,
    // There is no embedded package to activate in downloadOnOpen mode. The
    // existing admission floor is shared by live sessions and management RPCs.
    minimumBuild: embeddedBuild - 1,
    trustStore: trustStore,
    trustPolicyUri: updateConfig.trustPolicyConfigured
        ? Uri.parse(updateConfig.trustPolicyUrl!)
        : null,
    debugHttpHosts: <String>{
      if (kDebugMode) ...const <String>['127.0.0.1', 'localhost', '10.0.2.2'],
      ...updateConfig.debugHttpHosts,
    },
  );
}
