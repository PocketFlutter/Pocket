import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  final uri = Uri.parse('https://updates.example.test/app.pak');

  test('successful headers and body cancel every timeout timer', () async {
    final timers = _TimerTracker();
    final dio = Dio()
      ..httpClientAdapter = _MockAdapter((options) async {
        expect(options.uri, uri);
        return ResponseBody.fromBytes(<int>[1, 2, 3, 4], 200);
      });
    final transport = DioPocketUpdateTransport(
      dio: dio,
      requestTimeout: const Duration(seconds: 20),
      bodyTimeout: const Duration(seconds: 20),
    );
    final cancellation = PocketCancellationToken();
    final response = await runZoned(
      () => transport.open(uri, cancellation: cancellation),
      zoneSpecification: timers.specification,
    );
    final bytes = await runZoned(
      () => response.bytes.fold<List<int>>(
        <int>[],
        (all, chunk) => all..addAll(chunk),
      ),
      zoneSpecification: timers.specification,
    );

    expect(bytes, <int>[1, 2, 3, 4]);
    expect(timers.pendingCount, 0);
    transport.close();
  });

  test('cancelling an in-flight request cancels its timeout timer', () async {
    final timers = _TimerTracker();
    final request = Completer<ResponseBody>();
    final dio = Dio()..httpClientAdapter = _MockAdapter((_) => request.future);
    final transport = DioPocketUpdateTransport(
      dio: dio,
      requestTimeout: const Duration(seconds: 20),
    );
    final cancellation = PocketCancellationToken();
    final open = runZoned(
      () => transport.open(uri, cancellation: cancellation),
      zoneSpecification: timers.specification,
    );
    cancellation.cancel();

    await expectLater(open, throwsA(isA<PocketUpdateCancellation>()));
    expect(timers.pendingCount, 0);
    transport.close();

    request.complete(ResponseBody(Stream<Uint8List>.empty(), 200));
  });

  test(
    'request timeout keeps the transport error contract and no timer',
    () async {
      final timers = _TimerTracker();
      final request = Completer<ResponseBody>();
      final dio = Dio()
        ..httpClientAdapter = _MockAdapter((_) => request.future);
      final transport = DioPocketUpdateTransport(
        dio: dio,
        requestTimeout: const Duration(milliseconds: 10),
      );
      final open = runZoned(
        () => transport.open(uri, cancellation: PocketCancellationToken()),
        zoneSpecification: timers.specification,
      );

      await expectLater(
        open,
        throwsA(
          isA<PocketPackageException>()
              .having((error) => error.code, 'code', 'http-timeout')
              .having(
                (error) => error.message,
                'message',
                'HTTP request timeout',
              ),
        ),
      );
      expect(timers.pendingCount, 0);
      transport.close();

      request.complete(ResponseBody(Stream<Uint8List>.empty(), 200));
    },
  );
}

final class _MockAdapter implements HttpClientAdapter {
  _MockAdapter(this._handler);

  final Future<ResponseBody> Function(RequestOptions options) _handler;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) => _handler(options);

  @override
  void close({bool force = false}) {}
}

final class _TimerTracker {
  final List<Timer> _timers = <Timer>[];

  ZoneSpecification get specification => ZoneSpecification(
    createTimer: (self, parent, zone, duration, callback) {
      final timer = parent.createTimer(zone, duration, callback);
      if (duration > Duration.zero) _timers.add(timer);
      return timer;
    },
    createPeriodicTimer: (self, parent, zone, duration, callback) {
      final timer = parent.createPeriodicTimer(zone, duration, callback);
      if (duration > Duration.zero) _timers.add(timer);
      return timer;
    },
  );

  int get pendingCount => _timers.where((timer) => timer.isActive).length;
}
