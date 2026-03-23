import SwiftUI
import VellumAssistantShared

// MARK: - Interleaved Content

extension ChatBubble {
    /// Whether tool progress should be rendered inline at tool-call block positions
    /// instead of in the trailing status area.
    var shouldRenderToolProgressInline: Bool {
        // Tool calls are never hidden; always consider inline rendering.
        guard cachedHasInterleavedContent else { return false }
        return message.contentOrder.contains(where: {
            if case .toolCall = $0 { return true }
            return false
        })
    }

    /// Groups consecutive tool call refs for rendering.
    /// Hashable so ForEach can use stable identity based on content rather than
    /// array offset, which avoids spurious view invalidation when the array is
    /// recreated with identical values on each render pass.
    enum ContentGroup: Hashable {
        case texts([Int])
        case toolCalls([Int])
        case surface(Int)

        /// Stable identity based on the first index in the group.
        /// Using \.self as ForEach identity causes SwiftUI to destroy and recreate
        /// views when new items are appended (e.g. a new tool call), which resets
        /// @State like isExpanded. This ID stays constant as the group grows.
        var stableId: String {
            switch self {
            case .texts(let indices): return "t\(indices.first ?? 0)"
            case .toolCalls(let indices): return "tc\(indices.first ?? 0)"
            case .surface(let i): return "s\(i)"
            }
        }
    }

    // MARK: - Static Interleaved Content Cache

    /// Cache key for memoized interleaved content computation results.
    /// Keyed by (messageId, contentOrderHash) to invalidate when content changes.
    private struct InterleavedCacheKey: Hashable {
        let messageId: UUID
        let contentOrderHash: Int
    }

    /// Cached result of interleaved content computation.
    private struct InterleavedCacheValue {
        let hasInterleaved: Bool
        let groups: [ContentGroup]
        let trailingTextIds: Set<String>
    }

    /// Static cache of interleaved content computation results. For completed
    /// messages in old conversations, `contentOrder` is stable so these results
    /// can be reused across ChatBubble.init() calls during scroll.
    @MainActor private static var interleavedContentCache: [InterleavedCacheKey: InterleavedCacheValue] = [:]

    /// Maximum number of entries in the interleaved content cache before
    /// clearing. This is a performance cache, not a correctness cache, so
    /// full clear on overflow is safe and simple.
    private static let interleavedCacheMaxEntries = 500

