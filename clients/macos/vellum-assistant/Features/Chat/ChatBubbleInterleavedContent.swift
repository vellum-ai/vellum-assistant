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

    /// A contiguous burst of work activity (tool calls and optionally thinking)
    /// that renders as a single progress card. Text and surface groups act as
    /// burst boundaries — each burst gets its own "Worked for X.Ys" card.
    struct WorkBurst {
        /// All tool call indices in this burst.
        let toolIndices: [Int]
        /// All thinking segment indices in this burst.
        let thinkingIndices: [Int]
        /// Identity from the first group's stableId.
        let stableId: String
        /// Chronological sequence of tool calls and thinking for the progress
        /// card's expanded view.
        var expandedItems: [ProgressExpandedItem]
    }

    /// Computes work bursts from content groups by merging consecutive tool-call
    /// and thinking groups into a single burst. Text and surface groups flush the
    /// current burst and create boundaries.
    ///
    /// A burst MUST contain at least one tool call. Thinking-only groups (thinking
    /// with no adjacent tool calls) are NOT included in any burst — they remain
    /// standalone groups for separate rendering.
    static func computeWorkBursts(
        groups: [ContentGroup],
        contentOrder: [ContentBlockRef],
        toolCalls: [ToolCallData],
        thinkingSegments: [String],
        showThinking: Bool,
        isStreaming: Bool,
        messageId: UUID
    ) -> [WorkBurst] {
        var bursts: [WorkBurst] = []

        // Accumulate consecutive tool/thinking groups into a pending burst
        var pendingToolIndices: [Int] = []
        var pendingThinkingIndices: [Int] = []
        var pendingStableId: String?
        var pendingGroupStableIds: [String] = []

        // Orphan thinking: thinking flushed without adjacent tool calls.
        // Gets prepended to the next burst that has tools.
        var orphanThinkingIndices: [Int] = []
        var orphanThinkingStableId: String?

        func flushBurst() {
            guard !pendingToolIndices.isEmpty else {
                // Thinking-only — save as orphan to forward to the next burst
                if !pendingThinkingIndices.isEmpty {
                    orphanThinkingIndices.append(contentsOf: pendingThinkingIndices)
                    if orphanThinkingStableId == nil {
                        orphanThinkingStableId = pendingStableId
                    }
                }
                pendingToolIndices = []
                pendingThinkingIndices = []
                pendingStableId = nil
                pendingGroupStableIds = []
                return
            }

            // Absorb any orphan thinking from before this burst
            let allThinkingIndices = orphanThinkingIndices + pendingThinkingIndices
            let burstStableId = orphanThinkingStableId ?? pendingStableId ?? "burst-\(bursts.count)"

            let toolSet = Set(pendingToolIndices)
            let thinkingSet = Set(allThinkingIndices)

            // Build expandedItems by walking contentOrder for chronological ordering
            var items: [ProgressExpandedItem] = []
            for ref in contentOrder {
                switch ref {
                case .toolCall(let i):
                    if toolSet.contains(i), i < toolCalls.count {
                        items.append(.toolCall(toolCalls[i]))
                    }
                case .thinking(let i):
                    guard showThinking, thinkingSet.contains(i) else { continue }
                    guard i < thinkingSegments.count, !thinkingSegments[i].isEmpty else { continue }
                    let expansionKey = "\(messageId.uuidString)-th\(i)"
                    items.append(.thinking(
                        content: thinkingSegments[i],
                        expansionKey: expansionKey,
                        isStreaming: false
                    ))
                default:
                    continue
                }
            }

            bursts.append(WorkBurst(
                toolIndices: pendingToolIndices,
                thinkingIndices: allThinkingIndices,
                stableId: burstStableId,
                expandedItems: items
            ))

            orphanThinkingIndices = []
            orphanThinkingStableId = nil

            pendingToolIndices = []
            pendingThinkingIndices = []
            pendingStableId = nil
            pendingGroupStableIds = []
        }

        for group in groups {
            switch group {
            case .toolCalls(let indices):
                if pendingStableId == nil {
                    pendingStableId = group.stableId
                }
                pendingToolIndices.append(contentsOf: indices)
                pendingGroupStableIds.append(group.stableId)
            case .thinking(let indices):
                if pendingStableId == nil {
                    pendingStableId = group.stableId
                }
                pendingThinkingIndices.append(contentsOf: indices)
                pendingGroupStableIds.append(group.stableId)
            case .texts, .surface:
                flushBurst()
            }
        }
        // Flush any trailing burst
        flushBurst()

        // Orphan thinking with no following tool burst is NOT wrapped in a
        // burst — it renders as a standalone ThinkingBlockView instead.
        // (Thinking-only content doesn't need a "Worked for" card.)

        // Set isStreaming on the last thinking item in the last burst, but
        // only when it's also the last item overall — if a tool call follows
        // the thinking, the model has moved past thinking to execution.
        if isStreaming, var lastBurst = bursts.last {
            if let lastThinkingIdx = lastBurst.expandedItems.lastIndex(where: {
                if case .thinking = $0 { return true }
                return false
            }), lastThinkingIdx == lastBurst.expandedItems.count - 1 {
                if case .thinking(let content, let key, _) = lastBurst.expandedItems[lastThinkingIdx] {
                    lastBurst.expandedItems[lastThinkingIdx] = .thinking(
                        content: content, expansionKey: key, isStreaming: true
                    )
                }
                bursts[bursts.count - 1] = lastBurst
            }
        }

        return bursts
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
            // Update static cache with non-interleaved result
            Self.storeInterleavedResult(
                InterleavedCacheValue(hasInterleaved: false, groups: []),
                for: message
            )
            return
        }

        let groups = Self.computeContentGroupsStatic(
            contentOrder: message.contentOrder,
            hasInterleavedContent: interleaved
        )

        if !cachedHasInterleavedContent {
            cachedHasInterleavedContent = true
        }
        if cachedContentGroups != groups {
            cachedContentGroups = groups
        }

        // Update static cache so the next init() for this message uses fresh values
        Self.storeInterleavedResult(
            InterleavedCacheValue(hasInterleaved: interleaved, groups: groups),
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
    private func inlineToolProgress(toolIndices: [Int], isLatestGroup: Bool, hasTrailingText: Bool, expandedItems: [ProgressExpandedItem]? = nil) -> some View {
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

            // ⚠️ No .frame(maxWidth:) in LazyVStack cells — see AGENTS.md.
            HStack(spacing: 0) {
                AssistantProgressView(
                    toolCalls: groupedToolCalls,
                    isStreaming: isLatestGroup ? message.isStreaming : false,
                    hasText: hasTrailingText,
                    isProcessing: isLatestGroup && isProcessingAfterTools,
                    processingStatusText: isLatestGroup && isProcessingAfterTools ? processingStatusText : nil,
                    streamingCodePreview: isLatestGroup ? message.streamingCodePreview : nil,
                    streamingCodeToolName: isLatestGroup ? message.streamingCodeToolName : nil,
                    decidedConfirmations: groupConfirmations,
                    expandedItems: expandedItems,
                    onRehydrate: onRehydrate,
                    onConfirmationAllow: onConfirmationAllow,
                    onConfirmationDeny: onConfirmationDeny,
                    onAlwaysAllow: onAlwaysAllow,
                    onTemporaryAllow: onTemporaryAllow,
                    activeConfirmationRequestId: activeConfirmationRequestId,
                    progressUIState: $progressUIState,
                    suggestRuleToolCall: $suggestRuleToolCall,
                    suggestRuleSuggestion: $suggestRuleSuggestion
                )
                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder
    var interleavedContent: some View {
        let groups = cachedContentGroups
        let showThinking = MacOSClientFeatureFlagManager.shared.isEnabled("show-thinking-blocks")

        // Compute work bursts — consecutive tool/thinking groups merged into cards
        let bursts = Self.computeWorkBursts(
            groups: groups,
            contentOrder: message.contentOrder,
            toolCalls: message.toolCalls,
            thinkingSegments: message.thinkingSegments,
            showThinking: showThinking,
            isStreaming: message.isStreaming,
            messageId: message.id
        )

        // Map each participating group's stableId to its burst
        let burstForGroup: [String: WorkBurst] = {
            var map: [String: WorkBurst] = [:]
            for burst in bursts {
                let toolSet = Set(burst.toolIndices)
                let thinkingSet = Set(burst.thinkingIndices)
                for group in groups {
                    switch group {
                    case .toolCalls(let indices):
                        if !Set(indices).isDisjoint(with: toolSet) {
                            map[group.stableId] = burst
                        }
                    case .thinking(let indices):
                        if !Set(indices).isDisjoint(with: thinkingSet) {
                            map[group.stableId] = burst
                        }
                    default:
                        continue
                    }
                }
            }
            return map
        }()

        // The anchor group is the first group in each burst (renders the card)
        let burstAnchorIds: Set<String> = Set(bursts.map(\.stableId))

        // Identify the latest burst by stableId (last burst in the list)
        let latestBurstId: String? = bursts.last?.stableId

        // Compute hasTrailingText per-burst: true if any text group follows
        // the burst's last tool call group in the groups array
        let burstTrailingText: [String: Bool] = {
            var result: [String: Bool] = [:]
            for burst in bursts {
                let burstToolSet = Set(burst.toolIndices)
                // Find the last group index that belongs to this burst
                var lastBurstGroupIdx: Int?
                for (idx, group) in groups.enumerated() {
                    switch group {
                    case .toolCalls(let indices):
                        if !Set(indices).isDisjoint(with: burstToolSet) {
                            lastBurstGroupIdx = idx
                        }
                    case .thinking(let indices):
                        let burstThinkingSet = Set(burst.thinkingIndices)
                        if !Set(indices).isDisjoint(with: burstThinkingSet) {
                            lastBurstGroupIdx = idx
                        }
                    default:
                        break
                    }
                }
                guard let lastIdx = lastBurstGroupIdx else {
                    result[burst.stableId] = false
                    continue
                }
                var found = false
                if lastIdx + 1 < groups.count {
                    for followingGroup in groups[(lastIdx + 1)...] {
                        if case .texts(let textIndices) = followingGroup {
                            let hasNonEmpty = textIndices.contains { i in
                                i < message.textSegments.count
                                    && !message.textSegments[i].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            }
                            if hasNonEmpty {
                                found = true
                                break
                            }
                        }
                    }
                }
                result[burst.stableId] = found
            }
            return result
        }()

        // Map text group stableIds to the burst whose images they should render.
        // Only bursts whose immediately following group is a `.texts` group
        // qualify — if a surface sits between the burst and the next text,
        // the burst keeps its images to avoid them vanishing.
        let textGroupDeferredBurst: [String: WorkBurst] = {
            var map: [String: WorkBurst] = [:]
            for burst in bursts {
                guard burstTrailingText[burst.stableId] == true else { continue }
                let burstToolSet = Set(burst.toolIndices)
                let burstThinkingSet = Set(burst.thinkingIndices)
                var lastBurstGroupIdx: Int?
                for (idx, group) in groups.enumerated() {
                    switch group {
                    case .toolCalls(let indices):
                        if !Set(indices).isDisjoint(with: burstToolSet) { lastBurstGroupIdx = idx }
                    case .thinking(let indices):
                        if !Set(indices).isDisjoint(with: burstThinkingSet) { lastBurstGroupIdx = idx }
                    default: break
                    }
                }
                guard let lastIdx = lastBurstGroupIdx, lastIdx + 1 < groups.count else { continue }
                if case .texts = groups[lastIdx + 1] {
                    map[groups[lastIdx + 1].stableId] = burst
                }
            }
            return map
        }()

        // Derive deferred image burst IDs from the text-group mapping so that
        // images are only suppressed at the burst site when a text group is
        // actually mapped to render them. This prevents image loss when a
        // surface separates a burst from a later text group.
        let deferredImageBurstIds: Set<String> = Set(textGroupDeferredBurst.values.map(\.stableId))

        // Identify the last text group so attachments render right after it
        let lastTextGroupId: String? = groups.last(where: {
            if case .texts = $0 { return true }
            return false
        })?.stableId

        // Render all content groups in order: text, burst cards, and surfaces.
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
                    textBubble(for: joined, textGroupIndex: indices.first ?? 0)
                }
                // Render deferred burst images after the text so descriptive
                // text appears before the screenshot it introduces.
                if shouldRenderToolProgressInline,
                   let deferredBurst = textGroupDeferredBurst[group.stableId] {
                    let deferredCalls: [ToolCallData] = deferredBurst.toolIndices.compactMap { tcIdx in
                        guard tcIdx < message.toolCalls.count else { return nil }
                        return message.toolCalls[tcIdx]
                    }
                    inlineToolCallImages(from: deferredCalls)
                }
                // Render attachments right after the last text group
                if group.stableId == lastTextGroupId {
                    inlineAttachments
                }
            case .toolCalls(let indices):
                if shouldRenderToolProgressInline {
                    if burstAnchorIds.contains(group.stableId),
                       let burst = burstForGroup[group.stableId] {
                        // This group is the anchor for its burst — render the burst card
                        inlineToolProgress(
                            toolIndices: burst.toolIndices,
                            isLatestGroup: burst.stableId == latestBurstId,
                            hasTrailingText: burstTrailingText[burst.stableId] ?? false,
                            expandedItems: burst.expandedItems.contains(where: { if case .thinking = $0 { return true }; return false }) ? burst.expandedItems : nil
                        )
                        // Render tool call images unless deferred to the following text group
                        if !deferredImageBurstIds.contains(burst.stableId) {
                            let burstToolCalls: [ToolCallData] = burst.toolIndices.compactMap { tcIdx in
                                guard tcIdx < message.toolCalls.count else { return nil }
                                return message.toolCalls[tcIdx]
                            }
                            inlineToolCallImages(from: burstToolCalls)
                        }
                    } else if burstForGroup[group.stableId] != nil {
                        // Part of a burst but not the anchor — skip rendering
                        EmptyView()
                    } else {
                        // Not part of any burst (shouldn't happen for toolCalls, but fallback)
                        inlineToolProgress(
                            toolIndices: indices,
                            isLatestGroup: false,
                            hasTrailingText: false
                        )
                    }
                } else {
                    EmptyView()
                }
            case .surface(let i):
                if i < message.inlineSurfaces.count,
                   message.inlineSurfaces[i].id != activeSurfaceId {
                    InlineSurfaceRouter(surface: message.inlineSurfaces[i], onAction: onSurfaceAction, onRefetch: onSurfaceRefetch)
                }
            case .thinking:
                if burstForGroup[group.stableId] != nil {
                    // Thinking folded into a burst — rendered by the burst anchor
                    if burstAnchorIds.contains(group.stableId),
                       let burst = burstForGroup[group.stableId] {
                        // Render the burst card — no shouldRenderToolProgressInline
                        // guard because thinking-only bursts (no tool calls) still
                        // need to render even when the message has no interleaved tools.
                        inlineToolProgress(
                            toolIndices: burst.toolIndices,
                            isLatestGroup: burst.stableId == latestBurstId,
                            hasTrailingText: burstTrailingText[burst.stableId] ?? false,
                            expandedItems: burst.expandedItems.contains(where: { if case .thinking = $0 { return true }; return false }) ? burst.expandedItems : nil
                        )
                        if !deferredImageBurstIds.contains(burst.stableId) {
                            let burstToolCalls: [ToolCallData] = burst.toolIndices.compactMap { tcIdx in
                                guard tcIdx < message.toolCalls.count else { return nil }
                                return message.toolCalls[tcIdx]
                            }
                            inlineToolCallImages(from: burstToolCalls)
                        }
                    } else {
                        EmptyView()
                    }
                } else if showThinking, case .thinking(let indices) = group {
                    // Standalone thinking (no adjacent tools, not forwarded
                    // to a burst) — render as ThinkingBlockView.
                    let joined = indices
                        .compactMap { i in
                            i < message.thinkingSegments.count
                                ? message.thinkingSegments[i]
                                : nil
                        }
                        .filter { !$0.isEmpty }
                        .joined(separator: "\n")
                    if !joined.isEmpty {
                        ThinkingBlockView(
                            content: joined,
                            isStreaming: message.isStreaming,
                            expansionKey: "\(message.id.uuidString)-th\(indices.first ?? 0)",
                            typographyGeneration: typographyGeneration
                        )
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
                    if attachment.isTextPreviewable {
                        InlineFilePreviewView(
                            attachment: attachment,
                            isUser: isUser,
                            messageId: message.id
                        )
                    } else {
                        fileAttachmentChip(attachment)
                    }
                }
            }
        }
    }
}
