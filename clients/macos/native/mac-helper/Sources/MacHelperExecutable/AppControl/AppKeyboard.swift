import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// Per-process keyboard input helper.
///
/// All input is posted via [`CGEvent.postToPid(_:)`](https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:))
/// (the Swift-bridged form of `CGEventPostToPid`) so events are delivered
/// directly to the target process's event queue without affecting whichever
/// app currently has system focus. This intentionally differs from
/// `CGEvent.post(tap:)`, which injects at the system level and would leak
/// to whatever the user has frontmost.
enum AppKeyboard {
    enum Error: LocalizedError {
        case eventCreationFailed
        case unknownKey(String)

        var errorDescription: String? {
            switch self {
            case .eventCreationFailed: return "Failed to create CGEvent"
            case .unknownKey(let key): return "Unknown key: \(key)"
            }
        }
    }

    /// Friendly key name → Carbon `kVK_*` virtual key code.
    static let keyMap: [String: CGKeyCode] = {
        var map: [String: CGKeyCode] = [
            "enter": CGKeyCode(kVK_Return),
            "return": CGKeyCode(kVK_Return),
            "tab": CGKeyCode(kVK_Tab),
            "escape": CGKeyCode(kVK_Escape),
            "space": CGKeyCode(kVK_Space),
            "backspace": CGKeyCode(kVK_Delete),
            "delete": CGKeyCode(kVK_Delete),
            "forwarddelete": CGKeyCode(kVK_ForwardDelete),
            "up": CGKeyCode(kVK_UpArrow),
            "down": CGKeyCode(kVK_DownArrow),
            "left": CGKeyCode(kVK_LeftArrow),
            "right": CGKeyCode(kVK_RightArrow),
        ]

        let letters: [(String, Int)] = [
            ("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C), ("d", kVK_ANSI_D),
            ("e", kVK_ANSI_E), ("f", kVK_ANSI_F), ("g", kVK_ANSI_G), ("h", kVK_ANSI_H),
            ("i", kVK_ANSI_I), ("j", kVK_ANSI_J), ("k", kVK_ANSI_K), ("l", kVK_ANSI_L),
            ("m", kVK_ANSI_M), ("n", kVK_ANSI_N), ("o", kVK_ANSI_O), ("p", kVK_ANSI_P),
            ("q", kVK_ANSI_Q), ("r", kVK_ANSI_R), ("s", kVK_ANSI_S), ("t", kVK_ANSI_T),
            ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W), ("x", kVK_ANSI_X),
            ("y", kVK_ANSI_Y), ("z", kVK_ANSI_Z),
        ]
        for (name, code) in letters {
            map[name] = CGKeyCode(code)
        }

        let digits: [(String, Int)] = [
            ("0", kVK_ANSI_0), ("1", kVK_ANSI_1), ("2", kVK_ANSI_2), ("3", kVK_ANSI_3),
            ("4", kVK_ANSI_4), ("5", kVK_ANSI_5), ("6", kVK_ANSI_6), ("7", kVK_ANSI_7),
            ("8", kVK_ANSI_8), ("9", kVK_ANSI_9),
        ]
        for (name, code) in digits {
            map[name] = CGKeyCode(code)
        }

        let functionKeys: [(String, Int)] = [
            ("f1", kVK_F1), ("f2", kVK_F2), ("f3", kVK_F3), ("f4", kVK_F4),
            ("f5", kVK_F5), ("f6", kVK_F6), ("f7", kVK_F7), ("f8", kVK_F8),
            ("f9", kVK_F9), ("f10", kVK_F10), ("f11", kVK_F11), ("f12", kVK_F12),
        ]
        for (name, code) in functionKeys {
            map[name] = CGKeyCode(code)
        }

        return map
    }()

    /// Translate friendly modifier names (case-insensitive) to a `CGEventFlags`
    /// bitmask. Unknown names are silently ignored.
    static func modifierFlags(_ mods: [String]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for raw in mods {
            switch raw.lowercased() {
            case "cmd", "command":
                flags.insert(.maskCommand)
            case "shift":
                flags.insert(.maskShift)
            case "option", "alt":
                flags.insert(.maskAlternate)
            case "control", "ctrl":
                flags.insert(.maskControl)
            case "fn":
                flags.insert(.maskSecondaryFn)
            default:
                continue
            }
        }
        return flags
    }

