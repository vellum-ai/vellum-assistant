#if os(macOS)
import AppKit
import CoreGraphics
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppControlExecutor")

/// Dispatches a `HostAppControlRequest` to the appropriate per-process input
/// helper (`AppKeyboard`, `AppMouse`, `AppWindowCapture`) and returns a
/// `HostAppControlResultPayload` for the daemon.
///
/// All catch-paths surface as a result payload tagged with the originating
/// `requestId` so the daemon can correlate failures with the request that
/// produced them.
enum AppControlExecutor {

    /// Execute `request` and produce a wire result. Never throws — every
    /// failure is reported as a result payload with `executionError` set.
    static func perform(_ request: HostAppControlRequest) async -> HostAppControlResultPayload {
        switch request.input {
        case .start(let app, let args):
            return await performStart(requestId: request.requestId, app: app, args: args)
        case .observe(let app):
            return await performObserve(requestId: request.requestId, app: app)
        case .press(let app, let key, let modifiers, let durationMs):
            return await performPress(
                requestId: request.requestId,
                app: app,
                key: key,
                modifiers: modifiers ?? [],
                durationMs: durationMs ?? 50
            )
        case .combo(let app, let keys, let durationMs):
            return await performCombo(
                requestId: request.requestId,
                app: app,
                keys: keys,
                durationMs: durationMs ?? 50
            )
        case .type(let app, let text):
            return await performType(requestId: request.requestId, app: app, text: text)
        case .click(let app, let x, let y, let button, let double):
            return await performClick(
                requestId: request.requestId,
                app: app,
                x: x,
                y: y,
                button: button,
                double: double ?? false
            )
        case .drag(let app, let fromX, let fromY, let toX, let toY, let button):
            return await performDrag(
                requestId: request.requestId,
                app: app,
                fromX: fromX,
                fromY: fromY,
                toX: toX,
                toY: toY,
                button: button
            )
        case .stop:
            return performStop(requestId: request.requestId)
        }
    }

    // MARK: - start

    private static func performStart(
        requestId: String,
        app: String,
        args: [String]?
    ) async -> HostAppControlResultPayload {
        if let resolved = resolvePid(forApp: app) {
            // Already running — capture and return.
            let capture = await AppWindowCapture.capture(forPid: resolved.pid)
            return HostAppControlResultPayload(
                requestId: requestId,
                state: capture.state,
                pngBase64: capture.pngBase64,
                windowBounds: capture.bounds,
                executionResult: "started: \(resolved.name) (already running, pid=\(resolved.pid))",
                executionError: nil
            )
        }

        // Not running — try to launch.
        guard let appURL = locateApplicationURL(for: app) else {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .missing,
                executionError: "App not found: \(app)"
            )
        }

        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        if let args, !args.isEmpty {
            config.arguments = args
        }

