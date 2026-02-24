import AppKit
import ApplicationServices
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "FocusManager")

/// Centralized focus acquisition with multi-strategy retry and AX-level window raise.
///
/// Strategies (in order):
/// 1. Unhide the target app (handles NSApp.hide / isHidden state)
/// 2. NSRunningApplication.activate(options:) with .activateIgnoringOtherApps
/// 3. AX-level kAXRaiseAction on the main/focused window (bypasses WM quirks)
/// 4. Verify frontmost app matches target
///
/// Each attempt includes a settle delay to let the window server process the switch.
@MainActor
final class FocusManager {

    /// Result of a focus acquisition attempt.
    enum FocusResult {
        case success
        case targetNotRunning
        case failed(reason: String)
    }

    /// The settle delay after each activation attempt (in nanoseconds).
    private static let settleDelayNs: UInt64 = 300_000_000 // 300ms

    /// Attempts to bring the target app to the foreground and verify it's frontmost.
    ///
    /// - Parameters:
    ///   - bundleId: Target app's bundle identifier (preferred, most reliable).
    ///   - appName: Target app's display name (fallback when no bundle ID).
    ///   - maxRetries: Maximum activation attempts (default 2 for strict, 1 for normal).
    /// - Returns: `.success` if the target is frontmost, or a failure reason.
    func acquireVerifiedFocus(
        bundleId: String?,
        appName: String?,
        maxRetries: Int = 2
    ) async -> FocusResult {
        let frontmostBefore = NSWorkspace.shared.frontmostApplication
        log.info("Focus: acquiring target=\(bundleId ?? "nil", privacy: .public)/\(appName ?? "nil", privacy: .public) frontmostBefore=\(frontmostBefore?.localizedName ?? "nil", privacy: .public)(\(frontmostBefore?.bundleIdentifier ?? "nil", privacy: .public))")

        // Fast path: already frontmost
        if isFrontmost(bundleId: bundleId, appName: appName) {
            log.info("Focus: already frontmost — no activation needed")
            return .success
        }

        // Resolve the running application (deterministic: prefers visible-window instance)
        guard let targetApp = resolveRunningApp(bundleId: bundleId, appName: appName) else {
            log.warning("Focus: target not running bundleId=\(bundleId ?? "nil", privacy: .public) appName=\(appName ?? "nil", privacy: .public)")
            return .targetNotRunning
        }

        let displayName = targetApp.localizedName ?? appName ?? bundleId ?? "unknown"
        let targetPID = targetApp.processIdentifier
        log.info("Focus: resolved target=\(displayName, privacy: .public) pid=\(targetPID)")

        for attempt in 1...maxRetries {
            // Step 1: Unhide if hidden
            if targetApp.isHidden {
                targetApp.unhide()
                log.info("Focus[\(attempt)]: unhid \(displayName, privacy: .public)")
            }

            // Special handling for our own app (LSUIElement / .accessory policy)
            let selfBundleId = Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant"
            if targetApp.bundleIdentifier == selfBundleId {
                NSApp.unhide(nil)
                for window in NSApp.windows where window.isMiniaturized {
                    window.deminiaturize(nil)
                }
            }

            // Step 2: NSRunningApplication.activate
            targetApp.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])

            // Step 3: AX-level window raise — more reliable for stubborn windows
            raiseMainWindowViaAX(pid: targetPID)

            // Settle delay
            try? await Task.sleep(nanoseconds: Self.settleDelayNs)

            // Step 4: Verify
            if isFrontmost(bundleId: bundleId, appName: appName) {
                let frontmostAfter = NSWorkspace.shared.frontmostApplication
                log.info("Focus[\(attempt)]: verified \(displayName, privacy: .public) is frontmost pid=\(targetPID) frontmostAfter=\(frontmostAfter?.localizedName ?? "nil", privacy: .public)")
                return .success
            }

