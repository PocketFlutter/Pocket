// ignore_for_file: invalid_use_of_internal_member

import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:dio/dio.dart';

typedef _WorkerHttpCallbackNative =
    Void Function(
      Uint64 requestId,
      Pointer<Uint8> requestJsonPtr,
      Size requestJsonLen,
    );

typedef _RegisterBridgeNative =
    Void Function(Pointer<NativeFunction<_WorkerHttpCallbackNative>> callback);
typedef _RegisterBridgeDart =
    void Function(Pointer<NativeFunction<_WorkerHttpCallbackNative>> callback);

typedef _CompleteRequestNative =
    Void Function(
      Uint64 requestId,
      Int32 status,
      Pointer<Uint8> finalUrlPtr,
      Size finalUrlLen,
      Pointer<Uint8> headersJsonPtr,
      Size headersJsonLen,
      Pointer<Uint8> bodyPtr,
      Size bodyLen,
      Pointer<Uint8> errorPtr,
      Size errorLen,
    );
typedef _CompleteRequestDart =
    void Function(
      int requestId,
      int status,
      Pointer<Uint8> finalUrlPtr,
      int finalUrlLen,
      Pointer<Uint8> headersJsonPtr,
      int headersJsonLen,
      Pointer<Uint8> bodyPtr,
      int bodyLen,
      Pointer<Uint8> errorPtr,
      int errorLen,
    );

/// Bridges native Pocket Worker `net.http` requests directly to Flutter's `dio`
/// HTTP/TLS stack across iOS, Android, macOS, Windows, and Linux so the native
/// Rust library never needs to ship `ureq`, `rustls`, `ring`, `webpki`, or `icu`.
final class PocketDioWorkerHttpBridge {
  PocketDioWorkerHttpBridge._();

  static NativeCallable<_WorkerHttpCallbackNative>? _callable;
  static _CompleteRequestDart? _completeRequest;
  static _RegisterBridgeDart? _registerBridge;
  static Dio? _dio;
  static Dio Function()? _dioFactory;

  /// Whether the native C-FFI Worker HTTP bridge is currently active.
  static bool get isInstalled => _callable != null;

  /// Installs the process-wide Dio HTTP bridge into `libpocket_flutter` when
  /// the native library is available. Safe to call multiple times or in
  /// pure-Dart unit test environments without a native library.
  static bool install({Dio Function()? dioFactory}) {
    if (dioFactory != null) {
      _dioFactory = dioFactory;
    }
    if (_callable != null) return true;
    final lib = _tryOpenNativeLibrary();
    if (lib == null) return false;
    try {
      final register = lib
          .lookupFunction<_RegisterBridgeNative, _RegisterBridgeDart>(
            'pocket_register_worker_http_bridge',
          );
      final complete = lib
          .lookupFunction<_CompleteRequestNative, _CompleteRequestDart>(
            'pocket_complete_worker_http_request',
          );
      final callable = NativeCallable<_WorkerHttpCallbackNative>.listener(
        _onNativeHttpRequest,
      )..keepIsolateAlive = false;
      register(callable.nativeFunction);
      _registerBridge = register;
      _completeRequest = complete;
      _callable = callable;
      return true;
    } on Object {
      return false;
    }
  }

  /// Uninstalls the process-wide Dio HTTP bridge and closes any owned client.
  static void uninstall() {
    final register = _registerBridge;
    final callable = _callable;
    _callable = null;
    _completeRequest = null;
    _registerBridge = null;
    if (register != null) {
      try {
        register(nullptr);
      } on Object {}
    }
    callable?.close();
    _dio?.close(force: true);
    _dio = null;
  }

  static DynamicLibrary? _tryOpenNativeLibrary() {
    try {
      final override = Platform.environment['POCKET_NATIVE_LIBRARY'];
      if (override != null && override.isNotEmpty) {
        return DynamicLibrary.open(override);
      }
      if (Platform.isAndroid || Platform.isLinux) {
        return DynamicLibrary.open('libpocket_flutter.so');
      }
      if (Platform.isWindows) {
        return DynamicLibrary.open('pocket_flutter.dll');
      }
      if (Platform.isIOS || Platform.isMacOS) {
        return DynamicLibrary.process();
      }
    } on Object {
      return null;
    }
    return null;
  }

  static Dio _ensureDio() =>
      _dio ??= (_dioFactory != null ? _dioFactory!() : Dio());

  static void _onNativeHttpRequest(
    int requestId,
    Pointer<Uint8> requestJsonPtr,
    int requestJsonLen,
  ) {
    String rawJson = '';
    if (requestJsonPtr != nullptr && requestJsonLen > 0) {
      rawJson = utf8.decode(
        Uint8List.fromList(requestJsonPtr.asTypedList(requestJsonLen)),
        allowMalformed: true,
      );
    }
    unawaited(_executeRequest(requestId, rawJson));
  }

