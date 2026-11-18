/// Optional embedded HTTP/WebSocket sync server and multi-endpoint cross-subnet
/// client capability provider for PocketJS hosts.
///
/// Runs all inbound HTTP/WebSocket serving, network interface enumeration
/// (LAN RFC1918 + Tailscale/WireGuard CGNAT `100.64.0.0/10`), HKDF-HMAC replay
/// verification, chunked blob storage, and outbound cross-subnet requests inside
/// an isolated Dart IO Worker so UI frames remain 100% non-blocking.
library;

export 'src/sync_plugin.dart';
