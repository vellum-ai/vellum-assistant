#if os(macOS)
import AppKit

final class ComposerTextView: NSTextView {

    // MARK: - Properties

    var placeholderString: String = ""
    var cmdEnterToSend: Bool = false
    var onSubmit: (() -> Void)?
    var onTab: (() -> Bool)?        // return true = handled
    var onUpArrow: (() -> Bool)?
    var onDownArrow: (() -> Bool)?
    var onEscape: (() -> Bool)?
    var onPasteImage: (() -> Void)?

    // MARK: - Placeholder Drawing

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        // Draw placeholder when string is empty and placeholder is set
        guard string.isEmpty, !placeholderString.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 13),
            .foregroundColor: NSColor.placeholderTextColor,
        ]
        let inset = textContainerInset
        let padding = textContainer?.lineFragmentPadding ?? 5
        let rect = NSRect(
            x: inset.width + padding,
            y: inset.height,
            width: bounds.width - inset.width * 2 - padding * 2,
            height: bounds.height - inset.height * 2
        )
        placeholderString.draw(in: rect, withAttributes: attrs)
    }

    override var string: String {
        didSet { needsDisplay = true }
    }

    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        needsDisplay = true
        return result
    }

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        needsDisplay = true
        return result
    }

    // MARK: - Key Routing

    override func keyDown(with event: NSEvent) {
        // [IME guard] Skip all custom handling during composition
        if hasMarkedText() {
            super.keyDown(with: event)
            return
        }

        let modifiers = event.modifierFlags.intersection([.shift, .command, .control, .option])
        let isReturn = event.keyCode == 36 || event.keyCode == 76

        if isReturn {
            let action = ComposerReturnKeyRouting.resolve(
                cmdEnterToSend: cmdEnterToSend,
                modifiers: modifiers
            )
            switch action {
            case .bridgeSend:
                onSubmit?()
                return
            case .bridgeInsertNewline:
                insertText("\n", replacementRange: selectedRange())
                return
            case .deferToSubmit:
                // Only send for plain Return (no modifiers).
                // Cmd+Return in default mode falls through to super.
                if modifiers.isEmpty {
                    onSubmit?()
                    return
                }
                super.keyDown(with: event)
                return
            }
        }

        // Tab (no shift): ghost text accept or slash menu, else insert tab
        if event.keyCode == 48, !modifiers.contains(.shift) {
            if onTab?() == true { return }
            // Fall through to super which inserts a tab character
        }

        // Up arrow: slash menu navigation
        if event.keyCode == 126 {
            if onUpArrow?() == true { return }
        }

        // Down arrow: slash menu navigation
        if event.keyCode == 125 {
            if onDownArrow?() == true { return }
        }

        // Escape: slash menu dismiss
        if event.keyCode == 53 {
            if onEscape?() == true { return }
        }

        super.keyDown(with: event)
    }

    // MARK: - Cmd+V Image Paste

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
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

    /// Check if the pasteboard contains image content (file URLs with image extensions or raw image data).
    static func pasteboardHasImageContent() -> Bool {
        let pasteboard = NSPasteboard.general
        let hasImageFile = (pasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true,
        ]) as? [URL])?.contains { url in
            let ext = url.pathExtension.lowercased()
            return ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp"].contains(ext)
        } ?? false
        let hasImageData = pasteboard.data(forType: .png) != nil || pasteboard.data(forType: .tiff) != nil
        return hasImageFile || hasImageData
    }
}
#endif
