import AppKit
import ApplicationServices
import Carbon

/// The text selected in the application in front.
///
/// Read at the moment a hold begins, so a hold made with something highlighted
/// carries what was highlighted. Accessibility first: the focused element's
/// selected text, or its selected range picked out of its value. Where that
/// yields nothing and there is a focused element, a copy keystroke is sent to
/// the application in front and the pasteboard read and put back. The keystroke
/// is posted to that application's process rather than the HID stream, so the
/// raw key monitor that watches the hold never sees it as a chord.
///
/// The read happens on the keyboard event's own thread, ahead of the edge it
/// travels on, so it is held to short waits: an application that does not
/// answer costs the edge at most a few of `requestTimeoutSeconds` and, when the
/// copy runs, `copyWaitSeconds`. The edge carries how long it was held so the
/// far side can take that off its own clock.
enum FrontSelection {
    /// How much of a selection travels. The rest is dropped and flagged.
    static let maxChars = 4000

    /// The longest one Accessibility request is given to answer.
    static let requestTimeoutSeconds: Float = 0.05
    /// How long the pasteboard is given to change after the copy keystroke.
    static let copyWaitSeconds: TimeInterval = 0.12

    struct Selection {
        let text: String
        let truncated: Bool
    }

    /// Where the text came from, for the log. `copySkipped` is a copy that was
    /// not attempted because the pasteboard held something it could not be
    /// given back cheaply.
    enum Path: String {
        case selectedText
        case range
        case copy
        case copySkipped
        case none
    }

    /// The most pasteboard text that is saved and put back around a copy.
    static let maxRestoredBytes = 256 * 1024

    /// The pasteboard types a saved string gives back whole: the one type
    /// the snapshot below reads. Anything else on the pasteboard, an image,
    /// a file, rich text beside its plain text, a legacy string type, is
    /// something the restore could not put back, so no copy is attempted
    /// over it. An empty pasteboard qualifies.
    private static let restorableTypes: Set<NSPasteboard.PasteboardType> = [.string]

    /// Everything a read learned, the text aside: what the log carries. No
    /// user content in here; the bundle id and role name the application and
    /// the kind of control, not what is in them.
    struct Outcome {
        var trusted: Bool
        var promptShown = false
        var bundleId: String?
        var focused = false
        var role: String?
        var path: Path = .none
        var chars = 0
        var selection: Selection?

        var logLine: String {
            "trusted=\(trusted) prompt=\(promptShown) app=\(bundleId ?? "-") focused=\(focused) role=\(role ?? "-") path=\(path.rawValue) chars=\(chars)"
        }
    }

    /// Whether the Accessibility prompt has been shown by this process. Shown
    /// the first time a hold needs a selection and the helper is not trusted,
    /// and not again: the prompt is the system's own dialog, and a hold is
    /// not the moment to keep raising it.
    private nonisolated(unsafe) static var promptedForTrust = false

    /// The current selection, and how it was found.
    static func read() -> Outcome {
        var outcome = Outcome(trusted: AXIsProcessTrusted())
        outcome.bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        if !outcome.trusted {
            if !promptedForTrust {
                promptedForTrust = true
                outcome.promptShown = true
                _ = ActionExecutor.checkAccessibilityPermission(prompt: true)
            }
            return outcome
        }

        let systemWide = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(systemWide, requestTimeoutSeconds)
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef
        ) == .success,
            let focusedValue = focusedRef,
            CFGetTypeID(focusedValue) == AXUIElementGetTypeID()
        else {
            return outcome
        }
        let focused = focusedValue as! AXUIElement
        AXUIElementSetMessagingTimeout(focused, requestTimeoutSeconds)
        outcome.focused = true
        outcome.role = stringAttribute(focused, kAXRoleAttribute as CFString)

        var text = stringAttribute(focused, kAXSelectedTextAttribute as CFString) ?? ""
        var path = Path.selectedText
        if isBlank(text) {
            // Some text views answer the range but not the selected text
            // itself; the value is the whole document, and the range picks
            // the selection out of it.
            text = selectionFromRange(focused) ?? ""
            path = .range
        }
        if isBlank(text) {
            switch selectionFromCopy() {
            case .text(let copied):
                text = copied
                path = .copy
            case .nothing:
                path = .copy
            case .skipped:
                path = .copySkipped
            }
        }
        guard !isBlank(text) else {
            outcome.path = path == .copySkipped ? .copySkipped : .none
            return outcome
        }

        outcome.path = path
        outcome.chars = text.count
        // Whitespace decides only whether anything is selected. What is
        // selected travels as it is: the indentation of a selected snippet is
        // part of what the user is asking about.
        if text.count > maxChars {
            outcome.selection = Selection(text: String(text.prefix(maxChars)), truncated: true)
        } else {
            outcome.selection = Selection(text: text, truncated: false)
        }
        return outcome
    }

    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

    enum CopyResult {
        case text(String)
        case nothing
        case skipped
    }

    /// Copy whatever the application in front has selected and read it off
    /// the pasteboard, then put the pasteboard back as it was. A pasteboard
    /// that does not change inside `copyWaitSeconds` means nothing was
    /// selected, and it is left untouched.
    ///
    /// What is saved is the pasteboard's text, as `ActionExecutor` saves it
    /// around a paste: reading every representation of everything on the
    /// pasteboard is unbounded work on the keyboard callback (a lazily
    /// supplied image waits on its owner), and a pasteboard holding an image
    /// or a file is left alone rather than replaced with text. The restore
    /// also mirrors `ActionExecutor`'s guard: it only happens while the
    /// pasteboard still holds the copy, so a write by anyone else in the
    /// meantime is never overwritten.
    private static func selectionFromCopy() -> CopyResult {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            return .nothing
        }
        let pasteboard = NSPasteboard.general
        let types = pasteboard.types ?? []
        if types.contains(where: { !restorableTypes.contains($0) }) {
            return .skipped
        }
        let savedData = types.contains(.string) ? pasteboard.data(forType: .string) : nil
        if let savedData, savedData.count > maxRestoredBytes {
            return .skipped
        }
        let changeCountBefore = pasteboard.changeCount

        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(kVK_ANSI_C), keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(kVK_ANSI_C), keyDown: false)
        else {
            return .nothing
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.postToPid(pid)
        up.postToPid(pid)

        let deadline = Date().addingTimeInterval(copyWaitSeconds)
        while pasteboard.changeCount == changeCountBefore, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        let changeCountAfterCopy = pasteboard.changeCount
        guard changeCountAfterCopy != changeCountBefore else {
            return .nothing
        }
        let text = pasteboard.string(forType: .string)

        // Only while the pasteboard still holds the copy. Anyone who wrote to
        // it since owns it now, and what was saved is not theirs to lose.
        if pasteboard.changeCount == changeCountAfterCopy {
            pasteboard.clearContents()
            if let savedData {
                pasteboard.setData(savedData, forType: .string)
            }
        }
        return text.map { .text($0) } ?? .nothing
    }

    private static func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        return value as? String
    }
}
