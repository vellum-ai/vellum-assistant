#if os(macOS)
import AppKit

/// Routes Return key presses in the composer based on modifier keys and the user's send-mode preference.
/// Only Shift+Return (default mode) and Cmd+Return (cmd-enter mode) are intercepted;
/// all other combinations defer to SwiftUI's `.onSubmit` handler.
enum ComposerReturnKeyRouting {
    enum Action: Equatable {
        case bridgeSend
        case bridgeInsertNewline
        case deferToSubmit
    }

    static func resolve(cmdEnterToSend: Bool, modifiers: NSEvent.ModifierFlags) -> Action {
        // Strip device-independent modifier flags to compare only modifier keys
        let keys = modifiers.intersection(.deviceIndependentFlagsMask)

        if !cmdEnterToSend && keys == .shift {
            return .bridgeInsertNewline
        }
        if cmdEnterToSend && keys == .command {
            return .bridgeSend
        }
        return .deferToSubmit
    }
}
#endif
