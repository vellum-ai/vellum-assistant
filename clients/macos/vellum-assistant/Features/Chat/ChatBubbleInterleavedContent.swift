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
        case thinking([Int])

        /// Stable identity based on the first index in the group.
        /// Using \.self as ForEach identity causes SwiftUI to destroy and recreate
        /// views when new items are appended (e.g. a new tool call), which resets
        /// @State like isExpanded. This ID stays constant as the group grows.
        var stableId: String {
            switch self {
            case .texts(let indices): return "t\(indices.first ?? 0)"
            case .toolCalls(let indices): return "tc\(indices.first ?? 0)"
            case .surface(let i): return "s\(i)"
            case .thinking(let indices): return "th\(indices.first ?? 0)"
            }
        }
    }

    // MARK: - Static Interleaved Content Cache

    /// Cache key for memoized interleaved content computation results.
    /// Keyed by (messageId, contentOrderHash) to invalidate when content changes.
    struct InterleavedCacheKey: Hashable {
        let messageId: UUID
        let contentOrderHash: Int
    }

    /// Cached result of interleaved content computation.
    struct InterleavedCacheValue {
        let hasInterleaved: Bool
        let groups: [ContentGroup]
        let trailingTextIds: Set<String>
    }

    /// Static cache of interleaved content computation results. For completed
    /// messages in old conversations, `contentOrder` is stable so these results
    /// can be reused across ChatBubble.init() calls during scroll.
    @MainActor static var interleavedContentCache: [InterleavedCacheKey: InterleavedCacheValue] = [:]

    /// Maximum number of entries in the interleaved content cache before
    /// clearing. This is a performance cache, not a correctness cache, so
    /// full clear on overflow is safe and simple.
    static let interleavedCacheMaxEntries = 500

    /// Builds a cache key from message identity + content structure.
    static func interleavedCacheKey(for message: ChatMessage) -> InterleavedCacheKey {
        var orderHasher = Hasher()
        for ref in message.contentOrder { orderHasher.combine(ref) }
        // Hash per-segment emptiness since trailingText computation checks
        // each segment's trimmed content, not just the count.
        for segment in message.textSegments {
            orderHasher.combine(segment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
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

    /// Recomputes all cached interleaved content state when message structure
    /// changes, while avoiding no-op `@State` writes that would otherwise
    /// re-render the bubble on every streaming token.
    func recomputeInterleavedContentCache() {
        let interleaved = Self.computeHasInterleavedContent(message.contentOrder)

        guard interleaved else {
            if cachedHasInterleavedContent {
                cachedHasInterleavedContent = false
            }
            if !cachedContentGroups.isEmpty {
                cachedContentGroups = []
            }
            if !cachedToolGroupsWithTrailingText.isEmpty {
                cachedToolGroupsWithTrailingText = []
            }
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
        if !cachedHasInterleavedContent {
            cachedHasInterleavedContent = true
        }
        if cachedContentGroups != groups {
            cachedContentGroups = groups
        }
        if cachedToolGroupsWithTrailingText != trailingTextIds {
            cachedToolGroupsWithTrailingText = trailingTextIds
        }

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
            case .toolCall, .surface, .thinking: hasNonText = true
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
            case .thinking(let i):
                if case .thinking(let indices) = groups.last {
                    groups[groups.count - 1] = .thinking(indices + [i])
                } else {
                    groups.append(.thinking([i]))
                }
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
            case .surface, .thinking:
                // A surface or thinking block breaks the text run — flush pending state.
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
                activeConfirmationRequestId: activeConfirmationRequestId,
                expandedStepIds: $expandedStepIds,
                cardExpansionOverrides: $cardExpansionOverrides
            )
            .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)

        }
    }

    @ViewBuilder
    var interleavedContent: some View {
        let groups = cachedContentGroups
        let latestToolGroup: [Int]? = groups.reversed().compactMap { group in
            guard case .toolCalls(let indices) = group else { return nil }
            return indices
        }.first

        // Pre-compute which tool groups defer images to the following text group.
        // When a tool group is immediately followed by a text group, images render
        // after the text so descriptive text like "Here's the screenshot:" appears
        // before the screenshot it introduces.
        let deferredImageGroupIds: Set<String> = {
            var ids = Set<String>()
            for i in 0..<groups.count {
                guard case .toolCalls = groups[i] else { continue }
                if i + 1 < groups.count, case .texts = groups[i + 1] {
                    ids.insert(groups[i].stableId)
                }
            }
            return ids
        }()

        // Pre-compute which text groups should show deferred images from preceding tool group
        let textGroupDeferredToolIndices: [String: [Int]] = {
            var map: [String: [Int]] = [:]
            for i in 0..<groups.count {
                guard case .texts = groups[i] else { continue }
                if i > 0, case .toolCalls(let tcIndices) = groups[i - 1],
                   deferredImageGroupIds.contains(groups[i - 1].stableId) {
                    map[groups[i].stableId] = tcIndices
                }
            }
            return map
        }()

        // Identify the last text group so attachments render right after it
        // (inline with text) instead of at the very bottom after tool calls.
        let lastTextGroupId: String? = groups.last(where: {
            if case .texts = $0 { return true }
            return false
        })?.stableId


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
                // Render deferred tool call images from the preceding tool group,
                // so descriptive text appears before the screenshot it introduces.
                if shouldRenderToolProgressInline,
                   let deferredIndices = textGroupDeferredToolIndices[group.stableId] {
                    let deferredCalls: [ToolCallData] = deferredIndices.compactMap { tcIdx in
                        guard tcIdx < message.toolCalls.count else { return nil }
                        return message.toolCalls[tcIdx]
                    }
                    inlineToolCallImages(from: deferredCalls)
                }
                // Render attachments right after the last text group so they
                // appear inline with the text (like "Here's your SVG:" + image)
                // instead of buried below tool call progress views.
                if group.stableId == lastTextGroupId {
                    inlineAttachments
                }
            case .toolCalls(let indices):
                if shouldRenderToolProgressInline {
                    inlineToolProgress(
                        toolIndices: indices,
                        isLatestGroup: indices == latestToolGroup,
                        hasTrailingText: cachedToolGroupsWithTrailingText.contains(group.stableId)
                    )
                    // Show images immediately when no text follows;
                    // otherwise they are deferred to render after the next text group.
                    if !deferredImageGroupIds.contains(group.stableId) {
                        let toolCalls: [ToolCallData] = indices.compactMap { tcIdx in
                            guard tcIdx < message.toolCalls.count else { return nil }
                            return message.toolCalls[tcIdx]
                        }
                        inlineToolCallImages(from: toolCalls)
                    }
                } else {
                    // Tool calls are rendered by trailingStatus below the message
                    EmptyView()
                }
            case .surface(let i):
                if i < message.inlineSurfaces.count,
                   message.inlineSurfaces[i].id != activeSurfaceId {
                    InlineSurfaceRouter(surface: message.inlineSurfaces[i], onAction: onSurfaceAction, onRefetch: onSurfaceRefetch, isMessageStreaming: message.isStreaming)
                }
            case .thinking(let indices):
                if MacOSClientFeatureFlagManager.shared.isEnabled("show-thinking-blocks") {
                    let joined = indices
                        .compactMap { i in
                            i < message.thinkingSegments.count
                                ? message.thinkingSegments[i]
                                : nil
                        }
                        .filter { !$0.isEmpty }
                        .joined(separator: "\n")
                    if !joined.isEmpty {
                        ThinkingBlockView(content: joined, isStreaming: message.isStreaming)
                    }
                }
            }
        }

        // Fallback: if there are no text groups, render attachments after all content groups.
        if lastTextGroupId == nil {
            inlineAttachments
        }
        attachmentWarningBanners(message.attachmentWarnings)
    }

    /// Renders all non-tool-block attachments (images, videos, audios, files)
    /// inline at the current position in the content flow.
    @ViewBuilder
    private var inlineAttachments: some View {
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
    }
}
