import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:pocket_services/pocket_services.dart';

import 'platform_plugin.dart';

/// Capability names exported by [PocketSurfaceBridgePlugin] when an app opts
/// into Apple/Android system surfaces (`WidgetKit`, `Live Activity`, `Watch`,
/// `App Clip`, `AppWidget`, `Live Update`, `Wear OS Tile`).
abstract final class PocketSurfaceCapabilities {
  static const String surfaceGet = 'platform.surface.get';
  static const String publishSnapshot = 'platform.widgets.publishSnapshot';
  static const String drainActions = 'platform.widgets.drainActions';
  static const String actionEvents = 'platform.widgets.actions';
  static const String liveActivityUpsert = 'platform.liveActivity.upsert';
  static const String liveActivityEnd = 'platform.liveActivity.end';

  static const Set<String> all = <String>{
    surfaceGet,
    publishSnapshot,
    drainActions,
    actionEvents,
    liveActivityUpsert,
    liveActivityEnd,
  };
}

const String pocketSurfaceBridgePluginId = 'flutter.surfaces';
const String pocketSurfaceMethodChannelName = 'com.pocketnexus.host/surfaces';

const PocketPluginSchema _surfaceEmptySchema = PocketPluginSchema.object();

const PocketPluginSchema _surfaceInfoResultSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'available': PocketPluginSchema.boolean(),
    'ecosystem': PocketPluginSchema.string(),
    'appGroupId': PocketPluginSchema.unknown(),
    'supportsWidgets': PocketPluginSchema.boolean(),
    'supportsLiveActivities': PocketPluginSchema.boolean(),
    'watchPaired': PocketPluginSchema.boolean(),
    'pendingActionCount': PocketPluginSchema.integer(),
  },
  required: <String>{'available'},
);

const PocketPluginSchema _publishSnapshotParamsSchema =
    PocketPluginSchema.object(
      properties: <String, PocketPluginSchema>{
        'generation': PocketPluginSchema.integer(),
        'profileId': PocketPluginSchema.string(),
        'renderMode': PocketPluginSchema.string(),
        'eyebrow': PocketPluginSchema.string(),
        'title': PocketPluginSchema.string(),
        'primaryValue': PocketPluginSchema.string(),
        'subtitle': PocketPluginSchema.string(),
        'badge': PocketPluginSchema.string(),
        'primaryHref': PocketPluginSchema.string(),
        'progress': PocketPluginSchema.number(),
        'metrics': PocketPluginSchema.array(PocketPluginSchema.object()),
        'actions': PocketPluginSchema.array(PocketPluginSchema.object()),
        'hotspots': PocketPluginSchema.array(PocketPluginSchema.object()),
        'extra': PocketPluginSchema.object(),
      },
    );

const PocketPluginSchema _publishSnapshotResultSchema =
    PocketPluginSchema.object(
      properties: <String, PocketPluginSchema>{
        'published': PocketPluginSchema.boolean(),
        'reloadedWidgets': PocketPluginSchema.boolean(),
        'pushedWatchContext': PocketPluginSchema.boolean(),
        'reason': PocketPluginSchema.string(),
      },
      required: <String>{'published'},
    );

const PocketPluginSchema _liveActivityUpsertParamsSchema =
    PocketPluginSchema.object(
      properties: <String, PocketPluginSchema>{
        'activityId': PocketPluginSchema.string(),
        'leadingBadge': PocketPluginSchema.string(),
        'trailingMetric': PocketPluginSchema.string(),
        'title': PocketPluginSchema.string(),
        'subtitle': PocketPluginSchema.string(),
        'progress': PocketPluginSchema.number(),
        'primaryActionLabel': PocketPluginSchema.string(),
        'primaryHref': PocketPluginSchema.string(),
        'secondaryActionLabel': PocketPluginSchema.string(),
        'secondaryHref': PocketPluginSchema.string(),
      },
      required: <String>{'title'},
    );

const PocketPluginSchema _liveActivityResultSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'active': PocketPluginSchema.boolean(),
    'activityId': PocketPluginSchema.unknown(),
    'reason': PocketPluginSchema.string(),
  },
  required: <String>{'active'},
);

const PocketPluginSchema _liveActivityEndParamsSchema =
    PocketPluginSchema.object(
      properties: <String, PocketPluginSchema>{
        'activityId': PocketPluginSchema.string(),
      },
    );

const PocketPluginSchema _drainActionsResultSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'actions': PocketPluginSchema.array(PocketPluginSchema.object()),
  },
  required: <String>{'actions'},
);

