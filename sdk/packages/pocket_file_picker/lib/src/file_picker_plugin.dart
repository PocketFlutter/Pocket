import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';
import 'package:pocket_services/pocket_services.dart';

const String pocketFilePickerPluginId = 'flutter.files';

/// Host-granted permission. Opening a file dialog and reading what the user
/// picked is one deliberate grant; it never exposes a path.
abstract final class PocketFilePickerPermissions {
  static const String open = 'files.open';
}

abstract final class PocketFilePickerCapabilities {
  static const String pickOpen = 'files.pickOpen';
  static const String readChunk = 'files.readChunk';
  static const String release = 'files.release';

  static const Set<String> all = <String>{pickOpen, readChunk, release};
}

/// Largest raw chunk per `files.readChunk` (base64 encoded it stays below the
/// 256 KiB control message).
const int pocketFilePickerChunkBytes = 128 * 1024;

/// Default and largest accepted file size reported by `files.pickOpen`.
const int pocketFilePickerDefaultMaxFileBytes = 256 * 1024 * 1024;
const int pocketFilePickerMaxFileBytesCeiling = 1024 * 1024 * 1024;

/// Handles kept at once per plugin instance; release or pick again to free.
const int pocketFilePickerMaxHandles = 64;
const int _maxFilesPerPick = 32;
const int _maxAcceptEntries = 32;

// Descriptor response quota. A full chunk is 174,764 base64 characters plus the
// small result object; the bridge message cap is 256 KiB including the
// envelope, so 250 KiB leaves headroom (same quota as the clipboard plugin).
const int _responseQuotaBytes = 250 * 1024;

final RegExp _extension = RegExp(r'^[A-Za-z0-9]{1,16}$');
final RegExp _handle = RegExp(r'^[0-9a-f]{32}$');

const Map<String, String> _mimeByExtension = <String, String>{
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'bmp': 'image/bmp',
  'svg': 'image/svg+xml',
  'wav': 'audio/wav',
  'mp3': 'audio/mpeg',
  'ogg': 'audio/ogg',
  'm4a': 'audio/mp4',
  'aac': 'audio/aac',
  'flac': 'audio/flac',
  'mp4': 'video/mp4',
  'ttf': 'font/ttf',
  'otf': 'font/otf',
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'json': 'application/json',
  'txt': 'text/plain',
  'md': 'text/markdown',
};

const PocketPluginSchema _fileSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'handle': PocketPluginSchema.string(),
    'name': PocketPluginSchema.string(),
    'size': PocketPluginSchema.integer(),
    'mime': PocketPluginSchema.string(),
  },
  required: <String>{'handle', 'name', 'size', 'mime'},
);

const PocketPluginSchema _handleParam = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{'handle': PocketPluginSchema.string()},
  required: <String>{'handle'},
);

const Map<String, PocketPluginCapability> _capabilities = <String, PocketPluginCapability>{
  PocketFilePickerCapabilities.pickOpen: PocketPluginCapability(
    name: PocketFilePickerCapabilities.pickOpen,
    kind: PocketCapabilityKind.request,
    description: 'Shows the platform open-file dialog and returns opaque handles for the chosen files',
    permissions: <String>{PocketFilePickerPermissions.open},
    schema: PocketPluginCapabilitySchema(
      parameters: PocketPluginSchema.object(
        properties: <String, PocketPluginSchema>{
          'accept': PocketPluginSchema.array(PocketPluginSchema.string()),
          'multiple': PocketPluginSchema.boolean(),
        },
      ),
      result: PocketPluginSchema.object(
        properties: <String, PocketPluginSchema>{
          'files': PocketPluginSchema.array(_fileSchema),
        },
        required: <String>{'files'},
      ),
    ),
  ),
  PocketFilePickerCapabilities.readChunk: PocketPluginCapability(
    name: PocketFilePickerCapabilities.readChunk,
    kind: PocketCapabilityKind.request,
    description: 'Reads up to 128 KiB of a picked file as base64',
    permissions: <String>{PocketFilePickerPermissions.open},
    schema: PocketPluginCapabilitySchema(
      parameters: PocketPluginSchema.object(
        properties: <String, PocketPluginSchema>{
          'handle': PocketPluginSchema.string(),
          'offset': PocketPluginSchema.integer(),
          'length': PocketPluginSchema.integer(),
        },
        required: <String>{'handle', 'offset', 'length'},
      ),
      result: PocketPluginSchema.object(
        properties: <String, PocketPluginSchema>{
          'handle': PocketPluginSchema.string(),
          'offset': PocketPluginSchema.integer(),
          'length': PocketPluginSchema.integer(),
          'size': PocketPluginSchema.integer(),
          'eof': PocketPluginSchema.boolean(),
          'data': PocketPluginSchema.string(),
        },
        required: <String>{'handle', 'offset', 'length', 'size', 'eof', 'data'},
      ),
    ),
  ),
  PocketFilePickerCapabilities.release: PocketPluginCapability(
    name: PocketFilePickerCapabilities.release,
    kind: PocketCapabilityKind.request,
    description: 'Forgets a picked-file handle',
    permissions: <String>{PocketFilePickerPermissions.open},
    schema: PocketPluginCapabilitySchema(
      parameters: _handleParam,
      result: PocketPluginSchema.object(
        properties: <String, PocketPluginSchema>{'released': PocketPluginSchema.boolean()},
        required: <String>{'released'},
      ),
    ),
  ),
};

