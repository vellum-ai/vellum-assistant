import Foundation

/// A parsed chunk of assistant text — either regular text or extracted
/// `<thinking>` content that should render inside a collapsible
/// ThinkingBlockView. This lets the UI lift inline thinking tags out of
/// the text bubble without requiring any backend or view-model changes.
enum InlineContentChunk: Hashable {
    case text(String)
    case thinking(String)
}

/// Parses assistant response text for `<thinking>...</thinking>` or
/// `<think>...</think>` thinking tags, returning an ordered list of chunks.
/// The `<think>` format is used by MiniMax models.
func parseInlineThinkingTags(_ text: String) -> [InlineContentChunk] {
    // Fast path: no opening tag, return the whole string as a single
    // text chunk.
    guard containsInlineThinkingTag(text) else {
        return [.text(text)]
    }

    var chunks: [InlineContentChunk] = []
    var cursor = text.startIndex

    // Define tag pairs: opening -> closing
    // Note: <think>/</think> is MiniMax's format; <thinking>/</thinking> is the standard format
    let tagPairs: [(open: String, close: String)] = [
        ("<thinking>", "</thinking>"),
        ("<think>", "</think>"),
    ]

    while true {
        // Find the next opening tag of either type
        var earliestRange: Range<String.Index>? = nil
        var earliestOpenTag: String? = nil

        for pair in tagPairs {
            if let range = text.range(of: pair.open, range: cursor..<text.endIndex) {
                if earliestRange == nil || range.lowerBound < earliestRange!.lowerBound {
                    earliestRange = range
                    earliestOpenTag = pair.open
                }
            }
        }

        guard let openRange = earliestRange, let openTag = earliestOpenTag else {
            break
        }

        // Capture any text between the previous cursor and the opening tag.
        if openRange.lowerBound > cursor {
            let preceding = String(text[cursor..<openRange.lowerBound])
            if !preceding.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                chunks.append(.text(preceding))
            }
        }

        // Find the corresponding closing tag
        guard let pair = tagPairs.first(where: { $0.open == openTag }) else {
            break
        }
        let closeTag = pair.close

        if let closeRange = text.range(of: closeTag, range: openRange.upperBound..<text.endIndex) {
            let body = String(text[openRange.upperBound..<closeRange.lowerBound])
            let bodyTrimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            if !bodyTrimmed.isEmpty {
                chunks.append(.thinking(bodyTrimmed))
            }
            cursor = closeRange.upperBound
        } else {
            // Unclosed tag: streaming thinking content
            let body = String(text[openRange.upperBound..<text.endIndex])
            let bodyTrimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            if !bodyTrimmed.isEmpty {
                chunks.append(.thinking(bodyTrimmed))
            }
            return chunks
        }
    }

    // Flush any trailing text after the last closing tag.
    if cursor < text.endIndex {
        let trailing = String(text[cursor..<text.endIndex])
        if !trailing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            chunks.append(.text(trailing))
        }
    }

    return chunks
}

/// Whether the given text contains at least one thinking opening
/// tag. Exposed as a cheap check callers can run before calling
/// `parseInlineThinkingTags` to decide whether to take the fast path.
func containsInlineThinkingTag(_ text: String) -> Bool {
    text.contains("<thinking>") || text.contains("<think>")
}
