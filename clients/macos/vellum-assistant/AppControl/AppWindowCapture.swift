#if os(macOS)
import AppKit
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppWindowCapture")

/// Captures the frontmost normal window of a target process by PID.
///
/// Returns a `CaptureResult` whose `state` distinguishes:
///   - `.running`   — the process is alive and an on-screen normal window was captured.
///   - `.minimized` — the process is alive but no normal layer-0 window is on-screen
///                    (e.g. minimized to Dock or app is hidden).
///   - `.missing`   — no running NSRunningApplication has the requested PID.
///
/// PNG bytes (base64) and `WindowBounds` are populated when a normal window was
/// found and ScreenCaptureKit was able to capture it (`state == .running`).
///
/// Window filtering uses `CGWindowListCopyWindowInfo` (which remains available in
/// macOS 15) to identify on-screen layer-0 windows owned by the target PID. The
/// actual pixel capture goes through `SCScreenshotManager` because
/// `CGWindowListCreateImage` is unavailable in macOS 15.
enum AppWindowCapture {

    struct CaptureResult: Equatable {
        let state: HostAppControlState
        let pngBase64: String?
        let bounds: WindowBounds?
    }

    /// Capture the frontmost normal window owned by `pid`. See type docs for state semantics.
    static func capture(forPid pid: pid_t) async -> CaptureResult {
        let infoList = (CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[CFString: Any]]) ?? []

        let match = infoList.first { entry in
            guard let ownerPID = entry[kCGWindowOwnerPID] as? pid_t,
                  ownerPID == pid else { return false }
            // Layer 0 is the normal application-window layer; menu bar / dock / overlays sit
            // on positive layers we explicitly want to skip.
            guard let layer = entry[kCGWindowLayer] as? Int, layer == 0 else { return false }
            return true
        }

        guard let entry = match,
              let windowNumber = entry[kCGWindowNumber] as? CGWindowID else {
            // Distinguish a missing process from a running-but-minimized one.
            let processIsAlive = NSWorkspace.shared.runningApplications
                .contains(where: { $0.processIdentifier == pid })
            return CaptureResult(
                state: processIsAlive ? .minimized : .missing,
                pngBase64: nil,
                bounds: nil
            )
        }

        let bounds = parseBounds(entry[kCGWindowBounds])
        let pngBase64 = await captureWindowPNG(windowID: windowNumber)
        return CaptureResult(state: .running, pngBase64: pngBase64, bounds: bounds)
    }

    // MARK: - Private helpers

    private static func parseBounds(_ value: Any?) -> WindowBounds? {
        // kCGWindowBounds is a CFDictionary representation of a CGRect. Cast through
        // CFDictionary explicitly — `Any as CFDictionary` requires forced conversion.
        guard let value, CFGetTypeID(value as CFTypeRef) == CFDictionaryGetTypeID() else {
            return nil
        }
        let cfDict = value as! CFDictionary
        guard let rect = CGRect(dictionaryRepresentation: cfDict) else { return nil }
        return WindowBounds(
            x: Double(rect.origin.x),
            y: Double(rect.origin.y),
            width: Double(rect.size.width),
            height: Double(rect.size.height)
        )
    }

    private static func captureWindowPNG(windowID: CGWindowID) async -> String? {
        do {
            let shareable = try await SCShareableContent.current
            guard let scWindow = shareable.windows.first(where: { $0.windowID == windowID }) else {
                log.warning("AppWindowCapture: SCShareableContent missing windowID \(windowID)")
                return nil
            }

            let filter = SCContentFilter(desktopIndependentWindow: scWindow)
            let config = SCStreamConfiguration()
            config.width = max(Int(scWindow.frame.width), 1)
            config.height = max(Int(scWindow.frame.height), 1)
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = false

            let cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
            return encodePNGBase64(cgImage: cgImage)
        } catch {
            log.warning("AppWindowCapture: ScreenCaptureKit capture failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private static func encodePNGBase64(cgImage: CGImage) -> String? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data as CFMutableData,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            log.warning("AppWindowCapture: CGImageDestinationCreateWithData returned nil")
            return nil
        }
        CGImageDestinationAddImage(destination, cgImage, nil)
        guard CGImageDestinationFinalize(destination) else {
            log.warning("AppWindowCapture: CGImageDestinationFinalize failed")
            return nil
        }
        return (data as Data).base64EncodedString()
    }
}
#endif
