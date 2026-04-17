import ApplicationServices
import AppKit
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AXTree")

struct AXElement: Identifiable {
    let id: Int
    let role: String
    let title: String?
    let value: String?
    let frame: CGRect
    let isEnabled: Bool
    let isFocused: Bool
    let children: [AXElement]
    let roleDescription: String?
    let identifier: String?
    let url: String?
    let placeholderValue: String?
}

struct WindowInfo {
    let elements: [AXElement]
    let windowTitle: String
    let appName: String
}

protocol AccessibilityTreeProviding: Sendable {
    func enumerateCurrentWindow() async -> (elements: [AXElement], windowTitle: String, appName: String, pid: pid_t)?
    func enumerateSecondaryWindows(excludingPID: pid_t?, maxWindows: Int) async -> [WindowInfo]
}

/// Enumerates macOS accessibility trees for the focused window and any
/// secondary windows of interest. All AX IPC runs off the main thread so a
/// slow or unresponsive target app cannot stall the caller's actor (typically
/// `@MainActor`) past the system AppHang threshold.
///
/// AX operations are synchronous Mach IPC bound to the *target* process's run
/// loop, not the caller's — so running them on a background queue keeps the
/// caller responsive without changing AX semantics. See AltTab's 2020 rework
/// (https://github.com/lwouis/alt-tab-macos/commit/19130f7) for a production
/// precedent and AXSwift's `UIElement.swift` for a third-party wrapper that
/// documents the same IPC behavior.
///
/// Each `HostCuActionRunner.perform()` call creates a fresh enumerator that is
/// used from a single detached task at a time; instance state (`nextId`,
/// `lastTargetPid`, `totalElementsEnumerated`) therefore has no cross-task
/// contention. Static caches shared across calls (`enhancedAXEnabled`,
/// `lastFocusedPID`) are guarded by `stateLock`.
final class AccessibilityTreeEnumerator: AccessibilityTreeProviding, @unchecked Sendable {
    private var nextId = 1
    /// PID of the last successfully enumerated target app, used to resolve the
    /// correct app when our own window is frontmost.
    private var lastTargetPid: pid_t?

    /// Track total elements enumerated in current call to prevent infinite loops
    private var totalElementsEnumerated = 0
    /// Maximum elements to enumerate before bailing out (protects against circular refs)
    private let maxElementsPerEnumeration = 10000

    /// Timeout (in seconds) for AX API calls to a target app. If an app is
    /// unresponsive, individual AXUIElement calls return kAXErrorCannotComplete
    /// after this duration instead of blocking indefinitely. Kept under the 2s
    /// AppHang threshold so that even if a future regression routes AX calls
    /// back onto the main thread, a single unresponsive app cannot cause an
    /// AppHang report.
    private static let axMessagingTimeoutSeconds: Float = 1.5

    /// Maximum number of non-self running apps to probe when the tracked PID
    /// fails to yield a focused window. Capped to bound total IPC cost — the
    /// fallback is meant for edge cases where the tracker is stale, not a
    /// general "find any window" search.
    private static let maxPreviousAppProbes = 5

