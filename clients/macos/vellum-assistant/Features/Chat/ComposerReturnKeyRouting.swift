#if os(macOS)
import AppKit

/// Routes Return key presses in the composer based on modifier keys and the user's send-mode preference.
/// In default mode, Shift+Return is the only newline shortcut and Option+Return
/// is treated as send via the bridge. In cmd-enter mode, only Cmd+Return sends;
/// all other combinations defer to SwiftUI's `.onSubmit` handler.
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

        if !cmdEnterToSend {
            if keys == .shift {
                return .bridgeInsertNewline
            }
            if keys == .option {
                return .bridgeSend
            }
        }
        if cmdEnterToSend && keys == .command {
            return .bridgeSend
        }
        return .deferToSubmit
    }
}
#endif
