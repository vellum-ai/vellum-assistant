import AppKit
import ApplicationServices
import Carbon

/// The text selected in the application in front.
///
/// Read when the app asks (`selection.read`), which it does once a hold has
/// armed, so a hold made with something highlighted is about what was
/// highlighted. Accessibility first: the focused element's selected text, or
/// its selected range picked out of its value. Where that yields nothing and
/// there is a focused element, a copy keystroke is sent to the application in
/// front and the pasteboard read and put back. The keystroke is posted to that
/// application's process rather than the HID stream, so the raw key monitor
/// that watches the hold never sees it as a chord.
///
/// The read runs on the main thread, which also carries the keyboard monitor,
/// so it is held to short waits: an application that does not answer costs at
/// most a few of `requestTimeoutSeconds` and, when the copy runs,
/// `copyWaitSeconds`.
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
        /// Whether the control the selection sits in takes text, so a hold
        /// asked to change the selection can put the result back over it.
        /// See `isEditable`.
        let editable: Bool
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

    /// The pasteboard types the snapshot below saves and gives back whole:
    /// the text forms, which every browser and editor writes together and
    /// which are held as data rather than promised. Anything else on the
    /// pasteboard, an image, a file, a promised representation, is something
    /// the restore could not put back without waiting on its owner, so no
    /// copy is attempted over it. An empty pasteboard qualifies.
    private static let restorableTypes: Set<NSPasteboard.PasteboardType> = [
        .string,
        .html,
        .rtf,
        NSPasteboard.PasteboardType("public.utf8-plain-text"),
        // The legacy names the system writes beside the modern ones.
        NSPasteboard.PasteboardType("NSStringPboardType"),
        NSPasteboard.PasteboardType("Apple HTML pasteboard type"),
        NSPasteboard.PasteboardType("NeXT Rich Text Format v1.0 pasteboard type"),
        NSPasteboard.PasteboardType("com.apple.webarchive"),
        NSPasteboard.PasteboardType("org.chromium.web-custom-data"),
        NSPasteboard.PasteboardType("org.chromium.source-url"),
    ]

    /// The roles a copied selection can be put back into. A copy proves a
    /// selection by leaving it where it was, so editability has to come from
    /// the control instead: a text control in front is one a paste replaces
    /// the selection in.
    private static let textControlRoles: Set<String> = [
        "AXTextArea", "AXTextField", "AXComboBox", "AXSearchField",
    ]

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
            "trusted=\(trusted) prompt=\(promptShown) app=\(bundleId ?? "-") focused=\(focused) role=\(role ?? "-") path=\(path.rawValue) chars=\(chars) editable=\(selection?.editable ?? false)"
        }
    }

    /// Whether the Accessibility prompt has been shown by this process. Shown
    /// the first time a hold needs a selection and the helper is not trusted,
    /// and not again: the prompt is the system's own dialog, and a hold is
    /// not the moment to keep raising it.
    private nonisolated(unsafe) static var promptedForTrust = false

    /// What the focused control in the application in front is, for a paste
    /// that is about to be sent there.
    ///
    /// A read of its own rather than a by-product of `read()`: that one is
    /// asked once, at the top of a hold, and answers a question about text
    /// the user highlighted. This one is asked at the end, when the words
    /// exist and the only question left is whether anything will take them.
    /// Nothing is copied and no keystroke is sent, so it costs one
    /// Accessibility round trip.
    struct Focus {
        /// Whether the application in front reports a focused element at all.
        let focused: Bool
        /// Whether that element takes text. See `takesText`.
        let takesText: Bool
        let role: String?
        var bundleId: String?
        var trusted = true
        /// Why the focused element could not be read, when it could not be.
        /// Two very different things end up as `focused=false`, and only the
        /// log can tell them apart afterwards: an application that says
        /// nothing is focused, and one that did not answer in time.
        var error: AXError?

        var logLine: String {
            "trusted=\(trusted) app=\(bundleId ?? "-") focused=\(focused) role=\(role ?? "-") takesText=\(takesText) err=\(error.map { String($0.rawValue) } ?? "-")"
        }
    }

    /// Where a paste sent to the application in front would land.
    ///
    /// Untrusted reads as somewhere to paste. Without the Accessibility grant
    /// this cannot see a text field that is genuinely there, and withholding
    /// the words on a read that cannot see anything would turn a missing
    /// permission into dictation that never types.
    static func readFocus() -> Focus {
        guard AXIsProcessTrusted() else {
            return Focus(
                focused: false,
                takesText: true,
                role: nil,
                bundleId: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
                trusted: false
            )
        }
        let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let systemWide = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(systemWide, requestTimeoutSeconds)
        var focusedRef: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(
            systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef
        )
        guard status == .success,
            let focusedValue = focusedRef,
            CFGetTypeID(focusedValue) == AXUIElementGetTypeID()
        else {
            // **Only a conclusive answer withholds the paste.** `noValue` and
            // `attributeUnsupported` are the application saying there is
            // nothing focused, which is the whole case this read exists to
            // find. Everything else is this side failing to ask: the 50ms
            // timeout expiring as `cannotComplete`, the API off, an answer
            // that is not an element. A failure to ask has not seen the text
            // field it would be withholding from, so it answers the way an
            // untrusted read does.
            let conclusive = status == .noValue || status == .attributeUnsupported
            return Focus(
                focused: false,
                takesText: !conclusive,
                role: nil,
                bundleId: bundleId,
                error: status == .success ? nil : status
            )
        }
        let focused = focusedValue as! AXUIElement
        AXUIElementSetMessagingTimeout(focused, requestTimeoutSeconds)
        let role = stringAttribute(focused, kAXRoleAttribute as CFString)
        return Focus(
            focused: true,
            takesText: takesText(focused, role: role),
            role: role,
            bundleId: bundleId
        )
    }

    /// Whether text pasted right now would land in this element.
    ///
    /// Settability decides it wherever the element will say. Yes is yes, and
    /// **a settable-but-false answer is a no that nothing below overturns**:
    /// a disabled or read-only text field has a text control's role and a
    /// caret's attributes, and taking the role as a second opinion would hand
    /// it a paste and call the words delivered.
    ///
    /// The rest is for the elements that will not say. A settability answer
    /// the element did not give proves nothing either way, so the two weaker
    /// marks get their turn: a text control's role, and a selected text
    /// range, which is the generic sign of something with a caret in it and
    /// catches the editors that answer to neither of the others.
    private static func takesText(_ element: AXUIElement, role: String?) -> Bool {
        if isDisabled(element) {
            return false
        }
        switch settability(element) {
        case .settable:
            return true
        case .fixed:
            return false
        case .unknown:
            break
        }
        if let role, textControlRoles.contains(role) {
            return true
        }
        var rangeRef: CFTypeRef?
        return AXUIElementCopyAttributeValue(
            element, kAXSelectedTextRangeAttribute as CFString, &rangeRef
        ) == .success
    }

    /// What an element says about writing its text: that it can be written,
    /// that it cannot, or nothing usable. The third is its own answer because
    /// the two weaker marks in `takesText` are only worth asking once this
    /// one has come back empty.
    private enum Settability {
        case settable
        case fixed
        case unknown
    }

    private static func settability(_ element: AXUIElement) -> Settability {
        var conclusiveNos = 0
        for attribute in [kAXValueAttribute, kAXSelectedTextAttribute] {
            var settable = DarwinBoolean(false)
            let status = AXUIElementIsAttributeSettable(
                element, attribute as CFString, &settable
            )
            if status == .success, settable.boolValue {
                return .settable
            }
            // An attribute the element does not have is a no as firm as an
            // attribute it has and will not let this process write: either
            // way there is nothing here to put text into. Everything else is
            // the ask failing rather than the element answering, the 50ms
            // timeout expiring as `cannotComplete` above all, and proves
            // nothing about the attribute it was asking after.
            if status == .success
                || status == .attributeUnsupported
                || status == .noValue {
                conclusiveNos += 1
            }
        }
        // **Both, or neither.** The two attributes are independent and either
        // one alone establishes editability, so a no from one beside a
        // timeout from the other is not a no about the element. Calling it
        // one would withhold the paste from an editor that was merely slow.
        return conclusiveNos == 2 ? .fixed : .unknown
    }

    /// Whether the element says it is disabled. Only an explicit no counts: a
    /// control that does not report the attribute is not claiming anything,
    /// and this read never withholds a paste on silence.
    private static func isDisabled(_ element: AXUIElement) -> Bool {
        var enabledRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, kAXEnabledAttribute as CFString, &enabledRef
        ) == .success,
            let enabled = enabledRef as? Bool
        else {
            return false
        }
        return !enabled
    }

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
        // A selection Accessibility handed over directly is editable when the
        // element says its text can be set. One that had to be copied out is
        // editable when the focused control is a text control, since the
        // copy says nothing about the control: a canvas editor (Google Docs)
        // answers every Accessibility read with a one-character placeholder
        // and only the copy carries its selection. Known edge: an editor
        // that copies the current line on an empty selection (VS Code) reads
        // as a selection nothing is over.
        let editable = path == .copy
            ? textControlRoles.contains(outcome.role ?? "")
            : isEditable(focused)
        // Whitespace decides only whether anything is selected. What is
        // selected travels as it is: the indentation of a selected snippet is
        // part of what the user is asking about.
        if text.count > maxChars {
            outcome.selection = Selection(
                text: String(text.prefix(maxChars)), truncated: true, editable: editable
            )
        } else {
            outcome.selection = Selection(text: text, truncated: false, editable: editable)
        }
        return outcome
    }

    /// Whether the focused element takes text: its value or its selected text
    /// is reported settable. Text fields and text views say so; static text,
    /// web pages outside a contenteditable and read-only views do not. Asked
    /// rather than inferred from the role because a text view can be
    /// read-only and a web area can be an editor.
    ///
    /// An element that will not say reads as no here. This decides whether a
    /// selection can be written back over, and writing over the user's text
    /// on a guess is the mistake worth avoiding; `takesText` weighs the same
    /// answer the other way, since what it risks is a paste going nowhere.
    private static func isEditable(_ element: AXUIElement) -> Bool {
        settability(element) == .settable
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
    /// What is saved is the pasteboard's text forms, capped in bytes: reading
    /// every representation of everything on the pasteboard is unbounded
    /// work on the keyboard callback (a lazily supplied image waits on its
    /// owner), so a pasteboard holding an image or a file is left alone
    /// rather than replaced with text. The restore mirrors `ActionExecutor`'s
    /// guard: it only happens while the pasteboard still holds the copy, so
    /// a write by anyone else in the meantime is never overwritten.
    private static func selectionFromCopy() -> CopyResult {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            return .nothing
        }
        let pasteboard = NSPasteboard.general
        let types = pasteboard.types ?? []
        if types.contains(where: { !restorableTypes.contains($0) }) {
            return .skipped
        }
        var saved: [(NSPasteboard.PasteboardType, Data)] = []
        var savedBytes = 0
        for type in types {
            guard let data = pasteboard.data(forType: type) else { continue }
            savedBytes += data.count
            if savedBytes > maxRestoredBytes {
                return .skipped
            }
            saved.append((type, data))
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
            for (type, data) in saved {
                pasteboard.setData(data, forType: type)
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