    static let interactiveRoles: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXComboBox", "AXSlider", "AXLink", "AXMenuItem",
        "AXMenuButton", "AXIncrementor", "AXDisclosureTriangle", "AXTab",
        "AXTabGroup", "AXSegmentedControl"
    ]

    private static let containerRoles: Set<String> = [
        "AXGroup", "AXScrollArea", "AXSplitGroup", "AXTabGroup", "AXToolbar",
        "AXTable", "AXOutline", "AXList", "AXBrowser", "AXWebArea", "AXRow",
        "AXCell", "AXSheet", "AXDrawer",
        // Web content containers (Chrome, Safari, Electron)
        "AXSection", "AXForm", "AXLandmarkMain", "AXLandmarkNavigation",
        "AXLandmarkBanner", "AXLandmarkContentInfo", "AXLandmarkSearch",
        "AXArticle", "AXDocument", "AXApplication"
    ]

    /// Guards the shared static caches below. Accessed from both the
    /// `NSWorkspace` observer (main queue) and the detached tasks that run
    /// AX enumeration, so every read/write goes through this lock.
    private static let stateLock = NSLock()

    /// Set of app PIDs where we've already enabled enhanced AX. Guarded by `stateLock`.
    private static var _enhancedAXEnabled: Set<pid_t> = []

    /// Tracks the last non-self focused app PID, for fast lookup in enumeratePreviousApp().
    /// Guarded by `stateLock`.
    private static var _lastFocusedPID: pid_t?

    /// Whether the NSWorkspace notification observer has been registered.
    /// Only written from the main actor in `setupAppTracker()`, so no lock is needed.
    private static var appTrackerInstalled = false

    /// Atomically insert `pid` into the enhanced-AX cache.
    /// Returns true if the PID was newly inserted (caller should set the attribute).
    private static func markEnhancedAXIfNeeded(pid: pid_t) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _enhancedAXEnabled.insert(pid).inserted
    }

    private static func setLastFocusedPID(_ pid: pid_t?) {
        stateLock.lock()
        defer { stateLock.unlock() }
        _lastFocusedPID = pid
    }

    private static func getLastFocusedPID() -> pid_t? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _lastFocusedPID
    }

    /// Register an NSWorkspace observer to track the previously active app.
    /// Call this once at app startup (e.g., from AppDelegate).
    @MainActor
    static func setupAppTracker() {
        guard !appTrackerInstalled else { return }
        appTrackerInstalled = true

        let myBundleId = Bundle.main.bundleIdentifier
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            // Only track non-self apps
            if let myId = myBundleId, app.bundleIdentifier == myId { return }
            setLastFocusedPID(app.processIdentifier)
            log.debug("App tracker: updated lastFocusedPID to \(app.processIdentifier) (\(app.localizedName ?? "?", privacy: .public))")
        }
        log.info("App activation tracker installed")
    }

    /// Clear the cache so we re-set AXEnhancedUserInterface (e.g., after restarting Chrome).
    static func clearEnhancedAXCache() {
        stateLock.lock()
        defer { stateLock.unlock() }
        _enhancedAXEnabled.removeAll()
    }

    /// Async entry point. Runs the enumeration on a detached task so the
    /// caller (typically `@MainActor`) is not blocked by synchronous AX IPC
    /// to a slow or unresponsive target app.
    func enumerateCurrentWindow() async -> (elements: [AXElement], windowTitle: String, appName: String, pid: pid_t)? {
        await Task.detached { [self] in
            enumerateCurrentWindowSync()
        }.value
    }

    private func enumerateCurrentWindowSync() -> (elements: [AXElement], windowTitle: String, appName: String, pid: pid_t)? {
        guard let frontApp = NSWorkspace.shared.frontmostApplication else {
            log.warning("No frontmost application found")
            return nil
        }

        let myBundleId = Bundle.main.bundleIdentifier
        log.debug("Frontmost app: \(frontApp.localizedName ?? "?", privacy: .public) (\(frontApp.bundleIdentifier ?? "no-bundle-id", privacy: .public)) — my bundle: \(myBundleId ?? "nil", privacy: .public)")

        // Track the frontmost app's PID so enumeratePreviousApp() can use it directly
        if myBundleId == nil || frontApp.bundleIdentifier != myBundleId {
            Self.setLastFocusedPID(frontApp.processIdentifier)
        }

        // Skip our own app — we want the window behind the overlay
        if let myId = myBundleId, frontApp.bundleIdentifier == myId {
            log.info("Skipping own app, looking for previous app")
            return enumeratePreviousAppSync()
        }

        let pid = frontApp.processIdentifier
        let appName = frontApp.localizedName ?? "Unknown"
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, Self.axMessagingTimeoutSeconds)

        // Tell apps (especially Chrome, Electron) to expose full web content AX tree.
        // This is what real assistive technologies do.
        if Self.markEnhancedAXIfNeeded(pid: pid) {
            let result = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, true as CFTypeRef)
            log.info("Set AXEnhancedUserInterface on \(appName, privacy: .public) (pid \(pid)): \(result == .success ? "success" : "failed (\(result.rawValue))")")
        }

        var windowValue: CFTypeRef?
        let windowResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
        guard windowResult == .success, let windowRef = windowValue else {
            log.warning("Failed to get focused window for \(appName, privacy: .public) (pid \(pid)): AXError \(windowResult.rawValue)")
            if windowResult.rawValue == -25211 {
                log.error("AX API disabled — Accessibility permission likely not granted for this executable")
            }
            return nil
        }
        guard CFGetTypeID(windowRef) == AXUIElementGetTypeID() else { return nil }
        let windowElement = windowRef as! AXUIElement

        let windowTitle = getStringAttribute(windowElement, kAXTitleAttribute as CFString) ?? "Untitled"

        nextId = 1
        totalElementsEnumerated = 0
        let elements = enumerateElementSafely(element: windowElement, depth: 0, maxDepth: 25)

        let flat = AccessibilityTreeEnumerator.flattenElements(elements)
        let interactive = flat.filter { Self.interactiveRoles.contains($0.role) }
        log.info("Enumerated \(appName, privacy: .public): \(flat.count) total, \(interactive.count) interactive, maxId=\(self.nextId - 1)")

        lastTargetPid = pid
        return (elements: elements, windowTitle: windowTitle, appName: appName, pid: pid)
    }

    /// When our own app is focused, find the previously-active app's window instead.
    /// Prefers the tracked last-focused PID so the agent returns to the correct
    /// window rather than an arbitrary app from the running-apps list. If the
    /// fast path fails, probes at most `maxPreviousAppProbes` non-self running
    /// apps to bound worst-case IPC latency.
    private func enumeratePreviousAppSync() -> (elements: [AXElement], windowTitle: String, appName: String, pid: pid_t)? {
        // Fast path: try the tracked last-focused PID first
        if let trackedPID = Self.getLastFocusedPID() {
            log.debug("enumeratePreviousApp: trying tracked PID \(trackedPID)")
            if let result = enumerateAppByPIDSync(trackedPID) {
                return result
            }
            log.debug("enumeratePreviousApp: tracked PID \(trackedPID) failed, falling back to iteration")
        }

        // Slow fallback: iterate a bounded number of running apps. The previous
        // implementation scanned every `runningApplications` entry, which on
        // busy systems could compound IPC delays into multi-second hangs.
        let runningApps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != Bundle.main.bundleIdentifier && !$0.isTerminated }

        // Try the last-known target app first for deterministic behavior
        if let targetPid = lastTargetPid,
           runningApps.contains(where: { $0.processIdentifier == targetPid }),
           let result = enumerateAppByPIDSync(targetPid) {
            return result
        }

        var probes = 0
        for app in runningApps {
            if app.processIdentifier == lastTargetPid { continue } // already tried
            guard probes < Self.maxPreviousAppProbes else {
                log.debug("enumeratePreviousApp: hit probe cap (\(Self.maxPreviousAppProbes)) without finding a focused window")
                break
            }
            probes += 1
            if let result = enumerateAppByPIDSync(app.processIdentifier) {
                return result
            }
        }
        return nil
    }

    /// Try to enumerate the focused window for a specific PID.
    /// Returns nil if the app has no focused window or yields no elements.
    private func enumerateAppByPIDSync(_ pid: pid_t) -> (elements: [AXElement], windowTitle: String, appName: String, pid: pid_t)? {
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, Self.axMessagingTimeoutSeconds)

        if Self.markEnhancedAXIfNeeded(pid: pid) {
            AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, true as CFTypeRef)
        }

        var windowValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
        guard result == .success, let windowRef = windowValue else {
            let appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "Unknown"
            log.debug("enumerateAppByPID: no focused window for \(appName, privacy: .public) (pid \(pid)): AXError \(result.rawValue)")
            return nil
        }
        guard CFGetTypeID(windowRef) == AXUIElementGetTypeID() else { return nil }
        let windowElement = windowRef as! AXUIElement

        let windowTitle = getStringAttribute(windowElement, kAXTitleAttribute as CFString) ?? "Untitled"
        let appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "Unknown"

        nextId = 1
        totalElementsEnumerated = 0
        let elements = enumerateElementSafely(element: windowElement, depth: 0, maxDepth: 25)

        guard !elements.isEmpty else { return nil }
        lastTargetPid = pid
        return (elements: elements, windowTitle: windowTitle, appName: appName, pid: pid)
    }

    /// Async entry point. Offloads AX IPC to a detached task — see
    /// `enumerateCurrentWindow()` for rationale.
    func enumerateSecondaryWindows(excludingPID: pid_t?, maxWindows: Int = 2) async -> [WindowInfo] {
        await Task.detached { [self] in
            enumerateSecondaryWindowsSync(excludingPID: excludingPID, maxWindows: maxWindows)
        }.value
    }

    private func enumerateSecondaryWindowsSync(excludingPID: pid_t?, maxWindows: Int) -> [WindowInfo] {
        let myBundleId = Bundle.main.bundleIdentifier
        let runningApps = NSWorkspace.shared.runningApplications
            .filter { app in
                app.activationPolicy == .regular
                    && !app.isTerminated
                    && app.bundleIdentifier != myBundleId
                    && (excludingPID == nil || app.processIdentifier != excludingPID)
            }

        var results: [WindowInfo] = []
        for app in runningApps {
            guard results.count < maxWindows else { break }
            let pid = app.processIdentifier
            let appElement = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(appElement, Self.axMessagingTimeoutSeconds)

            if Self.markEnhancedAXIfNeeded(pid: pid) {
                AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, true as CFTypeRef)
            }

            // Get all windows for this app and find the first visible one
            var windowsRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef) == .success,
                  let windows = windowsRef as? [AXUIElement],
                  !windows.isEmpty else { continue }

            // Find a window that is on the main display (skip external monitors)
            let mainDisplayBounds = CGDisplayBounds(CGMainDisplayID())
            guard let visibleWindow = windows.first(where: {
                let frame = getFrameAttribute($0)
                return frame.width > 50 && frame.height > 50 && frame.intersects(mainDisplayBounds)
            }) else { continue }

            let windowTitle = getStringAttribute(visibleWindow, kAXTitleAttribute as CFString) ?? "Untitled"
            let appName = app.localizedName ?? "Unknown"

            nextId = 1
            totalElementsEnumerated = 0
            let elements = enumerateElementSafely(element: visibleWindow, depth: 0, maxDepth: 15) // shallower for secondary
            guard !elements.isEmpty else { continue }

            results.append(WindowInfo(elements: elements, windowTitle: windowTitle, appName: appName))
            log.info("Secondary window: \(appName, privacy: .public) — \"\(windowTitle)\"")
        }

        return results
    }

    /// Safe wrapper around enumerateElement that prevents infinite loops.
    /// File save dialogs (especially with Downloads) can have corrupted AX trees or circular references.
    private func enumerateElementSafely(element: AXUIElement, depth: Int, maxDepth: Int) -> [AXElement] {
        // Bail out if we've processed too many elements (circular reference protection)
        guard totalElementsEnumerated < maxElementsPerEnumeration else {
            log.warning("Hit max element limit (\(self.maxElementsPerEnumeration)) during enumeration — stopping to prevent infinite loop")
            return []
        }

        totalElementsEnumerated += 1
        return enumerateElement(element: element, depth: depth, maxDepth: maxDepth)
    }

    private func enumerateElement(element: AXUIElement, depth: Int, maxDepth: Int) -> [AXElement] {
        guard depth < maxDepth else { return [] }

        let role = getStringAttribute(element, kAXRoleAttribute as CFString) ?? ""
        let title = getStringAttribute(element, kAXTitleAttribute as CFString)
            ?? getStringAttribute(element, kAXDescriptionAttribute as CFString)
        let value = getValueAttribute(element)
        let roleDescription = getStringAttribute(element, kAXRoleDescriptionAttribute as CFString)
        let identifier = getStringAttribute(element, kAXIdentifierAttribute as CFString)
        let placeholderValue = getStringAttribute(element, kAXPlaceholderValueAttribute as CFString)
        let isEnabled = getBoolAttribute(element, kAXEnabledAttribute as CFString) ?? true
        let isFocused = getBoolAttribute(element, kAXFocusedAttribute as CFString) ?? false
        let frame = getFrameAttribute(element)
        let url = getStringAttribute(element, "AXURL" as CFString)

        let isInteractive = Self.interactiveRoles.contains(role)
        let isContainer = Self.containerRoles.contains(role)
        let hasTextContent = (title != nil && !title!.isEmpty) || (value != nil && !value!.isEmpty)
        let isStaticText = role == "AXStaticText" || role == "AXHeading"

        // Enumerate children with safety checks
        var childElements: [AXElement] = []
        var childrenRef: CFTypeRef?

        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            // Sanity check: if children array is suspiciously large, it might be corrupted
            // Skip children enumeration but continue processing current element
            if children.count >= 1000 {
                log.warning("Element has \(children.count) children — likely corrupted, skipping children enumeration")
            } else {
                for (index, child) in children.enumerated() {
                    // Stop if we've hit the limit mid-enumeration
                    guard totalElementsEnumerated < maxElementsPerEnumeration else {
                        log.warning("Hit element limit while enumerating children (\(index)/\(children.count) processed)")
                        break
                    }

                    // Recursively enumerate with the safe wrapper
                    childElements.append(contentsOf: enumerateElementSafely(element: child, depth: depth + 1, maxDepth: maxDepth))
                }
            }
        }

        if isInteractive {
            let id = nextId
            nextId += 1
            return [AXElement(
                id: id,
                role: role,
                title: title,
                value: value,
                frame: frame,
                isEnabled: isEnabled,
                isFocused: isFocused,
                children: [], // Flatten interactive elements
                roleDescription: roleDescription,
                identifier: identifier,
                url: url,
                placeholderValue: placeholderValue
            )]
        }

        if isStaticText && hasTextContent {
            let id = nextId
            nextId += 1
            return [AXElement(
                id: id,
                role: role,
                title: title,
                value: value,
                frame: frame,
                isEnabled: isEnabled,
                isFocused: isFocused,
                children: [],
                roleDescription: roleDescription,
                identifier: identifier,
                url: url,
                placeholderValue: placeholderValue
            )]
        }

        if isContainer && !childElements.isEmpty {
            let id = nextId
            nextId += 1
            return [AXElement(
                id: id,
                role: role,
                title: title,
                value: value,
                frame: frame,
                isEnabled: isEnabled,
                isFocused: isFocused,
                children: childElements,
                roleDescription: roleDescription,
                identifier: identifier,
                url: url,
                placeholderValue: placeholderValue
            )]
        }

        // Skip this element but keep children
        return childElements
    }

    // MARK: - AX Attribute Helpers

    private func getStringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        return value as? String
    }

    private func getBoolAttribute(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        return (value as? NSNumber)?.boolValue
    }

    private func getValueAttribute(_ element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success else { return nil }
        if let str = value as? String { return str }
        if let num = value as? NSNumber { return num.stringValue }
        return nil
    }

    private func getFrameAttribute(_ element: AXUIElement) -> CGRect {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?

        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success
        else { return .zero }

        var point = CGPoint.zero
        var size = CGSize.zero

        if let posRef = positionValue, CFGetTypeID(posRef) == AXValueGetTypeID() {
            AXValueGetValue(posRef as! AXValue, .cgPoint, &point)
        }
        if let sizeRef = sizeValue, CFGetTypeID(sizeRef) == AXValueGetTypeID() {
            AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
        }

        return CGRect(origin: point, size: size)
    }

    // MARK: - Formatting

    static func formatAXTree(elements: [AXElement], windowTitle: String, appName: String) -> String {
        var lines: [String] = []
        lines.append("Window: \"\(windowTitle)\" (\(appName))")

        var interactive: [String] = []
        var staticTexts: [String] = []
        var prunedCount = 0
        collectFormatted(elements: elements, interactive: &interactive, staticTexts: &staticTexts, prunedCount: &prunedCount)

        if !interactive.isEmpty {
            lines.append("Interactive elements:")
            for line in interactive {
                lines.append("  \(line)")
            }
            if prunedCount > 0 {
                lines.append("  (\(prunedCount) unlabeled elements hidden)")
            }
        }

        if !staticTexts.isEmpty {
            lines.append("")
            lines.append("Visible text:")
            for text in staticTexts.prefix(30) {
                lines.append("  \(text)")
            }
        }

        return lines.joined(separator: "\n")
    }

    /// Roles that represent text inputs — always shown even without a title,
    /// since the model may need to click/type in them.
    private static let textInputRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXComboBox"
    ]

    private static func collectFormatted(elements: [AXElement], interactive: inout [String], staticTexts: inout [String], prunedCount: inout Int) {
        for element in elements {
            let isInteractiveRole = interactiveRoles.contains(element.role)
            let isText = element.role == "AXStaticText" || element.role == "AXHeading"

            if isInteractiveRole {
                // Skip unlabeled non-text elements — the model can't meaningfully target
                // "button at (431, 56)" without knowing what it does.
                let hasTitle = element.title != nil && !element.title!.isEmpty
                let isTextInput = textInputRoles.contains(element.role)
                let hasPlaceholder = element.placeholderValue != nil && !element.placeholderValue!.isEmpty
                let hasUrl = element.url != nil && !element.url!.isEmpty

                if !hasTitle && !isTextInput && !element.isFocused && !hasPlaceholder && !hasUrl {
                    prunedCount += 1
                    collectFormatted(elements: element.children, interactive: &interactive, staticTexts: &staticTexts, prunedCount: &prunedCount)
                    continue
                }

                let cleanedRole = cleanRole(element.role)
                let centerX = Int(element.frame.midX)
                let centerY = Int(element.frame.midY)
                var line = "[\(element.id)] \(cleanedRole)"
                if let title = element.title, !title.isEmpty {
                    line += " \"\(title)\""
                }
                line += " at (\(centerX), \(centerY))"
                if element.isFocused { line += " FOCUSED" }
                if !element.isEnabled { line += " disabled" }
                if let value = element.value, !value.isEmpty {
                    let truncated = value.count > 50 ? String(value.prefix(50)) + "..." : value
                    line += " value: \"\(truncated)\""
                } else if let placeholder = element.placeholderValue, !placeholder.isEmpty {
                    line += " placeholder: \"\(placeholder)\""
                }
                if let url = element.url, !url.isEmpty {
                    line += " → \(url)"
                }
                interactive.append(line)
            } else if isText {
                if let title = element.title, !title.isEmpty {
                    staticTexts.append(title)
                } else if let value = element.value, !value.isEmpty {
                    staticTexts.append(value)
                }
            }

            collectFormatted(elements: element.children, interactive: &interactive, staticTexts: &staticTexts, prunedCount: &prunedCount)
        }
    }

    private static func cleanRole(_ role: String) -> String {
        var cleaned = role
        if cleaned.hasPrefix("AX") {
            cleaned = String(cleaned.dropFirst(2))
        }
        // Split camelCase
        var result = ""
        for char in cleaned {
            if char.isUppercase && !result.isEmpty {
                result += " "
            }
            result += String(char).lowercased()
        }
        return result
    }

    /// Format secondary windows into a compact text representation.
    /// Uses a condensed format (interactive elements only) to minimize token cost.
    static func formatSecondaryWindows(_ windows: [WindowInfo]) -> String? {
        guard !windows.isEmpty else { return nil }

        var lines: [String] = ["OTHER VISIBLE WINDOWS:"]
        for window in windows {
            lines.append("")
            lines.append("  Window: \"\(window.windowTitle)\" (\(window.appName))")

            var interactive: [String] = []
            var staticTexts: [String] = []
            var prunedCount = 0
            collectFormatted(elements: window.elements, interactive: &interactive, staticTexts: &staticTexts, prunedCount: &prunedCount)

            if !interactive.isEmpty {
                for line in interactive.prefix(15) { // Cap per window to limit tokens
                    lines.append("    \(line)")
                }
                if interactive.count > 15 {
                    lines.append("    ... and \(interactive.count - 15) more elements")
                }
            }

            if !staticTexts.isEmpty {
                for text in staticTexts.prefix(10) {
                    lines.append("    \(text)")
                }
            }
        }

        return lines.joined(separator: "\n")
    }

    static func shouldFallbackToVision(elements: [AXElement]) -> Bool {
        var interactiveCount = 0
        countInteractive(elements: elements, count: &interactiveCount)
        return interactiveCount < 3
    }

    private static func countInteractive(elements: [AXElement], count: inout Int) {
        for element in elements {
            if interactiveRoles.contains(element.role) {
                count += 1
            }
            countInteractive(elements: element.children, count: &count)
        }
    }

    static func flattenElements(_ elements: [AXElement]) -> [AXElement] {
        var result: [AXElement] = []
        for element in elements {
            result.append(element)
            result.append(contentsOf: flattenElements(element.children))
        }
        return result
    }
}
