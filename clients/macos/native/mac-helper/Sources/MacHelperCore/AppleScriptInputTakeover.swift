import Foundation

/// Decides whether an AppleScript seizes the keyboard, pointer or focus the way
/// a posted event does. Most scripts ask one app to do something and leave the
/// user's input alone, including read-only System Events queries such as the
/// frontmost process. A script takes the machine over when it drives System
/// Events input (keystrokes, key codes, UI clicks, focus changes) or brings an
/// app forward.
public enum AppleScriptInputTakeover {
    /// System Events commands that deliver input or move focus.
    private static let systemEventsInputVerbs = [
        "keystroke", "key code", "click", "perform action",
        "set focused", "set frontmost", "set value",
    ]

    public static func takesOver(script: String) -> Bool {
        // App names live inside string literals, so the target is read from the
        // whole script. Verbs are read from code only, so a comment or a string
        // that merely mentions one does not count.
        let whole = collapsed(script)
        let code = collapsed(stripLiteralsAndComments(script))

        let targetsSystemEvents = whole.contains("system events") || whole.contains("com.apple.systemevents")
        if targetsSystemEvents, systemEventsInputVerbs.contains(where: { code.contains($0) }) {
            return true
        }
        return code.contains(/\b(activate|reopen)\b/) || code.contains("open location")
    }

    private static func collapsed(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
    }

    /// The script with `"..."` literals, `--` and `#` line comments, and
    /// `(* ... *)` block comments replaced by a space.
    static func stripLiteralsAndComments(_ script: String) -> String {
        var out = ""
        var chars = Array(script)[...]
        while let c = chars.first {
            if c == "\"" {
                chars = chars.dropFirst()
                while let d = chars.first {
                    chars = chars.dropFirst()
                    if d == "\\" { chars = chars.dropFirst() } else if d == "\"" { break }
                }
                out.append(" ")
            } else if c == "(", chars.dropFirst().first == "*" {
                chars = chars.dropFirst(2)
                while !chars.isEmpty, !(chars.first == "*" && chars.dropFirst().first == ")") {
                    chars = chars.dropFirst()
                }
                chars = chars.dropFirst(2)
                out.append(" ")
            } else if (c == "-" && chars.dropFirst().first == "-") || c == "#" {
                while let d = chars.first, d != "\n" { chars = chars.dropFirst() }
                out.append(" ")
            } else {
                out.append(c)
                chars = chars.dropFirst()
            }
        }
        return out
    }
}
