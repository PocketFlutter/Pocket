import 'dart:io';

import 'package:test/test.dart';

import 'package:pocket_sdk/src/pocket_platform_data.dart';

void main() {
  late Directory directory;
  late PocketPlatformData store;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('pocket-platform-data-');
    store = PocketPlatformData(directory: directory);
    await store.initialize();
  });

  tearDown(() async {
    await store.close();
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  test('isolates private values and enforces shared namespace ACL', () async {
    store.registerApp('app.a', sharedNamespaces: {'account'});
    store.registerApp('app.b', sharedNamespaces: {'account'});

    final value = <String, Object?>{
      'name': 'Ada',
      'roles': <Object?>['admin'],
    };
    await store.write('app.a', 'profile', value);
    value['name'] = 'mutated-after-write';
    expect(await store.read('app.a', 'profile'), {
      'name': 'Ada',
      'roles': ['admin'],
    });
    expect(await store.read('app.b', 'profile'), isNull);
    expect(await store.keys('app.b'), isEmpty);

    await store.write('app.a', 'user', 'Ada', namespace: 'account');
    expect(await store.read('app.b', 'user', namespace: 'account'), 'Ada');
    expect(
      () => store.read('app.b', 'user', namespace: 'private'),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'shared_namespace_denied',
        ),
      ),
    );
    expect(await store.keys('app.a'), ['profile']);
    expect(await store.keys('app.a', namespace: 'account'), ['user']);
  });

  test('rejects non-JSON values and path-like identifiers', () async {
    store.registerApp('app.a');
    final cyclic = <String, Object?>{};
    cyclic['self'] = cyclic;
    expect(
      () => store.write('app.a', 'date', DateTime.now()),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'invalid_value',
        ),
      ),
    );
    expect(
      () => store.write('app.a', '../escape', 1),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'invalid_key',
        ),
      ),
    );
    expect(
      () => store.registerApp('../app'),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'invalid_app_id',
        ),
      ),
    );
    expect(
      () => store.write('app.a', 'nan', double.nan),
      throwsA(isA<PocketCapabilityException>()),
    );
    expect(
      () => store.write('app.a', 'cycle', cyclic),
      throwsA(isA<PocketCapabilityException>()),
    );
  });

  test('recovers app and shared values after restart', () async {
    store.registerApp('app.a', sharedNamespaces: {'account'});
    await store.write('app.a', 'counter', 7);
    await store.write('app.a', 'user', 'Ada', namespace: 'account');
    await store.close();
    final reopened = PocketPlatformData(directory: directory);
    await reopened.initialize();
    reopened.registerApp('app.a', sharedNamespaces: {'account'});
    expect(await reopened.read('app.a', 'counter'), 7);
    expect(await reopened.read('app.a', 'user', namespace: 'account'), 'Ada');
    await reopened.close();
  });

  test(
    'quota failures preserve old values and shared quota is per namespace',
    () async {
      await store.close();
      store = PocketPlatformData(
        directory: directory,
        maxValueBytes: 128,
        maxAppBytes: 80,
      );
      await store.initialize();
      store.registerApp('app.a', sharedNamespaces: {'common'});
      store.registerApp('app.b', sharedNamespaces: {'common'});
      await store.write('app.a', 'value', 'old');
      expect(
        store.write('app.a', 'value', 'x' * 200),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'value_too_large',
          ),
        ),
      );
      expect(await store.read('app.a', 'value'), 'old');

      await store.write('app.a', 'one', 'x' * 20, namespace: 'common');
      expect(
        store.write('app.b', 'two', 'y' * 80, namespace: 'common'),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'quota_exceeded',
          ),
        ),
      );
      expect(await store.read('app.a', 'one', namespace: 'common'), 'x' * 20);
      expect(await store.read('app.b', 'two', namespace: 'common'), isNull);
    },
  );

  test('batch moves and swaps a bucket in one persisted transaction', () async {
    store.registerApp('app.a', sharedNamespaces: {'account'});
    await store.write('app.a', 'slot.1', {'story': 'chapter-1'});
    await store.write('app.a', 'slot.2', {'story': 'chapter-2'});
    final file = File('${directory.path}${Platform.pathSeparator}pocket_platform_data.json');
    final writesBeforeBatch = await file.readAsString();

    await store.batch('app.a', <Object?>[
      <String, Object?>{'type': 'set', 'key': 'slot.1', 'value': {'story': 'chapter-2'}},
      <String, Object?>{'type': 'set', 'key': 'slot.2', 'value': {'story': 'chapter-1'}},
      <String, Object?>{'type': 'remove', 'key': 'obsolete'},
    ]);
    expect(await store.read('app.a', 'slot.1'), {'story': 'chapter-2'});
    expect(await store.read('app.a', 'slot.2'), {'story': 'chapter-1'});
    expect(await file.readAsString(), isNot(writesBeforeBatch));

    await store.close();
    final reopened = PocketPlatformData(directory: directory);
    await reopened.initialize();
    reopened.registerApp('app.a', sharedNamespaces: {'account'});
    expect(await reopened.read('app.a', 'slot.1'), {'story': 'chapter-2'});
    expect(await reopened.read('app.a', 'slot.2'), {'story': 'chapter-1'});
    await reopened.close();
    store = PocketPlatformData(directory: directory);
    await store.initialize();
  });

  test('malformed, duplicate, over-value and over-count batches leave data unchanged', () async {
    store.registerApp('app.a');
    await store.write('app.a', 'slot', 'original');
    final file = File('${directory.path}${Platform.pathSeparator}pocket_platform_data.json');
    final before = await file.readAsString();

    Future<void> expectUnchanged(List<Object?> operations, String code) async {
      await expectLater(
        store.batch('app.a', operations),
        throwsA(isA<PocketCapabilityException>().having((error) => error.code, 'code', code)),
      );
      expect(await store.read('app.a', 'slot'), 'original');
      expect(await file.readAsString(), before);
    }

    await expectUnchanged(<Object?>[
      <String, Object?>{'type': 'set', 'key': 'slot', 'value': 'changed'},
      <String, Object?>{'type': 'invalid', 'key': 'bad'},
    ], 'invalid_storage_operation');
    await expectUnchanged(<Object?>[
      <String, Object?>{'type': 'set', 'key': 'slot', 'value': 'changed'},
      <String, Object?>{'type': 'remove', 'key': 'slot'},
    ], 'duplicate_storage_key');
    await expectUnchanged(<Object?>[
      <String, Object?>{'type': 'set', 'key': 'slot', 'value': 'x' * 65537},
    ], 'value_too_large');
    await expectUnchanged(List<Object?>.generate(257, (index) => <String, Object?>{
      'type': 'remove', 'key': 'unused.$index',
    }), 'too_many_storage_operations');
  });

  test('final quota and temp-file failures keep the old memory and disk snapshot', () async {
    await store.close();
    store = PocketPlatformData(directory: directory, maxValueBytes: 128, maxAppBytes: 50);
    await store.initialize();
    store.registerApp('app.a');
    await store.write('app.a', 'one', 'x' * 20);
    final file = File('${directory.path}${Platform.pathSeparator}pocket_platform_data.json');
    final before = await file.readAsString();
    await expectLater(
      store.batch('app.a', <Object?>[
        <String, Object?>{'type': 'set', 'key': 'two', 'value': 'y' * 20},
      ]),
      throwsA(isA<PocketCapabilityException>().having((error) => error.code, 'code', 'quota_exceeded')),
    );
    expect(await store.read('app.a', 'one'), 'x' * 20);
    expect(await store.read('app.a', 'two'), isNull);
    expect(await file.readAsString(), before);

    final obstruction = Directory('${file.path}.tmp');
    await obstruction.create();
    await expectLater(
      store.batch('app.a', <Object?>[
        <String, Object?>{'type': 'set', 'key': 'one', 'value': 'replacement'},
      ]),
      throwsA(isA<PocketCapabilityException>().having((error) => error.code, 'code', 'storage_unavailable')),
    );
    expect(await store.read('app.a', 'one'), 'x' * 20);
    expect(await file.readAsString(), before);
  });

  test(
    'serializes concurrent writes and rejects late calls after close',
    () async {
      store.registerApp('app.a');
      await Future.wait([
        store.write('app.a', 'a', 1),
        store.write('app.a', 'b', 2),
        store.write('app.a', 'c', 3),
      ]);
      expect(await store.keys('app.a'), ['a', 'b', 'c']);
      await store.close();
      expect(
        store.read('app.a', 'a'),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'closed',
          ),
        ),
      );
      expect(
        () => store.registerApp('app.b'),
        throwsA(isA<PocketCapabilityException>()),
      );
    },
  );

  test('lets operations already queued before close finish', () async {
    store.registerApp('app.a');
    final queuedWrite = store.write('app.a', 'beforeClose', true);
    final closeFuture = store.close();
    await queuedWrite;
    await closeFuture;
  });

  test(
    'concurrent initialize calls share one startup and close follows it',
    () async {
      await store.close();
      final concurrent = PocketPlatformData(directory: directory);
      final first = concurrent.initialize();
      final second = concurrent.initialize();
      final closeFuture = concurrent.close();
      await Future.wait([first, second, closeFuture]);
    },
  );

  group('openShared', () {
    test(
      'shares in-memory state and disk queue across concurrent leases while isolating per-lease ACLs',
      () async {
        await store.close();
        final leaseA = await PocketPlatformData.openShared(
          directory: Directory('${directory.path}/./shared-store/'),
        );
        final leaseB = await PocketPlatformData.openShared(
          directory: Directory('${directory.path}/shared-store'),
        );

        leaseA.registerApp('app.a', sharedNamespaces: {'common', 'onlyA'});
        leaseB.registerApp('app.b', sharedNamespaces: {'common'});

        // Per-lease ACL isolation: app.a is not registered on leaseB, and
        // leaseB can register app.a with different permissions without conflict.
        await expectLater(
          leaseB.read('app.a', 'k'),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'app_not_registered',
            ),
          ),
        );
        leaseB.registerApp('app.a', sharedNamespaces: {'common'});
        await expectLater(
          leaseB.read('app.a', 'secret', namespace: 'onlyA'),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'shared_namespace_denied',
            ),
          ),
        );

        // Concurrent private & shared writes do not clobber each other in memory or on disk.
        await Future.wait([
          leaseA.write('app.a', 'fromA', 1),
          leaseB.write('app.b', 'fromB', 2),
          leaseA.write('app.a', 'sharedA', 'alpha', namespace: 'common'),
          leaseB.write('app.b', 'sharedB', 'beta', namespace: 'common'),
        ]);

        expect(await leaseB.read('app.a', 'fromA'), 1);
        expect(
          await leaseB.read('app.b', 'sharedA', namespace: 'common'),
          'alpha',
        );
        expect(
          await leaseA.read('app.a', 'sharedB', namespace: 'common'),
          'beta',
        );
        expect(await leaseA.keys('app.a', namespace: 'common'), [
          'sharedA',
          'sharedB',
        ]);

        await leaseA.close();
        await leaseB.close();

        final reopened = await PocketPlatformData.openShared(
          directory: Directory('${directory.path}/shared-store'),
        );
        reopened.registerApp('app.a', sharedNamespaces: {'common'});
        reopened.registerApp('app.b', sharedNamespaces: {'common'});
        expect(await reopened.read('app.a', 'fromA'), 1);
        expect(await reopened.read('app.b', 'fromB'), 2);
        expect(
          await reopened.read('app.a', 'sharedA', namespace: 'common'),
          'alpha',
        );
        expect(
          await reopened.read('app.b', 'sharedB', namespace: 'common'),
          'beta',
        );
        await reopened.close();
      },
    );

    test(
      'closing one lease keeps remaining leases functional and rejects calls on closed lease',
      () async {
        await store.close();
        final leaseA = await PocketPlatformData.openShared(
          directory: directory,
        );
        final leaseB = await PocketPlatformData.openShared(
          directory: directory,
        );
        leaseA.registerApp('app.a', sharedNamespaces: {'common'});
        leaseB.registerApp('app.a', sharedNamespaces: {'common'});

        final pendingWrite = leaseA.write('app.a', 'queuedBeforeClose', 'ok');
        await leaseA.close();
        // Idempotent close.
        await leaseA.close();
        await pendingWrite;

        Matcher throwsClosed() => throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'closed',
          ),
        );

        await expectLater(leaseA.read('app.a', 'queuedBeforeClose'), throwsClosed());
        await expectLater(leaseA.write('app.a', 'x', 1), throwsClosed());
        await expectLater(leaseA.remove('app.a', 'x'), throwsClosed());
        await expectLater(leaseA.keys('app.a'), throwsClosed());
        await expectLater(
          leaseA.batch('app.a', const <Object?>[
            <String, Object?>{'type': 'set', 'key': 'x', 'value': 1},
          ]),
          throwsClosed(),
        );
        expect(() => leaseA.registerApp('app.c'), throwsClosed());

        // Lease B remains open and sees lease A's queued write.
        expect(await leaseB.read('app.a', 'queuedBeforeClose'), 'ok');
        await leaseB.write('app.a', 'afterAClosed', 42);
        expect(await leaseB.read('app.a', 'afterAClosed'), 42);
        await leaseB.close();
      },
    );

    test(
      'reopening after all leases close or while close is in flight reloads persisted values cleanly',
      () async {
        await store.close();
        final lease1 = await PocketPlatformData.openShared(
          directory: directory,
        );
        lease1.registerApp('app.a');
        await lease1.write('app.a', 'step', 1);

        final queuedWrite = lease1.write('app.a', 'step', 2);
        final closeFuture = lease1.close();
        final reopenWhileClosing = PocketPlatformData.openShared(
          directory: directory,
        );

        final lease2 = await reopenWhileClosing;
        await queuedWrite;
        await closeFuture;

        lease2.registerApp('app.a');
        expect(await lease2.read('app.a', 'step'), 2);
        await lease2.write('app.a', 'step', 3);
        await lease2.close();

        final lease3 = await PocketPlatformData.openShared(
          directory: directory,
        );
        lease3.registerApp('app.a');
        expect(await lease3.read('app.a', 'step'), 3);
        await lease3.close();
      },
    );

    test(
      'mismatched quota limits on openShared throw registration_conflict',
      () async {
        await store.close();
        final lease = await PocketPlatformData.openShared(
          directory: directory,
          maxValueBytes: 1024,
          maxAppBytes: 4096,
        );
        await expectLater(
          PocketPlatformData.openShared(
            directory: directory,
            maxValueBytes: 2048,
            maxAppBytes: 4096,
          ),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'registration_conflict',
            ),
          ),
        );
        await expectLater(
          PocketPlatformData.openShared(
            directory: directory,
            maxValueBytes: 1024,
            maxAppBytes: 8192,
          ),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'registration_conflict',
            ),
          ),
        );
        await lease.close();
      },
    );
  });
}
