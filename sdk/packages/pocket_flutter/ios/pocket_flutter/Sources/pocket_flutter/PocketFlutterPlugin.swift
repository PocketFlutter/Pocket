import Flutter

/// Standard Flutter plugin entry point for PocketView's optional native
/// display geometry bridge and C FFI symbol retention under Release archives.
public final class PocketFlutterPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    PocketNativeAbiRetainer.retainCAbiSymbols()
    PocketDisplayGeometry.shared.attach(registrar: registrar)
  }
}
