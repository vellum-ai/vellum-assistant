#if os(macOS)
import AppKit

/// Routes Return key presses in the composer based on modifier keys and
/// the user's send-mode preference.
///
/// **Default mode** (Return to send):
///   - Return, Cmd+Return, Ctrl+Return → send
///   - Shift+Return → insert newline
///   - Option+Return → send
///
/// **Cmd+Enter mode:**
///   - Cmd+Return → send
///   - All other Return variants → insert newline
enum ComposerReturnKeyRouting {
    enum Action: Equatable {
        case send
        case insertNewline
    }

    static func resolve(cmdEnterToSend: Bool, modifiers: NSEvent.ModifierFlags) -> Action {
        // Mask to only the four modifier keys we care about so that
        // incidental flags (capsLock, function, numericPad) don't break
        // equality checks.
        let keys = modifiers.intersection([.shift, .command, .control, .option])

        if cmdEnterToSend {
            if keys == .command { return .send }
            return .insertNewline
        }

        if keys == .shift { return .insertNewline }
        if keys == .option { return .send }
        return .send
    }

}
#endif
