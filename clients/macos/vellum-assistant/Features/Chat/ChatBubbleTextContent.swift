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
                    .font(.system(size: 14 * conversationZoomScale))
                    .lineSpacing(6)
                    .foregroundColor(VColor.textPrimary)
                    .tint(VColor.accent)
                    .textSelection(.enabled)
                    // Bound width before fixedSize so vertical measurement is
                    // computed within a finite horizontal space, preventing
                    // unbounded layout passes on long messages during scroll.
                    .frame(maxWidth: 520, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Cached inline markdown AttributedString to avoid re-parsing on every render.
    /// Uses `inlineMarkdownCache` (not `markdownCache`) to avoid cross-contamination
    /// with `markdownText`, which applies slash-command highlighting before caching.
    /// When `isStreaming` is true the result is not stored in the main LRU cache
    /// (to avoid filling it with intermediate text states), but a single-entry
    /// dedup cache returns the previous result when the text hasn't changed
    /// between SwiftUI reevaluations.
    static func cachedInlineMarkdown(for text: String, isStreaming: Bool = false) -> AttributedString {
        if let cached = inlineMarkdownCache[text] {
            lruCounter += 1
            inlineMarkdownCache[text] = (cached.value, lruCounter)
            return cached.value
        }
        // Streaming dedup: return the last-parsed result when text is unchanged.
        if isStreaming, let last = lastStreamingInlineMarkdown, last.text == text {
            return last.value
        }
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        var result = (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
        var inlineCodeRanges: [Range<AttributedString.Index>] = []
        for run in result.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                inlineCodeRanges.append(run.range)
            }
        }
        for range in inlineCodeRanges.reversed() {
            result[range].foregroundColor = VColor.codeText
            result[range].backgroundColor = VColor.codeBackground
            var trailing = AttributedString("\u{2009}")
            trailing.backgroundColor = VColor.codeBackground
            result.insert(trailing, at: range.upperBound)
            var leading = AttributedString("\u{2009}")
            leading.backgroundColor = VColor.codeBackground
            result.insert(leading, at: range.lowerBound)
        }
        // Underline links so they are visually distinct from plain text
        for run in result.runs where result[run.range].link != nil {
            result[run.range].underlineStyle = .single
        }
        if isStreaming {
            lastStreamingInlineMarkdown = (text, result)
            return result
        }
        // Skip caching for very long text to avoid a single huge entry
        // evicting many smaller, more frequently accessed entries.
        if text.count > maxCacheableTextLength { return result }
        if inlineMarkdownCache.count >= maxCacheSize {
            // Evict the least-recently-used entry (lowest accessTime).
            if let lruKey = inlineMarkdownCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key {
                estimatedCacheBytes -= estimatedBytes(for: lruKey)
                inlineMarkdownCache.removeValue(forKey: lruKey)
            }
        }
        lruCounter += 1
        let cost = estimatedBytes(for: text)
        inlineMarkdownCache[text] = (result, lruCounter)
        estimatedCacheBytes += cost
        evictIfOverBudget()
        return result
    }

    /// Cached markdown segment parser to avoid re-parsing on every render.
    /// When `isStreaming` is true the result is not stored in the main LRU
    /// cache (to avoid filling it with intermediate text states), but a
    /// single-entry dedup cache returns the previous result when the text
    /// hasn't changed between SwiftUI reevaluations.
    static func cachedSegments(for text: String, isStreaming: Bool = false) -> [MarkdownSegment] {
        if let cached = segmentCache[text] {
            lruCounter += 1
            segmentCache[text] = (cached.value, lruCounter)
            return cached.value
        }
        // Streaming dedup: return the last-parsed result when text is unchanged.
        if isStreaming, let last = lastStreamingSegments, last.text == text {
            return last.value
        }
        let result = parseMarkdownSegments(text)
        if isStreaming {
            lastStreamingSegments = (text, result)
            return result
        }
        // Skip caching for very long text to avoid a single huge entry
        // evicting many smaller, more frequently accessed entries.
        if text.count > maxCacheableTextLength { return result }
        if segmentCache.count >= maxCacheSize {
            // Evict the least-recently-used entry (lowest accessTime).
            if let lruKey = segmentCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key {
                estimatedCacheBytes -= estimatedBytes(for: lruKey)
                segmentCache.removeValue(forKey: lruKey)
            }
        }
        lruCounter += 1
        let cost = estimatedBytes(for: text)
        segmentCache[text] = (result, lruCounter)
        estimatedCacheBytes += cost
        evictIfOverBudget()
        return result
    }

    /// Cached markdown parser to avoid re-parsing on every render.
    /// When streaming, results are not stored in the main LRU cache (to
    /// avoid filling it with intermediate text states), but a single-entry
    /// dedup cache returns the previous result when the text hasn't changed
    /// between SwiftUI reevaluations.
    var markdownText: AttributedString {
        let textToRender = message.text
        let trimmed = textToRender.trimmingCharacters(in: .whitespacesAndNewlines)
        // Include role in the cache key so user and assistant messages with
        // identical text don't share entries (they use different inline code colors).
        let cacheKey = isUser ? "u:\(trimmed)" : trimmed

        // Return cached value if available
        if let cached = Self.markdownCache[cacheKey] {
            Self.lruCounter += 1
            Self.markdownCache[cacheKey] = (cached.value, Self.lruCounter)
            return cached.value
        }

        // Streaming dedup: return the last-parsed result when text is unchanged.
        if message.isStreaming, let last = Self.lastStreamingMarkdown, last.text == cacheKey {
            return last.value
        }

        // Parse markdown
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        var parsed = (try? AttributedString(markdown: trimmed, options: options))
            ?? AttributedString(trimmed)

        // Apply background and text color to inline code spans,
        // using user-bubble-appropriate colors when inside a user message.
        let inlineCodeTextColor = isUser ? VColor.userBubbleText : VColor.codeText
        let inlineCodeBgColor = isUser ? VColor.userBubbleText.opacity(0.1) : VColor.codeBackground
        var markdownCodeRanges: [Range<AttributedString.Index>] = []
        for run in parsed.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                markdownCodeRanges.append(run.range)
            }
        }
        for range in markdownCodeRanges.reversed() {
            parsed[range].foregroundColor = inlineCodeTextColor
            parsed[range].backgroundColor = inlineCodeBgColor
            var trailing = AttributedString("\u{2009}")
            trailing.backgroundColor = inlineCodeBgColor
            parsed.insert(trailing, at: range.upperBound)
            var leading = AttributedString("\u{2009}")
            leading.backgroundColor = inlineCodeBgColor
            parsed.insert(leading, at: range.lowerBound)
        }
        // Underline links so they are visually distinct from plain text
        for run in parsed.runs where parsed[run.range].link != nil {
            parsed[run.range].underlineStyle = .single
        }

        // Highlight slash command token (e.g. /model) in blue
        if let slashMatch = trimmed.range(of: #"^/\w+"#, options: .regularExpression) {
            let offset = trimmed.distance(from: trimmed.startIndex, to: slashMatch.lowerBound)
            let length = trimmed.distance(from: slashMatch.lowerBound, to: slashMatch.upperBound)
            let attrStart = parsed.index(parsed.startIndex, offsetByCharacters: offset)
            let attrEnd = parsed.index(attrStart, offsetByCharacters: length)
            parsed[attrStart..<attrEnd].foregroundColor = VColor.slashCommand
        }

        // Skip main cache during streaming — intermediate text wastes cache slots.
        // Store in the single-entry dedup cache instead.
        if message.isStreaming {
            Self.lastStreamingMarkdown = (cacheKey, parsed)
            return parsed
        }

        // Skip caching for very long text to avoid a single huge entry
        // evicting many smaller, more frequently accessed entries.
        if trimmed.count > Self.maxCacheableTextLength { return parsed }

        // Store in cache with LRU eviction
        if Self.markdownCache.count >= Self.maxCacheSize {
            if let lruKey = Self.markdownCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key {
                Self.estimatedCacheBytes -= Self.estimatedBytes(for: lruKey)
                Self.markdownCache.removeValue(forKey: lruKey)
            }
        }
        Self.lruCounter += 1
        let cost = Self.estimatedBytes(for: cacheKey)
        Self.markdownCache[cacheKey] = (parsed, Self.lruCounter)
        Self.estimatedCacheBytes += cost
        Self.evictIfOverBudget()

        return parsed
    }
}
