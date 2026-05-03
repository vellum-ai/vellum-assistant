#if os(macOS)
import AppKit
import CoreGraphics
import ScreenCaptureKit
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
/// `WindowBounds` is populated whenever a layer-0 window matched
/// (`state == .running`). `pngBase64` is populated only when ScreenCaptureKit
/// also succeeded; on capture failure it stays `nil` and `captureError`
/// carries the underlying reason (most commonly: Screen Recording permission
/// is not granted). Callers must not assume "running implies image" — `state`
/// describes the window, `captureError` describes the screenshot.
///
/// Window filtering uses `CGWindowListCopyWindowInfo` (which remains available in
/// macOS 15) to identify on-screen layer-0 windows owned by the target PID.
/// Pixel capture is delegated to `AppWindowStreamer`, which maintains a
/// long-running `SCStream` per window — the one-shot `SCScreenshotManager
/// .captureImage` path returns stale frames for GPU-rendered apps regardless
/// of timing or warmup tricks.
enum AppWindowCapture {

    struct CaptureResult: Equatable {
        let state: HostAppControlState
        let pngBase64: String?
        let bounds: WindowBounds?
        /// Set when ScreenCaptureKit failed even though the window exists. Most
        /// commonly indicates missing Screen Recording permission. The window
        /// `state` remains correctly classified (`.running`/`.minimized`/
        /// `.missing`); this field is an orthogonal signal that *capture* failed.
        let captureError: String?
    }

    /// Inner result for the ScreenCaptureKit path. Distinguishes "no PNG, here's
    /// why" from "no PNG, no error" so callers can surface the failure reason
    /// without conflating it with the window-state classification.
    private struct PNGCaptureResult {
        let pngBase64: String?
        let error: String?
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
                bounds: nil,
                captureError: nil
            )
        }

        let bounds = parseBounds(entry[kCGWindowBounds])
        let png = await captureWindowPNG(windowID: windowNumber)
        return CaptureResult(
            state: .running,
            pngBase64: png.pngBase64,
            bounds: bounds,
            captureError: png.error
        )
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

    /// Capture a single PNG of `windowID` by pulling the latest frame from
    /// the long-running `AppWindowStreamer` (which maintains a continuous
    /// `SCStream` per window). On the first call for a window the streamer
    /// starts the stream and waits for the first frame (~200-500ms);
    /// subsequent calls return the buffered latest frame in ~5-15ms.
    ///
    /// Stream-based capture is necessary because the one-shot
    /// `SCScreenshotManager.captureImage` path with `desktopIndependentWindow`
    /// returns stale frames for apps that render via Metal/OpenGL/CAMetalLayer
    /// (emulators, OpenGL canvases, custom Electron). The streamer uses
    /// `SCContentFilter(display:including:)` instead, which routes through
    /// the display-composite path and sees fresh GPU pixels.
    private static func captureWindowPNG(windowID: CGWindowID) async -> PNGCaptureResult {
        switch await AppWindowStreamer.shared.latestFrame(forWindow: windowID) {
        case .success(let png):
            return PNGCaptureResult(pngBase64: png, error: nil)
        case .failure(let message):
            log.warning("AppWindowCapture: \(message, privacy: .public)")
            return PNGCaptureResult(pngBase64: nil, error: message)
        }
    }
}
#endif
