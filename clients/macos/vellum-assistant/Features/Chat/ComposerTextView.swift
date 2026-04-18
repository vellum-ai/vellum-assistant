#if os(macOS)
import AppKit

/// NSTextView subclass powering the chat composer input.
///
/// Handles placeholder drawing, Return/Tab/Arrow/Escape key routing
/// (via ``ComposerReturnKeyRouting``), Cmd+V image-paste interception,
/// and focus-change callbacks.
///
/// Ref: https://developer.apple.com/documentation/appkit/nstextview
final class ComposerTextView: NSTextView {

    // MARK: - Properties

    var cmdEnterToSend: Bool = false
    var onSubmit: (() -> Void)?
    var onTab: (() -> Bool)?
    var onUpArrow: (() -> Bool)?
    var onDownArrow: (() -> Bool)?
    var onEscape: (() -> Bool)?
    var onPasteImage: (() -> Void)?
    var onFocusChanged: ((Bool) -> Void)?
    /// When this returns `true`, Return bypasses ``ComposerReturnKeyRouting``
    /// and fires ``onSubmit`` directly. Used to let active picker popups
    /// (emoji, slash commands) intercept Return regardless of the
    /// send-mode preference.
    var shouldOverrideReturn: (() -> Bool)?

    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if result { onFocusChanged?(true) }
        needsDisplay = true
        return result
    }

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result { onFocusChanged?(false) }
        needsDisplay = true
        return result
    }

    // MARK: - Key Routing

    override func keyDown(with event: NSEvent) {
        if hasMarkedText() {
            super.keyDown(with: event)
            return
        }

        let modifiers = event.modifierFlags.intersection([.shift, .command, .control, .option])
        let isReturn = event.keyCode == 36 || event.keyCode == 76

        if isReturn {
            if shouldOverrideReturn?() == true {
                onSubmit?()
                return
            }
            let action = ComposerReturnKeyRouting.resolve(
                cmdEnterToSend: cmdEnterToSend,
                modifiers: modifiers
            )
            switch action {
            case .send:
                onSubmit?()
                return
            case .insertNewline:
                insertText("\n", replacementRange: selectedRange())
                return
            }
        }

        if event.keyCode == 48, !modifiers.contains(.shift) {
            if onTab?() == true { return }
            return  // Prevent NSTextView from inserting a literal tab character
        }

        if event.keyCode == 126 {
            if onUpArrow?() == true { return }
        }

        if event.keyCode == 125 {
            if onDownArrow?() == true { return }
        }

        if event.keyCode == 53 {
            if onEscape?() == true { return }
        }

        super.keyDown(with: event)
    }

    // MARK: - Paste

    /// Force text paste to read only the pasteboard's plain-text type,
    /// bypassing NSTextView's default preference for RTF/HTML. Rich
    /// sources (Claude, web pages) otherwise route through an attributed-
    /// string conversion that mangles newlines, list indentation, and
    /// bullet characters before `isRichText == false` strips attributes.
    ///
    /// Image content is diverted to ``onPasteImage`` so attachments still
    /// work via the Edit → Paste menu as well as Cmd+V.
    ///
    /// Refs:
    /// - https://developer.apple.com/documentation/appkit/nstext/pasteasplaintext(_:)
    /// - https://developer.apple.com/documentation/appkit/nstext/isrichtext
    override func paste(_ sender: Any?) {
        if Self.pasteboardHasImageContent(), let onPasteImage {
            onPasteImage()
            return
        }
        pasteAsPlainText(sender)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder == self else {
            return super.performKeyEquivalent(with: event)
        }
        let modifiers = event.modifierFlags.intersection([.shift, .command, .control, .option])
        if modifiers == [.command],
           event.charactersIgnoringModifiers?.lowercased() == "v",
           Self.pasteboardHasImageContent(),
           let onPasteImage {
            onPasteImage()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    static func pasteboardHasImageContent() -> Bool {
        let pasteboard = NSPasteboard.general
        let hasImageFile = (pasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true,
        ]) as? [URL])?.contains { url in
            let ext = url.pathExtension.lowercased()
            return ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tiff", "bmp"].contains(ext)
        } ?? false
        let hasImageData = pasteboard.data(forType: .png) != nil || pasteboard.data(forType: .tiff) != nil
        return hasImageFile || hasImageData
    }
}
#endif