    /// Builds a cache key from message identity + content structure.
    static func interleavedCacheKey(for message: ChatMessage) -> InterleavedCacheKey {
        var orderHasher = Hasher()
        for ref in message.contentOrder { orderHasher.combine(ref) }
        // Also hash textSegments count since trailingText depends on it
        orderHasher.combine(message.textSegments.count)
        orderHasher.combine(message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        return InterleavedCacheKey(
            messageId: message.id,
            contentOrderHash: orderHasher.finalize()
        )
    }

    /// Looks up a cached interleaved content result for the given message.
    @MainActor
    static func cachedInterleavedResult(for message: ChatMessage) -> InterleavedCacheValue? {
        let key = interleavedCacheKey(for: message)
        return interleavedContentCache[key]
    }

    /// Stores an interleaved content computation result in the static cache.
    @MainActor
    static func storeInterleavedResult(_ value: InterleavedCacheValue, for message: ChatMessage) {
        if interleavedContentCache.count > interleavedCacheMaxEntries {
            interleavedContentCache.removeAll(keepingCapacity: true)
        }
        let key = interleavedCacheKey(for: message)
        interleavedContentCache[key] = value
    }

    // MARK: - Cache Recomputation

    /// Recomputes all cached interleaved content state. Called from `.onAppear`
    /// and `.onChange(of: message.contentOrder)` / `.onChange(of: message.textSegments)`.
    func recomputeInterleavedContentCache() {
        let interleaved = Self.computeHasInterleavedContent(message.contentOrder)
        cachedHasInterleavedContent = interleaved

        guard interleaved else {
            cachedContentGroups = []
            cachedToolGroupsWithTrailingText = []
            // Update static cache with non-interleaved result
            Self.storeInterleavedResult(
                InterleavedCacheValue(hasInterleaved: false, groups: [], trailingTextIds: []),
                for: message
            )
            return
        }

        let groups = Self.computeContentGroupsStatic(
            contentOrder: message.contentOrder,
            hasInterleavedContent: interleaved
        )
        cachedContentGroups = groups

        // Pre-compute which tool-call groups have trailing text so that
        // `interleavedContent` can look up the set instead of scanning
        // contentOrder per group during body evaluation.
        var trailingTextIds = Set<String>()
        for group in groups {
            guard case .toolCalls(let indices) = group else { continue }
            if Self.computeHasTextAfterToolGroupStatic(
                toolIndices: indices,
                contentOrder: message.contentOrder,
                textSegments: message.textSegments,
                hasText: hasText
            ) {
                trailingTextIds.insert(group.stableId)
            }
        }
        cachedToolGroupsWithTrailingText = trailingTextIds

        // Update static cache so the next init() for this message uses fresh values
        Self.storeInterleavedResult(
            InterleavedCacheValue(hasInterleaved: interleaved, groups: groups, trailingTextIds: trailingTextIds),
            for: message
        )
    }

    /// Whether this message has meaningful interleaved content (multiple block types).
    static func computeHasInterleavedContent(_ contentOrder: [ContentBlockRef]) -> Bool {
        // Use interleaved path when contentOrder has more than one distinct block type
        guard contentOrder.count > 1 else { return false }
        var hasTextBlock = false
        var hasNonText = false
        for ref in contentOrder {
            switch ref {
            case .text: hasTextBlock = true
            case .toolCall, .surface: hasNonText = true
            }
            if hasTextBlock && hasNonText { return true }
        }
        return false
    }

    /// Static version of content group computation, callable from init() before
    /// self is fully initialized. The instance method delegates to this.
    static func computeContentGroupsStatic(
        contentOrder: [ContentBlockRef],
        hasInterleavedContent: Bool
    ) -> [ContentGroup] {
        var groups: [ContentGroup] = []
        for ref in contentOrder {
            switch ref {
            case .text(let i):
                if case .texts(let indices) = groups.last {
                    groups[groups.count - 1] = .texts(indices + [i])
                } else {
                    groups.append(.texts([i]))
                }
            case .toolCall(let i):
                if case .toolCalls(let indices) = groups.last {
                    groups[groups.count - 1] = .toolCalls(indices + [i])
                } else {
                    groups.append(.toolCalls([i]))
                }
            case .surface(let i):
                groups.append(.surface(i))
            }
        }

        // When tool calls render inline (visible progress views), they must
        // break text runs just like surfaces do — skip coalescing entirely.
        // Replicate shouldRenderToolProgressInline logic inline:
        let shouldRenderInline = hasInterleavedContent && contentOrder.contains(where: {
            if case .toolCall = $0 { return true }
            return false
        })
        guard !shouldRenderInline else { return groups }

        // Post-process: coalesce text groups that are only separated by tool call
        // groups so that the user can drag-select across text that spans a tool
        // invocation (tool calls render as EmptyView and produce no visual gap).
        // Only .surface entries break a text run because they render visible content.
        var coalesced: [ContentGroup] = []
        var pendingTexts: [Int]?
        var pendingToolCalls: [ContentGroup] = []

        for group in groups {
            switch group {
            case .texts(let indices):
                if var existing = pendingTexts {
                    existing.append(contentsOf: indices)
                    pendingTexts = existing
                } else {
                    pendingTexts = indices
                }
            case .toolCalls:
                if pendingTexts != nil {
                    // Buffer the tool calls; they might sit between two text groups.
                    pendingToolCalls.append(group)
                } else {
                    coalesced.append(group)
                }
            case .surface:
                // A surface breaks the text run — flush pending state.
                if let texts = pendingTexts {
                    coalesced.append(.texts(texts))
                    coalesced.append(contentsOf: pendingToolCalls)
                    pendingTexts = nil
                    pendingToolCalls = []
                }
                coalesced.append(group)
            }
        }

        // Flush any remaining pending state.
        if let texts = pendingTexts {
            coalesced.append(.texts(texts))
            coalesced.append(contentsOf: pendingToolCalls)
        }

        return coalesced
    }

    /// Static version of trailing text detection, callable from init() before
    /// self is fully initialized. The instance method delegates to this.
    static func computeHasTextAfterToolGroupStatic(
        toolIndices: [Int],
        contentOrder: [ContentBlockRef],
        textSegments: [String],
        hasText: Bool
    ) -> Bool {
        let indexSet = Set(toolIndices)
        guard let lastToolRefIndex = contentOrder.lastIndex(where: {
            if case .toolCall(let i) = $0 { return indexSet.contains(i) }
            return false
        }) else {
            return hasText
        }
        let start = contentOrder.index(after: lastToolRefIndex)
        guard start < contentOrder.endIndex else { return false }
        for ref in contentOrder[start...] {
            guard case .text(let textIndex) = ref,
                  textIndex >= 0,
                  textIndex < textSegments.count else { continue }
            if !textSegments[textIndex].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return true
            }
        }
        return false
    }

