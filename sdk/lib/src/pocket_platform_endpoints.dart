import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show AssetBundle, rootBundle;
import 'package:pocket_services/pocket_services.dart';

import 'pocket_config.dart';
import 'pocket_distribution.dart';
import 'pocket_host_config.dart';

/// Ordered primary and fallback entry URLs resolved for a single client platform.
@immutable
final class PocketEndpointRoute {
  PocketEndpointRoute({
    required this.platformKey,
    required this.primaryUri,
    Iterable<Uri> fallbackUris = const <Uri>[],
  }) : fallbackUris = List<Uri>.unmodifiable(fallbackUris);

  /// Matched route selector (`ios`, `android`, `macos`, `windows`, `linux`, `web`, `wechat`, or `*`).
  final String platformKey;

  /// Primary Cloudflare account Custom Domain entry (`latest.json` or `host.json`).
  final Uri primaryUri;

  /// Ordered backup Cloudflare account Custom Domain entries tried on transient network/5xx failures.
  final List<Uri> fallbackUris;

  /// Complete ordered candidate list (`primaryUri` followed by `fallbackUris`).
  List<Uri> get orderedUris => <Uri>[primaryUri, ...fallbackUris];
}

/// Build-generated multi-account platform routing table (`pocket-endpoints.json`).
///
/// Keeps the Flutter host strictly thin: selects the current platform's
/// Cloudflare account origin and delegates all same-origin manifest fetching,
/// Ed25519 signature verification, trust-anchor pinning, and PAK assembly to
/// [PocketHostConfig] and [PocketUpdateCoordinator].
@immutable
final class PocketPlatformEndpoints {
  PocketPlatformEndpoints({
    required this.appId,
    required this.hostVersion,
    required Map<String, PocketEndpointRoute> routes,
    this.packageVersion,
    this.slot,
    this.keyId,
    this.publicKey,
    this.trustRootKeyId,
    this.trustRootPublicKey,
    this.trustPolicyUrl,
  }) : routes = Map<String, PocketEndpointRoute>.unmodifiable(routes);

  factory PocketPlatformEndpoints.fromJson(
    Map<String, dynamic> json, {
    Set<String> allowInsecureHttpHosts = const <String>{},
  }) {
    final schemaVersion = json['schemaVersion'];
    if (schemaVersion != 1 || json['kind'] != 'pocket-platform-endpoints') {
      throw const FormatException(
        'Unsupported Pocket platform endpoints schema',
      );
    }
    final appId = _nonEmptyString(json['appId']);
    final hostVersion = _nonEmptyString(json['hostVersion']);
    if (appId == null || hostVersion == null) {
      throw const FormatException(
        'Pocket platform endpoints require appId and hostVersion',
      );
    }
    final rawRoutes = json['routes'];
    if (rawRoutes is! Map || rawRoutes.isEmpty) {
      throw const FormatException(
        'Pocket platform endpoints require a non-empty routes map',
      );
    }

    final allowedHosts = <String>{
      for (final h in allowInsecureHttpHosts)
        if (h.trim().isNotEmpty) h.trim().toLowerCase(),
    };

    final parsedRoutes = <String, PocketEndpointRoute>{};
    for (final entry in rawRoutes.entries) {
      final key = entry.key.toString().trim().toLowerCase();
      if (!_supportedSelectors.contains(key)) {
        throw FormatException(
          'Unsupported platform selector in pocket-endpoints: $key',
        );
      }
      final routeVal = entry.value;
      if (routeVal is String) {
        final primary = _parseValidatedEndpointUri(routeVal, allowedHosts);
        parsedRoutes[key] = PocketEndpointRoute(
          platformKey: key,
          primaryUri: primary,
        );
        continue;
      }
      if (routeVal is! Map) {
        throw FormatException('Invalid route descriptor for platform $key');
      }
      final primaryRaw = _nonEmptyString(routeVal['primaryUrl']);
      if (primaryRaw == null) {
        throw FormatException('Missing primaryUrl for platform $key');
      }
      final primary = _parseValidatedEndpointUri(primaryRaw, allowedHosts);
      final fallbacks = <Uri>[];
      final seen = <String>{primary.toString()};
      final rawFallbacks = routeVal['fallbackUrls'];
      if (rawFallbacks != null) {
        if (rawFallbacks is! List) {
          throw FormatException('fallbackUrls for $key must be an array');
        }
        for (final item in rawFallbacks) {
          final itemStr = _nonEmptyString(item);
          if (itemStr == null) {
            throw FormatException('Invalid fallbackUrl entry for $key');
          }
          final uri = _parseValidatedEndpointUri(itemStr, allowedHosts);
          if (seen.add(uri.toString())) {
            fallbacks.add(uri);
          }
        }
      }
      parsedRoutes[key] = PocketEndpointRoute(
        platformKey: key,
        primaryUri: primary,
        fallbackUris: fallbacks,
      );
    }

    return PocketPlatformEndpoints(
      appId: appId,
      hostVersion: hostVersion,
      routes: parsedRoutes,
      packageVersion: _nonEmptyString(json['packageVersion']),
      slot: _nonEmptyString(json['slot']),
      keyId: _nonEmptyString(json['keyId']),
      publicKey: _nonEmptyString(json['publicKey']),
      trustRootKeyId: _nonEmptyString(json['trustRootKeyId']),
      trustRootPublicKey: _nonEmptyString(json['trustRootPublicKey']),
      trustPolicyUrl: _nonEmptyString(json['trustPolicyUrl']),
    );
  }

