import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:pocket_services/pocket_services.dart';

/// Largest edge of a decoded preview. The IMG entry (8-byte header plus the
/// power-of-two RGBA envelope) must stay below the 256 KiB plugin response
/// quota, so the envelope is at most 128 x 128 (65,544 bytes).
const int pocketStudioPreviewMaxEdge = 128;

/// Source images above this many pixels are refused instead of decoded.
const int pocketStudioPreviewMaxSourcePixels = 100 * 1000 * 1000;

/// Extensions the Flutter codecs decode. SVG is deliberately absent.
const Set<String> pocketStudioDecodableImageExtensions = <String>{'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'};

/// A decoded thumbnail as a ready-to-upload IMG entry (same layout the host's
/// `platform.images.read` produces): little-endian u16 width and height of the
/// power-of-two texture envelope, PSM_8888 (3), linear filter flag (2), a
/// reserved u16 and straight RGBA rows. Source pixels are top-left aligned, the
/// remainder of the envelope is transparent.
final class StudioImagePreview {
  const StudioImagePreview({
    required this.width,
    required this.height,
    required this.textureWidth,
    required this.textureHeight,
    required this.sourceWidth,
    required this.sourceHeight,
    required this.img,
  });
  final int width;
  final int height;
  final int textureWidth;
  final int textureHeight;
  final int sourceWidth;
  final int sourceHeight;
  final Uint8List img;

  Map<String, Object?> toResult(Map<String, Object?> identity) => <String, Object?>{
    ...identity,
    'width': width,
    'height': height,
    'textureWidth': textureWidth,
    'textureHeight': textureHeight,
    'sourceWidth': sourceWidth,
    'sourceHeight': sourceHeight,
    'img': img,
  };
}

int _nextPowerOfTwo(int value) {
  var result = 1;
  while (result < value) {
    result *= 2;
  }
  return result;
}

/// Decodes [bytes] with Flutter's image codecs (PNG, JPEG, GIF first frame, WebP, BMP) and scales the
/// result down so its longest edge is at most [maxEdge] (a power of two). Anything the codecs cannot
/// decode fails with `decode_failed`; nothing is substituted.
Future<StudioImagePreview> decodeStudioImagePreview(Uint8List bytes, {int maxEdge = pocketStudioPreviewMaxEdge}) async {
  if (bytes.isEmpty) throw const PocketCapabilityException('decode_failed', 'the image is empty');
  ui.ImmutableBuffer? buffer;
  ui.ImageDescriptor? descriptor;
  ui.Codec? codec;
  ui.Image? image;
  try {
    buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    descriptor = await ui.ImageDescriptor.encoded(buffer);
    final sourceWidth = descriptor.width;
    final sourceHeight = descriptor.height;
    if (sourceWidth < 1 || sourceHeight < 1) {
      throw const PocketCapabilityException('decode_failed', 'the image has no pixels');
    }
    if (sourceWidth * sourceHeight > pocketStudioPreviewMaxSourcePixels) {
      throw const PocketCapabilityException('too_large', 'the image has too many pixels to preview');
    }
    final longest = sourceWidth > sourceHeight ? sourceWidth : sourceHeight;
    final scale = longest > maxEdge ? maxEdge / longest : 1.0;
    final width = (sourceWidth * scale).round().clamp(1, maxEdge);
    final height = (sourceHeight * scale).round().clamp(1, maxEdge);
    codec = await descriptor.instantiateCodec(targetWidth: width, targetHeight: height);
    image = (await codec.getNextFrame()).image;
    final data = await image.toByteData(format: ui.ImageByteFormat.rawStraightRgba);
    if (data == null || data.lengthInBytes != image.width * image.height * 4) {
      throw const PocketCapabilityException('decode_failed', 'Flutter did not return a complete RGBA image');
    }
    final decodedWidth = image.width;
    final decodedHeight = image.height;
    final textureWidth = _nextPowerOfTwo(decodedWidth);
    final textureHeight = _nextPowerOfTwo(decodedHeight);
    if (textureWidth > maxEdge || textureHeight > maxEdge) {
      throw const PocketCapabilityException('decode_failed', 'the decoded image does not fit the preview envelope');
    }
    final rgba = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    final entry = Uint8List(8 + textureWidth * textureHeight * 4);
    final header = ByteData.sublistView(entry);
    header.setUint16(0, textureWidth, Endian.little);
    header.setUint16(2, textureHeight, Endian.little);
    entry[4] = 3; // PSM_8888
    entry[5] = 2; // IMG_FLAG_LINEAR
    for (var row = 0; row < decodedHeight; row++) {
      final from = row * decodedWidth * 4;
      final to = 8 + row * textureWidth * 4;
      entry.setRange(to, to + decodedWidth * 4, rgba, from);
    }
    return StudioImagePreview(
      width: decodedWidth,
      height: decodedHeight,
      textureWidth: textureWidth,
      textureHeight: textureHeight,
      sourceWidth: sourceWidth,
      sourceHeight: sourceHeight,
      img: entry,
    );
  } on PocketCapabilityException {
    rethrow;
  } on Object {
    throw const PocketCapabilityException('decode_failed', 'the image could not be decoded');
  } finally {
    image?.dispose();
    codec?.dispose();
    descriptor?.dispose();
    buffer?.dispose();
  }
}
