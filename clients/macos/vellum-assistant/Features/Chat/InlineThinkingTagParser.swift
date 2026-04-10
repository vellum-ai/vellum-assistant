import Foundation

/// A parsed chunk of assistant text — either regular text or extracted
/// `<thinking>` content that should render inside a collapsible
/// ThinkingBlockView. This lets the UI lift inline thinking tags out of
/// the text bubble without requiring any backend or view-model changes.
enum InlineContentChunk: Hashable {
    case text(String)
    case thinking(String)
}

/// Parses assistant response text for `<thinking>...</thinking>` tags,
/// returning an ordered list of chunks. Chunks preserve source order so
/// the caller can render thinking blocks inline at the position they
/// appear in the text.
///
/// An unclosed `<thinking>` tag (common while a response is still
/// streaming in) is treated as an in-progress thinking block containing
/// all remaining text — this way the thinking content streams into the
/// collapsible block as soon as the opening tag arrives, instead of
/// flashing the raw tag until the close tag finally shows up.
///
/// The parser is case-sensitive and only matches the exact lowercase
/// `<thinking>` / `</thinking>` pair emitted by the model.
func parseInlineThinkingTags(_ text: String) -> [InlineContentChunk] {
    // Fast path: no opening tag, return the whole string as a single
    // text chunk. Cheap contains check avoids the full scan below for
    // the vast majority of messages that don't use thinking tags.
    guard text.contains("<thinking>") else {
        return [.text(text)]
    }

    var chunks: [InlineContentChunk] = []
    var cursor = text.startIndex

    while let openRange = text.range(of: "<thinking>", range: cursor..<text.endIndex) {
        // Capture any text between the previous cursor and the opening
        // tag. Keep the original substring (not trimmed) so markdown
        // spacing is preserved when it renders.
        if openRange.lowerBound > cursor {
            let preceding = String(text[cursor..<openRange.lowerBound])
            if !preceding.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                chunks.append(.text(preceding))
            }
        }

        if let closeRange = text.range(of: "</thinking>", range: openRange.upperBound..<text.endIndex) {
            let body = String(text[openRange.upperBound..<closeRange.lowerBound])
            let bodyTrimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            if !bodyTrimmed.isEmpty {
                chunks.append(.thinking(bodyTrimmed))
            }
            cursor = closeRange.upperBound
        } else {
            // Unclosed tag: treat the remainder of the text as
            // streaming thinking content so the user sees it accumulate
            // inside the collapsible block rather than as raw markup.
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

/// Whether the given text contains at least one `<thinking>` opening
/// tag. Exposed as a cheap check callers can run before calling
/// `parseInlineThinkingTags` to decide whether to take the fast path.
func containsInlineThinkingTag(_ text: String) -> Bool {
    text.contains("<thinking>")
}
