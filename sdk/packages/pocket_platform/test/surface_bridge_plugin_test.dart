import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/src/pocket_model.dart' show PocketEvent;
import 'package:pocket_platform/pocket_platform.dart';
import 'package:pocket_services/pocket_services.dart';

final class _FakeSurfaceTransport implements PocketPlatformTransport {
  final List<(String, Map<String, dynamic>)> calls =
      <(String, Map<String, dynamic>)>[];
  PocketPlatformMethodCallHandler? handler;
  bool throwMissingPlugin = false;
  Object? snapshotResult = <String, dynamic>{
    'published': true,
    'reloadedWidgets': true,
    'pushedWatchContext': true,
  };
  Map<String, dynamic>? liveResult;
  final List<Map<String, dynamic>> pendingQueue = <Map<String, dynamic>>[];

  @override
  Future<Object?> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
    calls.add((method, arguments));
    if (throwMissingPlugin) {
      throw MissingPluginException('No implementation for $method');
    }
    switch (method) {
      case 'configureSurfaces':
        return <String, dynamic>{
          'configured': true,
          'appGroupId': arguments['appGroupId'],
        };
      case 'getSurfaceStatus':
        return <String, dynamic>{
          'available': true,
          'ecosystem': 'apple',
          'appGroupId': arguments['appGroupId'] ?? 'group.dev.pocketjs.demo',
          'supportsWidgets': true,
          'supportsLiveActivities': true,
          'watchPaired': true,
          'pendingActionCount': pendingQueue.length,
        };
      case 'publishSnapshot':
        return snapshotResult;
      case 'upsertLiveActivity':
        return liveResult ??
            <String, dynamic>{
              'active': true,
              'activityId': arguments['activityId'] ?? 'live-1',
            };
      case 'endLiveActivity':
        return <String, dynamic>{'active': false};
      case 'drainPendingActions':
        final copy = List<Map<String, dynamic>>.from(pendingQueue);
        pendingQueue.clear();
        return <String, dynamic>{'actions': copy};
      default:
        return null;
    }
  }

  @override
  void setMethodCallHandler(PocketPlatformMethodCallHandler? next) {
    handler = next;
  }
}

({PocketPluginManager manager, PocketHost host}) _managerFor(
  PocketPlugin plugin,
  Set<String> capabilities, {
  List<Map<String, dynamic>>? sent,
}) {
  bool send(String method, Map<String, dynamic> params) {
    sent?.add(<String, dynamic>{'method': method, ...params});
    return true;
  }

  final host = PocketHost(
    registry: PocketHostRegistry(),
    streams: PocketStreamBridge(send: send),
    allowedCapabilities: capabilities,
    send: send,
  );
  final manager = PocketPluginManager(
    host: host,
    appId: 'test.surfaces',
    sessionId: 'surfaces-session',
  )..register(plugin);
  return (manager: manager, host: host);
}

