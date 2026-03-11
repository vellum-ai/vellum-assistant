#if os(macOS)
import AppKit

/// Routes Return key presses in the composer based on modifier keys and the user's send-mode preference.
/// In default mode, Shift+Return is the only newline shortcut and Option+Return
/// is treated as send via the bridge. In cmd-enter mode, only Cmd+Return sends;
/// all other Return variants insert a newline via the bridge so the event is
/// consumed before SwiftUI's `.onSubmit` can interfere with the field selection.
enum ComposerReturnKeyRouting {
    enum Action: Equatable {
        case bridgeSend
        case bridgeInsertNewline
        case deferToSubmit
    }

    static func resolve(cmdEnterToSend: Bool, modifiers: NSEvent.ModifierFlags) -> Action {
        // Mask to only the four modifier keys we care about so that
        // incidental flags (capsLock, function, numericPad) don't break
        // equality checks.
        let keys = modifiers.intersection([.shift, .command, .control, .option])

        if cmdEnterToSend {
            if keys == .command { return .bridgeSend }
            // All non-Cmd Return variants insert a newline via the bridge.
            // Deferring to `.onSubmit` caused SwiftUI to select the line
            // instead of inserting a newline.
            return .bridgeInsertNewline
        }

        if keys == .shift {
            return .bridgeInsertNewline
        }
        if keys == .option {
            return .bridgeSend
        }
        return .deferToSubmit
    }

    // Keep bridge interception and `.onSubmit` on the same execution contract
    // so routing tweaks cannot silently diverge from the user-visible behavior.
    @discardableResult
    static func performBridgeAction(
        _ action: Action,
        textView: NSTextView?,
        onSend: () -> Void
    ) -> Bool {
        switch action {
        case .bridgeSend:
            onSend()
            return true
        case .bridgeInsertNewline:
            insertNewline(into: textView)
            return true
        case .deferToSubmit:
            return false
        }
    }

    private static func insertNewline(into textView: NSTextView?) {
        guard let textView else { return }
        textView.insertText("\n", replacementRange: textView.selectedRange())
    }
}
#endif