final class _Picked {
  _Picked(this.file, this.size);
  final XFile file;
  final int size;
}

/// Platform open-file dialog backed by `package:file_selector`.
///
/// The plugin keeps one small table of handles it issued (the native
/// boundary's fact: which file the user chose). It owns no policy: which app
/// may open files is decided by the host's `allowedPermissions`, the guest
/// manifest and the capability grant. Paths never leave the host; the guest
/// receives an opaque handle, the display name, the byte size and a MIME type
/// derived from the extension.
final class PocketFilePickerPlugin extends PocketPlugin {
  PocketFilePickerPlugin({
    int maxFileBytes = pocketFilePickerDefaultMaxFileBytes,
    Random? random,
  }) : maxFileBytes = _boundedLimit(maxFileBytes),
       _random = random ?? Random.secure();

  final int maxFileBytes;
  final Random _random;
  final Map<String, _Picked> _handles = <String, _Picked>{};
  bool _picking = false;

  static int _boundedLimit(int value) {
    if (value <= 0 || value > pocketFilePickerMaxFileBytesCeiling) {
      throw ArgumentError.value(
        value,
        'maxFileBytes',
        'must be between 1 and $pocketFilePickerMaxFileBytesCeiling',
      );
    }
    return value;
  }

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: pocketFilePickerPluginId,
    version: '0.1.0',
    description: 'Platform open-file dialog with opaque handles and chunked reads',
    optionalPermissions: <String>{PocketFilePickerPermissions.open},
    limits: PocketPluginLimits(
      maxConcurrentRequests: 4,
      maxResponseBytes: _responseQuotaBytes,
    ),
    capabilities: _capabilities,
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(PocketFilePickerCapabilities.pickOpen, pickOpen);
    context.registerRequest(PocketFilePickerCapabilities.readChunk, readChunk);
    context.registerRequest(PocketFilePickerCapabilities.release, release);
  }

  @override
  Future<void> dispose() async => _handles.clear();

  PocketCapabilityException _invalid(String message) =>
      PocketCapabilityException('invalid_params', message);

  Future<Object?> pickOpen(Map<String, dynamic> params) async {
    final accept = params['accept'];
    final extensions = <String>[];
    if (accept != null) {
      if (accept is! List || accept.length > _maxAcceptEntries) {
        throw _invalid('accept must be an array of at most $_maxAcceptEntries extensions');
      }
      for (final entry in accept) {
        if (entry is! String || !_extension.hasMatch(entry)) {
          throw _invalid('accept entries must be bare extensions such as "png"');
        }
        extensions.add(entry.toLowerCase());
      }
    }
    final multipleParam = params['multiple'];
    if (multipleParam != null && multipleParam is! bool) {
      throw _invalid('multiple must be a boolean');
    }
    final multiple = multipleParam == true;
    if (_picking) {
      throw const PocketCapabilityException('busy', 'a file dialog is already open');
    }
    _picking = true;
    final List<XFile> chosen;
    try {
      final groups = <XTypeGroup>[
        if (extensions.isNotEmpty) XTypeGroup(label: 'files', extensions: extensions),
      ];
      chosen = multiple
          ? await openFiles(acceptedTypeGroups: groups)
          : <XFile>[
              if (await openFile(acceptedTypeGroups: groups) case final XFile file) file,
            ];
    } on PocketCapabilityException {
      rethrow;
    } on Object catch (error) {
      throw PocketCapabilityException('dialog_failed', 'file dialog failed: ${error.runtimeType}');
    } finally {
      _picking = false;
    }
    if (chosen.length > _maxFilesPerPick) {
      throw const PocketCapabilityException('too_many_files', 'too many files were chosen');
    }
    final picked = <Map<String, Object?>>[];
    final staged = <String, _Picked>{};
    for (final file in chosen) {
      final name = _displayName(file.name);
      final int size;
      try {
        size = await file.length();
      } on Object {
        throw const PocketCapabilityException('read_failed', 'the chosen file cannot be read');
      }
      if (size > maxFileBytes) {
        throw PocketCapabilityException('too_large', '$name exceeds $maxFileBytes bytes');
      }
      final handle = _newHandle(staged.keys);
      staged[handle] = _Picked(file, size);
      picked.add(<String, Object?>{
        'handle': handle,
        'name': name,
        'size': size,
        'mime': _mimeFor(name),
      });
    }
    if (picked.isNotEmpty && _handles.length + staged.length > pocketFilePickerMaxHandles) {
      throw const PocketCapabilityException(
        'too_many_handles',
        'release picked files before choosing more',
      );
    }
    _handles.addAll(staged);
    return <String, Object?>{'files': picked};
  }

  Future<Object?> readChunk(Map<String, dynamic> params) async {
    final handle = params['handle'];
    final offset = params['offset'];
    final length = params['length'];
    if (handle is! String || !_handle.hasMatch(handle)) {
      throw _invalid('handle must be a file handle');
    }
    if (offset is! int || offset < 0) throw _invalid('offset must be a non-negative integer');
    if (length is! int || length < 1) throw _invalid('length must be a positive integer');
    if (length > pocketFilePickerChunkBytes) {
      throw PocketCapabilityException('too_large', 'length exceeds $pocketFilePickerChunkBytes bytes');
    }
    final picked = _handles[handle];
    if (picked == null) {
      throw const PocketCapabilityException('handle_not_found', 'unknown or released file handle');
    }
    final size = picked.size;
    final end = min(offset + length, size);
    final bytes = BytesBuilder(copy: false);
    if (offset < size) {
      try {
        if (await picked.file.length() != size) {
          throw const PocketCapabilityException('file_changed', 'the file changed after it was chosen');
        }
        await for (final part in picked.file.openRead(offset, end)) {
          bytes.add(part);
        }
      } on PocketCapabilityException {
        rethrow;
      } on Object {
        throw const PocketCapabilityException('read_failed', 'the chosen file cannot be read');
      }
    }
    final data = bytes.takeBytes();
    if (data.length != end - (offset < size ? offset : end)) {
      throw const PocketCapabilityException('file_changed', 'the file changed after it was chosen');
    }
    return <String, Object?>{
      'handle': handle,
      'offset': offset,
      'length': data.length,
      'size': size,
      'eof': offset + data.length >= size,
      'data': base64Encode(data),
    };
  }

  Future<Object?> release(Map<String, dynamic> params) async {
    final handle = params['handle'];
    if (handle is! String || !_handle.hasMatch(handle)) {
      throw _invalid('handle must be a file handle');
    }
    return <String, Object?>{'released': _handles.remove(handle) != null};
  }

  String _newHandle(Iterable<String> taken) {
    while (true) {
      final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
      final value = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
      if (!_handles.containsKey(value) && !taken.contains(value)) return value;
    }
  }

  /// The platform file name, never a path: anything up to the last separator is dropped.
  static String _displayName(String raw) {
    var name = raw.split(RegExp(r'[\\/]')).last;
    name = name.replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), '');
    if (name.isEmpty) name = 'file';
    return name.length > 255 ? name.substring(name.length - 255) : name;
  }

  static String _mimeFor(String name) {
    final dot = name.lastIndexOf('.');
    if (dot < 0 || dot == name.length - 1) return 'application/octet-stream';
    return _mimeByExtension[name.substring(dot + 1).toLowerCase()] ?? 'application/octet-stream';
  }
}
