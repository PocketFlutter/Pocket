import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_file_picker/pocket_file_picker.dart';
import 'package:pocket_services/pocket_services.dart';

const MethodChannel _channel = MethodChannel('plugins.flutter.io/file_selector');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory work;
  var dialogs = <Map<Object?, Object?>>[];
  List<String>? dialogResult;
  Object? dialogError;

  setUp(() async {
    work = await Directory.systemTemp.createTemp('pocket-files-');
    dialogs = <Map<Object?, Object?>>[];
    dialogResult = null;
    dialogError = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, (call) async {
      expect(call.method, 'openFile');
      dialogs.add(Map<Object?, Object?>.from(call.arguments as Map));
      if (dialogError != null) throw PlatformException(code: 'boom', message: '${work.path}/secret');
      return dialogResult;
    });
  });
  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, null);
    await work.delete(recursive: true);
  });

  File make(String name, List<int> bytes) => File('${work.path}/$name')..writeAsBytesSync(bytes);

  Future<PocketPluginManager> admit({
    Set<String> hostAllowed = const {'files.open'},
    List<String> optional = const ['files.pickOpen', 'files.readChunk', 'files.release'],
    List<String> declared = const ['files.open'],
    PocketFilePickerPlugin? plugin,
    String appId = 'dev.test',
  }) async {
    final host = PocketHost(
      registry: PocketHostRegistry(),
      streams: PocketStreamBridge(send: (_, __) => true),
      allowedCapabilities: PocketFilePickerCapabilities.all,
      send: (_, __) => true,
    );
    final manager = PocketPluginManager(host: host, appId: appId, sessionId: '1', allowedPermissions: hostAllowed);
    manager.register(plugin ?? PocketFilePickerPlugin());
    final availability = manager.negotiate(
      required: const <String>[],
      optional: optional,
      requestedPermissions: declared,
    );
    await manager.activate(availability);
    addTearDown(manager.dispose);
    return manager;
  }

  Future<Map<String, dynamic>> pick(PocketPluginManager manager, [Map<String, dynamic> params = const {}]) async =>
      Map<String, dynamic>.from(await manager.invoke('files.pickOpen', params) as Map);

  test('descriptor serializes with schemas and the single files.open permission', () {
    final json = PocketFilePickerPlugin().descriptor.toJson();
    expect(json['id'], 'flutter.files');
    final caps = (json['capabilities'] as List).cast<Map>();
    expect(caps.map((c) => c['name']), containsAll(PocketFilePickerCapabilities.all));
  });

  test('pickOpen returns opaque handles with name, size and mime, never a path; chunks reassemble the file', () async {
    final bytes = List<int>.generate(300 * 1024 + 7, (i) => i % 251);
    final file = make('photo.PNG', bytes);
    dialogResult = [file.path];
    final manager = await admit();
    final result = await pick(manager, {'accept': ['png', 'JPG']});
    final files = (result['files'] as List).cast<Map>();
    expect(files, hasLength(1));
    expect(files.single['name'], 'photo.PNG');
    expect(files.single['size'], bytes.length);
    expect(files.single['mime'], 'image/png');
    expect(files.single['handle'], matches(RegExp(r'^[0-9a-f]{32}$')));
    expect(jsonEncode(result), isNot(contains(work.path)));
    final groups = (dialogs.single['acceptedTypeGroups'] as List).cast<Map>();
    expect(groups.single['extensions'], ['png', 'jpg']);
    expect(dialogs.single['multiple'], isFalse);

    final handle = files.single['handle'] as String;
    final out = BytesBuilder();
    var offset = 0;
    var chunks = 0;
    while (true) {
      final chunk = Map<String, dynamic>.from(
        await manager.invoke('files.readChunk', {'handle': handle, 'offset': offset, 'length': pocketFilePickerChunkBytes}) as Map,
      );
      final data = base64Decode(chunk['data'] as String);
      expect(data.length, lessThanOrEqualTo(pocketFilePickerChunkBytes));
      expect(chunk['size'], bytes.length);
      out.add(data);
      offset += data.length;
      chunks++;
      if (chunk['eof'] == true) break;
    }
    expect(chunks, 3);
    expect(out.takeBytes(), bytes);
    // Reading past the end is an empty eof chunk, not an error.
    final tail = Map<String, dynamic>.from(
      await manager.invoke('files.readChunk', {'handle': handle, 'offset': bytes.length, 'length': 10}) as Map,
    );
    expect(tail, containsPair('eof', true));
    expect(tail['data'], '');
  });

  test('cancelling the dialog returns no files; multiple uses the multi dialog', () async {
    final manager = await admit();
    expect(await pick(manager), {'files': <Object?>[]});
    final a = make('a.wav', [1, 2]);
    final b = make('b.ogg', [3]);
    dialogResult = [a.path, b.path];
    final result = await pick(manager, {'multiple': true});
    expect(dialogs.last['multiple'], isTrue);
    expect((result['files'] as List).map((f) => (f as Map)['name']), ['a.wav', 'b.ogg']);
    expect(dialogs.first['acceptedTypeGroups'], anyOf(isNull, isEmpty));
  });

  test('size, handle and parameter validation', () async {
    final file = make('x.bin', List<int>.filled(100, 7));
    dialogResult = [file.path];
    final limited = await admit(plugin: PocketFilePickerPlugin(maxFileBytes: 99));
    await expectLater(pick(limited), throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'too_large')));

    final manager = await admit();
    final handle = ((await pick(manager))['files'] as List).cast<Map>().single['handle'] as String;
    Future<Object?> read(Map<String, dynamic> p) => manager.invoke('files.readChunk', p);
    Matcher code(String c) => throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', c));
    await expectLater(read({'handle': handle, 'offset': 0, 'length': pocketFilePickerChunkBytes + 1}), code('too_large'));
    await expectLater(read({'handle': handle, 'offset': -1, 'length': 1}), code('invalid_params'));
    await expectLater(read({'handle': handle, 'offset': 0, 'length': 0}), code('invalid_params'));
    await expectLater(read({'handle': handle, 'offset': 0, 'length': 1.5}), code('invalid_params'));
    await expectLater(read({'handle': '../../etc/passwd', 'offset': 0, 'length': 1}), code('invalid_params'));
    await expectLater(read({'handle': '0' * 32, 'offset': 0, 'length': 1}), code('handle_not_found'));
    await expectLater(pick(manager, {'accept': ['.png']}), code('invalid_params'));
    await expectLater(pick(manager, {'accept': ['*']}), code('invalid_params'));
    await expectLater(pick(manager, {'accept': 'png'}), code('invalid_params'));
    await expectLater(pick(manager, {'multiple': 'yes'}), code('invalid_params'));
    expect(
      Map<String, dynamic>.from(await read({'handle': handle, 'offset': 90, 'length': 100}) as Map),
      containsPair('length', 10),
    );
    expect(await manager.invoke('files.release', {'handle': handle}), {'released': true});
    expect(await manager.invoke('files.release', {'handle': handle}), {'released': false});
    await expectLater(read({'handle': handle, 'offset': 0, 'length': 1}), code('handle_not_found'));
    expect(() => PocketFilePickerPlugin(maxFileBytes: 0), throwsArgumentError);
    expect(() => PocketFilePickerPlugin(maxFileBytes: pocketFilePickerMaxFileBytesCeiling + 1), throwsArgumentError);
  });

  test('a file that changes after it was chosen is refused', () async {
    final file = make('grow.txt', [1, 2, 3]);
    dialogResult = [file.path];
    final manager = await admit();
    final handle = ((await pick(manager))['files'] as List).cast<Map>().single['handle'] as String;
    file.writeAsBytesSync([1, 2, 3, 4]);
    await expectLater(
      manager.invoke('files.readChunk', {'handle': handle, 'offset': 0, 'length': 4}),
      throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'file_changed')),
    );
    file.deleteSync();
    await expectLater(
      manager.invoke('files.readChunk', {'handle': handle, 'offset': 0, 'length': 4}),
      throwsA(isA<PocketCapabilityException>()),
    );
  });

  test('handle table is bounded and a dialog failure does not leak the path', () async {
    final manager = await admit();
    final file = make('h.txt', [1]);
    dialogResult = [file.path];
    for (var i = 0; i < pocketFilePickerMaxHandles; i++) {
      await pick(manager);
    }
    await expectLater(pick(manager), throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'too_many_handles')));

    final fresh = await admit();
    dialogError = true;
    await expectLater(
      pick(fresh),
      throwsA(
        isA<PocketCapabilityException>()
            .having((e) => e.code, 'code', 'dialog_failed')
            .having((e) => e.message, 'message', isNot(contains(work.path))),
      ),
    );
  });

  test('a second dialog while one is open is refused as busy', () async {
    final file = make('b.txt', [1]);
    dialogResult = [file.path];
    final manager = await admit();
    final first = pick(manager);
    await expectLater(pick(manager), throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'busy')));
    expect(((await first)['files'] as List), hasLength(1));
  });

  test('without the host grant, manifest permission or capability the dialog is never shown', () async {
    final file = make('d.txt', [1]);
    dialogResult = [file.path];
    final noHost = await admit(hostAllowed: const <String>{});
    await expectLater(noHost.invoke('files.pickOpen', const {}), throwsA(isA<PocketCapabilityException>()));
    final undeclaredCapability = await admit(optional: const ['files.release']);
    await expectLater(undeclaredCapability.invoke('files.pickOpen', const {}), throwsA(isA<PocketCapabilityException>()));
    final undeclaredPermission = await admit(declared: const <String>[]);
    await expectLater(undeclaredPermission.invoke('files.pickOpen', const {}), throwsA(isA<PocketCapabilityException>()));
    await expectLater(undeclaredPermission.invoke('files.readChunk', {'handle': '0' * 32, 'offset': 0, 'length': 1}), throwsA(isA<PocketCapabilityException>()));
    expect(dialogs, isEmpty);
  });

  test('a child guest does not inherit the parent grant: its own manifest is negotiated against the host scope', () async {
    final file = make('c.txt', [1]);
    dialogResult = [file.path];
    final parent = await admit(appId: 'dev.parent');
    expect(((await pick(parent))['files'] as List), hasLength(1));
    // Same host scope, but the child manifest declares neither capability nor permission.
    final child = await admit(appId: 'dev.child', optional: const <String>[], declared: const <String>[]);
    final before = dialogs.length;
    await expectLater(child.invoke('files.pickOpen', const {}), throwsA(isA<PocketCapabilityException>()));
    expect(dialogs.length, before);
  });
}
