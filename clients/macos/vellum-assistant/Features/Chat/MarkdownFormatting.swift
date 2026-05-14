#if os(macOS)
import AppKit

/// Pure helpers for applying markdown formatting markers around a text
/// selection. Used by ``ComposerTextView`` to handle Cmd+B / Cmd+I /
/// Cmd+Shift+X / Cmd+Shift+C shortcuts.
///
/// The logic mirrors the web implementation in
/// `vellum-assistant-platform/web/src/components/app/assistant/ChatComposer/markdown-formatting.ts`
/// so both platforms produce identical results for the same input.
enum MarkdownFormatting {

    struct Result: Equatable {
        let text: String
        let selectionStart: Int
        let selectionEnd: Int
    }

    /// Apply a markdown marker around the selected range in `text`.
    ///
    /// - **Selection present**: wraps with markers (`**selected**`), or
    ///   removes them if the selection is already wrapped (toggle-off).
    /// - **Empty cursor**: inserts paired markers with cursor between
    ///   (`**|**`).
    ///
    /// All indices are UTF-16 offsets to match `NSTextView.selectedRange()`.
    static func apply(
        text: String,
        selectionStart: Int,
        selectionEnd: Int,
        marker: String
    ) -> Result {
        let utf16 = Array(text.utf16)
        let markerUTF16 = Array(marker.utf16)
        let mLen = markerUTF16.count

        if selectionStart == selectionEnd {
            // Empty cursor — insert paired markers with cursor between.
            var result = utf16
            result.insert(contentsOf: markerUTF16, at: selectionStart)
            result.insert(contentsOf: markerUTF16, at: selectionStart + mLen)
            let newText = String(utf16CodeUnits: result, count: result.count)
            let cursor = selectionStart + mLen
            return Result(text: newText, selectionStart: cursor, selectionEnd: cursor)
        }

        // Check if the selection is already wrapped by this marker.
        let beforeStart = selectionStart - mLen
        let afterEnd = selectionEnd + mLen
        if beforeStart >= 0,
           afterEnd <= utf16.count,
           Array(utf16[beforeStart..<selectionStart]) == markerUTF16,
           Array(utf16[selectionEnd..<afterEnd]) == markerUTF16 {
            // Toggle off — remove the wrapping markers.
            var result = utf16
            result.removeSubrange(selectionEnd..<afterEnd)
            result.removeSubrange(beforeStart..<selectionStart)
            let newText = String(utf16CodeUnits: result, count: result.count)
            return Result(
                text: newText,
                selectionStart: beforeStart,
                selectionEnd: beforeStart + (selectionEnd - selectionStart)
            )
        }

        // Wrap selection with markers.
        var result = utf16
        result.insert(contentsOf: markerUTF16, at: selectionEnd)
        result.insert(contentsOf: markerUTF16, at: selectionStart)
        let newText = String(utf16CodeUnits: result, count: result.count)
        return Result(
            text: newText,
            selectionStart: selectionStart + mLen,
            selectionEnd: selectionEnd + mLen
        )
    }

    /// Match a key event to a markdown formatting marker, or return `nil`
    /// if the event doesn't correspond to a formatting shortcut.
    ///
    /// - Cmd+B → `**` (bold)
    /// - Cmd+I → `*` (italic)
    /// - Cmd+Shift+X → `~~` (strikethrough)
    /// - Cmd+Shift+C → `` ` `` (inline code)
    static func matchShortcut(modifiers: NSEvent.ModifierFlags, key: String) -> String? {
        let mods = modifiers.intersection([.shift, .command, .control, .option])
        let lowered = key.lowercased()

        if mods == .command {
            switch lowered {
            case "b": return "**"
            case "i": return "*"
            default: return nil
            }
        }

        if mods == [.command, .shift] {
            switch lowered {
            case "x": return "~~"
            case "c": return "`"
            default: return nil
            }
        }

        return nil
    }
}
#endif