const PocketPluginSchema _widgetActionEventSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'id': PocketPluginSchema.string(),
    'href': PocketPluginSchema.string(),
    'source': PocketPluginSchema.string(),
    'timestampMs': PocketPluginSchema.integer(),
  },
  required: <String>{'id', 'href'},
);

/// Opt-in host <-> system extension communication bridge.
///
/// Synchronizes PocketJS surface snapshots and interactive hotspot manifests
/// with native iOS WidgetKit / ActivityKit / WatchConnectivity (via App Group
/// `UserDefaults` + shared container JSON) and Android `AppWidgetManager` /
/// Live Update ongoing notifications (via `SharedPreferences` + broadcast
/// intents), while draining background widget/watch tap actions back into the
/// active PocketJS guest.
final class PocketSurfaceBridgePlugin extends PocketPlugin {
  PocketSurfaceBridgePlugin({
    this.appGroupId,
    this.deepLinkScheme,
    PocketPlatformTransport? transport,
    this.maxSnapshotBytes = 64 * 1024,
  }) : _transport =
           transport ??
           MethodChannelPocketPlatformTransport(
             channel: const MethodChannel(pocketSurfaceMethodChannelName),
           ) {
    final group = appGroupId;
    if (group != null &&
        (group.trim().isEmpty ||
            group.length > 128 ||
            !RegExp(r'^group\.[A-Za-z0-9._-]+$').hasMatch(group))) {
      throw ArgumentError.value(
        appGroupId,
        'appGroupId',
        'must start with "group." and contain only [A-Za-z0-9._-]',
      );
    }
    if (maxSnapshotBytes < 1024 || maxSnapshotBytes > 256 * 1024) {
      throw ArgumentError.value(
        maxSnapshotBytes,
        'maxSnapshotBytes',
        'must be between 1 KiB and 256 KiB',
      );
    }
  }

  final String? appGroupId;
  final String? deepLinkScheme;
  final PocketPlatformTransport _transport;
  final int maxSnapshotBytes;

