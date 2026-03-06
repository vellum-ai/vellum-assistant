import AppKit
import Carbon.HIToolbox

/// Utilities for converting between the string shortcut representation
/// (e.g. "cmd+shift+space") and macOS modifier flags / display symbols.
enum ShortcutHelper {

    /// Converts a shortcut string like "cmd+shift+space" to a human-readable
    /// display string like "Command Shift Space".
    static func displayString(for shortcut: String) -> String {
        guard !shortcut.isEmpty else { return "None" }
        let parts = shortcut.lowercased().split(separator: "+").map(String.init)
        return parts.map { displayToken($0) }.joined(separator: " ")
    }

    /// Parses a shortcut string into modifier flags and a key string suitable
    /// for matching against `NSEvent.charactersIgnoringModifiers`.
    static func parseShortcut(_ shortcut: String) -> (NSEvent.ModifierFlags, String) {
        guard !shortcut.isEmpty else { return ([], "") }
        let parts = shortcut.lowercased().split(separator: "+").map(String.init)
        var modifiers: NSEvent.ModifierFlags = []
        var key = ""

        for part in parts {
            switch part {
            case "cmd", "command":
                modifiers.insert(.command)
            case "shift":
                modifiers.insert(.shift)
            case "opt", "alt", "option":
                modifiers.insert(.option)
            case "ctrl", "control":
                modifiers.insert(.control)
            case "fn":
                modifiers.insert(.function)
            case "plus":
                key = "+"
            default:
                key = keyString(for: part)
            }
        }

        return (modifiers, key)
    }

    /// Builds a shortcut string from modifier flags and a key code/characters,
    /// as captured from an NSEvent during recording.
    static func shortcutString(from modifiers: NSEvent.ModifierFlags, key: String, keyCode: UInt16) -> String {
        // Strip .numericPad — macOS implicitly sets it on arrow key events and it
        // shouldn't participate in shortcut matching.
        let mods = modifiers.subtracting(.numericPad)
        var parts: [String] = []
        if mods.contains(.function) { parts.append("fn") }
        if mods.contains(.control) { parts.append("ctrl") }
        if mods.contains(.option) { parts.append("opt") }
        if mods.contains(.shift) { parts.append("shift") }
        if mods.contains(.command) { parts.append("cmd") }

        let keyPart = keyName(for: key, keyCode: keyCode)
        parts.append(keyPart == "+" ? "plus" : keyPart)
        return parts.joined(separator: "+")
    }

    /// Splits a shortcut string into a normalized set of tokens for
    /// order-independent comparison (e.g. "shift+cmd+g" and "cmd+shift+g" both
    /// produce {"shift", "cmd", "g"}).
    static func normalizeShortcut(_ shortcut: String) -> Set<String> {
        Set(shortcut.lowercased().split(separator: "+").map(String.init))
    }

    /// Converts NSEvent modifier flags to the Carbon modifier mask used by `RegisterEventHotKey`.
    static func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
        var mods: UInt32 = 0
        if flags.contains(.command) { mods |= UInt32(cmdKey) }
        if flags.contains(.shift) { mods |= UInt32(shiftKey) }
        if flags.contains(.option) { mods |= UInt32(optionKey) }
        if flags.contains(.control) { mods |= UInt32(controlKey) }
        return mods
    }

    /// Returns a display string for the currently held modifier keys (e.g. "⌃ ⇧ ⌘").
    /// Used during shortcut recording to show which modifiers the user is pressing.
    static func modifierDisplayString(from flags: NSEvent.ModifierFlags) -> String {
        var parts: [String] = []
        if flags.contains(.control) { parts.append("\u{2303}") }
        if flags.contains(.option) { parts.append("\u{2325}") }
        if flags.contains(.shift) { parts.append("\u{21E7}") }
        if flags.contains(.command) { parts.append("\u{2318}") }
        return parts.joined(separator: " ")
    }

    // MARK: - Private

    private static func displayToken(_ token: String) -> String {
        switch token {
        case "plus": return "+"
        case "cmd", "command": return "\u{2318}"
        case "shift": return "\u{21E7}"
        case "opt", "alt", "option": return "\u{2325}"
        case "ctrl", "control": return "\u{2303}"
        case "fn": return "Fn"
        case "space": return "Space"
        case "return", "enter": return "\u{21A9}"
        case "tab": return "\u{21E5}"
        case "delete", "backspace": return "\u{232B}"
        case "escape", "esc": return "\u{238B}"
        case "up": return "\u{2191}"
        case "down": return "\u{2193}"
        case "left": return "\u{2190}"
        case "right": return "\u{2192}"
        default:
            return token.uppercased()
        }
    }

    /// Maps a token from the shortcut string to the value used for matching
    /// against `NSEvent.charactersIgnoringModifiers`.
    private static func keyString(for token: String) -> String {
        switch token {
        case "space": return " "
        case "return", "enter": return "\r"
        case "tab": return "\t"
        case "escape", "esc": return "\u{1B}"
        case "delete", "backspace": return "\u{7F}"
        case "up": return String(Character(UnicodeScalar(NSUpArrowFunctionKey)!))
        case "down": return String(Character(UnicodeScalar(NSDownArrowFunctionKey)!))
        case "left": return String(Character(UnicodeScalar(NSLeftArrowFunctionKey)!))
        case "right": return String(Character(UnicodeScalar(NSRightArrowFunctionKey)!))
        default:
            return token.lowercased()
        }
    }

    /// Converts a captured key event back into the canonical token name
    /// for the shortcut string format.
    private static func keyName(for characters: String, keyCode: UInt16) -> String {
        // Handle space explicitly (keyCode 49)
        if keyCode == 49 || characters == " " { return "space" }
        if characters == "\r" { return "return" }
        if characters == "\t" { return "tab" }

        // Single printable character
        if characters.count == 1, let scalar = characters.unicodeScalars.first {
            if scalar.value == NSUpArrowFunctionKey { return "up" }
            if scalar.value == NSDownArrowFunctionKey { return "down" }
            if scalar.value == NSLeftArrowFunctionKey { return "left" }
            if scalar.value == NSRightArrowFunctionKey { return "right" }
        }

        return characters.lowercased()
    }
}
