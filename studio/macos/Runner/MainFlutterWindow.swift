import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    self.contentViewController = flutterViewController

    self.appearance = NSAppearance(named: .darkAqua)
    self.backgroundColor = NSColor(
      srgbRed: 9.0 / 255.0,
      green: 11.0 / 255.0,
      blue: 15.0 / 255.0,
      alpha: 1.0
    )
    self.minSize = NSSize(width: 960, height: 640)

    if let visible = (self.screen ?? NSScreen.main)?.visibleFrame {
      let targetWidth = min(1440.0, max(960.0, visible.width - 48.0))
      let targetHeight = min(900.0, max(640.0, visible.height - 48.0))
      let originX = visible.origin.x + floor((visible.width - targetWidth) / 2.0)
      let originY = visible.origin.y + floor((visible.height - targetHeight) / 2.0)
      self.setFrame(
        NSRect(x: originX, y: originY, width: targetWidth, height: targetHeight),
        display: true
      )
    } else {
      self.setFrame(NSRect(x: 120, y: 80, width: 1440, height: 900), display: true)
    }

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