  final StreamController<Object?> _actionEvents =
      StreamController<Object?>.broadcast(sync: true);
  bool _disposed = false;
  bool _configured = false;
  bool _ownsMethodHandler = false;

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: pocketSurfaceBridgePluginId,
    version: '1.0.0',
    description:
        'Opt-in host bridge for iOS WidgetKit/LiveActivity/Watch and Android AppWidget/LiveUpdate surfaces',
    limits: PocketPluginLimits(
      maxConcurrentRequests: 4,
      maxActiveStreams: 2,
      maxResponseBytes: 64 * 1024,
      maxStreamEvents: 256,
      maxStreamEventBytes: 16 * 1024,
    ),
    capabilities: <String, PocketPluginCapability>{
      PocketSurfaceCapabilities.surfaceGet: PocketPluginCapability(
        name: PocketSurfaceCapabilities.surfaceGet,
        kind: PocketCapabilityKind.request,
        description:
            'Inspect native widget, App Group, Live Activity, and Watch bridge availability',
        schema: PocketPluginCapabilitySchema(
          parameters: _surfaceEmptySchema,
          result: _surfaceInfoResultSchema,
        ),
      ),
      PocketSurfaceCapabilities.publishSnapshot: PocketPluginCapability(
        name: PocketSurfaceCapabilities.publishSnapshot,
        kind: PocketCapabilityKind.request,
        description:
            'Publish a structured widget snapshot and hotspot manifest to native system extensions',
        schema: PocketPluginCapabilitySchema(
          parameters: _publishSnapshotParamsSchema,
          result: _publishSnapshotResultSchema,
        ),
      ),
      PocketSurfaceCapabilities.liveActivityUpsert: PocketPluginCapability(
        name: PocketSurfaceCapabilities.liveActivityUpsert,
        kind: PocketCapabilityKind.request,
        description:
            'Start or update an iOS Dynamic Island Live Activity or Android Live Update notification',
        schema: PocketPluginCapabilitySchema(
          parameters: _liveActivityUpsertParamsSchema,
          result: _liveActivityResultSchema,
        ),
      ),
      PocketSurfaceCapabilities.liveActivityEnd: PocketPluginCapability(
        name: PocketSurfaceCapabilities.liveActivityEnd,
        kind: PocketCapabilityKind.request,
        description: 'End active Live Activity / Live Update surfaces',
        schema: PocketPluginCapabilitySchema(
          parameters: _liveActivityEndParamsSchema,
          result: _liveActivityResultSchema,
        ),
      ),
      PocketSurfaceCapabilities.drainActions: PocketPluginCapability(
        name: PocketSurfaceCapabilities.drainActions,
        kind: PocketCapabilityKind.request,
        description:
            'Drain pending interactive actions queued by background widgets or watch companions',
        schema: PocketPluginCapabilitySchema(
          parameters: _surfaceEmptySchema,
          result: _drainActionsResultSchema,
        ),
      ),
      PocketSurfaceCapabilities.actionEvents: PocketPluginCapability(
        name: PocketSurfaceCapabilities.actionEvents,
        kind: PocketCapabilityKind.stream,
        description:
            'Stream interactive widget, Live Activity, and Watch action events into the guest',
        schema: PocketPluginCapabilitySchema(
          parameters: _surfaceEmptySchema,
          streamItem: _widgetActionEventSchema,
        ),
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(PocketSurfaceCapabilities.surfaceGet, _getSurface);
    context.registerRequest(
      PocketSurfaceCapabilities.publishSnapshot,
      _publishSnapshot,
    );
    context.registerRequest(
      PocketSurfaceCapabilities.liveActivityUpsert,
      _upsertLiveActivity,
    );
    context.registerRequest(
      PocketSurfaceCapabilities.liveActivityEnd,
      _endLiveActivity,
    );
    context.registerRequest(
      PocketSurfaceCapabilities.drainActions,
      _drainActions,
    );
    context.registerStream(
      PocketSurfaceCapabilities.actionEvents,
      (_) => _actionEvents.stream,
    );
  }

  @override
  Future<void> activate(PocketPluginContext context) async {
    if (_disposed) {
      throw StateError('$pocketSurfaceBridgePluginId is disposed');
    }
    if (_configured) return;
    _transport.setMethodCallHandler(_handleNativeCall);
    _ownsMethodHandler = true;
    try {
      await _transport.invoke('configureSurfaces', <String, dynamic>{
        if (appGroupId != null) 'appGroupId': appGroupId,
        if (deepLinkScheme != null) 'deepLinkScheme': deepLinkScheme,
      });
      _configured = true;
    } on MissingPluginException {
      // Desktop/test hosts without native widget extensions degrade cleanly.
      _configured = false;
    } on PlatformException {
      _configured = false;
    }
  }

  @override
  Future<void> deactivate(PocketPluginContext context) => _disableSurfaces();

  Future<void> _disableSurfaces() async {
    if (_ownsMethodHandler) {
      _ownsMethodHandler = false;
      try {
        _transport.setMethodCallHandler(null);
      } catch (_) {}
    }
    if (_configured) {
      _configured = false;
      try {
        await _transport.invoke('disableSurfaces');
      } on MissingPluginException {
        // The engine may already have detached.
      } on PlatformException {
        // Native teardown must not prevent guest disposal.
      }
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await _disableSurfaces();
    await _actionEvents.close();
  }

  Future<Object?> _handleNativeCall(String method, Object? arguments) async {
    if (method != 'onWidgetAction') return null;
    if (_disposed || !_actionEvents.hasListener || arguments is! Map) {
      return false;
    }
    final normalized = _normalizeActionMap(arguments);
    if (normalized == null) return false;
    _actionEvents.add(normalized);
    return true;
  }

  Future<Object?> _getSurface(Map<String, dynamic> _) async {
    try {
      final raw = await _transport.invoke('getSurfaceStatus', <String, dynamic>{
        if (appGroupId != null) 'appGroupId': appGroupId,
      });
      if (raw is Map) {
        return <String, dynamic>{
          'available': raw['available'] == true,
          if (raw['ecosystem'] is String) 'ecosystem': raw['ecosystem'],
          'appGroupId': raw['appGroupId'] ?? appGroupId,
          'supportsWidgets': raw['supportsWidgets'] == true,
          'supportsLiveActivities': raw['supportsLiveActivities'] == true,
          'watchPaired': raw['watchPaired'] == true,
          'pendingActionCount':
              (raw['pendingActionCount'] as num?)?.toInt() ?? 0,
        };
      }
    } on MissingPluginException {
      // Fall through to unavailable desktop/host response.
    }
    return <String, dynamic>{
      'available': false,
      'appGroupId': appGroupId,
      'supportsWidgets': false,
      'supportsLiveActivities': false,
      'watchPaired': false,
      'pendingActionCount': 0,
    };
  }

  Future<Object?> _publishSnapshot(Map<String, dynamic> params) async {
    final encoded = utf8.encode(jsonEncode(params));
    if (encoded.length > maxSnapshotBytes) {
      throw PocketCapabilityException(
        'snapshot_too_large',
        'widget snapshot exceeds $maxSnapshotBytes bytes (${encoded.length})',
      );
    }
    try {
      final raw = await _transport.invoke('publishSnapshot', <String, dynamic>{
        if (appGroupId != null) 'appGroupId': appGroupId,
        'snapshot': params,
        'snapshotJson': utf8.decode(encoded),
      });
      if (raw is Map && raw['published'] is bool) {
        return <String, dynamic>{
          'published': raw['published'],
          'reloadedWidgets': raw['reloadedWidgets'] == true,
          'pushedWatchContext': raw['pushedWatchContext'] == true,
          if (raw['reason'] is String) 'reason': raw['reason'],
        };
      }
      return <String, dynamic>{
        'published': false,
        'reloadedWidgets': false,
        'pushedWatchContext': false,
        'reason': 'empty_response',
      };
    } on MissingPluginException {
      return <String, dynamic>{
        'published': false,
        'reloadedWidgets': false,
        'pushedWatchContext': false,
        'reason': 'native_surface_channel_unavailable',
      };
    }
  }

  Future<Object?> _upsertLiveActivity(Map<String, dynamic> params) async {
    final title = (params['title'] as String?)?.trim() ?? '';
    if (title.isEmpty) {
      throw const PocketCapabilityException(
        'invalid_argument',
        'liveActivity.upsert requires a non-empty title',
      );
    }
    final rawProgress = (params['progress'] as num?)?.toDouble() ?? 0.0;
    final clampedProgress = rawProgress.isFinite
        ? rawProgress.clamp(0.0, 1.0)
        : 0.0;
    try {
      final raw = await _transport
          .invoke('upsertLiveActivity', <String, dynamic>{
            ...params,
            'title': title,
            'progress': clampedProgress,
            if (deepLinkScheme != null) 'deepLinkScheme': deepLinkScheme,
          });
      if (raw is Map) {
        return <String, dynamic>{
          'active': raw['active'] == true,
          'activityId': raw['activityId'],
          if (raw['reason'] is String) 'reason': raw['reason'],
        };
      }
      return <String, dynamic>{'active': false, 'reason': 'empty_response'};
    } on MissingPluginException {
      return <String, dynamic>{
        'active': false,
        'reason': 'native_surface_channel_unavailable',
      };
    }
  }

  Future<Object?> _endLiveActivity(Map<String, dynamic> params) async {
    try {
      final raw = await _transport.invoke('endLiveActivity', params);
      if (raw is Map) {
        return <String, dynamic>{
          'active': false,
          'activityId': raw['activityId'],
          if (raw['reason'] is String) 'reason': raw['reason'],
        };
      }
    } on MissingPluginException {
      // Ignore on unsupported platforms.
    }
    return <String, dynamic>{'active': false};
  }

  Future<Object?> _drainActions(Map<String, dynamic> _) async {
    try {
      final raw = await _transport.invoke(
        'drainPendingActions',
        <String, dynamic>{if (appGroupId != null) 'appGroupId': appGroupId},
      );
      if (raw is Map && raw['actions'] is List) {
        final actions = <Map<String, dynamic>>[];
        for (final item in raw['actions'] as List) {
          if (item is Map) {
            final normalized = _normalizeActionMap(item);
            if (normalized != null) actions.add(normalized);
          }
        }
        return <String, dynamic>{'actions': actions};
      }
    } on MissingPluginException {
      // No native extension queue on desktop/test hosts.
    }
    return const <String, dynamic>{'actions': <Map<String, dynamic>>[]};
  }

  static Map<String, dynamic>? _normalizeActionMap(Map<dynamic, dynamic> raw) {
    final id = raw['id'] is String ? (raw['id'] as String).trim() : '';
    final href = raw['href'] is String ? (raw['href'] as String).trim() : '';
    if (id.isEmpty || href.isEmpty) return null;
    final source = raw['source'];
    final timestampMs = raw['timestampMs'];
    return <String, dynamic>{
      'id': id,
      'href': href,
      'source': source is String ? source.trim() : 'widget',
      'timestampMs': timestampMs is num && timestampMs.isFinite
          ? timestampMs.toInt()
          : DateTime.now().millisecondsSinceEpoch,
    };
  }
}
