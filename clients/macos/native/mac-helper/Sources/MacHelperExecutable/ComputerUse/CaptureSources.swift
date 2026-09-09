import AppKit
import CoreGraphics
import Foundation
import os

private let log = Logger(subsystem: "ai.vellum.mac-helper", category: "CaptureSources")

/// The windows a watch session could be scoped to, as the window server sees
/// them right now.
///
/// The Electron shell lists these for the companion's Teach picker, and polls
/// the same list while a session is framing one window so the frame follows
/// the window as it moves. Everything here is the window server's own account
/// (`CGWindowListCopyWindowInfo`), front to back, so the first window of an
/// app is its frontmost one. Ids are `CGWindowID`s, the same ids a capture
/// scoped to a window is asked for.
enum CaptureSources {
    /// `includeOffscreen` adds the windows on other Spaces and the minimized
    /// ones, each marked `onScreen: false`. The shell asks for them when it
    /// has to tell a window it can capture from a look-alike it cannot: a
    /// Chrome window left on another Space shares its title and bounds with
    /// nothing the shell could otherwise see.
    static func list(includeOffscreen: Bool = false) -> [String: Any] {
        let options: CGWindowListOption = includeOffscreen
            ? [.excludeDesktopElements]
            : [.optionOnScreenOnly, .excludeDesktopElements]
        let entries = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
        let myPID = ProcessInfo.processInfo.processIdentifier
        let hostPID = getppid()
        var appsByPID: [pid_t: NSRunningApplication] = [:]

        var windows: [[String: Any]] = []
        for entry in entries {
            // Layer 0 is the ordinary application-window layer; the menu bar,
            // the Dock and overlays sit above it and are nothing to teach from.
            guard let layer = entry[kCGWindowLayer as String] as? Int, layer == 0,
                  let ownerPID = entry[kCGWindowOwnerPID as String] as? Int,
                  let windowNumber = entry[kCGWindowNumber as String] as? Int
            else { continue }
            let pid = pid_t(ownerPID)
            // Never the helper or the app it belongs to: a session cannot
            // teach the assistant about its own window, and the companion's
            // surfaces would otherwise list themselves.
            if pid == myPID || pid == hostPID { continue }
            if let alpha = entry[kCGWindowAlpha as String] as? Double, alpha <= 0 { continue }

            var bounds = CGRect.zero
            if let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
               let rect = CGRect(dictionaryRepresentation: boundsDict) {
                bounds = rect
            }
            // Below this it is a tooltip, a popover shadow or a status item's
            // menu remnant rather than something a session could read.
            if bounds.width < 50 || bounds.height < 50 { continue }

            let app = appsByPID[pid] ?? NSRunningApplication(processIdentifier: pid)
            appsByPID[pid] = app

            var window: [String: Any] = [
                "windowId": UInt32(windowNumber),
                "onScreen": (entry[kCGWindowIsOnscreen as String] as? Bool) ?? !includeOffscreen,
                "pid": Int32(pid),
                "app": (entry[kCGWindowOwnerName as String] as? String) ?? app?.localizedName ?? "",
                "title": (entry[kCGWindowName as String] as? String) ?? "",
                "bounds": [
                    "x": bounds.origin.x,
                    "y": bounds.origin.y,
                    "width": bounds.width,
                    "height": bounds.height,
                ],
            ]
            if let bundleId = app?.bundleIdentifier { window["bundleId"] = bundleId }
            if let appPath = app?.bundleURL?.path { window["appPath"] = appPath }
            window["displayId"] = ScreenCapture.displayHolding(bounds)
            windows.append(window)
        }

        return ["windows": windows]
    }

