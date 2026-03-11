import ApplicationServices
import AppKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "DictationContext")

/// Context captured at Fn-hold activation time, describing the user's current app state.
/// This is the Swift-side struct — it will be mapped to message types in M3.
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

        // Selected text — try AX first, fall back to clipboard for apps like
        // Chrome/Google Docs where AX returns whitespace instead of the real selection.
        var selectedText = axStringAttribute(focused, kAXSelectedTextAttribute as CFString)
        if let text = selectedText, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // AX returned real content — use it
        } else if selectedText != nil {
            // AX returned whitespace-only — try clipboard fallback
            log.info("AX selectedText is whitespace-only, trying clipboard fallback")
            if let clipboardText = clipboardSelectedText() {
                selectedText = clipboardText
            } else {
                selectedText = nil
            }
        }

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

    /// Capture selected text via clipboard (Cmd+C) as fallback for apps where AX
    /// doesn't return the real selection (e.g. Chrome with Google Docs).
    /// Saves and restores the previous clipboard contents.
    private static func clipboardSelectedText() -> String? {
        let pasteboard = NSPasteboard.general
        let changeCount = pasteboard.changeCount

        // Save all existing clipboard items with all their types
        let savedItems: [[(NSPasteboard.PasteboardType, Data)]] = (pasteboard.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in
                guard let data = item.data(forType: type) else { return nil }
                return (type, data)
            }
        }

        // Simulate Cmd+C
        let source = CGEventSource(stateID: .hidSystemState)
        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 8, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 8, keyDown: false) else {
            return nil
        }
        keyDown.flags = .maskCommand
        keyUp.flags = .maskCommand
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)

        // Poll for clipboard change with run loop alive so the target app
        // can process the Cmd+C keystroke and update the clipboard.
        // Use a generous timeout — busy apps or large selections can be slow.
        let copyDeadline = Date().addingTimeInterval(0.5) // 500ms max wait
        while pasteboard.changeCount == changeCount && Date() < copyDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }

        let text: String?
        if pasteboard.changeCount != changeCount {
            // Wait a bit longer after the initial change to let the app finish
            // writing all pasteboard types (the changeCount updates on first write
            // but apps may add multiple representations asynchronously).
            let settleCount = pasteboard.changeCount
            let settleDeadline = Date().addingTimeInterval(0.05)
            while Date() < settleDeadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.01))
            }
            // If the app wrote again during settle, wait a bit more
            if pasteboard.changeCount != settleCount {
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            }

            let raw = pasteboard.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines)
            text = (raw?.isEmpty == true) ? nil : raw
            log.info("Clipboard fallback captured \(text?.count ?? 0) chars")
        } else {
            text = nil
            log.info("Clipboard unchanged after Cmd+C — no selection to copy")
        }

        // Restore previous clipboard contents after copy is fully settled
        pasteboard.clearContents()
        let newItems: [NSPasteboardItem] = savedItems.map { pairs in
            let item = NSPasteboardItem()
            for (type, data) in pairs {
                item.setData(data, forType: type)
            }
            return item
        }
        if !newItems.isEmpty {
            pasteboard.writeObjects(newItems)
        }

        return text
    }
}
