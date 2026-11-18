import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final fixture = Platform.environment['POCKET_DISTRIBUTION_FIXTURE_DIR'];
  final skip =
      fixture == null || Platform.environment['POCKET_NATIVE_LIBRARY'] == null;

  test('real bundled QJBC input changes rendered text without recording', () {
    final runtime = FfiPocketRuntime.open(width: 360, height: 640);
    addTearDown(runtime.dispose);
    expect(runtime.syncHostFonts(), isTrue);
    final assets = '$fixture/assets';
    final metadata =
        jsonDecode(File('$assets/app.bytecode.json').readAsStringSync()) as Map;
    final first = runtime.loadBytecode(
      File('$assets/app.qjbc').readAsBytesSync(),
      File('$assets/app.pak').readAsBytesSync(),
      expectedRuntimeAbi: metadata['runtimeAbi'] as String,
    );
    String text(PocketFrame frame) =>
        frame.ops.whereType<PocketTextOp>().map((op) => op.text).join();
    expect(text(first), contains('Taps:0'));
    for (final phase in ['down', 'up']) {
      runtime.send({
        'method': 'input.pointer',
        'params': {'phase': phase, 'x': 20, 'y': 20, 'pointer': 1},
      });
      runtime.frame(17);
    }
    expect(text(runtime.frame(17)), contains('Taps:1'));
    expect(runtime.lastError, anyOf(isNull, isEmpty));
  }, skip: skip);

  testWidgets(
    'system host omits its automatic recording factory in the shipping profile',
    (tester) async {
      final support = Directory.systemTemp.createTempSync(
        'pocket-distribution-',
      );
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (_) async => support.path,
      );
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        final key = utf8.decode(data!.buffer.asUint8List());
        final bytes = File('$fixture/$key').readAsBytesSync();
        return ByteData.sublistView(bytes);
      });
      final controller = PocketSystemHostController();
      try {
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: PocketSystemHost(
              systemUI: const PocketAppConfig(
                appId: 'test.distribution',
                additionalCapabilities: {'ui.compositor-surfaces'},
              ),
              applications: const {},
              controller: controller,
            ),
          ),
        );
        for (var attempt = 0; attempt < 120; attempt++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          await tester.pump(const Duration(milliseconds: 17));
          if (controller.instances.isNotEmpty &&
              controller.instances.single.firstFrameReady)
            break;
        }
        final instance = controller.instances.single;
        expect(
          instance.firstFrameReady,
          isTrue,
          reason: '${instance.session.failure}',
        );
        expect(
          instance.session.config.recordingFactory != null,
          pocketSessionRecordingEnabled,
        );
        if (!pocketSessionRecordingEnabled) {
          expect(
            (instance.session.runtimeInfo()['features'] as Map)['recording'],
            isFalse,
          );
        }
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 30)),
        );
        binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          null,
        );
        binding.defaultBinaryMessenger.setMockMessageHandler(
          'flutter/assets',
          null,
        );
        controller.dispose();
        support.deleteSync(recursive: true);
      }
    },
    skip: skip,
  );
}