  static const Set<String> _supportedSelectors = <String>{
    'ios',
    'android',
    'macos',
    'windows',
    'linux',
    'web',
    'wechat',
    '*',
  };

  final String appId;
  final String hostVersion;
  final String? packageVersion;
  final String? slot;
  final String? keyId;
  final String? publicKey;
  final String? trustRootKeyId;
  final String? trustRootPublicKey;
  final String? trustPolicyUrl;
  final Map<String, PocketEndpointRoute> routes;

  /// Maps Flutter's runtime platform to the canonical selector name.
  static String selectorForTargetPlatform({
    TargetPlatform? platform,
    bool isWeb = kIsWeb,
  }) {
    if (isWeb) return 'web';
    final effective = platform ?? defaultTargetPlatform;
    return switch (effective) {
      TargetPlatform.iOS => 'ios',
      TargetPlatform.android => 'android',
      TargetPlatform.macOS => 'macos',
      TargetPlatform.windows => 'windows',
      TargetPlatform.linux => 'linux',
      TargetPlatform.fuchsia => '*',
    };
  }

  /// Resolves the ordered primary + fallback route for [platform] (or current OS).
  PocketEndpointRoute resolveRoute({
    TargetPlatform? platform,
    bool isWeb = kIsWeb,
    String? overridePlatformSelector,
  }) {
    final selector =
        overridePlatformSelector?.trim().toLowerCase() ??
        selectorForTargetPlatform(platform: platform, isWeb: isWeb);
    final exact = routes[selector];
    final wildcard = routes['*'];
    if (exact != null) {
      if (wildcard == null) return exact;
      // Append any global wildcard fallbacks not already listed on the exact route.
      final seen = <String>{
        exact.primaryUri.toString(),
        for (final u in exact.fallbackUris) u.toString(),
      };
      final mergedFallbacks = <Uri>[
        ...exact.fallbackUris,
        for (final u in wildcard.fallbackUris)
          if (seen.add(u.toString())) u,
      ];
      return PocketEndpointRoute(
        platformKey: exact.platformKey,
        primaryUri: exact.primaryUri,
        fallbackUris: mergedFallbacks,
      );
    }
    if (wildcard != null) return wildcard;
    throw FormatException(
      'No Cloudflare endpoint route configured for platform "$selector" or fallback "*"',
    );
  }

  /// Builds a signed [PocketUpdateConfig] for single-app `PocketApp` consumers
  /// targeting the resolved platform's primary (or selected candidate) endpoint.
  PocketUpdateConfig toUpdateConfig({
    TargetPlatform? platform,
    bool isWeb = kIsWeb,
    int candidateIndex = 0,
    String namespace = 'default',
    List<String> debugHttpHosts = const <String>[],
  }) {
    final route = resolveRoute(platform: platform, isWeb: isWeb);
    final candidates = route.orderedUris;
    if (candidateIndex < 0 || candidateIndex >= candidates.length) {
      throw RangeError.index(candidateIndex, candidates, 'candidateIndex');
    }
    final selected = candidates[candidateIndex];
    return PocketUpdateConfig(
      indexUrl: selected.path.endsWith('/latest.json') ? selected.toString() : '',
      url: selected.path.endsWith('/latest.json') ? '' : selected.toString(),
      keyId: keyId ?? '',
      publicKey: publicKey ?? '',
      namespace: namespace,
      trustRootKeyId: trustRootKeyId,
      trustRootPublicKey: trustRootPublicKey,
      trustPolicyUrl: trustPolicyUrl,
      debugHttpHosts: debugHttpHosts,
    );
  }

  /// Loads `pocket-endpoints.json` from [bundle] (defaults to [rootBundle]).
  static Future<PocketPlatformEndpoints> loadFromAsset({
    String assetKey = 'assets/pocket-endpoints.json',
    AssetBundle? bundle,
    Set<String> allowInsecureHttpHosts = const <String>{},
  }) async {
    final raw = await (bundle ?? rootBundle).loadString(assetKey);
    final decoded = jsonDecode(raw);
    if (decoded is! Map) {
      throw const FormatException(
        'pocket-endpoints.json must contain a JSON object',
      );
    }
    return PocketPlatformEndpoints.fromJson(
      Map<String, dynamic>.from(decoded),
      allowInsecureHttpHosts: allowInsecureHttpHosts,
    );
  }

