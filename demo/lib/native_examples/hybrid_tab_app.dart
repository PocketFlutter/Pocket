// dart format width=100
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'hybrid_flutter_host_plugin.dart';
import 'showcase_base_config.dart' show showcaseBaseConfig, showcaseNativePolicies;

/// Hybrid Flutter TabBar Demo hosting native Flutter pages alongside a
/// lazy-mounted Pocket SystemUI tab and fullscreen direct mini-app launches.
class PocketHybridTabDemoApp extends StatefulWidget {
  const PocketHybridTabDemoApp({
    super.key,
    this.bundledApplications,
    this.systemUI,
    this.nativePolicies,
    this.tabSystemController,
    this.launchControllerFactory,
    this.diagnostics,
    this.recordings,
    this.initialTabIndex = 0,
    this.onClose,
  });

  final PocketBundledApplicationCatalog? bundledApplications;
  final PocketAppConfig? systemUI;
  final Map<String, PocketAppConfig>? nativePolicies;
  final PocketSystemHostController? tabSystemController;
  final PocketSystemHostController Function()? launchControllerFactory;
  final PocketHostDiagnostics? diagnostics;
  final PocketRecordingLibrary? recordings;
  final int initialTabIndex;
  final VoidCallback? onClose;

  @override
  State<PocketHybridTabDemoApp> createState() => _PocketHybridTabDemoAppState();
}

class _PocketHybridTabDemoAppState extends State<PocketHybridTabDemoApp> {
  static const Set<String> _keyboardInputPrefixes = <String>{'dev.pocket-nexus.'};

  late int _currentIndex;
  late bool _pocketTabVisited;
  late Future<void> _catalogFuture;
  PocketAppConfig? _systemUI;
  PocketAppConfig? _launchSystemUI;
  Map<String, PocketAppConfig>? _applications;
  Object? _catalogError;
  final PocketSystemHostController _ownedTabSystemController = PocketSystemHostController();
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();
  int _nativeCounter = 0;
  PocketSystemLaunchResult? _lastLaunchResult;

  PocketSystemHostController get _tabSystemController =>
      widget.tabSystemController ?? _ownedTabSystemController;

  @override
  void initState() {
    super.initState();
    _currentIndex = widget.initialTabIndex.clamp(0, 2);
    _pocketTabVisited = _currentIndex == 2;
    _catalogFuture = _prepareCatalog();
  }

  Future<void> _prepareCatalog() async {
    try {
      final baseSystemUI = widget.systemUI ?? showcaseBaseConfig;
      final catalog =
          widget.bundledApplications ??
          await PocketBundledApplicationCatalog.loadFromBundle(
            'assets/apps/official/catalog.json',
            assetPrefix: 'assets/',
            firstCompositorHandle: 4,
            lastCompositorHandle: 62,
            reservedAppIds: <String>{baseSystemUI.appId},
          );
      final launchSystemUI = baseSystemUI.copyWith(
        compositorSurfaces: <String, int>{
          ...baseSystemUI.compositorSurfaces,
          ...catalog.compositorSurfaces,
        },
      );
      final systemUI = launchSystemUI.copyWith(
        pluginFactories: <PocketPluginFactory>[
          ...launchSystemUI.pluginFactories,
          (controller) => DemoHybridFlutterMiniAppPlugin(
            controller: controller,
            startMiniApp: _startExternalMiniApp,
          ),
        ],
      );
      final configured = catalog.applicationsWithNativePolicies(
        nativePolicies: widget.nativePolicies ?? showcaseNativePolicies,
      );
      final applications = Map<String, PocketAppConfig>.unmodifiable(<String, PocketAppConfig>{
        for (final entry in configured.entries)
          entry.key: _keyboardInputPrefixes.any(entry.key.startsWith)
              ? entry.value.copyWith(keyboardInputEnabled: true)
              : entry.value,
      });
      if (!mounted) return;
      setState(() {
        _launchSystemUI = launchSystemUI;
        _systemUI = systemUI;
        _applications = applications;
        _catalogError = null;
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _catalogError = error;
      });
    }
  }

  void _selectTab(int index) {
    setState(() {
      _currentIndex = index;
      if (index == 2) {
        _pocketTabVisited = true;
      }
    });
  }

