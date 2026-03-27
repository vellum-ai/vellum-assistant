import ApplicationServices
import AppKit
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AmbientAX")

struct ElementSummary {
    let role: String
    let originalRole: String
    let label: String?
    let value: String?
    let depth: Int
}

struct AmbientSnapshot {
    let timestamp: Date
    let focusedApp: String?       // bundle ID
    let focusedAppName: String
    let focusedWindowTitle: String
    let focusedElement: (role: String, label: String?)?
    let visibleElements: [ElementSummary]
    let ocrFallbackText: String?
}

enum AmbientAXCapture {

    private static let maxDepth = 4
    private static let maxElements = 50

    /// Timeout for AX API calls — prevents blocking if the target app is unresponsive.
    private static let axMessagingTimeoutSeconds: Float = 5.0

    /// Roles to skip — they add noise without meaningful content.
    private static let decorationRoles: Set<String> = [
        "AXScrollBar", "AXSplitter", "AXGrowArea", "AXRuler",
        "AXMatte", "AXValueIndicator", "AXLayoutArea", "AXLayoutItem",
        "AXUnknown"
    ]

    /// Roles that are only interesting when they carry a label or value.
    private static let labelRequiredRoles: Set<String> = [
        "AXGroup", "AXSplitGroup"
    ]

    // MARK: - Public API

    private static let ownBundleId = Bundle.appBundleIdentifier

    static func capture() async -> AmbientSnapshot? {
        guard let frontApp = NSWorkspace.shared.frontmostApplication else {
            log.debug("No frontmost app")
            return nil
        }

        // Skip capturing our own app to avoid self-referential observations
        if frontApp.bundleIdentifier == ownBundleId {
            log.debug("Frontmost app is self — skipping AX capture")
            return nil
        }

        let pid = frontApp.processIdentifier
        let bundleId = frontApp.bundleIdentifier
        let appName = frontApp.localizedName ?? "Unknown"
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, axMessagingTimeoutSeconds)

        // Get focused window
        var windowValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue) == .success,
              let windowRef = windowValue else {
            log.debug("No focused window for \(appName, privacy: .public)")
            return nil
        }
        guard CFGetTypeID(windowRef) == AXUIElementGetTypeID() else { return nil }
        let windowElement = windowRef as! AXUIElement
        let windowTitle = getStringAttribute(windowElement, kAXTitleAttribute as CFString) ?? "Untitled"

        // Get focused element
        var focusedRef: CFTypeRef?
        var focusedElement: (role: String, label: String?)?
        if AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
           let focused = focusedRef,
           CFGetTypeID(focused) == AXUIElementGetTypeID() {
            let fe = focused as! AXUIElement
            let role = getStringAttribute(fe, kAXRoleAttribute as CFString) ?? "unknown"
            let label = getStringAttribute(fe, kAXTitleAttribute as CFString)
                ?? getStringAttribute(fe, kAXDescriptionAttribute as CFString)
                ?? getStringAttribute(fe, kAXRoleDescriptionAttribute as CFString)
            focusedElement = (role: cleanRole(role), label: label)
        }

        // Enumerate elements (shallow)
        var elements: [ElementSummary] = []
        enumerateElement(element: windowElement, depth: 0, into: &elements)

        return AmbientSnapshot(
            timestamp: Date(),
            focusedApp: bundleId,
            focusedAppName: appName,
            focusedWindowTitle: windowTitle,
            focusedElement: focusedElement,
            visibleElements: elements,
            ocrFallbackText: nil
        )
    }

    static func isUseful(_ snapshot: AmbientSnapshot) -> Bool {
        let meaningful = snapshot.visibleElements.filter { element in
            !labelRequiredRoles.contains(element.originalRole)
            || element.label != nil
            || element.value != nil
        }
        return meaningful.count >= 3
    }

    static func format(_ snapshot: AmbientSnapshot) -> String {
        var lines: [String] = []
        lines.append("[App: \(snapshot.focusedAppName)] [Window: \(snapshot.focusedWindowTitle)]")

        if let focused = snapshot.focusedElement {
            var focusLine = "[Focused: \(focused.role)"
            if let label = focused.label, !label.isEmpty {
                focusLine += " \"\(label)\""
            }
            focusLine += "]"
            lines.append(focusLine)
        }

        if !snapshot.visibleElements.isEmpty {
            lines.append("Elements:")
            for element in snapshot.visibleElements {
                let indent = String(repeating: "  ", count: element.depth + 1)
                var line = "\(indent)\(element.role)"
                if let label = element.label, !label.isEmpty {
                    line += " \"\(label)\""
                }
                if let value = element.value, !value.isEmpty {
                    let truncated = value.count > 80 ? String(value.prefix(80)) + "..." : value
                    line += ": \"\(truncated)\""
                }
                lines.append(line)
            }
        }

        return lines.joined(separator: "\n")
    }

    // MARK: - Enumeration

    private static func enumerateElement(element: AXUIElement, depth: Int, into elements: inout [ElementSummary]) {
        guard depth < maxDepth, elements.count < maxElements else { return }

        let role = getStringAttribute(element, kAXRoleAttribute as CFString) ?? ""

        // Skip decoration roles
        if decorationRoles.contains(role) { return }

        let title = getStringAttribute(element, kAXTitleAttribute as CFString)
            ?? getStringAttribute(element, kAXDescriptionAttribute as CFString)
        let value = getValueAttribute(element)
        let hasLabel = title != nil && !title!.isEmpty
        let hasValue = value != nil && !value!.isEmpty

        // Skip label-required roles that have neither label nor value
        if labelRequiredRoles.contains(role) && !hasLabel && !hasValue {
            // Still recurse into children
        } else if !role.isEmpty && role != "AXWindow" {
            let cleanedRole = cleanRole(role)
            elements.append(ElementSummary(
                role: cleanedRole,
                originalRole: role,
                label: title,
                value: value,
                depth: depth
            ))
        }

        // Recurse into children
        var childrenRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            for child in children {
                guard elements.count < maxElements else { break }
                enumerateElement(element: child, depth: depth + 1, into: &elements)
            }
        }
    }

    // MARK: - AX Attribute Helpers

    private static func getStringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        return value as? String
    }

    private static func getValueAttribute(_ element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success else { return nil }
        if let str = value as? String { return str }
        if let num = value as? NSNumber { return num.stringValue }
        return nil
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

}
