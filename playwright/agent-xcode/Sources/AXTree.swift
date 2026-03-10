import ApplicationServices
import AppKit
import Foundation

// MARK: - AX Element Model

struct AXElement: Identifiable {
    let id: Int
    let role: String
    let title: String?
    let value: String?
    let frame: CGRect
    let isEnabled: Bool
    let isFocused: Bool
    let children: [AXElement]
    let identifier: String?
    let placeholderValue: String?
    let url: String?
}

// MARK: - AX Tree Enumerator

final class AXTreeEnumerator {
    private var nextId = 1
    private var totalElementsEnumerated = 0
    private let maxElementsPerEnumeration = 10000
    private static let axMessagingTimeoutSeconds: Float = 5.0

    static let interactiveRoles: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXComboBox", "AXSlider", "AXLink", "AXMenuItem",
        "AXMenuButton", "AXIncrementor", "AXDisclosureTriangle", "AXTab",
        "AXTabGroup", "AXSegmentedControl",
    ]

    private static let containerRoles: Set<String> = [
        "AXGroup", "AXScrollArea", "AXSplitGroup", "AXTabGroup", "AXToolbar",
        "AXTable", "AXOutline", "AXList", "AXBrowser", "AXWebArea", "AXRow",
        "AXCell", "AXSheet", "AXDrawer",
        "AXSection", "AXForm", "AXLandmarkMain", "AXLandmarkNavigation",
        "AXLandmarkBanner", "AXLandmarkContentInfo", "AXLandmarkSearch",
        "AXArticle", "AXDocument", "AXApplication",
    ]

    private static let textInputRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXComboBox",
    ]

    /// Window titles that should be excluded from enumeration (e.g. test overlays).
    private static let ignoredWindowTitles: Set<String> = [
        "E2E Status Overlay",
    ]

    // MARK: - Enumerate by App Name

    func enumerateApp(named appName: String) -> (elements: [AXElement], windowTitle: String, appName: String)? {
        let runningApps = NSWorkspace.shared.runningApplications
        guard let app = runningApps.first(where: {
            $0.localizedName?.lowercased() == appName.lowercased() && !$0.isTerminated
        }) else {
            return nil
        }

        let pid = app.processIdentifier
        let name = app.localizedName ?? appName
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, Self.axMessagingTimeoutSeconds)

        // Enable enhanced AX for web content in browsers
        AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, true as CFTypeRef)

        var windowValue: CFTypeRef?
        let windowResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue)

        // Use the focused window if available and not in the ignore list
        if windowResult == .success, let windowRef = windowValue,
           CFGetTypeID(windowRef) == AXUIElementGetTypeID() {
            let focusedTitle = getStringAttribute(windowRef as! AXUIElement, kAXTitleAttribute as CFString) ?? ""
            if !Self.ignoredWindowTitles.contains(focusedTitle) {
                return enumerateWindow(windowRef as! AXUIElement, appName: name)
            }
        }

        // Fall back to the first non-ignored window
        var windowsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef) == .success,
              let windows = windowsRef as? [AXUIElement] else {
            return nil
        }
        for window in windows {
            let title = getStringAttribute(window, kAXTitleAttribute as CFString) ?? ""
            if !Self.ignoredWindowTitles.contains(title) {
                return enumerateWindow(window, appName: name)
            }
        }
        return nil
    }

    private func enumerateWindow(_ windowElement: AXUIElement, appName: String) -> (elements: [AXElement], windowTitle: String, appName: String) {
        let windowTitle = getStringAttribute(windowElement, kAXTitleAttribute as CFString) ?? "Untitled"
        nextId = 1
        totalElementsEnumerated = 0
        let elements = enumerateElementSafely(element: windowElement, depth: 0, maxDepth: 25)
        return (elements: elements, windowTitle: windowTitle, appName: appName)
    }

    // MARK: - Element Enumeration

    private func enumerateElementSafely(element: AXUIElement, depth: Int, maxDepth: Int) -> [AXElement] {
        guard totalElementsEnumerated < maxElementsPerEnumeration else { return [] }
        totalElementsEnumerated += 1
        return enumerateElement(element: element, depth: depth, maxDepth: maxDepth)
    }

    private func enumerateElement(element: AXUIElement, depth: Int, maxDepth: Int) -> [AXElement] {
        guard depth < maxDepth else { return [] }

        let role = getStringAttribute(element, kAXRoleAttribute as CFString) ?? ""
        let title = getStringAttribute(element, kAXTitleAttribute as CFString)
            ?? getStringAttribute(element, kAXDescriptionAttribute as CFString)
        let value = getValueAttribute(element)
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
            if children.count >= 1000 {
                // Skip corrupted children
            } else {
                for (index, child) in children.enumerated() {
                    guard totalElementsEnumerated < maxElementsPerEnumeration else {
                        break
                    }
                    _ = index
                    childElements.append(contentsOf: enumerateElementSafely(element: child, depth: depth + 1, maxDepth: maxDepth))
                }
            }
        }

        if isInteractive {
            let id = nextId
            nextId += 1
            return [AXElement(
                id: id, role: role, title: title, value: value, frame: frame,
                isEnabled: isEnabled, isFocused: isFocused, children: [],
                identifier: identifier, placeholderValue: placeholderValue, url: url
            )]
        }

        if isStaticText && hasTextContent {
            let id = nextId
            nextId += 1
            return [AXElement(
                id: id, role: role, title: title, value: value, frame: frame,
                isEnabled: isEnabled, isFocused: isFocused, children: [],
                identifier: identifier, placeholderValue: placeholderValue, url: url
            )]
        }

        if isContainer && !childElements.isEmpty {
            let id = nextId
            nextId += 1
            return [AXElement(
                id: id, role: role, title: title, value: value, frame: frame,
                isEnabled: isEnabled, isFocused: isFocused, children: childElements,
                identifier: identifier, placeholderValue: placeholderValue, url: url
            )]
        }

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

    private static func collectFormatted(elements: [AXElement], interactive: inout [String], staticTexts: inout [String], prunedCount: inout Int) {
        for element in elements {
            let isInteractiveRole = interactiveRoles.contains(element.role)
            let isText = element.role == "AXStaticText" || element.role == "AXHeading"

            if isInteractiveRole {
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
        var result = ""
        for char in cleaned {
            if char.isUppercase && !result.isEmpty {
                result += " "
            }
            result += String(char).lowercased()
        }
        return result
    }

    static func flattenElements(_ elements: [AXElement]) -> [AXElement] {
        var result: [AXElement] = []
        for element in elements {
            result.append(element)
            result.append(contentsOf: flattenElements(element.children))
        }
        return result
    }

    // MARK: - State File (for element-based clicking)

    /// Build a map from element ID → center point and write to a JSON state file.
    static func writeStateFile(elements: [AXElement], path: String = "/tmp/ax-helper-state.json") {
        let flat = flattenElements(elements)
        var map: [String: [String: Int]] = [:]
        for el in flat {
            map[String(el.id)] = ["x": Int(el.frame.midX), "y": Int(el.frame.midY)]
        }
        if let data = try? JSONSerialization.data(withJSONObject: map, options: [.sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    /// Read the state file and return coordinates for a given element ID.
    static func readCoordinates(forElementId id: Int, path: String = "/tmp/ax-helper-state.json") -> CGPoint? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let map = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Int]],
              let coords = map[String(id)],
              let x = coords["x"], let y = coords["y"] else {
            return nil
        }
        return CGPoint(x: x, y: y)
    }
}