  Future<PocketSystemLaunchResult?> _launchMiniApp(
    BuildContext hostContext,
    String appId, {
    Object? arguments,
  }) async {
    await _catalogFuture;
    if (!mounted || !hostContext.mounted || _launchSystemUI == null || _applications == null) {
      return null;
    }
    final handle = _pushMiniAppRoute(Navigator.of(hostContext), appId, arguments: arguments);
    try {
      final result = await handle.result;
      if (mounted) setState(() => _lastLaunchResult = result);
      return result;
    } catch (_) {
      await handle.cancel();
      rethrow;
    }
  }

  Future<DemoHybridMiniAppRoute> _startExternalMiniApp(Map<String, dynamic> request) async {
    final requestId = request['requestId'];
    final appId = request['appId'];
    final navigator = _navigatorKey.currentState;
    if (!mounted ||
        requestId is! String ||
        requestId.isEmpty ||
        appId is! String ||
        appId.isEmpty ||
        navigator == null ||
        !navigator.mounted ||
        _launchSystemUI == null ||
        _applications == null) {
      throw StateError('The fullscreen MiniApp route is not ready.');
    }
    final handle = _pushMiniAppRoute(
      navigator,
      appId,
      arguments: request['arguments'],
      presentationStyle: request['presentationStyle'] as String?,
    );
    return handle;
  }

  DemoHybridMiniAppRoute _pushMiniAppRoute(
    NavigatorState navigator,
    String appId, {
    Object? arguments,
    String? presentationStyle,
  }) {
    final launchController = widget.launchControllerFactory?.call();
    PocketSystemLaunchResult? capturedResult;
    final route = MaterialPageRoute<PocketSystemLaunchResult>(
      builder: (routeContext) => Scaffold(
        backgroundColor: const Color(0xFF000000),
        body: PocketSystemHost(
          systemUI: _launchSystemUI!,
          applications: _applications!,
          controller: launchController,
          recordings: widget.recordings,
          diagnostics: widget.diagnostics,
          initialLaunch: PocketSystemLaunchRequest(
            appId: appId,
            arguments: arguments,
            presentationStyle: presentationStyle,
            closeContainerWhenEmpty: true,
          ),
          onCloseWithResult: (result) {
            capturedResult = result;
            final currentRoute = ModalRoute.of(routeContext);
            if (routeContext.mounted && (currentRoute?.isCurrent ?? true)) {
              Navigator.of(routeContext).pop(result);
            }
          },
        ),
      ),
    );
    var controllerDisposed = false;
    void disposeLaunchController() {
      if (controllerDisposed) return;
      controllerDisposed = true;
      launchController?.dispose();
    }

    unawaited(
      route.completed.whenComplete(() {
        WidgetsBinding.instance.addPostFrameCallback((_) => disposeLaunchController());
      }),
    );
    late final Future<PocketSystemLaunchResult?> routeResult;
    try {
      routeResult = navigator.push<PocketSystemLaunchResult>(route);
    } on Object {
      disposeLaunchController();
      rethrow;
    }
    final result = routeResult.then((value) async {
      await route.completed;
      return value ?? capturedResult;
    });
    return DemoHybridMiniAppRoute(
      result: result,
      cancel: () async {
        if (!route.isActive || !navigator.mounted) return;
        final cancelled = PocketSystemLaunchResult(
          appId: appId,
          cancelled: true,
          reason: 'cancelled',
        );
        if (route.isCurrent) {
          navigator.pop<PocketSystemLaunchResult>(cancelled);
        } else {
          navigator.removeRoute(route, cancelled);
        }
      },
    );
  }

  @override
  void dispose() {
    _ownedTabSystemController.dispose();
    super.dispose();
  }

  static String _formatLaunchResult(PocketSystemLaunchResult result) =>
      '最近唤起结果: appId=${result.appId} cancelled=${result.cancelled} '
      'value=${result.value} reason=${result.reason}';

  Widget _buildHomeTab(BuildContext context) => SafeArea(
    child: ListView(
      padding: const EdgeInsets.all(20),
      children: <Widget>[
        const Text('原生首页', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: <Widget>[
                Text('原生计数器: $_nativeCounter', style: const TextStyle(fontSize: 16)),
                FilledButton(
                  key: const ValueKey<String>('native-counter-increment'),
                  onPressed: () => setState(() => _nativeCounter += 1),
                  child: const Text('+1 原生计数'),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('launch-profile-btn'),
          onPressed: () => unawaited(
            _launchMiniApp(
              context,
              'pocket.demo.profile',
              arguments: const <String, Object?>{'source': 'native-home'},
            ),
          ),
          child: const Text('唤起 Profile 小程序'),
        ),
        const SizedBox(height: 8),
        FilledButton.tonal(
          key: const Key('launch-lobby-btn'),
          onPressed: () => unawaited(
            _launchMiniApp(
              context,
              'pocket.demo.lobby',
              arguments: const <String, Object?>{'source': 'native-home'},
            ),
          ),
          child: const Text('唤起 Lobby 小程序'),
        ),
        const SizedBox(height: 16),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: _lastLaunchResult == null
                ? const Text('尚未唤起外部小程序')
                : Text(
                    _formatLaunchResult(_lastLaunchResult!),
                    key: const Key('last-launch-result'),
                  ),
          ),
        ),
      ],
    ),
  );