        do {
            let runningApp = try await NSWorkspace.shared.openApplication(
                at: appURL,
                configuration: config
            )
            let pid = runningApp.processIdentifier
            let displayName = runningApp.localizedName ?? runningApp.bundleIdentifier ?? app
            let capture = await AppWindowCapture.capture(forPid: pid)
            return HostAppControlResultPayload(
                requestId: requestId,
                state: capture.state,
                pngBase64: capture.pngBase64,
                windowBounds: capture.bounds,
                executionResult: "started: \(displayName) (launched, pid=\(pid))",
                executionError: nil
            )
        } catch {
            log.warning("AppControlExecutor: openApplication failed for \(app, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .missing,
                executionError: "Failed to launch \(app): \(error.localizedDescription)"
            )
        }
    }

    // MARK: - observe

    private static func performObserve(
        requestId: String,
        app: String
    ) async -> HostAppControlResultPayload {
        guard let resolved = resolvePid(forApp: app) else {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .missing,
                executionError: "App not running: \(app)"
            )
        }
        let capture = await AppWindowCapture.capture(forPid: resolved.pid)
        return HostAppControlResultPayload(
            requestId: requestId,
            state: capture.state,
            pngBase64: capture.pngBase64,
            windowBounds: capture.bounds,
            executionResult: "observed: \(resolved.name) (pid=\(resolved.pid))",
            // Surface ScreenCaptureKit failures (commonly missing Screen
            // Recording permission) so the daemon/LLM doesn't see a "successful"
            // observe with no image and no signal to the user.
            executionError: capture.captureError
        )
    }

    // MARK: - press

    private static func performPress(
        requestId: String,
        app: String,
        key: String,
        modifiers: [String],
        durationMs: Int
    ) async -> HostAppControlResultPayload {
        guard let resolved = resolvePid(forApp: app) else {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .missing,
                executionError: "App not running: \(app)"
            )
        }

        do {
            try await AppKeyboard.press(
                pid: resolved.pid,
                key: key,
                modifiers: modifiers,
                durationMs: durationMs
            )
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .running,
                executionResult: "pressed \(key) (pid=\(resolved.pid))",
                executionError: nil
            )
        } catch {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .running,
                executionError: error.localizedDescription
            )
        }
    }

    // MARK: - combo

    private static func performCombo(
        requestId: String,
        app: String,
        keys: [String],
        durationMs: Int
    ) async -> HostAppControlResultPayload {
        guard let resolved = resolvePid(forApp: app) else {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .missing,
                executionError: "App not running: \(app)"
            )
        }

        do {
            try await AppKeyboard.combo(
                pid: resolved.pid,
                keys: keys,
                durationMs: durationMs
            )
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .running,
                executionResult: "combo \(keys.joined(separator: "+")) (pid=\(resolved.pid))",
                executionError: nil
            )
        } catch {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .running,
                executionError: error.localizedDescription
            )
        }
    }

    // MARK: - type

    private static func performType(
        requestId: String,
        app: String,
        text: String
    ) async -> HostAppControlResultPayload {
        guard let resolved = resolvePid(forApp: app) else {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .missing,
                executionError: "App not running: \(app)"
            )
        }

        do {
            try await AppKeyboard.type(pid: resolved.pid, text: text)
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .running,
                executionResult: "typed \(text.count) char(s) (pid=\(resolved.pid))",
                executionError: nil
            )
        } catch {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .running,
                executionError: error.localizedDescription
            )
        }
    }

    // MARK: - click

    private static func performClick(
        requestId: String,
        app: String,
        x: Double,
        y: Double,
        button: String?,
        double: Bool
    ) async -> HostAppControlResultPayload {
        guard let resolved = resolvePid(forApp: app) else {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .missing,
                executionError: "App not running: \(app)"
            )
        }

        let capture = await AppWindowCapture.capture(forPid: resolved.pid)
        guard capture.state == .running, let bounds = capture.bounds else {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: capture.state,
                pngBase64: capture.pngBase64,
                windowBounds: capture.bounds,
                executionError: boundsMissingExecutionError(capture)
            )
        }

        // Bounds came through, so a missing PNG is non-fatal: the click can
        // proceed without a screenshot. Ignore `capture.captureError` here.
        do {
            try AppMouse.click(
                pid: resolved.pid,
                windowBounds: bounds,
                x: x,
                y: y,
                button: parseButton(button),
                double: double
            )
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .running,
                pngBase64: capture.pngBase64,
                windowBounds: bounds,
                executionResult: "clicked at (\(x), \(y)) (pid=\(resolved.pid))",
                executionError: nil
            )
        } catch {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .running,
                pngBase64: capture.pngBase64,
                windowBounds: bounds,
                executionError: error.localizedDescription
            )
        }
    }

    // MARK: - drag

    private static func performDrag(
        requestId: String,
        app: String,
        fromX: Double,
        fromY: Double,
        toX: Double,
        toY: Double,
        button: String?
    ) async -> HostAppControlResultPayload {
        guard let resolved = resolvePid(forApp: app) else {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .missing,
                executionError: "App not running: \(app)"
            )
        }

        let capture = await AppWindowCapture.capture(forPid: resolved.pid)
        guard capture.state == .running, let bounds = capture.bounds else {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: capture.state,
                pngBase64: capture.pngBase64,
                windowBounds: capture.bounds,
                executionError: boundsMissingExecutionError(capture)
            )
        }

        // Bounds came through, so a missing PNG is non-fatal: the drag can
        // proceed without a screenshot. Ignore `capture.captureError` here.
        do {
            try AppMouse.drag(
                pid: resolved.pid,
                windowBounds: bounds,
                fromX: fromX,
                fromY: fromY,
                toX: toX,
                toY: toY,
                button: parseButton(button)
            )
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .running,
                pngBase64: capture.pngBase64,
                windowBounds: bounds,
                executionResult: "dragged (\(fromX), \(fromY)) -> (\(toX), \(toY)) (pid=\(resolved.pid))",
                executionError: nil
            )
        } catch {
            return HostAppControlResultPayload(
                requestId: requestId,
                state: .running,
                pngBase64: capture.pngBase64,
                windowBounds: bounds,
                executionError: error.localizedDescription
            )
        }
    }

    // MARK: - stop

    /// `stop` does NOT terminate the target app — it just acknowledges the
    /// session-end signal so the daemon can finalize bookkeeping.
    private static func performStop(requestId: String) -> HostAppControlResultPayload {
        return HostAppControlResultPayload(
            requestId: requestId,
            state: .running,
            executionResult: "session stopped",
            executionError: nil
        )
    }

    // MARK: - capture error mapping

    /// Pick an `executionError` value for the bounds-missing branch of click
    /// and drag. Bounds are required by those tools to translate the
    /// caller-supplied coordinates into screen space — so when bounds are
    /// missing we always return a non-nil error.
    ///
    /// We prefer `capture.captureError` when present (it tells the user *why*
    /// we couldn't get bounds — commonly missing Screen Recording permission)
    /// over a bare state-classification message. Marked `internal` for unit
    /// testing; not part of the public executor surface.
    static func boundsMissingExecutionError(_ capture: AppWindowCapture.CaptureResult) -> String {
        return capture.captureError
            ?? "Window not visible (state=\(capture.state.rawValue))"
    }

    // MARK: - PID resolution

    /// Resolves a user-supplied app identifier to a running PID and a display
    /// name. Tries bundle-ID match first (preferred), then falls back to a
    /// case-insensitive localized-name match across all running apps.
    ///
    /// When multiple processes match the bundle ID or localized name, the
    /// first match is returned and the count is encoded into the display name
    /// so callers can surface it in `executionResult`.
    private static func resolvePid(forApp app: String) -> (pid: pid_t, name: String)? {
        // Bundle ID (preferred).
        let bundleMatches = NSRunningApplication.runningApplications(withBundleIdentifier: app)
        if let first = bundleMatches.first {
            let pid = first.processIdentifier
            let name = displayName(for: first, fallback: app)
            if bundleMatches.count > 1 {
                return (pid, "\(name) [\(bundleMatches.count) matches]")
            }
            return (pid, name)
        }

        // Localized name (case-insensitive).
        let lowered = app.lowercased()
        let nameMatches = NSWorkspace.shared.runningApplications.filter { running in
            (running.localizedName?.lowercased() == lowered)
        }
        if let first = nameMatches.first {
            let pid = first.processIdentifier
            let name = displayName(for: first, fallback: app)
            if nameMatches.count > 1 {
                return (pid, "\(name) [\(nameMatches.count) matches]")
            }
            return (pid, name)
        }

        return nil
    }

    private static func displayName(for app: NSRunningApplication, fallback: String) -> String {
        return app.localizedName ?? app.bundleIdentifier ?? fallback
    }

    /// Try to find an installed `.app` URL for `app`, treating `app` first as a
    /// bundle identifier and falling back to a localized name lookup that
    /// scans common install directories.
    private static func locateApplicationURL(for app: String) -> URL? {
        if let bundleURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: app) {
            return bundleURL
        }

        // Fall back to scanning common application directories by name.
        let searchDirs = [
            "/Applications",
            "/System/Applications",
            "/System/Applications/Utilities",
            NSString("~/Applications").expandingTildeInPath,
        ]
        let nameWithSuffix = app.hasSuffix(".app") ? app : "\(app).app"
        let lowerName = nameWithSuffix.lowercased()

        for dir in searchDirs {
            let direct = "\(dir)/\(nameWithSuffix)"
            if FileManager.default.fileExists(atPath: direct) {
                return URL(fileURLWithPath: direct)
            }
            // Case-insensitive match within the directory.
            if let entries = try? FileManager.default.contentsOfDirectory(atPath: dir),
               let match = entries.first(where: { $0.lowercased() == lowerName }) {
                return URL(fileURLWithPath: "\(dir)/\(match)")
            }
        }
        return nil
    }

    /// Convert a daemon-supplied button string to an `AppMouse.MouseButton`.
    /// Defaults to `.left` for `nil` or unrecognized input so callers always
    /// get a valid button without surfacing parse errors.
    private static func parseButton(_ s: String?) -> AppMouse.MouseButton {
        guard let s, let parsed = AppMouse.MouseButton(rawValue: s.lowercased()) else {
            return .left
        }
        return parsed
    }
}
#endif
