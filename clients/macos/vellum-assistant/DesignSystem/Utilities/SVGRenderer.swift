import AppKit
import SwiftUI

enum SVGRenderer {
    private static var cache: [String: NSImage] = [:]

    static func render(svgString: String, id: String, size: CGFloat = 16) -> NSImage? {
        if let cached = cache[id] {
            return cached
        }

        guard let data = svgString.data(using: .utf8) else { return nil }

        guard let svgImage = NSImage(data: data) else { return nil }

        let targetSize = NSSize(width: size, height: size)
        let rendered = NSImage(size: targetSize)
        rendered.lockFocus()
        svgImage.draw(in: NSRect(origin: .zero, size: targetSize),
                      from: NSRect(origin: .zero, size: svgImage.size),
                      operation: .copy,
                      fraction: 1.0)
        rendered.unlockFocus()

        cache[id] = rendered
        return rendered
    }

    static func clearCache() {
        cache.removeAll()
    }

    static func swiftUIImage(svgString: String, id: String, size: CGFloat = 16) -> Image? {
        guard let nsImage = render(svgString: svgString, id: id, size: size) else { return nil }
        return Image(nsImage: nsImage)
    }
}