  Widget _buildExploreTab(BuildContext context) => SafeArea(
    child: Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Text('原生发现', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
            const SizedBox(height: 16),
            FilledButton(
              key: const Key('open-native-detail-btn'),
              onPressed: () {
                Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                    builder: (_) => _NativeDetailPage(onLaunchMiniApp: _launchMiniApp),
                  ),
                );
              },
              child: const Text('进入原生二级页'),
            ),
          ],
        ),
      ),
    ),
  );

  Widget _buildPocketTab() {
    if (!_pocketTabVisited) {
      return const SizedBox.expand();
    }
    if (_catalogError != null) {
      return Center(child: SelectableText('目录加载失败: $_catalogError'));
    }
    if (_systemUI == null || _applications == null) {
      return const SizedBox.expand();
    }
    return PocketSystemHost(
      systemUI: _systemUI!,
      applications: _applications!,
      controller: _tabSystemController,
      recordings: widget.recordings,
      diagnostics: widget.diagnostics,
      active: _currentIndex == 2,
    );
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    navigatorKey: _navigatorKey,
    debugShowCheckedModeBanner: false,
    home: Builder(
      builder: (scaffoldContext) {
        return Scaffold(
          appBar: widget.onClose == null
              ? null
              : AppBar(
                  leading: IconButton(
                    key: const Key('hybrid-host-close'),
                    tooltip: '关闭混合宿主',
                    onPressed: widget.onClose,
                    icon: const Icon(Icons.close),
                  ),
                  title: const Text('混合 Flutter 宿主'),
                  centerTitle: true,
                ),
          body: IndexedStack(
            index: _currentIndex,
            children: <Widget>[
              _buildHomeTab(scaffoldContext),
              _buildExploreTab(scaffoldContext),
              _buildPocketTab(),
            ],
          ),
          bottomNavigationBar: NavigationBar(
            selectedIndex: _currentIndex,
            onDestinationSelected: _selectTab,
            destinations: const <NavigationDestination>[
              NavigationDestination(
                icon: Icon(Icons.home_outlined),
                selectedIcon: Icon(Icons.home),
                label: '原生首页',
              ),
              NavigationDestination(
                icon: Icon(Icons.explore_outlined),
                selectedIcon: Icon(Icons.explore),
                label: '原生发现',
              ),
              NavigationDestination(
                icon: Icon(Icons.apps_outlined),
                selectedIcon: Icon(Icons.apps),
                label: 'Pocket 广场',
              ),
            ],
          ),
        );
      },
    ),
  );
}

class _NativeDetailPage extends StatefulWidget {
  const _NativeDetailPage({required this.onLaunchMiniApp});

  final Future<PocketSystemLaunchResult?> Function(
    BuildContext context,
    String appId, {
    Object? arguments,
  })
  onLaunchMiniApp;

  @override
  State<_NativeDetailPage> createState() => _NativeDetailPageState();
}

class _NativeDetailPageState extends State<_NativeDetailPage> {
  PocketSystemLaunchResult? _detailLaunchResult;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('原生二级详情页')),
    body: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          FilledButton(
            key: const Key('detail-launch-lobby-btn'),
            onPressed: () async {
              final result = await widget.onLaunchMiniApp(
                context,
                'pocket.demo.lobby',
                arguments: const <String, Object?>{'source': 'native-detail'},
              );
              if (!mounted) return;
              setState(() {
                _detailLaunchResult = result;
              });
            },
            child: const Text('唤起 Lobby 小程序'),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            key: const Key('native-detail-back-btn'),
            onPressed: () => unawaited(Navigator.of(context).maybePop()),
            child: const Text('返回上一页'),
          ),
          const SizedBox(height: 16),
          if (_detailLaunchResult != null)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  _PocketHybridTabDemoAppState._formatLaunchResult(_detailLaunchResult!),
                  key: const Key('detail-launch-result'),
                ),
              ),
            ),
        ],
      ),
    ),
  );
}
