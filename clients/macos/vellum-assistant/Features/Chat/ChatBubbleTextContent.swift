import SwiftUI
import VellumAssistantShared

// MARK: - Text Content

extension ChatBubble {
    /// Render a single text segment as a styled bubble, with table and image support.
    @ViewBuilder
    func textBubble(for segmentText: String) -> some View {
        let streaming = message.isStreaming
        let segments = Self.cachedSegments(for: segmentText, isStreaming: streaming)
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
                let attributed = Self.cachedInlineMarkdown(for: segmentText, isStreaming: streaming)
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
    /// When `isStreaming` is true the result is computed but not stored, since
    /// streaming text changes every token and caching intermediates wastes memory.
    static func cachedInlineMarkdown(for text: String, isStreaming: Bool = false) -> AttributedString {
        if let cached = inlineMarkdownCache[text] {
            lruCounter += 1
            inlineMarkdownCache[text] = (cached.value, lruCounter)
            return cached.value
        }
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        let result = (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
        if isStreaming { return result }
        if inlineMarkdownCache.count >= maxCacheSize {
            // Evict the least-recently-used entry (lowest accessTime).
            if let lruKey = inlineMarkdownCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key {
                inlineMarkdownCache.removeValue(forKey: lruKey)
            }
        }
        lruCounter += 1
        inlineMarkdownCache[text] = (result, lruCounter)
        return result
    }

    /// Cached markdown segment parser to avoid re-parsing on every render.
    /// When `isStreaming` is true the result is computed but not stored, since
    /// streaming text changes every token and caching intermediates wastes memory.
    static func cachedSegments(for text: String, isStreaming: Bool = false) -> [MarkdownSegment] {
        if let cached = segmentCache[text] {
            lruCounter += 1
            segmentCache[text] = (cached.value, lruCounter)
            return cached.value
        }
        let result = parseMarkdownSegments(text)
        if isStreaming { return result }
        if segmentCache.count >= maxCacheSize {
            // Evict the least-recently-used entry (lowest accessTime).
            if let lruKey = segmentCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key {
                segmentCache.removeValue(forKey: lruKey)
            }
        }
        lruCounter += 1
        segmentCache[text] = (result, lruCounter)
        return result
    }

    /// Cached markdown parser to avoid re-parsing on every render.
    /// Skips caching when the message is still streaming to avoid
    /// filling the cache with intermediate text states.
    var markdownText: AttributedString {
        let textToRender = message.text
        let trimmed = textToRender.trimmingCharacters(in: .whitespacesAndNewlines)

        // Return cached value if available
        if let cached = Self.markdownCache[trimmed] {
            Self.lruCounter += 1
            Self.markdownCache[trimmed] = (cached.value, Self.lruCounter)
            return cached.value
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

        // Skip caching during streaming — intermediate text wastes cache slots
        if message.isStreaming { return parsed }

        // Store in cache with LRU eviction
        if Self.markdownCache.count >= Self.maxCacheSize {
            if let lruKey = Self.markdownCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key {
                Self.markdownCache.removeValue(forKey: lruKey)
            }
        }
        Self.lruCounter += 1
        Self.markdownCache[trimmed] = (parsed, Self.lruCounter)

        return parsed
    }
}
