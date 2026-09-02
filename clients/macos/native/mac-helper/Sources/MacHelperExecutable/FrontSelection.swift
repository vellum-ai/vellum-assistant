import AppKit
import ApplicationServices

/// The text selected in the application in front, read over Accessibility.
///
/// Read at the moment a hold begins, so a hold made with something highlighted
/// carries what was highlighted. Accessibility is the only way in: a copy
/// keystroke would land on the app in front while the hold's own modifiers are
/// still down, and the hold detector would read the key as a chord and drop the
/// hold. Applications that expose no selection over Accessibility (a terminal,
/// a canvas) read as having none.
enum FrontSelection {
    /// How much of a selection travels. The rest is dropped and flagged.
    static let maxChars = 4000

    struct Selection {
        let text: String
        let truncated: Bool
    }

    /// The current selection, or nil where there is none or it cannot be read.
    static func read() -> Selection? {
        guard AXIsProcessTrusted() else { return nil }

        let systemWide = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(systemWide, 0.25)
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef
        ) == .success,
            let focusedValue = focusedRef,
            CFGetTypeID(focusedValue) == AXUIElementGetTypeID()
        else {
            return nil
        }
        let focused = focusedValue as! AXUIElement
        AXUIElementSetMessagingTimeout(focused, 0.25)

        var text = stringAttribute(focused, kAXSelectedTextAttribute as CFString) ?? ""
        if text.isEmpty {
            // Some text views answer the range but not the selected text
            // itself; the value is the whole document, and the range picks
            // the selection out of it.
            text = selectionFromRange(focused) ?? ""
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if trimmed.count > maxChars {
            return Selection(text: String(trimmed.prefix(maxChars)), truncated: true)
        }
        return Selection(text: trimmed, truncated: false)
    }

    private static func selectionFromRange(_ element: AXUIElement) -> String? {
        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, kAXSelectedTextRangeAttribute as CFString, &rangeRef
        ) == .success,
            let rangeValue = rangeRef,
            CFGetTypeID(rangeValue) == AXValueGetTypeID()
        else {
            return nil
        }
        var range = CFRange()
        guard AXValueGetValue(rangeValue as! AXValue, .cfRange, &range), range.length > 0 else {
            return nil
        }
        guard let value = stringAttribute(element, kAXValueAttribute as CFString) else {
            return nil
        }
        let utf16 = value.utf16
        guard range.location >= 0,
              range.location + range.length <= utf16.count,
              let start = utf16.index(utf16.startIndex, offsetBy: range.location, limitedBy: utf16.endIndex),
              let end = utf16.index(start, offsetBy: range.length, limitedBy: utf16.endIndex)
        else {
            return nil
        }
        return String(utf16[start..<end])
    }

    private static func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        return value as? String
    }
}
