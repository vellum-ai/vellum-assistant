import ApplicationServices
import AppKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AXTree")

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

final class AccessibilityTreeEnumerator {
    private var nextId = 1

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

    /// Set of app PIDs where we've already enabled enhanced AX.
    private static var enhancedAXEnabled: Set<pid_t> = []

    /// Clear the cache so we re-set AXEnhancedUserInterface (e.g., after restarting Chrome).
    static func clearEnhancedAXCache() {
        enhancedAXEnabled.removeAll()
    }

    func enumerateCurrentWindow() -> (elements: [AXElement], windowTitle: String, appName: String)? {
        guard let frontApp = NSWorkspace.shared.frontmostApplication else {
            log.warning("No frontmost application found")
            return nil
        }

        let myBundleId = Bundle.main.bundleIdentifier
        log.debug("Frontmost app: \(frontApp.localizedName ?? "?", privacy: .public) (\(frontApp.bundleIdentifier ?? "no-bundle-id", privacy: .public)) — my bundle: \(myBundleId ?? "nil", privacy: .public)")

        // Skip our own app — we want the window behind the overlay
        if let myId = myBundleId, frontApp.bundleIdentifier == myId {
            log.info("Skipping own app, looking for previous app")
            return enumeratePreviousApp()
        }

        let pid = frontApp.processIdentifier
        let appName = frontApp.localizedName ?? "Unknown"
        let appElement = AXUIElementCreateApplication(pid)

        // Tell apps (especially Chrome, Electron) to expose full web content AX tree.
        // This is what real assistive technologies do.
        if !Self.enhancedAXEnabled.contains(pid) {
            let result = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, true as CFTypeRef)
            log.info("Set AXEnhancedUserInterface on \(appName, privacy: .public) (pid \(pid)): \(result == .success ? "success" : "failed (\(result.rawValue))")")
            Self.enhancedAXEnabled.insert(pid)
        }

        var windowValue: CFTypeRef?
        let windowResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
        guard windowResult == .success, let windowRef = windowValue else { return nil }
        let windowElement = windowRef as! AXUIElement

        let windowTitle = getStringAttribute(windowElement, kAXTitleAttribute as CFString) ?? "Untitled"

        nextId = 1
        let elements = enumerateElement(element: windowElement, depth: 0, maxDepth: 25)

        let flat = AccessibilityTreeEnumerator.flattenElements(elements)
        let interactive = flat.filter { Self.interactiveRoles.contains($0.role) }
        log.info("Enumerated \(appName, privacy: .public): \(flat.count) total, \(interactive.count) interactive, maxId=\(self.nextId - 1)")

        return (elements: elements, windowTitle: windowTitle, appName: appName)
    }

    /// When our own app is focused, find the previously-active app's window instead.
    private func enumeratePreviousApp() -> (elements: [AXElement], windowTitle: String, appName: String)? {
        let runningApps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != Bundle.main.bundleIdentifier && !$0.isTerminated }

        for app in runningApps {
            let pid = app.processIdentifier
            let appElement = AXUIElementCreateApplication(pid)

            if !Self.enhancedAXEnabled.contains(pid) {
                AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, true as CFTypeRef)
                Self.enhancedAXEnabled.insert(pid)
            }

            var windowValue: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)
            guard result == .success, let windowRef = windowValue else { continue }
            let windowElement = windowRef as! AXUIElement

            let windowTitle = getStringAttribute(windowElement, kAXTitleAttribute as CFString) ?? "Untitled"
            let appName = app.localizedName ?? "Unknown"

            nextId = 1
            let elements = enumerateElement(element: windowElement, depth: 0, maxDepth: 25)

            // Only return if we found something useful
            if !elements.isEmpty {
                return (elements: elements, windowTitle: windowTitle, appName: appName)
            }
        }
        return nil
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

        // Enumerate children
        var childElements: [AXElement] = []
        var childrenRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            for child in children {
                childElements.append(contentsOf: enumerateElement(element: child, depth: depth + 1, maxDepth: maxDepth))
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

        if let posRef = positionValue {
            AXValueGetValue(posRef as! AXValue, .cgPoint, &point)
        }
        if let sizeRef = sizeValue {
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
        collectFormatted(elements: elements, interactive: &interactive, staticTexts: &staticTexts)

        if !interactive.isEmpty {
            lines.append("Interactive elements:")
            for line in interactive {
                lines.append("  \(line)")
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

    private static func collectFormatted(elements: [AXElement], interactive: inout [String], staticTexts: inout [String]) {
        for element in elements {
            let isInteractiveRole = interactiveRoles.contains(element.role)
            let isText = element.role == "AXStaticText" || element.role == "AXHeading"

            if isInteractiveRole {
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

            collectFormatted(elements: element.children, interactive: &interactive, staticTexts: &staticTexts)
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
