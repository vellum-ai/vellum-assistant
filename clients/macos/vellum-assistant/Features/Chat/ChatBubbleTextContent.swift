import SwiftUI
import VellumAssistantShared

// MARK: - Text Content

extension ChatBubble {
    /// Render a single text segment as a styled bubble, with table and image support.
    @ViewBuilder
    func textBubble(for segmentText: String) -> some View {
        let segments = Self.cachedSegments(for: segmentText)
        let hasRichContent = segments.contains(where: {
            switch $0 {
            case .table, .image, .heading, .codeBlock, .horizontalRule, .list: return true
            case .text: return false
            }
        })

        bubbleChrome {
            if hasRichContent {
                MarkdownSegmentView(segments: segments)
            } else {
                let attributed = Self.cachedInlineMarkdown(for: segmentText)
                Text(attributed)
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundColor(VColor.textPrimary)
                    .tint(VColor.accent)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 520, alignment: .leading)
            }
        }
    }

    /// Cached inline markdown AttributedString to avoid re-parsing on every render.
    /// Uses `inlineMarkdownCache` (not `markdownCache`) to avoid cross-contamination
    /// with `markdownText`, which applies slash-command highlighting before caching.
    static func cachedInlineMarkdown(for text: String) -> AttributedString {
        if let cached = inlineMarkdownCache[text] { return cached }
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        let result = (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
        if inlineMarkdownCache.count >= maxCacheSize {
            // Dictionary iteration order is unspecified; this evicts an arbitrary entry.
            if let first = inlineMarkdownCache.keys.first { inlineMarkdownCache.removeValue(forKey: first) }
        }
        inlineMarkdownCache[text] = result
        return result
    }

    /// Cached markdown segment parser to avoid re-parsing on every render.
    static func cachedSegments(for text: String) -> [MarkdownSegment] {
        if let cached = segmentCache[text] { return cached }
        let result = parseMarkdownSegments(text)
        if segmentCache.count >= maxCacheSize {
            // Dictionary iteration order is unspecified; this evicts an arbitrary entry.
            if let first = segmentCache.keys.first { segmentCache.removeValue(forKey: first) }
        }
        segmentCache[text] = result
        return result
    }

    /// Cached markdown parser to avoid re-parsing on every render.
    var markdownText: AttributedString {
        let textToRender = message.text
        let trimmed = textToRender.trimmingCharacters(in: .whitespacesAndNewlines)

        // Return cached value if available
        if let cached = Self.markdownCache[trimmed] {
            return cached
        }

        // Parse markdown
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        var parsed = (try? AttributedString(markdown: trimmed, options: options))
            ?? AttributedString(trimmed)

        // Highlight slash command token (e.g. /model) in blue
        if let slashMatch = trimmed.range(of: #"^/\w+"#, options: .regularExpression) {
            let offset = trimmed.distance(from: trimmed.startIndex, to: slashMatch.lowerBound)
            let length = trimmed.distance(from: slashMatch.lowerBound, to: slashMatch.upperBound)
            let attrStart = parsed.index(parsed.startIndex, offsetByCharacters: offset)
            let attrEnd = parsed.index(attrStart, offsetByCharacters: length)
            parsed[attrStart..<attrEnd].foregroundColor = VColor.slashCommand
        }

        // Store in cache (with size limit to prevent unbounded growth)
        if Self.markdownCache.count >= Self.maxCacheSize {
            // Dictionary iteration order is unspecified; this evicts an arbitrary entry.
            if let firstKey = Self.markdownCache.keys.first {
                Self.markdownCache.removeValue(forKey: firstKey)
            }
        }
        Self.markdownCache[trimmed] = parsed

        return parsed
    }
}
