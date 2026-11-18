import 'dart:convert';
import 'dart:typed_data';

/// Pure-Dart RFC 6234 SHA-256, HMAC-SHA256, and HKDF-SHA256 matching
/// `@pocket/sync/protocol` byte-for-byte with zero external pub dependencies.
final Uint32List _sha256K = Uint32List.fromList(const <int>[
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

int _rotr32(int x, int n) => ((x & 0xffffffff) >>> n) | ((x << (32 - n)) & 0xffffffff);

Uint8List sha256Bytes(List<int> input) {
  final msgLen = input.length;
  final bitLen = msgLen * 8;
  final padLen = (((msgLen + 8) >> 6) + 1) << 6;
  final buf = Uint8List(padLen);
  buf.setRange(0, msgLen, input);
  buf[msgLen] = 0x80;
  final view = ByteData.sublistView(buf);
  view.setUint32(padLen - 8, (bitLen ~/ 0x100000000) & 0xffffffff, Endian.big);
  view.setUint32(padLen - 4, bitLen & 0xffffffff, Endian.big);

  var h0 = 0x6a09e667;
  var h1 = 0xbb67ae85;
  var h2 = 0x3c6ef372;
  var h3 = 0xa54ff53a;
  var h4 = 0x510e527f;
  var h5 = 0x9b05688c;
  var h6 = 0x1f83d9ab;
  var h7 = 0x5be0cd19;

  final w = Uint32List(64);
  for (var offset = 0; offset < padLen; offset += 64) {
    for (var i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, Endian.big);
    }
    for (var i = 16; i < 64; i++) {
      final w15 = w[i - 15];
      final w2 = w[i - 2];
      final s0 = _rotr32(w15, 7) ^ _rotr32(w15, 18) ^ (w15 >>> 3);
      final s1 = _rotr32(w2, 17) ^ _rotr32(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xffffffff;
    }

    var a = h0;
    var b = h1;
    var c = h2;
    var d = h3;
    var e = h4;
    var f = h5;
    var g = h6;
    var h = h7;

    for (var i = 0; i < 64; i++) {
      final bigS1 = _rotr32(e, 6) ^ _rotr32(e, 11) ^ _rotr32(e, 25);
      final ch = (e & f) ^ ((~e & 0xffffffff) & g);
      final temp1 = (h + bigS1 + ch + _sha256K[i] + w[i]) & 0xffffffff;
      final bigS0 = _rotr32(a, 2) ^ _rotr32(a, 13) ^ _rotr32(a, 22);
      final maj = (a & b) ^ (a & c) ^ (b & c);
      final temp2 = (bigS0 + maj) & 0xffffffff;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) & 0xffffffff;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & 0xffffffff;
    }

    h0 = (h0 + a) & 0xffffffff;
    h1 = (h1 + b) & 0xffffffff;
    h2 = (h2 + c) & 0xffffffff;
    h3 = (h3 + d) & 0xffffffff;
    h4 = (h4 + e) & 0xffffffff;
    h5 = (h5 + f) & 0xffffffff;
    h6 = (h6 + g) & 0xffffffff;
    h7 = (h7 + h) & 0xffffffff;
  }

  final out = Uint8List(32);
  final outView = ByteData.sublistView(out);
  outView.setUint32(0, h0, Endian.big);
  outView.setUint32(4, h1, Endian.big);
  outView.setUint32(8, h2, Endian.big);
  outView.setUint32(12, h3, Endian.big);
  outView.setUint32(16, h4, Endian.big);
  outView.setUint32(20, h5, Endian.big);
  outView.setUint32(24, h6, Endian.big);
  outView.setUint32(28, h7, Endian.big);
  return out;
}

String bytesToHex(List<int> bytes) {
  final sb = StringBuffer();
  for (final b in bytes) {
    sb.write(b.toRadixString(16).padLeft(2, '0'));
  }
  return sb.toString();
}

String sha256HexFromBytes(List<int> bytes) => bytesToHex(sha256Bytes(bytes));
String sha256HexFromString(String text) => sha256HexFromBytes(utf8.encode(text));

Uint8List hmacSha256Bytes(List<int> key, List<int> message) {
  final effectiveKey = key.length > 64 ? sha256Bytes(key) : key;
  final oPad = Uint8List(64);
  final iPad = Uint8List(64);
  for (var i = 0; i < 64; i++) {
    final kb = i < effectiveKey.length ? effectiveKey[i] : 0;
    oPad[i] = kb ^ 0x5c;
    iPad[i] = kb ^ 0x36;
  }
  final inner = Uint8List(64 + message.length);
  inner.setRange(0, 64, iPad);
  inner.setRange(64, 64 + message.length, message);
  final innerDigest = sha256Bytes(inner);

  final outer = Uint8List(64 + 32);
  outer.setRange(0, 64, oPad);
  outer.setRange(64, 96, innerDigest);
  return sha256Bytes(outer);
}

String deriveRoomAuthKeyHex(String roomSecret, String namespace) {
  final prk = hmacSha256Bytes(
    utf8.encode('pocket-sync-salt:$namespace'),
    utf8.encode(roomSecret),
  );
  final info = utf8.encode('pocket-sync-auth-v1|$namespace\x01');
  return bytesToHex(hmacSha256Bytes(prk, info));
}

bool timingSafeEqualString(String a, String b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
  }
  return diff == 0;
}

String signArchiveReceiptHmac({
  required String roomSecret,
  required String namespace,
  required String blobSha256,
  required int byteLength,
  required String serverInstanceId,
  required String serverNodeId,
  required String storageDurability,
  required bool permanentArchiveSafe,
  required int issuedAtMs,
}) {
  final keyHex = deriveRoomAuthKeyHex(roomSecret, namespace);
  final canonical =
      'receipt-v1|$namespace|$blobSha256|$byteLength|$serverInstanceId|$serverNodeId|$storageDurability|${permanentArchiveSafe ? 1 : 0}|$issuedAtMs';
  return bytesToHex(
    hmacSha256Bytes(utf8.encode(keyHex), utf8.encode(canonical)),
  );
}
