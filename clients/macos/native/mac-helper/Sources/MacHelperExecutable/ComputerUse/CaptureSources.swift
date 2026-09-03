import AppKit
import CoreGraphics
import Foundation

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
    static func list() -> [String: Any] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
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