void main() {
  test(
    'PocketSurfaceBridgePlugin publishes snapshots, manages live activities, and streams widget actions',
    () async {
      final transport = _FakeSurfaceTransport();
      transport.pendingQueue.add(<String, dynamic>{
        'id': 'quick-feed',
        'href': 'babylink://app/today?action=quick_bottle',
        'source': 'ios-widget',
        'timestampMs': 1700000000000,
      });

      final sent = <Map<String, dynamic>>[];
      final plugin = PocketSurfaceBridgePlugin(
        appGroupId: 'group.fun.selfstudio.babylink.set',
        deepLinkScheme: 'babylink',
        transport: transport,
      );

      final pair = _managerFor(
        plugin,
        PocketSurfaceCapabilities.all,
        sent: sent,
      );
      final availability = pair.manager.negotiate(
        required: const <String>[],
        optional: PocketSurfaceCapabilities.all,
      );
      await pair.manager.activate(availability);

      final status =
          await pair.manager.invoke(
                PocketSurfaceCapabilities.surfaceGet,
                const <String, dynamic>{},
              )
              as Map<String, dynamic>;
      expect(status['available'], isTrue);
      expect(status['appGroupId'], equals('group.fun.selfstudio.babylink.set'));
      expect(status['supportsLiveActivities'], isTrue);
      expect(status['pendingActionCount'], equals(1));

      final publishRes =
          await pair.manager.invoke(
                PocketSurfaceCapabilities.publishSnapshot,
                <String, dynamic>{
                  'profileId': 'ios-widget-medium',
                  'renderMode': 'fullColor',
                  'title': '今日喂养',
                  'primaryValue': '120 ml',
                  'subtitle': '刚刚记录',
                },
              )
              as Map<String, dynamic>;
      expect(publishRes['published'], isTrue);
      expect(publishRes['reloadedWidgets'], isTrue);
      expect(publishRes['pushedWatchContext'], isTrue);

      transport.snapshotResult = null;
      final emptyPublishRes =
          await pair.manager.invoke(
                PocketSurfaceCapabilities.publishSnapshot,
                <String, dynamic>{'title': 'Snapshot'},
              )
              as Map<String, dynamic>;
      expect(emptyPublishRes['published'], isFalse);
      expect(emptyPublishRes['reason'], equals('empty_response'));

      transport.snapshotResult = <String, dynamic>{
        'published': false,
        'reason': 'app_group_unavailable',
      };
      final rejectedPublishRes =
          await pair.manager.invoke(
                PocketSurfaceCapabilities.publishSnapshot,
                <String, dynamic>{'title': 'Snapshot'},
              )
              as Map<String, dynamic>;
      expect(rejectedPublishRes['published'], isFalse);
      expect(rejectedPublishRes['reason'], equals('app_group_unavailable'));

      final liveRes =
          await pair.manager.invoke(
                PocketSurfaceCapabilities.liveActivityUpsert,
                <String, dynamic>{
                  'activityId': 'nursing',
                  'leadingBadge': '亲喂中',
                  'trailingMetric': '08:20',
                  'title': '左侧亲喂计时',
                  'subtitle': '单侧满 15 分钟温和提醒',
                  'progress': 0.55,
                  'primaryActionLabel': '换右侧',
                  'primaryHref': 'babylink://app/feeding?action=switch_side',
                },
              )
              as Map<String, dynamic>;
      expect(liveRes['active'], isTrue);
      expect(liveRes['activityId'], equals('nursing'));

      transport.liveResult = <String, dynamic>{
        'active': false,
        'reason': 'notification_channel_disabled',
      };
      final blockedLive =
          await pair.manager.invoke(
                PocketSurfaceCapabilities.liveActivityUpsert,
                <String, dynamic>{'title': 'Snapshot'},
              )
              as Map<String, dynamic>;
      expect(blockedLive['active'], isFalse);
      expect(blockedLive['reason'], equals('notification_channel_disabled'));

      final drained =
          await pair.manager.invoke(
                PocketSurfaceCapabilities.drainActions,
                const <String, dynamic>{},
              )
              as Map<String, dynamic>;
      expect((drained['actions'] as List).length, equals(1));

      final event = <String, dynamic>{
        'id': 'watch-diaper',
        'href': 'babylink://app/today?action=quick_diaper',
        'source': 'apple-watch',
        'timestampMs': 1700000005000,
      };
      expect(await transport.handler?.call('onWidgetAction', event), isFalse);

      await pair.host.handle(
        PocketEvent(
          id: 'surfaces-open',
          method: 'stream.open',
          params: <String, dynamic>{
            'streamId': 'surfaces-test',
            'topic': PocketSurfaceCapabilities.actionEvents,
          },
        ),
      );

      expect(
        await transport.handler?.call('onWidgetAction', {
          'id': 1,
          'href': 'bad',
        }),
        isFalse,
      );
      expect(await transport.handler?.call('onWidgetAction', event), isTrue);
      await Future<void>.delayed(Duration.zero);

      final streamedData = sent
          .where((event) => event['method'] == 'stream.data')
          .toList();
      expect(streamedData.length, equals(1));
      expect(
        (streamedData.single['data'] as Map)['id'],
        equals('watch-diaper'),
      );
      expect(
        (streamedData.single['data'] as Map)['source'],
        equals('apple-watch'),
      );

      await pair.manager.dispose();
      expect(transport.handler, isNull);
      expect(transport.calls.last.$1, equals('disableSurfaces'));
      pair.host.dispose();
    },
  );

  test(
    'PocketSurfaceBridgePlugin degrades cleanly when native channel is absent on desktop',
    () async {
      final transport = _FakeSurfaceTransport()..throwMissingPlugin = true;
      final plugin = PocketSurfaceBridgePlugin(
        appGroupId: 'group.fun.selfstudio.babylink.set',
        transport: transport,
      );
      final pair = _managerFor(plugin, PocketSurfaceCapabilities.all);
      final availability = pair.manager.negotiate(
        required: const <String>[],
        optional: PocketSurfaceCapabilities.all,
      );
      await pair.manager.activate(availability);

      final status =
          await pair.manager.invoke(
                PocketSurfaceCapabilities.surfaceGet,
                const <String, dynamic>{},
              )
              as Map<String, dynamic>;
      expect(status['available'], isFalse);

      final pub =
          await pair.manager.invoke(
                PocketSurfaceCapabilities.publishSnapshot,
                <String, dynamic>{'title': 'Clean'},
              )
              as Map<String, dynamic>;
      expect(pub['published'], isFalse);
      expect(pub['reason'], equals('native_surface_channel_unavailable'));

      await pair.manager.dispose();
      pair.host.dispose();
    },
  );
}
