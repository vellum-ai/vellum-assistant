import AppKit
import XCTest
@testable import VellumAssistantLib

final class AvatarIconRenderingTests: XCTestCase {
    func testSquircleIconPointSize() {
        let source = Self.solidColorImage(size: 200, color: .red)
        let icon = AvatarAppearanceManager.squircleIcon(source, size: 128)
        XCTAssertEqual(icon.size.width, 128)
        XCTAssertEqual(icon.size.height, 128)
    }

    func testNotificationPNGExportsAt2xPixels() {
        let size: CGFloat = 256
        let source = Self.solidColorImage(size: 300, color: .blue)
        let icon = AvatarAppearanceManager.squircleIcon(source, size: size)

        let px = Int(size) * 2
        let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        )!
        bitmap.size = NSSize(width: size, height: size)

        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        icon.draw(in: NSRect(origin: .zero, size: NSSize(width: size, height: size)),
                  from: .zero, operation: .copy, fraction: 1.0)

        XCTAssertEqual(bitmap.pixelsWide, 512)
        XCTAssertEqual(bitmap.pixelsHigh, 512)

        // Corner pixel should be transparent (squircle clips corners)
        let cornerColor = bitmap.colorAt(x: 0, y: 0)
        XCTAssertEqual(cornerColor?.alphaComponent ?? 1.0, 0.0, accuracy: 0.01)

        // Center pixel should be opaque (inside the squircle)
        let centerColor = bitmap.colorAt(x: px / 2, y: px / 2)
        XCTAssertEqual(centerColor?.alphaComponent ?? 0.0, 1.0, accuracy: 0.01)
    }

    // MARK: - Helpers

    /// Creates an NSImage filled with a solid color so pixel assertions are meaningful.
    private static func solidColorImage(size: CGFloat, color: NSColor) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            color.setFill()
            rect.fill()
            return true
        }
    }
}