    @ViewBuilder
    private func inlineToolProgress(toolIndices: [Int], isLatestGroup: Bool, hasTrailingText: Bool) -> some View {
        let groupedToolCalls: [ToolCallData] = toolIndices.compactMap { idx -> ToolCallData? in
            guard idx < message.toolCalls.count else { return nil }
            return message.toolCalls[idx]
        }
        if !groupedToolCalls.isEmpty {
            // Derive confirmations from this group's own tool call stamps.
            // We intentionally do NOT use the message-level decidedConfirmation
            // here because it comes from the confirmation message at index+1,
            // which can be stale — after the confirmation is resolved and new
            // tool groups are added, the old confirmation message stays at
            // index+1 and would leak to unrelated groups.
            // Deduplicate by (toolCategory, state) so repeated identical permissions
            // collapse into one chip.
            let groupConfirmations: [ToolConfirmationData] = {
                var seen = Set<String>()
                var result: [ToolConfirmationData] = []
                for tc in groupedToolCalls {
                    guard let decision = tc.confirmationDecision else { continue }
                    let label = tc.confirmationLabel ?? tc.toolName
                    let key = "\(label)|\(decision)"
                    guard seen.insert(key).inserted else { continue }
                    var data = ToolConfirmationData(
                        requestId: "",
                        toolName: tc.toolName,
                        riskLevel: "medium",
                        state: decision
                    )
                    data._overrideToolCategory = tc.confirmationLabel
                    result.append(data)
                }
                return result
            }()

            AssistantProgressView(
                toolCalls: groupedToolCalls,
                isStreaming: isLatestGroup ? message.isStreaming : false,
                hasText: hasTrailingText,
                isProcessing: isLatestGroup && isProcessingAfterTools,
                processingStatusText: isLatestGroup && isProcessingAfterTools ? processingStatusText : nil,
                streamingCodePreview: isLatestGroup ? message.streamingCodePreview : nil,
                streamingCodeToolName: isLatestGroup ? message.streamingCodeToolName : nil,
                decidedConfirmations: groupConfirmations,
                onRehydrate: onRehydrate,
                onConfirmationAllow: onConfirmationAllow,
                onConfirmationDeny: onConfirmationDeny,
                onAlwaysAllow: onAlwaysAllow,
                onTemporaryAllow: onTemporaryAllow,
                activeConfirmationRequestId: activeConfirmationRequestId
            )
            .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)

            // Inline image previews from completed tool calls (e.g. image generation)
            inlineToolCallImages(from: groupedToolCalls)
        }
    }

    @ViewBuilder
    var interleavedContent: some View {
        let groups = cachedContentGroups
        let latestToolGroup: [Int]? = groups.reversed().compactMap { group in
            guard case .toolCalls(let indices) = group else { return nil }
            return indices
        }.first

        // Render all content groups in order: text, tool calls, and surfaces.
        // Uses \.stableId (based on the first index in each group) so SwiftUI
        // preserves @State (like isExpanded) when new items are appended to a
        // group, and skips re-evaluating children whose identity hasn't changed.
        ForEach(groups, id: \.stableId) { group in
            switch group {
            case .texts(let indices):
                let joined = indices
                    .compactMap { i in
                        i < message.textSegments.count
                            ? message.textSegments[i].trimmingCharacters(in: .whitespacesAndNewlines)
                            : nil
                    }
                    .filter { !$0.isEmpty }
                    .joined(separator: "\n")
                if !joined.isEmpty {
                    textBubble(for: joined)
                }
            case .toolCalls(let indices):
                if shouldRenderToolProgressInline {
                    inlineToolProgress(
                        toolIndices: indices,
                        isLatestGroup: indices == latestToolGroup,
                        hasTrailingText: cachedToolGroupsWithTrailingText.contains(group.stableId)
                    )
                } else {
                    // Tool calls are rendered by trailingStatus below the message
                    EmptyView()
                }
            case .surface(let i):
                if i < message.inlineSurfaces.count,
                   message.inlineSurfaces[i].id != activeSurfaceId {
                    InlineSurfaceRouter(surface: message.inlineSurfaces[i], onAction: onSurfaceAction, onRefetch: onSurfaceRefetch)
                }
            }
        }

        // Attachments are not part of contentOrder but must still be rendered.
        // Hide only the tool-block image attachments that are already shown
        // inline by completed tool calls; keep directive/host images visible.
        let partitioned = partitionedAttachments
        let visibleImages = visibleAttachmentImages(partitioned.images)
        if !visibleImages.isEmpty {
            attachmentImageGrid(visibleImages)
        }
        if !partitioned.videos.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(partitioned.videos) { attachment in
                    InlineVideoAttachmentView(attachment: attachment)
                }
            }
        }
        if !partitioned.audios.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(partitioned.audios) { attachment in
                    InlineAudioAttachmentView(attachment: attachment)
                }
            }
        }
        if !partitioned.files.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(partitioned.files) { attachment in
                    fileAttachmentChip(attachment)
                }
            }
        }
        attachmentWarningBanners(message.attachmentWarnings)
    }
}
