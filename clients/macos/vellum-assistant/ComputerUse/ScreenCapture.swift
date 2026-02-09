import ScreenCaptureKit
import AppKit
import CoreGraphics

enum CaptureError: LocalizedError {
    case noDisplay
    case conversionFailed
    case permissionDenied

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "No display found"
        case .conversionFailed: return "Failed to convert screenshot to JPEG"
        case .permissionDenied: return "Screen Recording permission denied"
        }
    }
}

final class ScreenCapture {
    func captureScreen(maxWidth: Int = 1920, maxHeight: Int = 1080) async throws -> Data {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.current
        } catch {
            throw CaptureError.permissionDenied
        }

        guard let display = content.displays.first else {
            throw CaptureError.noDisplay
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()

        let displayWidth = CGFloat(display.width)
        let displayHeight = CGFloat(display.height)
        let scaleX = CGFloat(maxWidth) / displayWidth
        let scaleY = CGFloat(maxHeight) / displayHeight
        let scale = min(scaleX, scaleY, 1.0) // Don't upscale

        config.width = Int(displayWidth * scale)
        config.height = Int(displayHeight * scale)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true

        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)

        let nsImage = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
        guard let tiffData = nsImage.tiffRepresentation,
              let bitmapRep = NSBitmapImageRep(data: tiffData),
              let jpegData = bitmapRep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
            throw CaptureError.conversionFailed
        }

        return jpegData
    }

    /// Returns the main display size in logical points (same coordinate space as AX tree and CGEvent).
    /// Uses CGDisplayBounds like graphos for consistency.
    func screenSize() -> CGSize {
        let bounds = CGDisplayBounds(CGMainDisplayID())
        return bounds.size
    }
}
