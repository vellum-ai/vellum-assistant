import QuickLookThumbnailing
import AppKit
import CoreGraphics

/// Quick Look thumbnail provider for .vellum bundle files.
///
/// Extracts icon.png from the ZIP-based .vellum file for the thumbnail.
/// Falls back to rendering the emoji from manifest.json, or the first
/// letter of the app name on a gradient background.
class ThumbnailProvider: QLThumbnailProvider {

    override func provideThumbnail(
        for request: QLFileThumbnailRequest,
        _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        let fileURL = request.fileURL
        let maxSize = request.maximumSize

        // Try extracting icon.png from the .vellum ZIP
        if let iconData = extractFileFromZip(at: fileURL, entryName: "icon.png"),
           let nsImage = NSImage(data: iconData) {
            let reply = QLThumbnailReply(contextSize: maxSize) { context -> Bool in
                let rect = CGRect(origin: .zero, size: maxSize)
                NSGraphicsContext.saveGraphicsState()
                let gfxContext = NSGraphicsContext(cgContext: context, flipped: false)
                NSGraphicsContext.current = gfxContext
                nsImage.draw(in: rect, from: .zero, operation: .copy, fraction: 1.0)
                NSGraphicsContext.restoreGraphicsState()
                return true
            }
            handler(reply, nil)
            return
        }

        // Try extracting manifest.json for emoji/name fallback
        var emoji: String?
        var name: String?
        if let manifestData = extractFileFromZip(at: fileURL, entryName: "manifest.json"),
           let json = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any] {
            emoji = json["icon"] as? String
            name = json["name"] as? String
        }

        let displayEmoji = emoji
        let displayName = name ?? fileURL.deletingPathExtension().lastPathComponent

        let reply = QLThumbnailReply(contextSize: maxSize) { context -> Bool in
            Self.drawFallbackThumbnail(
                context: context,
                size: maxSize,
                emoji: displayEmoji,
                name: displayName
            )
            return true
        }
        handler(reply, nil)
    }

    // MARK: - ZIP Extraction

    /// Extracts a single file entry from a ZIP archive using the `unzip` command.
    private func extractFileFromZip(at url: URL, entryName: String) -> Data? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = ["-p", url.path, entryName]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return nil
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return data.isEmpty ? nil : data
    }

    // MARK: - Fallback Rendering

    /// Draws a gradient background with centered emoji or first-letter text.
    private static func drawFallbackThumbnail(
        context: CGContext,
        size: CGSize,
        emoji: String?,
        name: String
    ) {
        let rect = CGRect(origin: .zero, size: size)

        // Generate a hash-based gradient color from the name
        let hue = Self.stableHue(for: name)
        let topColor = NSColor(hue: hue, saturation: 0.5, brightness: 0.85, alpha: 1.0)
        let bottomColor = NSColor(hue: hue, saturation: 0.6, brightness: 0.55, alpha: 1.0)

        // Draw rounded rect background with gradient
        let cornerRadius = min(size.width, size.height) * 0.18
        let path = CGPath(roundedRect: rect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
        context.addPath(path)
        context.clip()

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        if let gradient = CGGradient(
            colorsSpace: colorSpace,
            colors: [topColor.cgColor, bottomColor.cgColor] as CFArray,
            locations: [0.0, 1.0]
        ) {
            context.drawLinearGradient(
                gradient,
                start: CGPoint(x: size.width / 2, y: size.height),
                end: CGPoint(x: size.width / 2, y: 0),
                options: []
            )
        }

        // Draw centered text (emoji or first letter)
        let displayText: String
        let fontSize: CGFloat

        if let emoji = emoji, !emoji.isEmpty {
            displayText = emoji
            fontSize = size.width * 0.5
        } else {
            displayText = String(name.prefix(1)).uppercased()
            fontSize = size.width * 0.45
        }

        let font = NSFont.systemFont(ofSize: fontSize, weight: .bold)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.white, // color-literal-ok
        ]

        let attrString = NSAttributedString(string: displayText, attributes: attributes)
        let textSize = attrString.size()
        let textRect = CGRect(
            x: (size.width - textSize.width) / 2,
            y: (size.height - textSize.height) / 2,
            width: textSize.width,
            height: textSize.height
        )

        NSGraphicsContext.saveGraphicsState()
        let gfxContext = NSGraphicsContext(cgContext: context, flipped: false)
        NSGraphicsContext.current = gfxContext
        attrString.draw(in: textRect)
        NSGraphicsContext.restoreGraphicsState()
    }

    /// Produces a stable hue value (0-1) from a string using a simple hash.
    private static func stableHue(for string: String) -> CGFloat {
        var hash: UInt64 = 5381
        for char in string.utf8 {
            hash = ((hash &<< 5) &+ hash) &+ UInt64(char)
        }
        return CGFloat(hash % 360) / 360.0
    }
}
