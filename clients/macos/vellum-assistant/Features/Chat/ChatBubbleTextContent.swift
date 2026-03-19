import SwiftUI
import VellumAssistantShared

// MARK: - Text Content

extension ChatBubble {
    /// Render a single text segment as a styled bubble, with table and image support.
    /// For large messages (>500 chars) with a segment cache miss, renders plain text
    /// immediately and parses rich formatting asynchronously to avoid blocking scroll.
    @ViewBuilder
    func textBubble(for segmentText: String) -> some View {
        let streaming = message.isStreaming
        let segments = resolveSegments(for: segmentText, isStreaming: streaming)

        bubbleChrome {
            // Always render through MarkdownSegmentView to keep view
            // identity stable across async segment parsing transitions.
            // Switching between Text and MarkdownSegmentView caused
            // LazyVStack to use stale height measurements, resulting in
            // content truncation and footer overlap.
            MarkdownSegmentView(segments: segments)
                .equatable()
        }
        .task(id: "\(segmentText)|\(streaming)") {
            // Only run async parsing for large, non-streaming text with a cache miss
            guard !streaming,
                  segmentText.count > Self.asyncParseThreshold,
                  Self.segmentCache[segmentText] == nil,
                  asyncSegments[segmentText] == nil else { return }
            let result = await MarkdownParseActor.shared.parse(segmentText)
            guard !Task.isCancelled else { return }
            asyncSegments[segmentText] = result
            // Backfill the synchronous cache with guardrails (size limit,
            // byte tracking, eviction) — mirrors the logic in cachedSegments.
            // Re-check cache after await to avoid double-counting bytes when
            // multiple bubbles parse the same text concurrently.
            if segmentText.count <= Self.maxCacheableTextLength,
               Self.segmentCache[segmentText] == nil {
                if Self.segmentCache.count >= Self.maxCacheSize {
                    if let lruKey = Self.segmentCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key {
                        Self.estimatedCacheBytes -= Self.estimatedBytes(for: lruKey)
                        Self.segmentCache.removeValue(forKey: lruKey)
                    }
                }
                Self.lruCounter += 1
                let cost = Self.estimatedBytes(for: segmentText)
                Self.segmentCache[segmentText] = (result, Self.lruCounter)
                Self.estimatedCacheBytes += cost
                Self.evictIfOverBudget()
            }
        }
    }

    /// Resolves markdown segments for the given text, using the async result for
    /// large messages that haven't been synchronously cached yet.
    func resolveSegments(for text: String, isStreaming: Bool) -> [MarkdownSegment] {
        // Check the synchronous cache first (fast path for all sizes)
        if let cached = Self.segmentCache[text] {
            Self.lruCounter += 1
            Self.segmentCache[text] = (cached.value, Self.lruCounter)
            return cached.value
        }
        // For large text with a cache miss, return async result or plain placeholder
        if !isStreaming, text.count > Self.asyncParseThreshold {
            if let async = asyncSegments[text] {
                return async
            }
            // Fast placeholder: single plain-text segment avoids expensive parsing
            return [.text(text)]
        }
        // Small text or streaming: parse synchronously (cheap enough)
        return Self.cachedSegments(for: text, isStreaming: isStreaming)
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

}