    /// Bring `windowId` to the front: restore it if it is in the Dock, make its
    /// app the active one, and raise that window above the app's others.
    ///
    /// What a pick in the Teach picker does to the window it names, so the
    /// session reads what the user is looking at rather than something framed
    /// behind their work. Best effort at every step: an app that refuses the
    /// AX request still gets activated, and the pick goes ahead either way,
    /// since the capture does not depend on the window being in front.
    ///
    /// The window is found the way the tree finds it, by frame and then by a
    /// title that names exactly one of the app's windows. When neither holds
    /// (two windows titled alike at frames the app will not report) nothing
    /// is raised rather than a guess at a sibling; the app still comes
    /// forward, and the session frames the window wherever the app left it.
    ///
    /// Reads and writes window state through Accessibility, the same grant
    /// the session reads its tree with. Without that grant the app is
    /// activated and nothing else: there is no prompt from here, since the
    /// session this pick starts checks the grant itself and prompts once
    /// (`HostCuExecutor`), and a pick is not the moment for a second dialog
    /// on top of that one.
    static func raise(windowId: CGWindowID) -> [String: Any] {
        let enumerator = AccessibilityTreeEnumerator()
        guard let server = enumerator.serverWindow(for: windowId) else {
            log.warning("raise: window \(windowId) is not known to the window server")
            return ["raised": false, "reason": "unknown window"]
        }
        // Why the window itself was not raised, for the shell's log. The
        // answer names the reason rather than hiding it in this process's
        // own log, since the pick is made from the shell and that is where
        // someone looks first.
        var reason = ""
        var raised = false
        if !AXIsProcessTrusted() {
            reason = "accessibility not granted"
            log.warning("raise: Accessibility is not granted; activating the app of window \(windowId) only")
        } else {
            let appElement = AXUIElementCreateApplication(server.pid)
            // Bounded per call like the tree walk, so an app that has stopped
            // answering costs seconds, not the default six per attribute;
            // main.swift keeps this off the main queue for the same reason.
            AXUIElementSetMessagingTimeout(appElement, AccessibilityTreeEnumerator.axMessagingTimeoutSeconds)
            if let window = enumerator.axWindow(for: server, in: appElement) {
                var minimized: CFTypeRef?
                if AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimized) == .success,
                   (minimized as? Bool) == true {
                    AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                }
                let result = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                raised = result == .success
                if !raised {
                    reason = "AXRaise failed (\(result.rawValue))"
                }
            } else {
                reason = "no AX window matched"
                log.warning("raise: no AX window matches window \(windowId); activating its app only")
            }
        }
        // Through Launch Services, the way the Dock brings a running app
        // forward, rather than `NSRunningApplication.activate()`. Since macOS
        // 14 activation is cooperative: a process that is not itself in
        // front, which this helper never is, gets `true` back from
        // `activate()` and nothing happens, and the AX raise above only
        // reorders the window among its app's own. Opening the running app
        // with `activates` is what the system does for a Dock click, and it
        // also switches to the Space the app's windows are on when none are
        // on this one. AppKit work belongs on the main thread, and the answer
        // does not wait on it: whether the app took focus is not something
        // the pick acts on.
        var activation = "requested"
        if let app = NSRunningApplication(processIdentifier: server.pid) {
            DispatchQueue.main.async {
                guard let bundleURL = app.bundleURL else {
                    app.activate()
                    return
                }
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                NSWorkspace.shared.openApplication(at: bundleURL, configuration: configuration) { _, error in
                    if let error {
                        log.warning("raise: could not bring \(app.localizedName ?? "the app", privacy: .public) forward: \(error.localizedDescription, privacy: .public)")
                    }
                }
            }
        } else {
            activation = "no running app for pid \(server.pid)"
        }
        var answer: [String: Any] = ["raised": raised, "activation": activation]
        if !reason.isEmpty {
            answer["reason"] = reason
        }
        return answer
    }

    /// The frontmost ordinary window lying wholly on `displayId`, by the
    /// window server's front-to-back order, or nil when no window of another
    /// app does.
    ///
    /// What a watch session scoped to a display reads its accessibility tree
    /// from: the focused window may be on another display entirely, and a
    /// tree from there would describe something the frame never showed.
    /// Wholly on the display rather than mostly, because a tree has no crop:
    /// a window straddling two displays would file the text of the part the
    /// frame never showed. Such a window is left to the screenshot, and so is
    /// everything behind it: a straddling window in front covers part of
    /// the display, and the tree of a window under it would describe text
    /// the screenshot does not show.
    static func topmostWindowId(onDisplay displayId: CGDirectDisplayID) -> CGWindowID? {
        let displayBounds = CGDisplayBounds(displayId)
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let entries = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
        let myPID = ProcessInfo.processInfo.processIdentifier
        let hostPID = getppid()
        for entry in entries {
            guard let layer = entry[kCGWindowLayer as String] as? Int, layer == 0,
                  let ownerPID = entry[kCGWindowOwnerPID as String] as? Int,
                  let windowNumber = entry[kCGWindowNumber as String] as? Int
            else { continue }
            let pid = pid_t(ownerPID)
            if pid == myPID || pid == hostPID { continue }
            if let alpha = entry[kCGWindowAlpha as String] as? Double, alpha <= 0 { continue }
            guard let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict),
                  bounds.width >= 50, bounds.height >= 50
            else { continue }
            if !bounds.intersects(displayBounds) { continue }
            return displayBounds.contains(bounds) ? CGWindowID(windowNumber) : nil
        }
        return nil
    }
}