  static Future<void> _executeRequest(int requestId, String rawJson) async {
    final complete = _completeRequest;
    if (complete == null) return;
    try {
      final payload = jsonDecode(rawJson) as Map<String, dynamic>;
      final url = payload['url'] as String;
      final method = (payload['method'] as String?) ?? 'GET';
      final timeoutMs = (payload['timeoutMs'] as num?)?.toInt() ?? 30000;
      final maxBytes = (payload['maxBytes'] as num?)?.toInt() ?? (256 * 1024);
      final rawHeaders = payload['headers'];
      final headers = <String, dynamic>{
        if (rawHeaders is Map)
          for (final entry in rawHeaders.entries)
            entry.key.toString(): entry.value,
      };
      final body = payload['body'] as String?;

      final dio = _ensureDio();
      final cancelToken = CancelToken();
      final response = await dio
          .requestUri<ResponseBody>(
            Uri.parse(url),
            data: body == null ? null : utf8.encode(body),
            cancelToken: cancelToken,
            options: Options(
              method: method,
              headers: headers,
              followRedirects: false,
              responseType: ResponseType.stream,
              validateStatus: (_) => true,
              sendTimeout: Duration(milliseconds: timeoutMs),
              receiveTimeout: Duration(milliseconds: timeoutMs),
            ),
          )
          .timeout(Duration(milliseconds: timeoutMs));

      final streamBody = response.data;
      final collected = BytesBuilder(copy: false);
      var total = 0;
      // Only read up to maxBytes + 1 so Rust's own response-size check triggers
      // deterministically without unbounded memory buffering in Dart.
      final cap = maxBytes + 1;
      if (streamBody != null) {
        try {
          await for (final chunk in streamBody.stream) {
            final remaining = cap - total;
            if (remaining <= 0) {
              cancelToken.cancel('maxBytes reached');
              break;
            }
            if (chunk.length <= remaining) {
              collected.add(chunk);
              total += chunk.length;
            } else {
              collected.add(Uint8List.sublistView(chunk, 0, remaining));
              total += remaining;
              cancelToken.cancel('maxBytes reached');
              break;
            }
          }
        } finally {
          streamBody.close();
        }
      }

      final flatHeaders = <String, String>{};
      response.headers.map.forEach((key, values) {
        if (values.isNotEmpty) {
          flatHeaders[key] = values.join(', ');
        }
      });

      _sendCompletion(
        complete,
        requestId: requestId,
        status: response.statusCode ?? 0,
        finalUrl: response.realUri.toString(),
        headersJson: jsonEncode(flatHeaders),
        body: collected.takeBytes(),
      );
    } on Object catch (error) {
      _sendCompletion(
        complete,
        requestId: requestId,
        status: 0,
        error: error.toString(),
      );
    }
  }

  static void _sendCompletion(
    _CompleteRequestDart complete, {
    required int requestId,
    required int status,
    String finalUrl = '',
    String headersJson = '',
    Uint8List? body,
    String error = '',
  }) {
    final urlBytes = finalUrl.isEmpty
        ? const <int>[]
        : utf8.encode(finalUrl);
    final hdrBytes = headersJson.isEmpty
        ? const <int>[]
        : utf8.encode(headersJson);
    final bodyBytes = body ?? Uint8List(0);
    final errBytes = error.isEmpty ? const <int>[] : utf8.encode(error);

    final totalAlloc =
        urlBytes.length + hdrBytes.length + bodyBytes.length + errBytes.length;
    if (totalAlloc == 0) {
      complete(
        requestId,
        status,
        nullptr,
        0,
        nullptr,
        0,
        nullptr,
        0,
        nullptr,
        0,
      );
      return;
    }

    // Allocate one temporary native slab via DynamicLibrary.process() malloc/free
    // without requiring an extra package:ffi dependency in pocket_dio.
    final stdlib = Platform.isWindows
        ? DynamicLibrary.open('msvcrt.dll')
        : DynamicLibrary.process();
    final mallocFn = stdlib
        .lookupFunction<Pointer<Uint8> Function(Size), Pointer<Uint8> Function(int)>(
          'malloc',
        );
    final freeFn = stdlib
        .lookupFunction<Void Function(Pointer<Uint8>), void Function(Pointer<Uint8>)>(
          'free',
        );
    final slab = mallocFn(totalAlloc);
    if (slab == nullptr) {
      complete(
        requestId,
        0,
        nullptr,
        0,
        nullptr,
        0,
        nullptr,
        0,
        nullptr,
        0,
      );
      return;
    }
    try {
      final view = slab.asTypedList(totalAlloc);
      var offset = 0;
      Pointer<Uint8> slice(List<int> src) {
        if (src.isEmpty) return nullptr;
        final ptr = Pointer<Uint8>.fromAddress(slab.address + offset);
        view.setRange(offset, offset + src.length, src);
        offset += src.length;
        return ptr;
      }

      final urlPtr = slice(urlBytes);
      final hdrPtr = slice(hdrBytes);
      final bodyPtr = slice(bodyBytes);
      final errPtr = slice(errBytes);

      complete(
        requestId,
        status,
        urlPtr,
        urlBytes.length,
        hdrPtr,
        hdrBytes.length,
        bodyPtr,
        bodyBytes.length,
        errPtr,
        errBytes.length,
      );
    } finally {
      freeFn(slab);
    }
  }
}