  /// Resolves the current platform's primary Cloudflare account endpoint and
  /// loads its [PocketHostConfig], automatically failing over to configured
  /// fallback accounts on transient network/HTTP 5xx/timeout errors.
  ///
  /// Fail-closed security invariant:
  /// Deterministic validation, schema, hash, cross-origin, or trust-anchor
  /// errors ([FormatException]) NEVER trigger failover and are rethrown
  /// immediately.
  Future<PocketHostConfig> loadHostConfig({
    TargetPlatform? platform,
    bool isWeb = kIsWeb,
    String? overridePlatformSelector,
    HttpClient? client,
    Set<String> allowInsecureHttpHosts = const <String>{},
    Directory? trustAnchorDirectory,
    String? requiredRootPayloadSha256,
    bool cacheFirst = false,
    PocketHostLoadProgressCallback? onProgress,
    PocketCancellationToken? cancellation,
  }) async {
    requirePocketRemoteCode('Multi-account platform endpoint loading');
    cancellation?.throwIfCancelled();
    final route = resolveRoute(
      platform: platform,
      isWeb: isWeb,
      overridePlatformSelector: overridePlatformSelector,
    );
    final candidates = route.orderedUris;
    Object? lastTransientError;
    StackTrace? lastStackTrace;

    for (var index = 0; index < candidates.length; index++) {
      cancellation?.throwIfCancelled();
      final candidateUri = candidates[index];
      try {
        final loaded = await PocketHostConfig.load(
          candidateUri,
          client: client,
          allowInsecureHttpHosts: allowInsecureHttpHosts,
          trustAnchorDirectory: trustAnchorDirectory,
          requiredRootPayloadSha256: requiredRootPayloadSha256,
          cacheFirst: cacheFirst,
          onProgress: onProgress,
          cancellation: cancellation,
        );
        _verifyExpectedIdentityAndKey(loaded);
        return loaded;
      } on PocketUpdateCancellation {
        rethrow;
      } on FormatException {
        // Security/schema/hash/trust-anchor violation: fail closed immediately.
        rethrow;
      } catch (error, stackTrace) {
        if (!_isTransientFailoverError(error)) {
          rethrow;
        }
        lastTransientError = error;
        lastStackTrace = stackTrace;
        if (index == candidates.length - 1) {
          Error.throwWithStackTrace(error, stackTrace);
        }
      }
    }

    Error.throwWithStackTrace(
      lastTransientError ??
          const HttpException('All platform update endpoints failed'),
      lastStackTrace ?? StackTrace.current,
    );
  }

  void _verifyExpectedIdentityAndKey(PocketHostConfig loaded) {
    if (loaded.systemUI.appId != appId) {
      throw FormatException(
        'Platform endpoint returned unexpected systemUI "${loaded.systemUI.appId}" (expected "$appId")',
      );
    }
    if (loaded.hostVersion != hostVersion) {
      throw FormatException(
        'Platform endpoint returned unexpected hostVersion "${loaded.hostVersion}" (expected "$hostVersion")',
      );
    }
    final updates = loaded.systemUI.updates;
    if (keyId != null && updates?.keyId != keyId) {
      throw FormatException(
        'Platform endpoint release keyId "${updates?.keyId}" does not match pinned keyId "$keyId"',
      );
    }
    if (publicKey != null && updates?.publicKey != publicKey) {
      throw const FormatException(
        'Platform endpoint release publicKey does not match pinned publicKey',
      );
    }
    if (trustRootKeyId != null && updates?.trustRootKeyId != trustRootKeyId) {
      throw FormatException(
        'Platform endpoint trustRootKeyId "${updates?.trustRootKeyId}" does not match pinned "$trustRootKeyId"',
      );
    }
    if (trustRootPublicKey != null &&
        updates?.trustRootPublicKey != trustRootPublicKey) {
      throw const FormatException(
        'Platform endpoint trustRootPublicKey does not match pinned root key',
      );
    }
  }
}

bool _isTransientFailoverError(Object error) =>
    error is SocketException ||
    error is HttpException ||
    error is HandshakeException ||
    error is TimeoutException ||
    error is OSError;

String? _nonEmptyString(Object? value) =>
    value is String && value.trim().isNotEmpty ? value.trim() : null;

Uri _parseValidatedEndpointUri(String raw, Set<String> allowedHttpHosts) {
  final uri = Uri.tryParse(raw.trim());
  if (uri == null ||
      !uri.hasScheme ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment) {
    throw FormatException('Invalid platform endpoint URL: $raw');
  }
  final scheme = uri.scheme.toLowerCase();
  final hostLower = uri.host.toLowerCase();
  final loopback =
      hostLower == '127.0.0.1' ||
      hostLower == 'localhost' ||
      hostLower == '::1';
  final httpAllowed =
      scheme == 'http' &&
      ((kDebugMode && loopback) || allowedHttpHosts.contains(hostLower));
  if (scheme != 'https' && !httpAllowed) {
    throw FormatException(
      'Platform endpoint URL must use HTTPS or an allowed HTTP host: $raw',
    );
  }
  if (!uri.path.endsWith('/latest.json') && !uri.path.endsWith('/host.json')) {
    throw FormatException(
      'Platform endpoint URL must end in /latest.json or /host.json: $raw',
    );
  }
  return uri;
}
