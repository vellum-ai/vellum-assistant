import Foundation

/// Decides whether an AppleScript seizes the keyboard, pointer or focus the way
/// a posted event does. Most scripts ask one app to do something and leave the
/// user's input alone. A script that goes through System Events (keystrokes,
/// key codes, UI clicks) or calls `activate` takes the machine over instead.
public enum AppleScriptInputTakeover {
    public static func takesOver(script: String) -> Bool {
        let normalized = script
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .lowercased()
        if normalized.contains("system events") { return true }
        // A whole word, so `activated` and `deactivate` do not match.
        return normalized.contains(/\bactivate\b/)
    }
}
