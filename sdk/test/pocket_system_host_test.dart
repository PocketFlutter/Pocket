import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart'
    show
        PocketBytecodeRuntime,
        PocketCompositorRuntime,
        PocketEvent,
        PocketFrame,
        PocketImageResource,
        PocketOp,
        PocketHostSurfaceOp,
        PocketRectOp,
        PocketRuntime,
        PocketView,
        debugPocketSelfOwnedRuntimeFactory;
import 'package:pocket_flutter/src/pocket_compositor.dart';
import 'package:pocket_flutter/src/pocket_memory_limits.dart';
import 'package:pocket_sdk/src/pocket_app.dart'
    show PocketGuest, PocketGuestSession, PocketGuestSessionState;
import 'package:pocket_sdk/src/pocket_config.dart';
import 'package:pocket_sdk/src/pocket_system_host.dart';
import 'package:pocket_services/pocket_services.dart';

final class _ProbeChildRuntime
    implements PocketRuntime, PocketCompositorRuntime, PocketBytecodeRuntime {
  int frameCalls = 0;
  final List<int> frameDeltas = <int>[];
  final List<Map<String, dynamic>> sentMessages = <Map<String, dynamic>>[];
  void Function(Map<String, dynamic> message)? onMessage;
  PocketFrame? frameOverride;
  Map<String, dynamic>? presetsBeforeFirstFrame;

  static const PocketFrame _frame = PocketFrame(
    width: 240,
    height: 320,
    ops: <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 240, height: 320, color: 0xff101827),
    ],
    events: <PocketEvent>[],
    resources: <PocketImageResource>[],
  );

  @override
  void configureCompositor(Map<String, int> applications) {}

  @override
  String? get actualAbi => 'system-host-unit-abi';

  @override
  PocketFrame loadBytecode(
    Uint8List bytecode,
    Uint8List pak, {
    String? expectedRuntimeAbi,
  }) => _frame;

  @override
  PocketFrame eval(String source) => _frame;

  @override
  PocketFrame load(String source, Uint8List pak) => _frame;

  @override
  PocketFrame frame(int deltaMilliseconds) {
    frameCalls += 1;
    frameDeltas.add(deltaMilliseconds);
    for (final message in sentMessages) {
      if (message['name'] == 'platform.presets' &&
          message['payload'] is Map<String, dynamic>) {
        presetsBeforeFirstFrame = Map<String, dynamic>.from(
          message['payload'] as Map<String, dynamic>,
        );
      }
    }
    return frameOverride ?? _frame;
  }

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {
    final copy = Map<String, dynamic>.from(message);
    sentMessages.add(copy);
    onMessage?.call(copy);
  }

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

final class _RegistryCapturePlugin extends PocketPlugin {
  _RegistryCapturePlugin(this.onRegistered);

