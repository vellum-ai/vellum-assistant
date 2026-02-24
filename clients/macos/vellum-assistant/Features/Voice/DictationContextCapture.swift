import ApplicationServices
import AppKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "DictationContext")

/// Context captured at Fn-hold activation time, describing the user's current app state.
/// This is the Swift-side struct — it will be mapped to IPC types in M3.
struct DictationContext {
    let bundleIdentifier: String
    let appName: String
    let windowTitle: String
    let selectedText: String?
    let cursorInTextField: Bool
}

/// Captures the user's current context (frontmost app, window, selection, text field status)
/// at voice dictation activation time using Accessibility APIs.
struct DictationContextCapture {

    /// Text-input roles that indicate the cursor is in a text field.
    private static let textFieldRoles: Set<String> = [
        "AXTextArea", "AXTextField", "AXTextView", "AXComboBox", "AXSearchField"
    ]

    /// Capture the current context synchronously. Returns sensible defaults when
    /// Accessibility permissions are unavailable or the frontmost app can't be queried.
    static func capture() -> DictationContext {
        guard let frontApp = NSWorkspace.shared.frontmostApplication else {
            log.warning("No frontmost application — returning empty context")
            return DictationContext(
                bundleIdentifier: "",
                appName: "",
                windowTitle: "",
                selectedText: nil,
                cursorInTextField: false
            )
        }

        let bundleIdentifier = frontApp.bundleIdentifier ?? ""

        // Skip capturing our own app's context during voice activation
        // (Bundle.main.bundleIdentifier is nil in SPM builds, so use hardcoded ID)
        if bundleIdentifier == "com.vellum.vellum-assistant" {
            log.info("Frontmost app is self — returning default context")
            return DictationContext(
                bundleIdentifier: bundleIdentifier,
                appName: frontApp.localizedName ?? "vellum-assistant",
                windowTitle: "",
                selectedText: nil,
                cursorInTextField: false
            )
        }

        let appName = frontApp.localizedName ?? "Unknown"
        let pid = frontApp.processIdentifier

        let appElement = AXUIElementCreateApplication(pid)

        // Prevent indefinite blocking if the target app is hung (matches
        // AccessibilityTree.swift and AmbientAXCapture.swift patterns)
        AXUIElementSetMessagingTimeout(appElement, 5.0)

        // Window title via focused window
        let windowTitle = axWindowTitle(appElement: appElement)

        // Selected text and text-field check via focused UI element
        let (selectedText, cursorInTextField) = axFocusedElementInfo(appElement: appElement)

        log.info("Captured context: app=\(appName, privacy: .public), window=\"\(windowTitle, privacy: .public)\", selected=\(selectedText != nil), inTextField=\(cursorInTextField)")

        return DictationContext(
            bundleIdentifier: bundleIdentifier,
            appName: appName,
            windowTitle: windowTitle,
            selectedText: selectedText,
            cursorInTextField: cursorInTextField
        )
    }

    // MARK: - AX Helpers

    /// Get the title of the focused window for the given app element.
    private static func axWindowTitle(appElement: AXUIElement) -> String {
        var windowValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowValue) == .success,
              let windowRef = windowValue else {
            log.debug("Could not get focused window — AX permission may be missing")
            return ""
        }
        guard CFGetTypeID(windowRef as CFTypeRef) == AXUIElementGetTypeID() else { return "" }
        let window = windowRef as! AXUIElement
        return axStringAttribute(window, kAXTitleAttribute as CFString) ?? ""
    }

    /// Get selected text and whether the focused element is a text field.
    private static func axFocusedElementInfo(appElement: AXUIElement) -> (selectedText: String?, cursorInTextField: Bool) {
        var focusedValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedValue) == .success,
              let focusedRef = focusedValue else {
            log.debug("Could not get focused UI element")
            return (nil, false)
        }
        guard CFGetTypeID(focusedRef as CFTypeRef) == AXUIElementGetTypeID() else { return (nil, false) }
        let focused = focusedRef as! AXUIElement

        // Selected text
        let selectedText = axStringAttribute(focused, kAXSelectedTextAttribute as CFString)

        // Role check for text field
        let role = axStringAttribute(focused, kAXRoleAttribute as CFString) ?? ""
        let cursorInTextField = textFieldRoles.contains(role)

        return (selectedText, cursorInTextField)
    }

    /// Read a string attribute from an AX element, returning nil on failure.
    private static func axStringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        return value as? String
    }
}
