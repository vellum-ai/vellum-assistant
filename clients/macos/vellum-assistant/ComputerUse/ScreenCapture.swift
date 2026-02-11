import ScreenCaptureKit
import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

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

protocol ScreenCaptureProviding {
    func captureScreen(maxWidth: Int, maxHeight: Int) async throws -> Data
    func screenSize() -> CGSize
}

extension ScreenCaptureProviding {
    func captureScreen() async throws -> Data {
        try await captureScreen(maxWidth: 1280, maxHeight: 720)
    }
}

final class ScreenCapture: ScreenCaptureProviding {
    func captureScreen(maxWidth: Int = 1280, maxHeight: Int = 720) async throws -> Data {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.current
        } catch {
            throw CaptureError.permissionDenied
        }

        // Match the main display (CGMainDisplayID) so screenshots align with AX tree coordinates.
        // content.displays.first is arbitrary and may return an external monitor.
        let mainDisplayID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainDisplayID })
                ?? content.displays.first else {
            throw CaptureError.noDisplay
        }

        // Exclude our own app's windows so the model never sees the overlay
        let myPID = ProcessInfo.processInfo.processIdentifier
        let ownWindows = content.windows.filter { $0.owningApplication?.processID == myPID }
        let filter = SCContentFilter(display: display, excludingWindows: ownWindows)
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

        // Direct CGImage → JPEG via ImageIO (skips NSImage/TIFF intermediate)
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw CaptureError.conversionFailed
        }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.6]
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw CaptureError.conversionFailed
        }

        return data as Data
    }

    /// Returns the main display size in logical points (same coordinate space as AX tree and CGEvent).
    /// Uses CGDisplayBounds like graphos for consistency.
    func screenSize() -> CGSize {
        let bounds = CGDisplayBounds(CGMainDisplayID())
        return bounds.size
    }
}
