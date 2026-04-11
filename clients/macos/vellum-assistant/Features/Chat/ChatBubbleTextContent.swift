import SwiftUI
import VellumAssistantShared

// MARK: - Text Content

extension ChatBubble {
    /// Render a single text segment as a styled bubble, with table and image support.
    /// For large messages (>500 chars) with a segment cache miss, renders plain text
    /// immediately and parses rich formatting asynchronously to avoid blocking scroll.
    ///
    /// When the text contains inline `<thinking>...</thinking>` tags (and the
    /// `show-thinking-blocks` feature flag is enabled for assistant messages),
    /// the tagged sections are lifted into collapsible `ThinkingBlockView`s
    /// rendered alongside text bubbles for the remaining content. This keeps
    /// the transformation entirely at the presentation layer — no changes to
    /// the message data model or streaming pipeline.
    @ViewBuilder
    func textBubble(for segmentText: String) -> some View {
        if !isUser,
           containsInlineThinkingTag(segmentText),
           MacOSClientFeatureFlagManager.shared.isEnabled("show-thinking-blocks") {
            let chunks = parseInlineThinkingTags(segmentText)
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(Array(chunks.enumerated()), id: \.offset) { offset, chunk in
                    switch chunk {
                    case .text(let body):
                        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            textBubbleChrome(for: trimmed)
                        }
                    case .thinking(let body):
                        ThinkingBlockView(
                            content: body,
                            isStreaming: message.isStreaming,
                            expansionKey: "\(message.id.uuidString)-txt\(segmentText.hashValue)-\(offset)",
                            typographyGeneration: typographyGeneration
                        )
                    }
                }
            }
        } else {
            textBubbleChrome(for: segmentText)
        }
    }

    /// Renders a single text segment inside the shared bubble chrome with
    /// markdown parsing. Extracted from `textBubble(for:)` so the thinking-
    /// tag dispatcher can reuse the same rendering for the text chunks it
    /// produces.
    @ViewBuilder
    fileprivate func textBubbleChrome(for segmentText: String) -> some View {
        let streaming = message.isStreaming
        let segments = resolveSegments(for: segmentText, isStreaming: streaming)

        bubbleChrome {
            // Always render through MarkdownSegmentView to keep view
            // identity stable across async segment parsing transitions.
            // Switching between Text and MarkdownSegmentView caused
            // LazyVStack to use stale height measurements, resulting in
            // content truncation and footer overlap.
            MarkdownSegmentView(
                segments: segments,
                isStreaming: streaming,
                typographyGeneration: typographyGeneration,
                maxContentWidth: bubbleMaxWidth
            )
                .equatable()
        }
        .task(id: "\(segmentText)|\(streaming)") {
            // Fallback async parsing for text exceeding maxCacheableTextLength
            // (10K+ chars) that can't be stored in segmentCache. Most text is
            // parsed synchronously in resolveSegments and cached — this only
            // fires for unusually large segments on a cache miss.
            guard !streaming,
                  segmentText.count > Self.maxCacheableTextLength,
                  Self.segmentCache.object(forKey: segmentText as NSString) == nil,
                  asyncSegments[segmentText] == nil else { return }
            let result = await MarkdownParseActor.shared.parse(segmentText)
            guard !Task.isCancelled else { return }
            asyncSegments[segmentText] = result
        }
    }

    /// Resolves markdown segments for the given text, using the async result for
    /// large messages that haven't been synchronously cached yet.
    func resolveSegments(for text: String, isStreaming: Bool) -> [MarkdownSegment] {
        // Check the synchronous cache first (fast path for all sizes)
        if let cached = Self.segmentCache.object(forKey: text as NSString) {
            // Clear stale streaming data only for the specific bubble that
            // transitioned from streaming to finalized. Other non-streaming
            // bubbles must not wipe the streaming cache or active streaming
            // bubbles lose their dedup/throttle entry.
            if !isStreaming, let last = Self.lastStreamingSegments, last.text == text {
                Self.lastStreamingSegments = nil
            }
            return cached.segments
        }
        // For large text with a cache miss, parse synchronously and cache.
        // parseMarkdownSegments is 1-5ms even for large text — well within
        // frame budget. The expensive operation (buildAttributedStringUncached)
        // runs regardless of sync/async path. The former async deferral only
        // saved 1-5ms of parsing but introduced a placeholder→re-render cycle
        // where placeholder height (single plain-text paragraph) differed
        // dramatically from proper height (tables, code blocks), triggering a
        // LazyVStack re-estimation cascade that froze the app.
        if !isStreaming, text.count > Self.asyncParseThreshold {
            if let async = asyncSegments[text] {
                return async
            }
            // Use streaming result if available (streaming→non-streaming transition)
            if let last = Self.lastStreamingSegments, last.text == text {
                if text.count <= Self.maxCacheableTextLength {
                    Self.segmentCache.setObject(
                        SegmentCacheEntry(last.value),
                        forKey: text as NSString,
                        cost: text.utf8.count * 10
                    )
                }
                Self.lastStreamingSegments = nil
                return last.value
            }
            // Parse synchronously — one render at the correct height, no cascade.
            let result = parseMarkdownSegments(text)
            if text.count <= Self.maxCacheableTextLength {
                Self.segmentCache.setObject(
                    SegmentCacheEntry(result),
                    forKey: text as NSString,
                    cost: text.utf8.count * 10
                )
            }
            return result
        }
        // Small text or streaming: parse synchronously (cheap enough)
        return Self.cachedSegments(for: text, isStreaming: isStreaming)
    }

    /// Cached markdown segment parser to avoid re-parsing on every render.
    /// When `isStreaming` is true the result is not stored in the main
    /// cache (to avoid filling it with intermediate text states), but a
    /// single-entry dedup cache returns the previous result when the text
    /// hasn't changed between SwiftUI reevaluations.
    static func cachedSegments(for text: String, isStreaming: Bool = false) -> [MarkdownSegment] {
        if let cached = segmentCache.object(forKey: text as NSString) {
            return cached.segments
        }
        // Streaming dedup: return the last-parsed result when text is unchanged.
        if isStreaming, let last = lastStreamingSegments, last.text == text {
            return last.value
        }
        // Streaming throttle: for large streaming text, reuse the previous
        // parse result if we parsed recently. Prevents synchronous O(n)
        // markdown re-parsing (with regex table checks per line and
        // per-cell AttributedString builds) on every rendering pass,
        // which otherwise pegs the CPU at 100% during streaming of
        // large messages with tables.
        if isStreaming,
           text.count > streamingParseThrottleThreshold,
           let last = lastStreamingSegments,
           text.hasPrefix(last.text) {
            let now = ProcessInfo.processInfo.systemUptime
            if now - lastStreamingParseTime < streamingParseThrottleInterval {
                return last.value
            }
        }
        let result = parseMarkdownSegments(text)
        if isStreaming {
            lastStreamingSegments = (text, result)
            lastStreamingParseTime = ProcessInfo.processInfo.systemUptime
            return result
        }
        // Skip caching for very long text to avoid a single huge entry
        // evicting many smaller, more frequently accessed entries.
        if text.count > maxCacheableTextLength { return result }
        segmentCache.setObject(
            SegmentCacheEntry(result),
            forKey: text as NSString,
            cost: text.utf8.count * 10
        )
        return result
    }

}