  final void Function(PocketHostRegistry registry) onRegistered;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'test.pocket-system-host-registry-capture',
    version: '1.0.0',
    capabilities: <String, PocketPluginCapability>{},
  );

  @override
  void register(PocketPluginContext context) => onRegistered(context.registry);
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  const rootId = 'system.test.root';
  const childId = 'system.test.child';
  const emptyMemoryChildId = 'system.test.empty-memory-child';
  late Directory directory;

  setUp(() {
    directory = Directory.systemTemp.createTempSync('pocket-system-host-unit-');
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => directory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final requested = utf8.decode(data.buffer.asUint8List());
      final Object content;
      if (requested.endsWith('metadata.json')) {
        content = <String, Object?>{
          'runtimeAbi': 'system-host-unit-abi',
          'bytecodeBytes': 1,
          'build': 1,
          'version': '1.0.0',
        };
      } else if (requested.contains('root.manifest.json')) {
        content = <String, Object?>{
          'capabilities': <String, Object?>{
            'requires': <String>[
              'ui.compositor-surfaces',
              'system.runtime.configure',
              'system.runtime.create',
              'system.runtime.awaitFirstFrame',
              'system.runtime.destroy',
              'system.runtime.post',
              'system.runtime.respond',
            ],
          },
        };
      } else {
        content = <String, Object?>{
          'capabilities': <String, Object?>{'requires': <String>[]},
        };
      }
      return ByteData.sublistView(
        Uint8List.fromList(utf8.encode(jsonEncode(content))),
      );
    });
  });

  tearDown(() {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
    rootBundle.clear();
    if (directory.existsSync()) {
      directory.deleteSync(recursive: true);
    }
  });

  Future<Object?> invokeSystem(
    WidgetTester tester,
    PocketHostRegistry rootRegistry,
    String capability, [
    Map<String, dynamic> params = const <String, dynamic>{},
  ]) async {
    final registration = rootRegistry.registrationFor(capability);
    if (registration?.request == null) {
      throw StateError('System capability was not registered: $capability');
    }
    var completed = false;
    Object? result;
    Object? failure;
    StackTrace? failureStack;
    unawaited(
      Future<Object?>.sync(() => registration!.request!(params)).then(
        (value) {
          result = value;
          completed = true;
        },
        onError: (Object error, StackTrace stack) {
          failure = error;
          failureStack = stack;
          completed = true;
        },
      ),
    );
    // System capability handlers can initialize app-private storage, so allow
    // a bounded real-time window instead of assuming every filesystem Future
    // completes within the former 60 ms poll interval.
    final wait = Stopwatch()..start();
    while (!completed && wait.elapsed < const Duration(seconds: 2)) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1)),
      );
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(completed, isTrue, reason: '$capability did not finish');
    if (failure != null) Error.throwWithStackTrace(failure!, failureStack!);
    return result;
  }

  Future<PocketSystemInstanceSnapshot> waitFor(
    WidgetTester tester,
    PocketSystemHostController controller,
    bool Function(PocketSystemInstanceSnapshot) predicate,
  ) async {
    for (var attempt = 0; attempt < 60; attempt++) {
      for (final instance in controller.instances) {
        if (predicate(instance)) return instance;
      }
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1)),
      );
      await tester.pump(const Duration(milliseconds: 16));
    }
    fail('Timed out waiting for host instance');
  }

  Future<void> verifyBackGestureRegistrationTarget(
    WidgetTester tester, {
    required bool registerChild,
    required bool staleChildRegistration,
  }) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    final controller = PocketSystemHostController();
    late PocketHostRegistry rootRegistry;
    final previousFactory = debugPocketSelfOwnedRuntimeFactory;
    final runtimes = <_ProbeChildRuntime>[];
    debugPocketSelfOwnedRuntimeFactory = (_) {
      final runtime = _ProbeChildRuntime();
      runtimes.add(runtime);
      return runtime;
    };
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final requested = utf8.decode(data.buffer.asUint8List());
      if (requested.endsWith('.qjbc')) return ByteData(1);
      if (requested.endsWith('.pak')) return ByteData(0);
      final Object content;
      if (requested.endsWith('metadata.json')) {
        content = <String, Object?>{
          'entryFormat': 'quickjs-bytecode',
          'formatVersion': 1,
          'kind': 'script',
          'bindingGeneration': 1,
          'tickHz': 60,
          'runtimeAbi': 'system-host-unit-abi',
          'bytecodeBytes': 1,
          'version': '1.0.0',
          'build': 1,
        };
      } else if (requested.contains('root.manifest.json')) {
        content = <String, Object?>{
          'capabilities': <String, Object?>{
            'requires': <String>[
              'ui.compositor-surfaces',
              'system.runtime.configure',
              'system.runtime.create',
              'system.runtime.awaitFirstFrame',
              'system.runtime.destroy',
              'system.runtime.post',
              'system.runtime.respond',
            ],
          },
        };
      } else {
        content = <String, Object?>{
          'capabilities': <String, Object?>{'requires': <String>[]},
        };
      }
      return ByteData.sublistView(
        Uint8List.fromList(utf8.encode(jsonEncode(content))),
      );
    });

    try {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PocketSystemHost(
              systemUI: PocketAppConfig(
                appId: rootId,
                bytecodeAsset: 'test/root.qjbc',
                pakAsset: 'test/root.pak',
                metadataAsset: 'test/root.metadata.json',
                manifestAsset: 'test/root.manifest.json',
                additionalCapabilities: const {'ui.compositor-surfaces'},
                compositorSurfaces: const <String, int>{childId: 2},
                pluginFactories: <PocketPluginFactory>[
                  (_) => _RegistryCapturePlugin((registry) {
                    rootRegistry = registry;
                  }),
                ],
              ),
              applications: const <String, PocketAppConfig>{
                childId: PocketAppConfig(
                  appId: childId,
                  bytecodeAsset: 'test/child.qjbc',
                  pakAsset: 'test/child.pak',
                  metadataAsset: 'test/child.metadata.json',
                  manifestAsset: 'test/child.manifest.json',
                ),
              },
              controller: controller,
            ),
          ),
        ),
      );

      final root = await waitFor(
        tester,
        controller,
        (entry) => entry.isSystemUI && entry.ready && entry.firstFrameReady,
      );
      await invokeSystem(
        tester,
        rootRegistry,
        'system.runtime.configure',
        <String, dynamic>{
          'systemUI': rootId,
          'grants': <Map<String, Object?>>[
            {'appId': rootId, 'sharedNamespaces': <String>[]},
            {'appId': childId, 'sharedNamespaces': <String>[]},
          ],
        },
      );
      final created = Map<String, dynamic>.from(
        await invokeSystem(
              tester,
              rootRegistry,
              'system.runtime.create',
              <String, dynamic>{'appId': childId},
            )
            as Map,
      );
      await waitFor(
        tester,
        controller,
        (entry) => entry.instanceId == created['instanceId'] && entry.ready,
      );
      final rootRuntime = runtimes.first;
      rootRuntime.frameOverride = PocketFrame(
        width: 240,
        height: 320,
        ops: const <PocketOp>[
          PocketHostSurfaceOp(
            x: 0,
            y: 0,
            width: 240,
            height: 320,
            id: 'focused-child',
            kind: 'application',
            parameters: <String, dynamic>{},
            surfaceHandle: 2,
            focused: true,
          ),
        ],
        events: const <PocketEvent>[],
        resources: const <PocketImageResource>[],
      );
      await tester.pump(const Duration(milliseconds: 32));
      final focusedChild = await waitFor(
        tester,
        controller,
        (entry) =>
            entry.instanceId == created['instanceId'] &&
            entry.firstFrameReady &&
            entry.foreground &&
            entry.compositorFocused,
      );
      if (registerChild) {
        focusedChild.session.onEvent(
          PocketEvent(
            id: 'gesture-ready-${focusedChild.generation}',
            method: 'platform.back.gesture.ready',
            params: const <String, Object?>{'ready': true},
          ),
        );
      }
      if (staleChildRegistration) focusedChild.session.generation++;

      expect(runtimes, hasLength(2));
      final childRuntime = runtimes.last;
      void answerStart(
        _ProbeChildRuntime runtime,
        PocketSystemInstanceSnapshot instance,
      ) {
        runtime.onMessage = (message) {
          if (message['name'] != 'platform.back.gesture') return;
          final payload = (message['payload'] as Map).cast<String, dynamic>();
          if (payload['phase'] != 'start') return;
          instance.session.onEvent(
            PocketEvent(
              id: 'gesture-response-${payload['gestureId']}',
              method: 'platform.back.gesture.response',
              params: <String, Object?>{
                'gestureId': payload['gestureId'],
                'handled': true,
              },
            ),
          );
        };
      }

      answerStart(rootRuntime, root);
      answerStart(childRuntime, focusedChild);
      final pointer = await tester.startGesture(const Offset(12, 200));
      await tester.pump();
      List<Map<String, dynamic>> gestureStarts(_ProbeChildRuntime runtime) =>
          runtime.sentMessages
              .where(
                (message) =>
                    message['name'] == 'platform.back.gesture' &&
                    (message['payload'] as Map)['phase'] == 'start',
              )
              .toList();
      if (registerChild && !staleChildRegistration) {
        expect(
          gestureStarts(childRuntime),
          hasLength(1),
          reason:
              'a child registered in its current generation must be asked first',
        );
        expect(gestureStarts(rootRuntime), isEmpty);
      } else {
        expect(
          gestureStarts(childRuntime),
          isEmpty,
          reason:
              'an unregistered or stale child must not receive a start handshake',
        );
        expect(
          gestureStarts(rootRuntime),
          hasLength(1),
          reason:
              'SystemUI should receive the gesture directly when child is ineligible',
        );
      }
      await pointer.cancel();
      await tester.pump();
      expect(
        (rootRuntime.sentMessages + childRuntime.sentMessages).where(
          (message) => message['name'] == 'platform.back.request',
        ),
        isEmpty,
        reason: 'a cancelled edge gesture must not dispatch discrete Back',
      );
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      if (staleChildRegistration) {
        // Advancing the synthetic generation remounts its PocketView and
        // starts the normal one-second health observation timer. Let it
        // retire while the test binding is still active.
        await tester.pump(const Duration(seconds: 1));
      }
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      debugDefaultTargetPlatformOverride = null;
      debugPocketSelfOwnedRuntimeFactory = previousFactory;
      controller.dispose();
    }
  }

  testWidgets('system Back asks the guest before closing the embedded host', (
    tester,
  ) async {
    final controller = PocketSystemHostController();
    final runtime = _ProbeChildRuntime();
    final previousFactory = debugPocketSelfOwnedRuntimeFactory;
    debugPocketSelfOwnedRuntimeFactory = (_) => runtime;
    var closes = 0;
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final requested = utf8.decode(data.buffer.asUint8List());
      if (requested.endsWith('.qjbc')) return ByteData(1);
      if (requested.endsWith('.pak')) return ByteData(0);
      final content = requested.endsWith('metadata.json')
          ? <String, Object?>{
              'entryFormat': 'quickjs-bytecode',
              'formatVersion': 1,
              'kind': 'script',
              'bindingGeneration': 1,
              'tickHz': 60,
              'runtimeAbi': 'system-host-unit-abi',
              'bytecodeBytes': 1,
              'version': '1.0.0',
              'build': 1,
            }
          : <String, Object?>{
              'capabilities': {
                'requires': ['ui.compositor-surfaces'],
              },
            };
      return ByteData.sublistView(
        Uint8List.fromList(utf8.encode(jsonEncode(content))),
      );
    });
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PocketSystemHost(
              systemUI: const PocketAppConfig(
                appId: rootId,
                bytecodeAsset: 'test/root.qjbc',
                pakAsset: 'test/root.pak',
                metadataAsset: 'test/root.metadata.json',
                manifestAsset: 'test/root.manifest.json',
                additionalCapabilities: {'ui.compositor-surfaces'},
              ),
              applications: const {},
              controller: controller,
              onClose: () => closes++,
            ),
          ),
        ),
      );
      final root = await waitFor(
        tester,
        controller,
        (entry) => entry.isSystemUI && entry.firstFrameReady,
      );
      List<Map<String, dynamic>> requests() => runtime.sentMessages
          .where((message) => message['name'] == 'platform.back.request')
          .toList();

      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(requests(), hasLength(1));
      expect(closes, 0);
      final pending = controller.requestBack();
      expect(
        identical(pending, controller.requestBack()),
        isTrue,
        reason: 'concurrent back requests must share one guest request',
      );
      final requestId = (requests().single['payload'] as Map)['requestId'];
      root.session.onEvent(
        PocketEvent(
          id: 'back-response',
          method: 'platform.back.response',
          params: {'requestId': 'stale-request', 'handled': false},
        ),
      );
      await tester.pump();
      expect(closes, 0);
      root.session.onEvent(
        PocketEvent(
          id: 'back-response',
          method: 'platform.back.response',
          params: {'requestId': requestId, 'handled': true},
        ),
      );
      await tester.pump();
      expect(await pending, isTrue);
      expect(
        closes,
        0,
        reason: 'a JS page pop must retain the embedded container',
      );

      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(requests(), hasLength(2));
      root.session.onEvent(
        PocketEvent(
          id: 'back-response',
          method: 'platform.back.response',
          params: {
            'requestId': (requests().last['payload'] as Map)['requestId'],
            'handled': false,
          },
        ),
      );
      await tester.pump();
      expect(
        closes,
        1,
        reason: 'an unhandled root back must close exactly once',
      );
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      debugPocketSelfOwnedRuntimeFactory = previousFactory;
      controller.dispose();
    }
  });

  testWidgets(
    'loaded host on iOS runtime with Android theme dispatches left-edge velocity and distance swipes to guest',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      final controller = PocketSystemHostController();
      final runtime = _ProbeChildRuntime();
      final previousFactory = debugPocketSelfOwnedRuntimeFactory;
      debugPocketSelfOwnedRuntimeFactory = (_) => runtime;
      var closes = 0;
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        if (data == null) return null;
        final requested = utf8.decode(data.buffer.asUint8List());
        if (requested.endsWith('.qjbc')) return ByteData(1);
        if (requested.endsWith('.pak')) return ByteData(0);
        final content = requested.endsWith('metadata.json')
            ? <String, Object?>{
                'entryFormat': 'quickjs-bytecode',
                'formatVersion': 1,
                'kind': 'script',
                'bindingGeneration': 1,
                'tickHz': 60,
                'runtimeAbi': 'system-host-unit-abi',
                'bytecodeBytes': 1,
                'version': '1.0.0',
                'build': 1,
              }
            : <String, Object?>{
                'capabilities': {
                  'requires': ['ui.compositor-surfaces'],
                },
              };
        return ByteData.sublistView(
          Uint8List.fromList(utf8.encode(jsonEncode(content))),
        );
      });
      try {
        await tester.pumpWidget(
          MaterialApp(
            theme: ThemeData(platform: TargetPlatform.android),
            home: Builder(
              builder: (context) => Scaffold(
                body: Center(
                  child: TextButton(
                    onPressed: () {
                      Navigator.of(context).push<void>(
                        MaterialPageRoute<void>(
                          builder: (_) => Scaffold(
                            body: PocketSystemHost(
                              systemUI: const PocketAppConfig(
                                appId: rootId,
                                bytecodeAsset: 'test/root.qjbc',
                                pakAsset: 'test/root.pak',
                                metadataAsset: 'test/root.metadata.json',
                                manifestAsset: 'test/root.manifest.json',
                                additionalCapabilities: {
                                  'ui.compositor-surfaces',
                                },
                              ),
                              applications: const {},
                              controller: controller,
                              onClose: () => closes++,
                            ),
                          ),
                        ),
                      );
                    },
                    child: const Text('open-host'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('open-host'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 350));

        final root = await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.firstFrameReady,
        );
        runtime.onMessage = (message) {
          if (message['name'] != 'platform.back.gesture') return;
          final payload = (message['payload'] as Map).cast<String, dynamic>();
          if (payload['phase'] != 'start') return;
          root.session.onEvent(
            PocketEvent(
              id: 'gesture-response-${payload['gestureId']}',
              method: 'platform.back.gesture.response',
              params: <String, Object?>{
                'gestureId': payload['gestureId'],
                'handled': false,
              },
            ),
          );
        };
        List<Map<String, dynamic>> requests() => runtime.sentMessages
            .where((message) => message['name'] == 'platform.back.request')
            .toList();

        // 1. Retained parent velocity-based left-edge fling (startX=30 < 36, dx=56 < 88, velocity > 260).
        await tester.flingFrom(const Offset(30, 200), const Offset(56, 0), 600);
        await tester.pump();
        expect(
          requests(),
          hasLength(1),
          reason:
              'iOS device with forced Android Theme must still dispatch velocity edge swipe over loaded PocketView',
        );
        root.session.onEvent(
          PocketEvent(
            id: 'back-response-1',
            method: 'platform.back.response',
            params: {
              'requestId': (requests().last['payload'] as Map)['requestId'],
              'handled': true,
            },
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 350));
        expect(closes, 0);

        // 2. Slow distance-based left-edge drag (startX=12 < 36, dx=100 >= 88, dy=10 <= 72, low velocity).
        final slowSwipe = await tester.startGesture(const Offset(12, 200));
        await slowSwipe.moveTo(const Offset(112, 210));
        await tester.pump(const Duration(milliseconds: 500));
        await slowSwipe.up();
        await tester.pump();
        expect(
          requests(),
          hasLength(2),
          reason: 'slow distance-based edge drag must also dispatch once',
        );
        root.session.onEvent(
          PocketEvent(
            id: 'back-response-2',
            method: 'platform.back.response',
            params: {
              'requestId': (requests().last['payload'] as Map)['requestId'],
              'handled': false,
            },
          ),
        );
        await tester.pump();
        expect(closes, 1);
        expect(tester.takeException(), isNull);
      } finally {
        debugDefaultTargetPlatformOverride = null;
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        debugPocketSelfOwnedRuntimeFactory = previousFactory;
        controller.dispose();
      }
    },
  );

  testWidgets('back gesture skips a child without ready registration', (
    tester,
  ) async {
    await verifyBackGestureRegistrationTarget(
      tester,
      registerChild: false,
      staleChildRegistration: false,
    );
  });

  testWidgets('back gesture asks a current-generation registered child first', (
    tester,
  ) async {
    await verifyBackGestureRegistrationTarget(
      tester,
      registerChild: true,
      staleChildRegistration: false,
    );
  });

  testWidgets(
    'back gesture ignores ready registration from an old generation',
    (tester) async {
      await verifyBackGestureRegistrationTarget(
        tester,
        registerChild: true,
        staleChildRegistration: true,
      );
    },
  );

  testWidgets(
    'awaitFirstFrame throws when a runtime fails after producing an Offstage frame and then becoming visible',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;

      try {
        // Zero-sized host constraints keep PocketView in its pre-start state
        // while exercising the real PocketSystemHost session/plugin lifecycle.
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox.shrink(
                child: PocketSystemHost(
                  systemUI: PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: const {'ui.compositor-surfaces'},
                    compositorSurfaces: const <String, int>{childId: 2},
                    pluginFactories: <PocketPluginFactory>[
                      (_) => _RegistryCapturePlugin((registry) {
                        rootRegistry = registry;
                      }),
                    ],
                  ),
                  applications: const <String, PocketAppConfig>{
                    childId: PocketAppConfig(
                      appId: childId,
                      bytecodeAsset: 'test/child.qjbc',
                      pakAsset: 'test/child.pak',
                      metadataAsset: 'test/child.metadata.json',
                      manifestAsset: 'test/child.manifest.json',
                    ),
                  },
                  controller: controller,
                ),
              ),
            ),
          ),
        );

        await waitFor(tester, controller, (e) => e.isSystemUI && e.ready);
        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.configure',
          <String, dynamic>{
            'systemUI': rootId,
            'grants': <Map<String, Object?>>[
              {'appId': rootId, 'sharedNamespaces': <String>[]},
              {'appId': childId, 'sharedNamespaces': <String>[]},
            ],
          },
        );
        await invokeSystem(
          tester,
          rootRegistry,
          'system.storage.batch',
          <String, dynamic>{
            'appId': rootId,
            'operations': <Map<String, Object?>>[
              {'type': 'set', 'key': 'slot.a', 'value': 'chapter-a'},
              {'type': 'set', 'key': 'slot.b', 'value': 'chapter-b'},
            ],
          },
        );
        expect(
          await invokeSystem(
            tester,
            rootRegistry,
            'system.storage.get',
            <String, dynamic>{'appId': rootId, 'key': 'slot.a'},
          ),
          'chapter-a',
        );
        await expectLater(
          invokeSystem(
            tester,
            rootRegistry,
            'system.storage.batch',
            <String, dynamic>{
              'appId': rootId,
              'operations': <Map<String, Object?>>[
                {'type': 'set', 'key': 'slot.a', 'value': 'must-not-commit'},
                {'type': 'remove', 'key': 'slot.a'},
              ],
            },
          ),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'duplicate_storage_key',
            ),
          ),
        );
        expect(
          await invokeSystem(
            tester,
            rootRegistry,
            'system.storage.get',
            <String, dynamic>{'appId': rootId, 'key': 'slot.a'},
          ),
          'chapter-a',
          reason:
              'invalid native batches must leave the complete old bucket intact',
        );
        final created = Map<String, dynamic>.from(
          await invokeSystem(
                tester,
                rootRegistry,
                'system.runtime.create',
                <String, dynamic>{'appId': childId},
              )
              as Map,
        );
        final childInstanceId = created['instanceId'] as String;
        final rootGuest = tester.widget<PocketGuestSession>(
          find.byType(PocketGuestSession).first,
        );

        var notifications = 0;
        void observeFacts() => notifications++;
        controller.addListener(observeFacts);
        rootGuest.onFirstFrame!();
        expect(notifications, 1, reason: 'new first-frame facts must publish');
        final published = controller.instances;
        rootGuest.onFirstFrame!();
        expect(notifications, 1, reason: 'identical facts must not republish');
        expect(controller.instances, same(published));
        controller.removeListener(observeFacts);

        // Child produces an Offstage first frame while its compositor slot is hidden.
        const offstageSlot = PocketCompositorSlot(
          surfaceHandle: 2,
          bounds: Rect.zero,
          visibleClip: Rect.zero,
          logicalViewport: Size(120, 120),
          visible: false,
          focused: false,
          drawIndex: 0,
        );
        final offstageChild =
            rootGuest.hostSurfaceBuilder!(offstageSlot) as PocketGuestSession;
        final stableOffstageChild =
            rootGuest.hostSurfaceBuilder!(offstageSlot) as PocketGuestSession;
        expect(
          stableOffstageChild.geometryRevision,
          offstageChild.geometryRevision,
          reason: 'unchanged slots must not schedule duplicate geometry work',
        );
        offstageChild.onFirstFrame!();

        final childAfterOffstageFrame = controller.instances.singleWhere(
          (entry) => entry.instanceId == childInstanceId,
        );
        expect(childAfterOffstageFrame.firstFrameReady, isTrue);
        expect(childAfterOffstageFrame.isPresented, isFalse);

        // Child fails while Offstage, then its compositor slot becomes visible.
        final beforeFailure = notifications;
        controller.addListener(observeFacts);
        await childAfterOffstageFrame.session.onError(
          StateError('failed after offstage frame'),
        );
        expect(
          notifications,
          greaterThan(beforeFailure),
          reason: 'live session failures must still notify host observers',
        );
        controller.removeListener(observeFacts);
        final visibleChild =
            rootGuest.hostSurfaceBuilder!(
                  const PocketCompositorSlot(
                    surfaceHandle: 2,
                    bounds: Rect.fromLTWH(0, 0, 120, 120),
                    visibleClip: Rect.fromLTWH(0, 0, 120, 120),
                    logicalViewport: Size(120, 120),
                    visible: true,
                    focused: true,
                    drawIndex: 0,
                  ),
                )
                as PocketGuestSession;
        expect(
          visibleChild.geometryRevision,
          greaterThan(offstageChild.geometryRevision),
          reason: 'a moved/visible slot must invalidate child geometry',
        );
        await tester.pump();

        final awaitRegistration = rootRegistry.registrationFor(
          'system.runtime.awaitFirstFrame',
        )!;
        await expectLater(
          Future<Object?>.sync(
            () => awaitRegistration.request!(<String, dynamic>{
              'instanceId': childInstanceId,
              'generation': childAfterOffstageFrame.generation,
            }),
          ),
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              contains('failed after offstage frame'),
            ),
          ),
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        controller.dispose();
      }
    },
  );

  testWidgets(
    'reloaded generation failure before first frame rejects both firstFrame and awaitFirstFrame',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;

      try {
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox.shrink(
                child: PocketSystemHost(
                  systemUI: PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: const {'ui.compositor-surfaces'},
                    compositorSurfaces: const <String, int>{childId: 2},
                    pluginFactories: <PocketPluginFactory>[
                      (_) => _RegistryCapturePlugin((registry) {
                        rootRegistry = registry;
                      }),
                    ],
                  ),
                  applications: const <String, PocketAppConfig>{
                    childId: PocketAppConfig(
                      appId: childId,
                      bytecodeAsset: 'test/child.qjbc',
                      pakAsset: 'test/child.pak',
                      metadataAsset: 'test/child.metadata.json',
                      manifestAsset: 'test/child.manifest.json',
                    ),
                  },
                  controller: controller,
                ),
              ),
            ),
          ),
        );

        await waitFor(tester, controller, (e) => e.isSystemUI && e.ready);
        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.configure',
          <String, dynamic>{
            'systemUI': rootId,
            'grants': <Map<String, Object?>>[
              {'appId': rootId, 'sharedNamespaces': <String>[]},
              {'appId': childId, 'sharedNamespaces': <String>[]},
            ],
          },
        );
        final created = Map<String, dynamic>.from(
          await invokeSystem(
                tester,
                rootRegistry,
                'system.runtime.create',
                <String, dynamic>{'appId': childId},
              )
              as Map,
        );
        final childInstanceId = created['instanceId'] as String;
        final rootGuest = tester.widget<PocketGuestSession>(
          find.byType(PocketGuestSession).first,
        );

        // Generation 0 produces its first frame so hasEverProducedFrame is true.
        final visibleChild =
            rootGuest.hostSurfaceBuilder!(
                  const PocketCompositorSlot(
                    surfaceHandle: 2,
                    bounds: Rect.fromLTWH(0, 0, 120, 120),
                    visibleClip: Rect.fromLTWH(0, 0, 120, 120),
                    logicalViewport: Size(120, 120),
                    visible: true,
                    focused: true,
                    drawIndex: 0,
                  ),
                )
                as PocketGuestSession;
        visibleChild.onFirstFrame!();
        await tester.pump();

        final gen0Snapshot = controller.instances.singleWhere(
          (entry) => entry.instanceId == childInstanceId,
        );
        expect(gen0Snapshot.generation, 0);
        expect(gen0Snapshot.firstFrameReady, isTrue);
        await gen0Snapshot.firstFrame;

        // Simulate a reload into generation 1 before any frame is produced.
        gen0Snapshot.session.generation = 1;
        await gen0Snapshot.session.setForeground(false);

        final gen1Snapshot = controller.instances.singleWhere(
          (entry) => entry.instanceId == childInstanceId,
        );
        expect(gen1Snapshot.generation, 1);
        expect(gen1Snapshot.firstFrameReady, isFalse);
        expect(gen1Snapshot.firstFrame, isNotNull);

        final awaitRegistration = rootRegistry.registrationFor(
          'system.runtime.awaitFirstFrame',
        )!;
        final awaitFirstVisible = Future<Object?>.value(
          awaitRegistration.request!(<String, dynamic>{
            'instanceId': childInstanceId,
            'generation': 1,
          }),
        );
        final firstFrameRejected = expectLater(
          gen1Snapshot.firstFrame,
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              contains('reloaded generation failed'),
            ),
          ),
        );
        final awaitFirstVisibleRejected = expectLater(
          awaitFirstVisible,
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              contains('reloaded generation failed'),
            ),
          ),
        );

        await gen1Snapshot.session.onError(
          StateError('reloaded generation failed'),
        );
        await firstFrameRejected;
        await awaitFirstVisibleRejected;
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        controller.dispose();
      }
    },
  );

  testWidgets('runtime memory requests cannot exceed trusted host limits', (
    tester,
  ) async {
    final controller = PocketSystemHostController();
    late PocketHostRegistry rootRegistry;
    const childLimits = PocketMemoryLimits(
      heapLimitBytes: 128 * 1024,
      maxPakBytes: 8 * 1024 * 1024,
    );

    try {
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: Center(
            child: SizedBox.shrink(
              child: PocketSystemHost(
                systemUI: PocketAppConfig(
                  appId: rootId,
                  bytecodeAsset: 'test/root.qjbc',
                  pakAsset: 'test/root.pak',
                  metadataAsset: 'test/root.metadata.json',
                  manifestAsset: 'test/root.manifest.json',
                  additionalCapabilities: const {'ui.compositor-surfaces'},
                  compositorSurfaces: const <String, int>{
                    childId: 2,
                    emptyMemoryChildId: 3,
                  },
                  pluginFactories: <PocketPluginFactory>[
                    (_) => _RegistryCapturePlugin((registry) {
                      rootRegistry = registry;
                    }),
                  ],
                ),
                applications: const <String, PocketAppConfig>{
                  childId: PocketAppConfig(
                    appId: childId,
                    bytecodeAsset: 'test/child.qjbc',
                    pakAsset: 'test/child.pak',
                    metadataAsset: 'test/child.metadata.json',
                    manifestAsset: 'test/child.manifest.json',
                    memoryLimits: childLimits,
                  ),
                  emptyMemoryChildId: PocketAppConfig(
                    appId: emptyMemoryChildId,
                    bytecodeAsset: 'test/child.qjbc',
                    pakAsset: 'test/child.pak',
                    metadataAsset: 'test/child.metadata.json',
                    manifestAsset: 'test/child.manifest.json',
                    memoryLimits: childLimits,
                  ),
                },
                controller: controller,
              ),
            ),
          ),
        ),
      );

      await waitFor(
        tester,
        controller,
        (entry) => entry.isSystemUI && entry.ready,
      );
      await invokeSystem(
        tester,
        rootRegistry,
        'system.runtime.configure',
        <String, dynamic>{
          'systemUI': rootId,
          'grants': <Map<String, Object?>>[
            {'appId': rootId, 'sharedNamespaces': <String>[]},
            {'appId': childId, 'sharedNamespaces': <String>[]},
            {'appId': emptyMemoryChildId, 'sharedNamespaces': <String>[]},
          ],
        },
      );

      final createRegistration = rootRegistry.registrationFor(
        'system.runtime.create',
      )!;
      await expectLater(
        Future<Object?>.sync(
          () => createRegistration.request!(<String, dynamic>{
            'appId': childId,
            'memory': <String, dynamic>{
              'heapLimitBytes': childLimits.heapLimitBytes! + 1,
            },
          }),
        ),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'memory_limit_denied',
          ),
        ),
      );
      expect(
        controller.instances.where((entry) => entry.appId == childId),
        isEmpty,
        reason:
            'an over-limit request must be rejected before runtime creation',
      );

      final admitted = Map<String, dynamic>.from(
        await invokeSystem(
              tester,
              rootRegistry,
              'system.runtime.create',
              <String, dynamic>{
                'appId': childId,
                'memory': <String, dynamic>{
                  'heapLimitBytes': 64 * 1024,
                  'maxPakBytes': 1,
                },
              },
            )
            as Map,
      );
      expect(admitted['memory'], <String, int>{
        'heapLimitBytes': 64 * 1024,
        'maxPakBytes': 1,
      });
      final admittedInstance = await waitFor(
        tester,
        controller,
        (entry) => entry.appId == childId && entry.ready,
      );
      expect(
        admittedInstance.session.memoryLimits,
        equals(
          const PocketMemoryLimits(heapLimitBytes: 64 * 1024, maxPakBytes: 1),
        ),
      );

      final defaulted = Map<String, dynamic>.from(
        await invokeSystem(
              tester,
              rootRegistry,
              'system.runtime.create',
              <String, dynamic>{'appId': emptyMemoryChildId},
            )
            as Map,
      );
      expect(defaulted['memory'], <String, int>{
        'heapLimitBytes': childLimits.heapLimitBytes!,
        'maxPakBytes': childLimits.maxPakBytes!,
      });
      final defaultedInstance = await waitFor(
        tester,
        controller,
        (entry) => entry.appId == emptyMemoryChildId && entry.ready,
      );
      expect(defaultedInstance.session.memoryLimits, equals(childLimits));
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      controller.dispose();
    }
  });

  testWidgets(
    'child image provider stays app-scoped and capture opt-in survives hide/resume',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;
      late PocketHostRegistry childRegistry;
      const imageCapabilities = <String>[
        'platform.images.capture',
        'platform.images.read',
        'platform.images.list',
        'platform.images.remove',
      ];
      final childConfig = PocketAppConfig(
        appId: childId,
        bytecodeAsset: 'test/child.qjbc',
        pakAsset: 'test/child.pak',
        metadataAsset: 'test/child.metadata.json',
        manifestAsset: 'test/child.manifest.json',
        bootstrapManifestJson: jsonEncode(<String, Object?>{
          'capabilities': <String, Object?>{'requires': imageCapabilities},
        }),
        pluginFactories: <PocketPluginFactory>[
          (_) => _RegistryCapturePlugin((registry) {
            childRegistry = registry;
          }),
        ],
      );

      try {
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox.shrink(
                child: PocketSystemHost(
                  systemUI: PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: const {'ui.compositor-surfaces'},
                    compositorSurfaces: const <String, int>{childId: 2},
                    pluginFactories: <PocketPluginFactory>[
                      (_) => _RegistryCapturePlugin((registry) {
                        rootRegistry = registry;
                      }),
                    ],
                  ),
                  applications: <String, PocketAppConfig>{childId: childConfig},
                  controller: controller,
                ),
              ),
            ),
          ),
        );

        await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.ready,
        );
        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.configure',
          <String, dynamic>{
            'systemUI': rootId,
            'grants': <Map<String, Object?>>[
              {'appId': rootId, 'sharedNamespaces': <String>[]},
              {'appId': childId, 'sharedNamespaces': <String>[]},
            ],
          },
        );
        final created = Map<String, dynamic>.from(
          await invokeSystem(
                tester,
                rootRegistry,
                'system.runtime.create',
                <String, dynamic>{'appId': childId},
              )
              as Map,
        );
        final childInstance = await waitFor(
          tester,
          controller,
          (entry) => entry.instanceId == created['instanceId'] && entry.ready,
        );
        expect(
          childInstance.session.hasConfiguredCapability(
            'platform.images.capture',
          ),
          isTrue,
        );
        expect(rootRegistry.registrationFor('platform.images.read'), isNull);

        final listRequest = childRegistry.registrationFor(
          'platform.images.list',
        )!;
        final listed = await tester.runAsync(
          () async => await listRequest.request!(<String, dynamic>{}),
        );
        expect(listed, isEmpty);
        final captureRequest = childRegistry.registrationFor(
          'platform.images.capture',
        )!;
        await expectLater(
          captureRequest.request!(<String, dynamic>{}),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'capture_unavailable',
            ),
          ),
          reason: 'a child with no mounted scene must not report a fake image',
        );

        final rootGuest = tester.widget<PocketGuestSession>(
          find.byType(PocketGuestSession).first,
        );
        final visibleSlot = const PocketCompositorSlot(
          surfaceHandle: 2,
          bounds: Rect.fromLTWH(0, 0, 120, 120),
          visibleClip: Rect.fromLTWH(0, 0, 120, 120),
          logicalViewport: Size(120, 120),
          visible: true,
          focused: true,
          drawIndex: 0,
        );
        final visibleChild =
            rootGuest.hostSurfaceBuilder!(visibleSlot) as PocketGuestSession;
        expect(visibleChild.enableSceneCapture, isTrue);
        await tester.pump();
        await childInstance.session.setForeground(true);
        expect(
          childInstance.session.hasConfiguredCapability(
            'platform.images.capture',
          ),
          isTrue,
          reason:
              'foreground capability revocation must not remove capture opt-in',
        );

        final hiddenChild =
            rootGuest.hostSurfaceBuilder!(
                  const PocketCompositorSlot(
                    surfaceHandle: 2,
                    bounds: Rect.zero,
                    visibleClip: Rect.zero,
                    logicalViewport: Size(120, 120),
                    visible: false,
                    focused: false,
                    drawIndex: 0,
                  ),
                )
                as PocketGuestSession;
        expect(hiddenChild.enableSceneCapture, isTrue);
        await tester.pump();
        await childInstance.session.setForeground(false);
        final resumedChild =
            rootGuest.hostSurfaceBuilder!(visibleSlot) as PocketGuestSession;
        expect(resumedChild.enableSceneCapture, isTrue);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        controller.dispose();
      }
    },
  );

  testWidgets(
    'system.container.close invokes onClose for trusted SystemUI and rejects unavailable or untrusted child requests',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;
      late PocketHostRegistry childRegistry;
      var closeCount = 0;

      try {
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox.shrink(
                child: PocketSystemHost(
                  systemUI: PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: const {'ui.compositor-surfaces'},
                    compositorSurfaces: const <String, int>{childId: 2},
                    pluginFactories: <PocketPluginFactory>[
                      (_) => _RegistryCapturePlugin((registry) {
                        rootRegistry = registry;
                      }),
                    ],
                  ),
                  applications: <String, PocketAppConfig>{
                    childId: PocketAppConfig(
                      appId: childId,
                      bytecodeAsset: 'test/child.qjbc',
                      pakAsset: 'test/child.pak',
                      metadataAsset: 'test/child.metadata.json',
                      manifestAsset: 'test/child.manifest.json',
                      pluginFactories: <PocketPluginFactory>[
                        (_) => _RegistryCapturePlugin((registry) {
                          childRegistry = registry;
                        }),
                      ],
                    ),
                  },
                  controller: controller,
                ),
              ),
            ),
          ),
        );

        await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.ready,
        );
        await expectLater(
          invokeSystem(tester, rootRegistry, 'system.container.close'),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'capability_unavailable',
            ),
          ),
          reason:
              'a host without onClose must report capability_unavailable honestly',
        );

        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.configure',
          <String, dynamic>{
            'systemUI': rootId,
            'grants': <Map<String, Object?>>[
              {'appId': rootId, 'sharedNamespaces': <String>[]},
              {'appId': childId, 'sharedNamespaces': <String>[]},
            ],
          },
        );
        final created = Map<String, dynamic>.from(
          await invokeSystem(
                tester,
                rootRegistry,
                'system.runtime.create',
                <String, dynamic>{'appId': childId},
              )
              as Map,
        );
        await waitFor(
          tester,
          controller,
          (entry) => entry.instanceId == created['instanceId'] && entry.ready,
        );
        expect(
          childRegistry.registrationFor('system.container.close'),
          isNull,
          reason:
              'untrusted child runtimes must not receive system.container.close',
        );

        // Unmount the first host before attaching this controller again.
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox.shrink(
                child: PocketSystemHost(
                  key: const ValueKey<String>('with-close'),
                  systemUI: PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: const {'ui.compositor-surfaces'},
                    compositorSurfaces: const <String, int>{childId: 2},
                    pluginFactories: <PocketPluginFactory>[
                      (_) => _RegistryCapturePlugin((registry) {
                        rootRegistry = registry;
                      }),
                    ],
                  ),
                  applications: <String, PocketAppConfig>{
                    childId: const PocketAppConfig(
                      appId: childId,
                      bytecodeAsset: 'test/child.qjbc',
                      pakAsset: 'test/child.pak',
                      metadataAsset: 'test/child.metadata.json',
                      manifestAsset: 'test/child.manifest.json',
                    ),
                  },
                  controller: controller,
                  onClose: () {
                    closeCount += 1;
                  },
                ),
              ),
            ),
          ),
        );

        await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.ready,
        );
        final closed = await invokeSystem(
          tester,
          rootRegistry,
          'system.container.close',
        );
        expect(closed, equals(<String, Object?>{'closed': true}));
        expect(closeCount, 1);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        controller.dispose();
      }
    },
  );

  testWidgets(
    'system.runtime.create and prepareOpen forward initialEvents into child PocketView before its first frame',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;
      final previousFactory = debugPocketSelfOwnedRuntimeFactory;
      final createdRuntimes = <_ProbeChildRuntime>[];
      debugPocketSelfOwnedRuntimeFactory = (_) {
        final runtime = _ProbeChildRuntime();
        createdRuntimes.add(runtime);
        return runtime;
      };

      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        if (data == null) return null;
        final requested = utf8.decode(data.buffer.asUint8List());
        if (requested.endsWith('.qjbc')) {
          return ByteData(1);
        }
        if (requested.endsWith('.pak')) {
          return ByteData(0);
        }
        final Object content;
        if (requested.endsWith('metadata.json')) {
          content = <String, Object?>{
            'entryFormat': 'quickjs-bytecode',
            'formatVersion': 1,
            'kind': 'script',
            'bindingGeneration': 1,
            'tickHz': 60,
            'runtimeAbi': 'system-host-unit-abi',
            'bytecodeBytes': 1,
            'build': 1,
            'version': '1.0.0',
          };
        } else if (requested.contains('root.manifest.json')) {
          content = <String, Object?>{
            'capabilities': <String, Object?>{
              'requires': <String>[
                'ui.compositor-surfaces',
                'system.runtime.configure',
                'system.runtime.create',
                'system.runtime.prepareOpen',
                'system.runtime.awaitFirstFrame',
                'system.runtime.destroy',
                'system.runtime.post',
                'system.runtime.respond',
              ],
            },
          };
        } else {
          content = <String, Object?>{
            'capabilities': <String, Object?>{'requires': <String>[]},
          };
        }
        return ByteData.sublistView(
          Uint8List.fromList(utf8.encode(jsonEncode(content))),
        );
      });

      try {
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox(
                width: 240,
                height: 320,
                child: PocketSystemHost(
                  systemUI: PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: const {'ui.compositor-surfaces'},
                    compositorSurfaces: const <String, int>{childId: 2},
                    pluginFactories: <PocketPluginFactory>[
                      (_) => _RegistryCapturePlugin((registry) {
                        rootRegistry = registry;
                      }),
                    ],
                  ),
                  applications: const <String, PocketAppConfig>{
                    childId: PocketAppConfig(
                      appId: childId,
                      bytecodeAsset: 'test/child.qjbc',
                      pakAsset: 'test/child.pak',
                      metadataAsset: 'test/child.metadata.json',
                      manifestAsset: 'test/child.manifest.json',
                    ),
                  },
                  controller: controller,
                ),
              ),
            ),
          ),
        );

        await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.firstFrameReady,
        );
        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.configure',
          <String, dynamic>{
            'systemUI': rootId,
            'grants': <Map<String, Object?>>[
              {'appId': rootId, 'sharedNamespaces': <String>[]},
              {'appId': childId, 'sharedNamespaces': <String>[]},
            ],
          },
        );

        await expectLater(
          invokeSystem(
            tester,
            rootRegistry,
            'system.runtime.create',
            <String, dynamic>{
              'appId': childId,
              'initialEvents': <Object?>[
                <String, Object?>{'method': '', 'params': <String, Object?>{}},
              ],
            },
          ),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'invalid_event',
            ),
          ),
        );

        final created = Map<String, dynamic>.from(
          await invokeSystem(
                tester,
                rootRegistry,
                'system.runtime.create',
                <String, dynamic>{
                  'appId': childId,
                  'prepareForOpen': true,
                  'cacheFirst': true,
                  'initialEvents': <Map<String, Object?>>[
                    <String, Object?>{
                      'method': 'platform.presets',
                      'params': <String, Object?>{
                        'darkMode': true,
                        'colorScheme': 'dark',
                        'accentColor': 'violet',
                        'density': 'desktop',
                        'presentationStyle': 'page',
                      },
                    },
                  ],
                },
              )
              as Map,
        );
        final childInstance = await waitFor(
          tester,
          controller,
          (entry) =>
              entry.instanceId == created['instanceId'] &&
              entry.firstFrameReady,
        );
        expect(createdRuntimes.length, greaterThanOrEqualTo(2));
        final childRuntime = createdRuntimes.last;
        expect(
          childRuntime.presetsBeforeFirstFrame,
          equals(<String, dynamic>{
            'darkMode': true,
            'colorScheme': 'dark',
            'accentColor': 'violet',
            'density': 'desktop',
            'presentationStyle': 'page',
          }),
          reason:
              'child PocketView must evaluate initialEvents at delta=0 before firstFrameReady is admitted',
        );
        expect(childRuntime.frameDeltas.first, 0);

        final childPocketView = tester
            .widgetList<PocketView>(
              find.byType(PocketView, skipOffstage: false),
            )
            .singleWhere((view) => view.bytecodeAsset == 'test/child.qjbc');
        expect(
          childPocketView.initialEvents,
          equals(<Map<String, dynamic>>[
            <String, dynamic>{
              'method': 'platform.presets',
              'params': <String, dynamic>{
                'darkMode': true,
                'colorScheme': 'dark',
                'accentColor': 'violet',
                'density': 'desktop',
                'presentationStyle': 'page',
              },
            },
          ]),
        );

        // Verify prepareOpen also updates session.initialEvents for subsequent remounts.
        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.prepareOpen',
          <String, dynamic>{
            'instanceId': childInstance.instanceId,
            'generation': childInstance.generation,
            'cacheFirst': true,
            'initialEvents': <Map<String, Object?>>[
              <String, Object?>{
                'method': 'platform.presets',
                'params': <String, Object?>{
                  'darkMode': false,
                  'colorScheme': 'light',
                  'accentColor': 'teal',
                  'density': 'touch',
                  'presentationStyle': 'sheet',
                },
              },
            ],
          },
        );
        expect(
          childInstance.session.initialEvents,
          equals(<Map<String, dynamic>>[
            <String, dynamic>{
              'method': 'platform.presets',
              'params': <String, dynamic>{
                'darkMode': false,
                'colorScheme': 'light',
                'accentColor': 'teal',
                'density': 'touch',
                'presentationStyle': 'sheet',
              },
            },
          ]),
        );
      } finally {
        debugPocketSelfOwnedRuntimeFactory = previousFactory;
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        controller.dispose();
      }
    },
  );

  testWidgets(
    'IndexedStack + TickerMode and active:false suspend foreground and release host back interception when offstage',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;
      final previousFactory = debugPocketSelfOwnedRuntimeFactory;
      final runtimes = <_ProbeChildRuntime>[];
      debugPocketSelfOwnedRuntimeFactory = (_) {
        final runtime = _ProbeChildRuntime();
        runtimes.add(runtime);
        return runtime;
      };
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        if (data == null) return null;
        final requested = utf8.decode(data.buffer.asUint8List());
        if (requested.endsWith('.qjbc')) return ByteData(1);
        if (requested.endsWith('.pak')) return ByteData(0);
        final Object content;
        if (requested.endsWith('metadata.json')) {
          content = <String, Object?>{
            'entryFormat': 'quickjs-bytecode',
            'formatVersion': 1,
            'kind': 'script',
            'bindingGeneration': 1,
            'tickHz': 60,
            'runtimeAbi': 'system-host-unit-abi',
            'bytecodeBytes': 1,
            'version': '1.0.0',
            'build': 1,
          };
        } else if (requested.contains('root.manifest.json')) {
          content = <String, Object?>{
            'capabilities': <String, Object?>{
              'requires': <String>[
                'ui.compositor-surfaces',
                'system.runtime.configure',
                'system.runtime.create',
                'system.runtime.awaitFirstFrame',
                'system.runtime.destroy',
                'system.runtime.post',
                'system.runtime.respond',
              ],
            },
          };
        } else {
          content = <String, Object?>{
            'capabilities': <String, Object?>{'requires': <String>[]},
          };
        }
        return ByteData.sublistView(
          Uint8List.fromList(utf8.encode(jsonEncode(content))),
        );
      });

      final tabIndex = ValueNotifier<int>(1);
      final hostActive = ValueNotifier<bool>(true);
      var hostCloses = 0;
      late BuildContext rootContext;
      final systemUIConfig = PocketAppConfig(
        appId: rootId,
        bytecodeAsset: 'test/root.qjbc',
        pakAsset: 'test/root.pak',
        metadataAsset: 'test/root.metadata.json',
        manifestAsset: 'test/root.manifest.json',
        additionalCapabilities: const {'ui.compositor-surfaces'},
        compositorSurfaces: const <String, int>{childId: 2},
        pluginFactories: <PocketPluginFactory>[
          (_) => _RegistryCapturePlugin((registry) {
            rootRegistry = registry;
          }),
        ],
      );
      const applicationsConfig = <String, PocketAppConfig>{
        childId: PocketAppConfig(
          appId: childId,
          bytecodeAsset: 'test/child.qjbc',
          pakAsset: 'test/child.pak',
          metadataAsset: 'test/child.metadata.json',
          manifestAsset: 'test/child.manifest.json',
        ),
      };

      try {
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) {
                rootContext = context;
                return Scaffold(
                  body: ValueListenableBuilder<int>(
                    valueListenable: tabIndex,
                    builder: (context, index, _) =>
                        ValueListenableBuilder<bool>(
                          valueListenable: hostActive,
                          builder: (context, active, _) => IndexedStack(
                            index: index,
                            children: <Widget>[
                              TickerMode(
                                enabled: index == 0,
                                child: const SizedBox.expand(
                                  child: Text('tab-0'),
                                ),
                              ),
                              TickerMode(
                                enabled: index == 1,
                                child: SizedBox(
                                  width: 240,
                                  height: 320,
                                  child: PocketSystemHost(
                                    active: active,
                                    systemUI: systemUIConfig,
                                    applications: applicationsConfig,
                                    controller: controller,
                                    onClose: () => hostCloses++,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                  ),
                );
              },
            ),
          ),
        );

        await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.ready && entry.firstFrameReady,
        );
        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.configure',
          <String, dynamic>{
            'systemUI': rootId,
            'grants': <Map<String, Object?>>[
              {'appId': rootId, 'sharedNamespaces': <String>[]},
              {'appId': childId, 'sharedNamespaces': <String>[]},
            ],
          },
        );
        final created = Map<String, dynamic>.from(
          await invokeSystem(
                tester,
                rootRegistry,
                'system.runtime.create',
                <String, dynamic>{'appId': childId},
              )
              as Map,
        );
        final rootRuntime = runtimes.first;
        rootRuntime.frameOverride = const PocketFrame(
          width: 240,
          height: 320,
          ops: <PocketOp>[
            PocketHostSurfaceOp(
              x: 0,
              y: 0,
              width: 240,
              height: 320,
              id: 'focused-child',
              kind: 'application',
              parameters: <String, dynamic>{},
              surfaceHandle: 2,
              focused: true,
            ),
          ],
          events: <PocketEvent>[],
          resources: <PocketImageResource>[],
        );
        await tester.pump(const Duration(milliseconds: 32));
        await waitFor(
          tester,
          controller,
          (entry) =>
              entry.instanceId == created['instanceId'] &&
              entry.firstFrameReady &&
              entry.foreground &&
              entry.compositorFocused,
        );
        expect(
          controller.instances.every((entry) => entry.foreground),
          isTrue,
        );

        // Switch Tab 1 offstage via IndexedStack + TickerMode(enabled: false).
        tabIndex.value = 0;
        await tester.pump();
        expect(
          controller.instances.every((entry) => !entry.foreground),
          isTrue,
          reason:
              'switching Tab 1 offstage must suspend foreground on system-ui and child sessions',
        );

        // Push a route from Tab 0 and verify Navigator.maybePop() is not blocked by offstage Tab 1.
        final routeFuture = Navigator.of(rootContext).push<String>(
          MaterialPageRoute<String>(
            builder: (_) => const Scaffold(body: Text('pushed-from-tab-0')),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('pushed-from-tab-0'), findsOneWidget);

        final backMessagesBeforePop = runtimes
            .expand((r) => r.sentMessages)
            .where((m) => m['name'] == 'platform.back.request')
            .length;
        final popped = await Navigator.of(rootContext).maybePop('done');
        await tester.pumpAndSettle();
        expect(popped, isTrue);
        expect(await routeFuture, 'done');
        expect(find.text('pushed-from-tab-0'), findsNothing);
        final backMessagesAfterPop = runtimes
            .expand((r) => r.sentMessages)
            .where((m) => m['name'] == 'platform.back.request')
            .length;
        expect(
          backMessagesAfterPop,
          backMessagesBeforePop,
          reason: 'offstage host must not intercept route pop from Tab 0',
        );

        // Return to Tab 1 and verify foreground + guest back handling are restored.
        tabIndex.value = 1;
        await tester.pump();
        expect(
          controller.instances.every((entry) => entry.foreground),
          isTrue,
          reason: 'returning to Tab 1 must restore foreground == true',
        );

        final childSnapshot = controller.instances.singleWhere(
          (entry) => !entry.isSystemUI,
        );
        final childRuntime = runtimes.last;
        await tester.binding.handlePopRoute();
        await tester.pump();
        final childBackRequests = childRuntime.sentMessages
            .where((m) => m['name'] == 'platform.back.request')
            .toList();
        expect(childBackRequests, hasLength(1));
        childSnapshot.session.onEvent(
          PocketEvent(
            id: 'back-reply',
            method: 'platform.back.response',
            params: <String, Object?>{
              'requestId':
                  (childBackRequests.single['payload'] as Map)['requestId'],
              'handled': true,
            },
          ),
        );
        await tester.pump();

        List<Map<String, dynamic>> backRequests(_ProbeChildRuntime runtime) =>
            runtime.sentMessages
                .where((message) => message['name'] == 'platform.back.request')
                .toList();
        expect(backRequests(rootRuntime), isEmpty);

        await tester.binding.handlePopRoute();
        await tester.pump();
        expect(backRequests(childRuntime), hasLength(2));
        expect(backRequests(rootRuntime), isEmpty);
        final declinedId =
            (backRequests(childRuntime).last['payload'] as Map)['requestId'];
        final beforeSystemRequestMs = DateTime.now().millisecondsSinceEpoch;
        childSnapshot.session.onEvent(
          PocketEvent(
            id: 'child-back-declined',
            method: 'platform.back.response',
            params: {'requestId': declinedId, 'handled': false},
          ),
        );
        await tester.pump();
        expect(backRequests(rootRuntime), hasLength(1));
        expect(hostCloses, 0);
        final systemPayload =
            backRequests(rootRuntime).single['payload'] as Map;
        final systemId = systemPayload['requestId'];
        expect(systemId, isNot(declinedId));
        expect(
          systemPayload['deadlineAtMs'],
          greaterThanOrEqualTo(beforeSystemRequestMs + 600),
        );
        final rootSnapshot = controller.instances.singleWhere(
          (entry) => entry.isSystemUI,
        );
        rootSnapshot.session.onEvent(
          PocketEvent(
            id: 'system-back-handled',
            method: 'platform.back.response',
            params: {'requestId': systemId, 'handled': true},
          ),
        );
        await tester.pump(const Duration(milliseconds: 650));
        expect(hostCloses, 0);
        expect(backRequests(rootRuntime), hasLength(1));
        expect(backRequests(childRuntime), hasLength(2));

        // Also verify explicit active: false while TickerMode is enabled.
        hostActive.value = false;
        await tester.pump();
        expect(
          controller.instances.every((entry) => !entry.foreground),
          isTrue,
        );
        hostActive.value = true;
        await tester.pump();
        expect(
          controller.instances.every((entry) => entry.foreground),
          isTrue,
        );
      } finally {
        tabIndex.dispose();
        hostActive.dispose();
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        debugPocketSelfOwnedRuntimeFactory = previousFactory;
        controller.dispose();
      }
    },
  );

  testWidgets('PocketGuest honors TickerMode(enabled: false) and active: false', (
    tester,
  ) async {
    final previousFactory = debugPocketSelfOwnedRuntimeFactory;
    debugPocketSelfOwnedRuntimeFactory = (_) => _ProbeChildRuntime();
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final requested = utf8.decode(data.buffer.asUint8List());
      if (requested.endsWith('.qjbc')) return ByteData(1);
      if (requested.endsWith('.pak')) return ByteData(0);
      final Object content = requested.endsWith('metadata.json')
          ? <String, Object?>{
              'entryFormat': 'quickjs-bytecode',
              'formatVersion': 1,
              'kind': 'script',
              'bindingGeneration': 1,
              'tickHz': 60,
              'runtimeAbi': 'system-host-unit-abi',
              'bytecodeBytes': 1,
              'version': '1.0.0',
              'build': 1,
            }
          : <String, Object?>{
              'capabilities': <String, Object?>{'requires': <String>[]},
            };
      return ByteData.sublistView(
        Uint8List.fromList(utf8.encode(jsonEncode(content))),
      );
    });

    final tickerEnabled = ValueNotifier<bool>(true);
    final guestActive = ValueNotifier<bool>(true);

    try {
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: ValueListenableBuilder<bool>(
            valueListenable: tickerEnabled,
            builder: (context, enabled, _) => TickerMode(
              enabled: enabled,
              child: ValueListenableBuilder<bool>(
                valueListenable: guestActive,
                builder: (context, active, _) => SizedBox(
                  width: 240,
                  height: 320,
                  child: PocketGuest(
                    active: active,
                    config: const PocketAppConfig(
                      appId: childId,
                      bytecodeAsset: 'test/child.qjbc',
                      pakAsset: 'test/child.pak',
                      metadataAsset: 'test/child.metadata.json',
                      manifestAsset: 'test/child.manifest.json',
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      for (var i = 0; i < 30; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 1)),
        );
        await tester.pump(const Duration(milliseconds: 16));
        final state = tester.state<PocketGuestSessionState>(
          find.byType(PocketGuestSession),
        );
        if (state.session.ready) break;
      }
      final guestState = tester.state<PocketGuestSessionState>(
        find.byType(PocketGuestSession),
      );
      expect(guestState.session.ready, isTrue);
      expect(guestState.session.foreground, isTrue);

      tickerEnabled.value = false;
      await tester.pump();
      expect(guestState.session.foreground, isFalse);

      tickerEnabled.value = true;
      await tester.pump();
      expect(guestState.session.foreground, isTrue);

      guestActive.value = false;
      await tester.pump();
      expect(guestState.session.foreground, isFalse);

      guestActive.value = true;
      await tester.pump();
      expect(guestState.session.foreground, isTrue);
    } finally {
      tickerEnabled.dispose();
      guestActive.dispose();
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      debugPocketSelfOwnedRuntimeFactory = previousFactory;
    }
  });

  testWidgets(
    'PocketSystemHost initialLaunch injects system.host.launch at t=0, clears after configure, supports requestLaunchApp, and delivers PocketSystemLaunchResult',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;
      final previousFactory = debugPocketSelfOwnedRuntimeFactory;
      late _ProbeChildRuntime rootRuntime;
      Map<String, dynamic>? launchBeforeFirstFrame;
      debugPocketSelfOwnedRuntimeFactory = (_) {
        rootRuntime = _ProbeChildRuntime();
        rootRuntime.onMessage = (message) {
          if (rootRuntime.frameCalls == 0 &&
              message['name'] == 'system.host.launch' &&
              message['payload'] is Map<String, dynamic>) {
            launchBeforeFirstFrame = Map<String, dynamic>.from(
              message['payload'] as Map<String, dynamic>,
            );
          }
        };
        return rootRuntime;
      };
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        if (data == null) return null;
        final requested = utf8.decode(data.buffer.asUint8List());
        if (requested.endsWith('.qjbc')) return ByteData(1);
        if (requested.endsWith('.pak')) return ByteData(0);
        final Object content;
        if (requested.endsWith('metadata.json')) {
          content = <String, Object?>{
            'entryFormat': 'quickjs-bytecode',
            'formatVersion': 1,
            'kind': 'script',
            'bindingGeneration': 1,
            'tickHz': 60,
            'runtimeAbi': 'system-host-unit-abi',
            'bytecodeBytes': 1,
            'version': '1.0.0',
            'build': 1,
          };
        } else if (requested.contains('root.manifest.json')) {
          content = <String, Object?>{
            'capabilities': <String, Object?>{
              'requires': <String>[
                'ui.compositor-surfaces',
                'system.container.close',
                'system.runtime.configure',
                'system.runtime.create',
                'system.runtime.awaitFirstFrame',
                'system.runtime.destroy',
                'system.runtime.post',
                'system.runtime.respond',
              ],
            },
          };
        } else {
          content = <String, Object?>{
            'capabilities': <String, Object?>{'requires': <String>[]},
          };
        }
        return ByteData.sublistView(
          Uint8List.fromList(utf8.encode(jsonEncode(content))),
        );
      });

      final results = <PocketSystemLaunchResult?>[];
      var closeCount = 0;

      try {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 240,
                height: 320,
                child: PocketSystemHost(
                  initialLaunch: const PocketSystemLaunchRequest(
                    appId: childId,
                    arguments: <String, Object?>{'orderId': 'ord-42'},
                    presentationStyle: 'sheet',
                    closeContainerWhenEmpty: true,
                  ),
                  onClose: () => closeCount += 1,
                  onCloseWithResult: results.add,
                  systemUI: PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: const {'ui.compositor-surfaces'},
                    compositorSurfaces: const <String, int>{childId: 2},
                    pluginFactories: <PocketPluginFactory>[
                      (_) => _RegistryCapturePlugin((registry) {
                        rootRegistry = registry;
                      }),
                    ],
                  ),
                  applications: const <String, PocketAppConfig>{
                    childId: PocketAppConfig(
                      appId: childId,
                      bytecodeAsset: 'test/child.qjbc',
                      pakAsset: 'test/child.pak',
                      metadataAsset: 'test/child.metadata.json',
                      manifestAsset: 'test/child.manifest.json',
                    ),
                  },
                  controller: controller,
                ),
              ),
            ),
          ),
        );

        final root = await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.ready && entry.firstFrameReady,
        );
        expect(
          launchBeforeFirstFrame,
          equals(<String, dynamic>{
            'appId': childId,
            'arguments': <String, dynamic>{'orderId': 'ord-42'},
            'presentationStyle': 'sheet',
            'closeContainerWhenEmpty': true,
          }),
          reason:
              'initialLaunch must be delivered into SystemUI at t=0 before its first frame',
        );
        expect(root.session.initialEvents, isNotEmpty);

        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.configure',
          <String, dynamic>{
            'systemUI': rootId,
            'grants': <Map<String, Object?>>[
              {'appId': rootId, 'sharedNamespaces': <String>[]},
              {'appId': childId, 'sharedNamespaces': <String>[]},
            ],
          },
        );
        expect(
          root.session.initialEvents,
          isEmpty,
          reason:
              'initialEvents must be cleared after generation 0 configure so remounts do not replay initialLaunch',
        );

        // Verify controller.requestLaunchApp sends system.host.launch.
        final accepted = controller.requestLaunchApp(
          const PocketSystemLaunchRequest(
            appId: childId,
            arguments: <String, Object?>{'step': 2},
            presentationStyle: 'page',
            closeContainerWhenEmpty: false,
          ),
        );
        expect(accepted, isTrue);
        final hostLaunches = rootRuntime.sentMessages
            .where((m) => m['name'] == 'system.host.launch')
            .toList();
        expect(hostLaunches, hasLength(2));
        expect(
          hostLaunches.last['payload'],
          equals(<String, dynamic>{
            'appId': childId,
            'arguments': <String, dynamic>{'step': 2},
            'presentationStyle': 'page',
            'closeContainerWhenEmpty': false,
          }),
        );

        // Verify system.container.close delivers PocketSystemLaunchResult to onCloseWithResult once.
        final closeResponse = await invokeSystem(
          tester,
          rootRegistry,
          'system.container.close',
          <String, dynamic>{
            'result': <String, Object?>{
              'appId': childId,
              'cancelled': false,
              'value': <String, Object?>{'paid': true},
              'reason': 'completed',
            },
          },
        );
        expect(closeResponse, equals(<String, Object?>{'closed': true}));
        expect(closeCount, 1);
        expect(results, hasLength(1));
        expect(results.single?.appId, childId);
        expect(results.single?.cancelled, isFalse);
        expect(results.single?.value, equals(<String, Object?>{'paid': true}));
        expect(results.single?.reason, 'completed');

        // Remount and verify unhandled Back delivers cancelled PocketSystemLaunchResult.
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        results.clear();
        closeCount = 0;

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 240,
                height: 320,
                child: PocketSystemHost(
                  key: const ValueKey<String>('unhandled-back-host'),
                  initialLaunch: const PocketSystemLaunchRequest(
                    appId: childId,
                  ),
                  onCloseWithResult: results.add,
                  onClose: () => closeCount += 1,
                  systemUI: const PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: {'ui.compositor-surfaces'},
                    compositorSurfaces: <String, int>{childId: 2},
                  ),
                  applications: const <String, PocketAppConfig>{
                    childId: PocketAppConfig(
                      appId: childId,
                      bytecodeAsset: 'test/child.qjbc',
                      pakAsset: 'test/child.pak',
                      metadataAsset: 'test/child.metadata.json',
                      manifestAsset: 'test/child.manifest.json',
                    ),
                  },
                  controller: controller,
                ),
              ),
            ),
          ),
        );

        final remountedRoot = await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.ready && entry.firstFrameReady,
        );
        await tester.binding.handlePopRoute();
        await tester.pump();
        final backRequests = rootRuntime.sentMessages
            .where((m) => m['name'] == 'platform.back.request')
            .toList();
        expect(backRequests, hasLength(1));
        remountedRoot.session.onEvent(
          PocketEvent(
            id: 'unhandled-back-response',
            method: 'platform.back.response',
            params: <String, Object?>{
              'requestId':
                  (backRequests.single['payload'] as Map)['requestId'],
              'handled': false,
            },
          ),
        );
        await tester.pump();
        expect(closeCount, 1);
        expect(results, hasLength(1));
        expect(results.single?.appId, childId);
        expect(results.single?.cancelled, isTrue);
        expect(results.single?.reason, 'back');
      } finally {
        debugPocketSelfOwnedRuntimeFactory = previousFactory;
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        controller.dispose();
      }
    },
  );
}
