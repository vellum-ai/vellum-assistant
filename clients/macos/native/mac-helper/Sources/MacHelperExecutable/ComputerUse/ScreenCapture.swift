import ScreenCaptureKit
import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

enum CaptureError: LocalizedError {
    case noDisplay
    case displayNotFound
    case windowNotFound
    case conversionFailed
    case permissionDenied

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "No display found"
        case .displayNotFound: return "The display to capture is no longer connected"
        case .windowNotFound: return "The window to capture is no longer on screen"
        case .conversionFailed: return "Failed to convert screenshot to JPEG"
        case .permissionDenied: return "Screen Recording permission denied"
        }
    }
}

/// What a capture reads when the caller picked something narrower than the
/// main display: one display or one window, by the window server's own ids.
/// The daemon carries the user's pick from the companion's Teach picker here
/// unchanged, so a session scoped to one window keeps reading that window
/// while the user works in another.
enum CaptureTarget: Sendable {
    case display(CGDirectDisplayID)
    case window(CGWindowID)
}

struct ScreenCaptureMetadata: Sendable {
    let screenshotWidthPx: Int
    let screenshotHeightPx: Int
    let captureDisplayId: UInt32
}

struct ScreenCaptureResult: Sendable {
    let jpegData: Data
    let metadata: ScreenCaptureMetadata?
}

protocol ScreenCaptureProviding: Sendable {
    func captureScreen(maxWidth: Int, maxHeight: Int) async throws -> Data
    func captureScreenWithMetadata(maxWidth: Int, maxHeight: Int) async throws -> ScreenCaptureResult
    func captureScreenWithMetadata(maxWidth: Int, maxHeight: Int, target: CaptureTarget?) async throws -> ScreenCaptureResult
    func screenSize() -> CGSize
}

extension ScreenCaptureProviding {
    func captureScreen() async throws -> Data {
        try await captureScreen(maxWidth: 1280, maxHeight: 720)
    }

    func captureScreenWithMetadata(maxWidth: Int, maxHeight: Int) async throws -> ScreenCaptureResult {
        let data = try await captureScreen(maxWidth: maxWidth, maxHeight: maxHeight)
        return ScreenCaptureResult(jpegData: data, metadata: nil)
    }

    /// A provider that knows nothing of targets reads what it always reads.
    func captureScreenWithMetadata(maxWidth: Int, maxHeight: Int, target: CaptureTarget?) async throws -> ScreenCaptureResult {
        try await captureScreenWithMetadata(maxWidth: maxWidth, maxHeight: maxHeight)
    }
}

final class ScreenCapture: ScreenCaptureProviding, @unchecked Sendable {
    func captureScreen(maxWidth: Int = 1280, maxHeight: Int = 720) async throws -> Data {
        let result = try await captureScreenWithMetadata(maxWidth: maxWidth, maxHeight: maxHeight)
        return result.jpegData
    }

    func captureScreenWithMetadata(maxWidth: Int = 1280, maxHeight: Int = 720) async throws -> ScreenCaptureResult {
        try await captureScreenWithMetadata(maxWidth: maxWidth, maxHeight: maxHeight, target: nil)
    }

    func captureScreenWithMetadata(maxWidth: Int, maxHeight: Int, target: CaptureTarget?) async throws -> ScreenCaptureResult {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.current
        } catch {
            throw CaptureError.permissionDenied
        }

        let filter: SCContentFilter
        let sourceSize: CGSize
        let captureDisplayId: CGDirectDisplayID

        switch target {
        case .window(let windowID):
            // One window, wherever it is and whatever is over it. A single
            // window filter has nothing to exclude, and the helper's own
            // windows are never the pick.
            guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                throw CaptureError.windowNotFound
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            sourceSize = window.frame.size
            captureDisplayId = Self.displayHolding(window.frame)

        case .display(let displayID):
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
                throw CaptureError.displayNotFound
            }
            filter = SCContentFilter(display: display, excludingWindows: Self.ownWindows(in: content))
            sourceSize = CGSize(width: display.width, height: display.height)
            captureDisplayId = display.displayID

        case nil:
            // Match the main display (CGMainDisplayID) so screenshots align with AX tree coordinates.
            // content.displays.first is arbitrary and may return an external monitor.
            let mainDisplayID = CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == mainDisplayID })
                    ?? content.displays.first else {
                throw CaptureError.noDisplay
            }
            filter = SCContentFilter(display: display, excludingWindows: Self.ownWindows(in: content))
            sourceSize = CGSize(width: display.width, height: display.height)
            captureDisplayId = display.displayID
        }

        let config = SCStreamConfiguration()

        let sourceWidth = max(sourceSize.width, 1)
        let sourceHeight = max(sourceSize.height, 1)
        let scaleX = CGFloat(maxWidth) / sourceWidth
        let scaleY = CGFloat(maxHeight) / sourceHeight
        let scale = min(scaleX, scaleY, 1.0) // Don't upscale

        config.width = max(Int(sourceWidth * scale), 1)
        config.height = max(Int(sourceHeight * scale), 1)
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

        return ScreenCaptureResult(
            jpegData: data as Data,
            metadata: ScreenCaptureMetadata(
                screenshotWidthPx: image.width,
                screenshotHeightPx: image.height,
                captureDisplayId: captureDisplayId
            )
        )
    }

    /// Exclude this helper's and the Electron host app's windows so the
    /// screenshot shows the app behind our UI, matching the AX tree, which
    /// skips the same processes (AccessibilityTreeEnumerator.isOwnOrHostApp).
    /// Otherwise the model reasons over a screenshot of the chat window while
    /// the AX tree describes the app behind it, and clicks the wrong place.
    private static func ownWindows(in content: SCShareableContent) -> [SCWindow] {
        let myPID = ProcessInfo.processInfo.processIdentifier
        let hostPID = getppid()
        return content.windows.filter {
            guard let pid = $0.owningApplication?.processID else { return false }
            return pid == myPID || pid == hostPID
        }
    }

    /// The display holding most of `frame`, or the main display when the
    /// window server names none (a window dragged fully off screen).
    static func displayHolding(_ frame: CGRect) -> CGDirectDisplayID {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        let status = CGGetDisplaysWithRect(frame, UInt32(ids.count), &ids, &count)
        guard status == .success, count > 0 else { return CGMainDisplayID() }
        var best = ids[0]
        var bestArea: CGFloat = -1
        for id in ids.prefix(Int(count)) {
            let area = CGDisplayBounds(id).intersection(frame).size
            let covered = area.width * area.height
            if covered > bestArea {
                bestArea = covered
                best = id
            }
        }
        return best
    }

    /// Returns the main display size in logical points (same coordinate space as AX tree and CGEvent).
    /// Uses CGDisplayBounds like graphos for consistency.
    func screenSize() -> CGSize {
        let bounds = CGDisplayBounds(CGMainDisplayID())
        return bounds.size
    }
}
