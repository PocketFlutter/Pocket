import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets('linked host keeps FFI roots and real pointer-driven pixels', (
    tester,
  ) async {
    final library = DynamicLibrary.process();
    for (final symbol in [
      'pocket_create',
      'pocket_send_binary',
      'pocket_frame_delta_binary',
      'pocket_worker_create',
      'pocket_worker_quickjs_create',
      'pocket_worker_ui_attach',
      'pocket_worker_runner_create',
    ]) {
      expect(library.providesSymbol(symbol), isTrue, reason: symbol);
    }
    final key = GlobalKey();
    await tester.pumpWidget(RepaintBoundary(key: key, child: pocketHostApp()));
    await guest.waitFor(tester, '00');
    Future<Uint8List> capture() async {
      await tester.pump();
      final boundary =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1);
      try {
        return (await image.toByteData(
          format: ui.ImageByteFormat.png,
        ))!.buffer.asUint8List();
      } finally {
        image.dispose();
      }
    }

    final before = await capture();
    await guest.tapGuest(tester, '+1');
    await guest.waitFor(tester, '01');
    final after = await capture();
    expect(after, isNot(orderedEquals(before)));
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  }, skip: !Platform.isMacOS);
}