            let currentFrontmost = NSWorkspace.shared.frontmostApplication
            log.warning("Focus[\(attempt)/\(maxRetries)]: \(displayName, privacy: .public) not frontmost after activation — frontmost is \(currentFrontmost?.localizedName ?? "unknown", privacy: .public)(\(currentFrontmost?.bundleIdentifier ?? "nil", privacy: .public))")
        }

        let frontmostName = NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"
        let frontmostBid = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "nil"
        let reason = "Could not activate '\(displayName)' (pid=\(targetPID)) after \(maxRetries) attempts. Frontmost is '\(frontmostName)' (\(frontmostBid))."
        log.error("Focus: FAILED — \(reason, privacy: .public)")
        return .failed(reason: reason)
    }

    // MARK: - Private Helpers

    /// Checks whether the frontmost app matches the target by bundle ID or name.
    private func isFrontmost(bundleId: String?, appName: String?) -> Bool {
        guard let frontmost = NSWorkspace.shared.frontmostApplication else { return false }

        if let bid = bundleId, !bid.isEmpty {
            return frontmost.bundleIdentifier == bid
        }
        if let name = appName, !name.isEmpty {
            return frontmost.localizedName == name
        }
        // No target constraint — always matches
        return true
    }

    /// Finds the NSRunningApplication for the target.
    ///
    /// When multiple instances match (e.g., two Chrome instances), prefers the one
    /// whose PID owns a visible layer-0 window (determined via `CGWindowListCopyWindowInfo`).
    /// This avoids picking a headless/background instance that can't be focused.
    private func resolveRunningApp(bundleId: String?, appName: String?) -> NSRunningApplication? {
        let workspace = NSWorkspace.shared

        let candidates: [NSRunningApplication]
        if let bid = bundleId, !bid.isEmpty {
            candidates = workspace.runningApplications.filter { $0.bundleIdentifier == bid }
        } else if let name = appName, !name.isEmpty {
            candidates = workspace.runningApplications.filter { $0.localizedName == name }
        } else {
            return nil
        }

        guard !candidates.isEmpty else { return nil }
        if candidates.count == 1 { return candidates.first }

        // Multiple instances — prefer the one with a visible layer-0 window
        let visiblePIDs = Self.pidsWithVisibleWindows()
        log.info("Focus: \(candidates.count) candidate instances, visiblePIDs=\(visiblePIDs)")

        for candidate in candidates {
            if visiblePIDs.contains(candidate.processIdentifier) {
                log.info("Focus: chose pid=\(candidate.processIdentifier) (has visible window)")
                return candidate
            }
        }

        // No candidate has a visible window — fall back to first
        log.info("Focus: no candidate has visible window, using first (pid=\(candidates[0].processIdentifier))")
        return candidates.first
    }

    /// Returns PIDs that own at least one visible, layer-0 (normal) window.
    private static func pidsWithVisibleWindows() -> Set<pid_t> {
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return []
        }

        var pids = Set<pid_t>()
        for info in windowList {
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t,
                  let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else {
                continue
            }
            pids.insert(pid)
        }
        return pids
    }

    /// Uses AX APIs to raise the main/focused window of the target app.
    ///
    /// This is more reliable than NSRunningApplication.activate() for apps that
    /// have multiple windows or that the WM doesn't bring to front on activate alone.
    ///
    /// Sequence:
    /// 1. Get focused or main window
    /// 2. Set kAXMainAttribute on the window (make it the main window)
    /// 3. Perform kAXRaiseAction (bring window to front)
    /// 4. Set kAXFocusedAttribute on the app element (transfer keyboard focus)
    private func raiseMainWindowViaAX(pid: pid_t) {
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, 3.0)

        // Try focused window first, fall back to main window
        var windowRef: CFTypeRef?
        var result = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef)
        if result != .success {
            result = AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &windowRef)
        }

        guard result == .success,
              let windowValue = windowRef,
              CFGetTypeID(windowValue) == AXUIElementGetTypeID() else {
            log.debug("AX raise: no focused/main window for pid \(pid)")
            return
        }

        let window = windowValue as! AXUIElement

        // Set as main window
        let mainResult = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        if mainResult != .success {
            log.debug("AX raise: kAXMainAttribute set failed for pid \(pid): \(mainResult.rawValue)")
        }

        // Raise the window to front
        let raiseResult = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        if raiseResult == .success {
            log.debug("AX raise: raised window for pid \(pid)")
        } else {
            log.debug("AX raise: kAXRaiseAction failed for pid \(pid): \(raiseResult.rawValue)")
        }

        // Set focused attribute on the app element to transfer keyboard focus
        let focusResult = AXUIElementSetAttributeValue(appElement, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if focusResult != .success {
            log.debug("AX raise: kAXFocusedAttribute set failed for pid \(pid): \(focusResult.rawValue)")
        }
    }
}
