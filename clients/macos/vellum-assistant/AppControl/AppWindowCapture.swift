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
/// `WindowBounds` is populated whenever a layer-0 window matched
/// (`state == .running`). `pngBase64` is populated only when ScreenCaptureKit
/// also succeeded; on capture failure it stays `nil` and `captureError`
/// carries the underlying reason (most commonly: Screen Recording permission
/// is not granted). Callers must not assume "running implies image" — `state`
/// describes the window, `captureError` describes the screenshot.
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

    /// Capture a single PNG of `windowID` via ScreenCaptureKit. Returns the
    /// base64 PNG on success, or a human-readable error message describing why
    /// capture failed. Empirically, missing Screen Recording permission may
    /// either *throw* (most common, observed in `ScreenCapture.swift`) or
    /// silently return an empty `SCShareableContent.windows` list on some
    /// macOS versions — we surface a permission hint in both branches so the
    /// daemon and the LLM can suggest the right fix.
    ///
    /// Two paths, gated by the `VELLUM_APP_CONTROL_USE_DISPLAY_FILTER` env
    /// var (diagnostic — default off):
    ///
    /// - **Default (warmup pattern)** — `SCContentFilter(desktopIndependentWindow:)`
    ///   with a discardable warmup capture + ~33ms gap before the real capture.
    ///   This is the historical path. Doesn't hang, but can return stale
    ///   buffered frames for GPU-rendered apps (emulators) because the
    ///   per-window filter reads the AppKit/CoreAnimation backing store.
    ///
    /// - **Display filter (env-gated)** — `SCContentFilter(display:including:)`,
    ///   one-shot. Theoretically reads via the display-composite path (fresh
    ///   GPU pixels) and lets SCK mask down to the window without coordinate
    ///   math. Empirically hangs for unknown reasons in this codebase
    ///   (#29389 one-shot + cropped sourceRect, #29445 continuous SCStream
    ///   both hung at 60s timeout). Re-enabled here behind an env var so we
    ///   can collect Console logs that pin down which call blocks.
    ///
    /// Both paths log every step with elapsed-ms timestamps under the
    /// `AppWindowCapture` category — filter Console.app for that to see the
    /// trace. Once we know where the display path hangs we can either fix
    /// it or close the door on display-filter for good.
    private static func captureWindowPNG(windowID: CGWindowID) async -> PNGCaptureResult {
        let useDisplay = ProcessInfo.processInfo.environment[USE_DISPLAY_FILTER_ENV] == "1"
        let start = Date()

        func elapsed() -> Int { Int(Date().timeIntervalSince(start) * 1000) }

        log.notice("captureWindowPNG: start (windowID=\(windowID, privacy: .public), useDisplay=\(useDisplay, privacy: .public))")

        do {
            log.notice("captureWindowPNG: requesting SCShareableContent.current (+\(elapsed())ms)")
            let shareable = try await SCShareableContent.current
            log.notice("captureWindowPNG: got SCShareableContent (+\(elapsed())ms, windows=\(shareable.windows.count, privacy: .public), displays=\(shareable.displays.count, privacy: .public))")

            guard let scWindow = shareable.windows.first(where: { $0.windowID == windowID }) else {
                let message = "ScreenCaptureKit could not find window \(windowID) — Screen Recording permission may be required (System Settings > Privacy & Security > Screen & System Audio Recording)"
                log.warning("captureWindowPNG: window not found in SCShareableContent.windows (+\(elapsed())ms)")
                return PNGCaptureResult(pngBase64: nil, error: message)
            }
            log.notice("captureWindowPNG: matched window \(windowID, privacy: .public) frame=\(NSStringFromRect(scWindow.frame), privacy: .public) (+\(elapsed())ms)")

            let filter: SCContentFilter
            if useDisplay {
                let center = CGPoint(x: scWindow.frame.midX, y: scWindow.frame.midY)
                let display = shareable.displays.first(where: { $0.frame.contains(center) })
                    ?? shareable.displays.first
                guard let display else {
                    log.warning("captureWindowPNG: no display available (+\(elapsed())ms)")
                    return PNGCaptureResult(
                        pngBase64: nil,
                        error: "No display available for capture"
                    )
                }
                log.notice("captureWindowPNG: display path — display id=\(display.displayID, privacy: .public) frame=\(NSStringFromRect(display.frame), privacy: .public) (+\(elapsed())ms)")
                filter = SCContentFilter(display: display, including: [scWindow])
                log.notice("captureWindowPNG: built display:including: filter (+\(elapsed())ms)")
            } else {
                filter = SCContentFilter(desktopIndependentWindow: scWindow)
                log.notice("captureWindowPNG: built desktopIndependentWindow filter (+\(elapsed())ms)")
            }

            let config = SCStreamConfiguration()
            config.width = max(Int(scWindow.frame.width), 1)
            config.height = max(Int(scWindow.frame.height), 1)
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = false
            log.notice("captureWindowPNG: built config \(config.width, privacy: .public)x\(config.height, privacy: .public) (+\(elapsed())ms)")

            if !useDisplay {
                // Warmup capture — discarded. Forces SCK to invalidate any
                // stale buffered frame for this window. Errors here are
                // non-fatal: if the warmup fails, the real capture below
                // will surface the error.
                log.notice("captureWindowPNG: warmup capture start (+\(elapsed())ms)")
                _ = try? await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: config
                )
                log.notice("captureWindowPNG: warmup capture done (+\(elapsed())ms)")
                try? await Task.sleep(nanoseconds: UInt64(CAPTURE_INTER_SHOT_GAP_MS) * 1_000_000)
                log.notice("captureWindowPNG: warmup gap elapsed (+\(elapsed())ms)")
            }

            log.notice("captureWindowPNG: real capture start (+\(elapsed())ms)")
            let cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
            log.notice("captureWindowPNG: real capture done \(cgImage.width, privacy: .public)x\(cgImage.height, privacy: .public) (+\(elapsed())ms)")

            guard let png = encodePNGBase64(cgImage: cgImage) else {
                log.warning("captureWindowPNG: PNG encode failed (+\(elapsed())ms)")
                return PNGCaptureResult(pngBase64: nil, error: "Failed to encode captured window as PNG")
            }
            log.notice("captureWindowPNG: PNG encoded (\(png.count, privacy: .public) base64 chars) (+\(elapsed())ms)")
            return PNGCaptureResult(pngBase64: png, error: nil)
        } catch {
            log.warning("captureWindowPNG: caught error after \(elapsed())ms: \(error.localizedDescription, privacy: .public)")
            let message = "Screen capture failed: \(error.localizedDescription) — Screen Recording permission may be required (System Settings > Privacy & Security > Screen & System Audio Recording)"
            return PNGCaptureResult(pngBase64: nil, error: message)
        }
    }

    /// Env var that opts in to the diagnostic `display:including:` filter
    /// path. Set to `"1"` before launching the macOS app to enable. Default
    /// behavior (env unset or any other value) is the historical
    /// warmup-capture pattern.
    private static let USE_DISPLAY_FILTER_ENV = "VELLUM_APP_CONTROL_USE_DISPLAY_FILTER"

    /// Gap between the warmup capture and the real capture. ~2 frames at
    /// 60fps — long enough for the SCK pipeline to advance past whatever
    /// stale frame was cached, short enough that the added observe latency
    /// is unnoticeable.
    private static let CAPTURE_INTER_SHOT_GAP_MS: Int = 33

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