    /// Press a single key (with optional modifiers) for `durationMs` and release.
    ///
    /// On `Task` cancellation the key-up is still posted before re-throwing, so
    /// a cancelled press never leaves the key stuck down.
    static func press(pid: pid_t, key: String, modifiers: [String], durationMs: Int) async throws {
        guard let keyCode = keyMap[key.lowercased()] else {
            throw Error.unknownKey(key)
        }
        let flags = modifierFlags(modifiers)

        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true) else {
            throw Error.eventCreationFailed
        }
        down.flags = flags
        down.postToPid(pid)

        do {
            try await Task.sleep(nanoseconds: UInt64(max(0, durationMs)) * 1_000_000)
        } catch {
            postKeyUp(pid: pid, keyCode: keyCode, flags: flags)
            throw error
        }

        postKeyUp(pid: pid, keyCode: keyCode, flags: flags)
    }

    /// Hold multiple keys simultaneously for `durationMs`, then release in
    /// reverse order. Modifier tokens (`cmd`, `shift`, `option`/`alt`,
    /// `control`/`ctrl`, `fn`) inside `keys` are folded into the event flags
    /// applied to each non-modifier key, so callers can pass a combined
    /// shortcut like `["cmd", "shift", "4"]`.
    ///
    /// On `Task` cancellation any keys that were successfully pressed are
    /// released (in reverse order) before re-throwing, so a cancelled combo
    /// never leaves keys stuck down.
    static func combo(pid: pid_t, keys: [String], durationMs: Int) async throws {
        var modifierTokens: [String] = []
        var keyCodes: [CGKeyCode] = []
        keyCodes.reserveCapacity(keys.count)
        for key in keys {
            let lower = key.lowercased()
            if isModifierToken(lower) {
                modifierTokens.append(lower)
                continue
            }
            guard let code = keyMap[lower] else {
                throw Error.unknownKey(key)
            }
            keyCodes.append(code)
        }
        let flags = modifierFlags(modifierTokens)

        var pressedCodes: [CGKeyCode] = []
        pressedCodes.reserveCapacity(keyCodes.count)
        for code in keyCodes {
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) else {
                releaseAll(pid: pid, keyCodes: pressedCodes, flags: flags)
                throw Error.eventCreationFailed
            }
            down.flags = flags
            down.postToPid(pid)
            pressedCodes.append(code)
        }

        do {
            try await Task.sleep(nanoseconds: UInt64(max(0, durationMs)) * 1_000_000)
        } catch {
            releaseAll(pid: pid, keyCodes: pressedCodes, flags: flags)
            throw error
        }

        releaseAll(pid: pid, keyCodes: pressedCodes, flags: flags)
    }

    /// Type a Unicode string by posting per-character key events with
    /// `keyboardSetUnicodeString`. Uses `virtualKey: 0` because the Unicode
    /// string carries the actual character — this lets us type emoji and other
    /// characters that have no virtual-key mapping.
    static func type(pid: pid_t, text: String) async throws {
        for character in text {
            try postUnicode(pid: pid, character: character, keyDown: true)
            try postUnicode(pid: pid, character: character, keyDown: false)
            try await Task.sleep(nanoseconds: 5 * 1_000_000)
        }
    }

    // MARK: - Private helpers

    private static func postKeyUp(pid: pid_t, keyCode: CGKeyCode, flags: CGEventFlags) {
        guard let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
            return
        }
        up.flags = flags
        up.postToPid(pid)
    }

    private static func releaseAll(pid: pid_t, keyCodes: [CGKeyCode], flags: CGEventFlags = []) {
        for code in keyCodes.reversed() {
            postKeyUp(pid: pid, keyCode: code, flags: flags)
        }
    }

    private static func isModifierToken(_ lowercased: String) -> Bool {
        switch lowercased {
        case "cmd", "command", "shift", "option", "alt", "control", "ctrl", "fn":
            return true
        default:
            return false
        }
    }

    private static func postUnicode(pid: pid_t, character: Character, keyDown: Bool) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: keyDown) else {
            throw Error.eventCreationFailed
        }
        let utf16 = Array(String(character).utf16)
        utf16.withUnsafeBufferPointer { buffer in
            if let base = buffer.baseAddress {
                event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
            }
        }
        event.postToPid(pid)
    }
}
