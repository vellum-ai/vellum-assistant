import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let stallLog = OSLog(subsystem: "com.vellum.assistant", category: "LayoutStall")

extension MessageListView {

    // MARK: - Visible messages

    /// The subset of messages actually shown, honoring the pagination window.
    /// Reads the pre-computed cache from the model layer in O(1) instead of
    /// running the O(n) visibility filter on every body evaluation.
    ///
    /// - SeeAlso: [WWDC23 — Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
    var visibleMessages: [ChatMessage] {
        paginatedVisibleMessages
    }

    // MARK: - Version tracking

    /// Checks whether observable message-level inputs have changed since the
    /// last body evaluation and, if so, bumps `scrollState.messageListVersion`.
    /// Over-invalidation is safe (triggers a recompute); under-invalidation
    /// is not.
    ///
    /// Tracks both the raw `messages.count` (catches new arrivals and
    /// paginated-window shifts at fixed length) and the filtered
    /// `visibleMessages.count` (catches hidden/subagent visibility
    /// transitions). All checks are O(1). `isSending` / `isThinking`
    /// transitions are handled via `PrecomputedCacheKey` fields directly.
    func refreshMessageListVersionIfNeeded(visibleMessages: [ChatMessage]) {
        let cache = scrollState.derivedStateCache
        let currentRawCount = messages.count
        let currentVisibleCount = visibleMessages.count
        let currentLastStreaming = visibleMessages.last?.isStreaming ?? false
        let currentIncompleteToolCalls = visibleMessages.last?.toolCalls.filter { !$0.isComplete }.count ?? 0

        // O(n) hash of visible message IDs — catches "same count, different
        // IDs" scenarios (e.g. mid-array swaps during streaming or pagination).
        var idHasher = Hasher()
        for msg in visibleMessages { idHasher.combine(msg.id) }
        let currentIdFingerprint = idHasher.finalize()

        var changed = false

        if currentRawCount != cache.lastKnownRawMessageCount {
            cache.lastKnownRawMessageCount = currentRawCount
            changed = true
        }
        if currentVisibleCount != cache.lastKnownVisibleMessageCount {
            cache.lastKnownVisibleMessageCount = currentVisibleCount
            changed = true
        }
        if currentLastStreaming != cache.lastKnownLastMessageStreaming {
            cache.lastKnownLastMessageStreaming = currentLastStreaming
            changed = true
        }
        if currentIncompleteToolCalls != cache.lastKnownIncompleteToolCallCount {
            cache.lastKnownIncompleteToolCallCount = currentIncompleteToolCalls
            changed = true
        }
        if currentIdFingerprint != cache.lastKnownVisibleIdFingerprint {
            cache.lastKnownVisibleIdFingerprint = currentIdFingerprint
            changed = true
        }

        if changed {
            cache.messageListVersion += 1
        }
    }

    // MARK: - Subagent fingerprint

    /// Computes a fingerprint over active subagents that captures identity,
    /// parent assignment, status, label, and error — not just count.
    static func computeSubagentFingerprint(_ subagents: [SubagentInfo]) -> Int {
        var hasher = Hasher()
        hasher.combine(subagents.count)
        for s in subagents {
            hasher.combine(s.id)
            hasher.combine(s.parentMessageId)
            hasher.combine(s.label)
            hasher.combine(s.status)
            hasher.combine(s.error)
        }
        return hasher.finalize()
    }

    // MARK: - Derived state

    /// Computes all derived values needed by the message list body.
    ///
    /// Structural metadata (IDs, timestamps, role-based indices, subagent
    /// grouping) is memoized behind a lightweight O(1) cache key stored in a
    /// non-observable cache attached to `MessageListScrollState`.
    /// Content-derived state (message data, confirmation placement, thinking indicators) is
    /// always computed fresh from the live `visibleMessages` array so
    /// SwiftUI's `.equatable()` diffing sees every mutation.
    var derivedState: MessageListDerivedState {
        os_signpost(.begin, log: stallLog, name: "DerivedState.resolve")
        scrollState.recordBodyEvaluation()
        let cache = scrollState.derivedStateCache

        if cache.isThrottled, let cached = cache.cachedDerivedState {
            os_signpost(.end, log: stallLog, name: "DerivedState.resolve")
            return cached
        }

        // Compute visible messages first so version tracking and layout
        // both operate on the same filtered set.
        let liveMessages = visibleMessages
        cache.cachedFirstVisibleMessageId = liveMessages.first?.id
        refreshMessageListVersionIfNeeded(visibleMessages: liveMessages)

        let key = PrecomputedCacheKey(
            messageListVersion: cache.messageListVersion,
            isSending: isSending,
            isThinking: isThinking,
            isCompacting: isCompacting,
            assistantStatusText: assistantStatusText,
            activeSubagentFingerprint: Self.computeSubagentFingerprint(activeSubagents),
            displayedMessageCount: displayedMessageCount
        )

        // --- Stage 1: Cached structural metadata ---
        let layout: CachedMessageLayoutMetadata
        if key == cache.cachedLayoutKey,
           let cached = cache.cachedLayoutMetadata,
           cached.displayMessageIds.count == liveMessages.count {
            #if DEBUG
            var seen = Set<UUID>()
            let freshIds = liveMessages.map(\.id).filter { seen.insert($0).inserted }
            assert(
                cached.displayMessageIds == freshIds,
                "layout cache stale: IDs \(cached.displayMessageIds.count) vs \(freshIds.count)"
            )
            #endif
            os_signpost(.event, log: stallLog, name: "DerivedState.layoutCacheHit")
            layout = cached
        } else {
            os_signpost(.event, log: stallLog, name: "DerivedState.layoutCacheMiss", "version=%d", cache.messageListVersion)

            let displayMessageIds: [UUID] = {
                var seen = Set<UUID>()
                return liveMessages.map(\.id).filter { seen.insert($0).inserted }
            }()
            let messageIndexById = Dictionary(liveMessages.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
            let showTimestamp = timestampIds(for: liveMessages)
            let latestAssistantId = liveMessages.last(where: { $0.role == .assistant })?.id

            var hasPrecedingAssistantByIndex = Set<Int>()
            for i in liveMessages.indices where i > 0 {
                if liveMessages[i - 1].role == .assistant {
                    hasPrecedingAssistantByIndex.insert(i)
                }
            }

            let hasUserMessage = liveMessages.contains { $0.role == .user }
            let subagentsByParent: [UUID: [SubagentInfo]] = Dictionary(
                grouping: activeSubagents.filter { $0.parentMessageId != nil },
                by: { $0.parentMessageId! }
            )
            let orphanSubagents = activeSubagents.filter { $0.parentMessageId == nil }
            let effectiveStatusText = isCompacting ? "Compacting context\u{2026}" : assistantStatusText

            layout = CachedMessageLayoutMetadata(
                displayMessageIds: displayMessageIds,
                messageIndexById: messageIndexById,
                showTimestamp: showTimestamp,
                hasPrecedingAssistantByIndex: hasPrecedingAssistantByIndex,
                hasUserMessage: hasUserMessage,
                latestAssistantId: latestAssistantId,
                subagentsByParent: subagentsByParent,
                orphanSubagents: orphanSubagents,
                effectiveStatusText: effectiveStatusText
            )
            cache.cachedLayoutKey = key
            cache.cachedLayoutMetadata = layout
        }

        // --- Stage 2: Live content-derived state (always fresh) ---

        let anchoredThinkingIndex = resolvedThinkingAnchorIndex(for: liveMessages)

        var nextDecidedConfirmationByIndex: [Int: ToolConfirmationData] = [:]
        for i in liveMessages.indices {
            if i + 1 < liveMessages.count,
               let conf = liveMessages[i + 1].confirmation,
               conf.state != .pending {
                nextDecidedConfirmationByIndex[i] = conf
            }
        }

        var isConfirmationRenderedInlineByIndex = Set<Int>()
        for i in liveMessages.indices {
            guard let confirmation = liveMessages[i].confirmation,
                  confirmation.state == .pending,
                  let confirmationToolUseId = confirmation.toolUseId,
                  !confirmationToolUseId.isEmpty else { continue }
            for j in (0..<i).reversed() {
                let msg = liveMessages[j]
                guard msg.role == .assistant, msg.confirmation == nil else { continue }
                if msg.toolCalls.contains(where: { $0.toolUseId == confirmationToolUseId && $0.pendingConfirmation != nil }) {
                    isConfirmationRenderedInlineByIndex.insert(i)
                }
                break
            }
        }

        let lastVisible = liveMessages.last
        let currentTurnMessages: ArraySlice<ChatMessage> = {
            if isSending, let last = liveMessages.last, last.role == .user {
                let lastNonUser = liveMessages.last(where: {
                    $0.role != .user
                })
                let isActivelyProcessing = lastNonUser?.isStreaming == true
                    || lastNonUser?.confirmation?.state == .pending
                if !isActivelyProcessing {
                    return liveMessages[liveMessages.endIndex...]
                }
            }
            let lastTurnStart = liveMessages.indices.reversed().first(where: { idx in
                liveMessages[idx].role == .user
                    && liveMessages.index(after: idx) < liveMessages.endIndex
                    && liveMessages[liveMessages.index(after: idx)].role != .user
            })
            if let idx = lastTurnStart {
                return liveMessages[liveMessages.index(after: idx)...]
            }
            return liveMessages[liveMessages.startIndex...]
        }()
        let hasActiveToolCall = currentTurnMessages.contains(where: {
            $0.toolCalls.contains(where: { !$0.isComplete })
        })
        let wouldShowThinking = isSending
            && (isThinking || !(lastVisible?.isStreaming == true))
            && !hasActiveToolCall
        let lastVisibleIsAssistant = lastVisible?.role == .assistant
        let canInlineProcessing = wouldShowThinking && lastVisibleIsAssistant
        let shouldShowThinkingIndicator = wouldShowThinking && !canInlineProcessing

        let result = MessageListDerivedState(
            messageIndexById: layout.messageIndexById,
            showTimestamp: layout.showTimestamp,
            hasPrecedingAssistantByIndex: layout.hasPrecedingAssistantByIndex,
            hasUserMessage: layout.hasUserMessage,
            latestAssistantId: layout.latestAssistantId,
            subagentsByParent: layout.subagentsByParent,
            orphanSubagents: layout.orphanSubagents,
            effectiveStatusText: layout.effectiveStatusText,
            displayMessages: {
                // SwiftUI's ForEach requires unique identity values;
                // duplicates during streaming or pagination cause
                // undefined behavior.
                var seen = Set<UUID>()
                return liveMessages.filter { seen.insert($0.id).inserted }
            }(),
            activePendingRequestId: activePendingRequestId,
            nextDecidedConfirmationByIndex: nextDecidedConfirmationByIndex,
            isConfirmationRenderedInlineByIndex: isConfirmationRenderedInlineByIndex,
            anchoredThinkingIndex: anchoredThinkingIndex,
            hasActiveToolCall: hasActiveToolCall,
            canInlineProcessing: canInlineProcessing,
            shouldShowThinkingIndicator: shouldShowThinkingIndicator,
            hasMessages: !liveMessages.isEmpty
        )

        cache.cachedDerivedState = result
        os_signpost(.end, log: stallLog, name: "DerivedState.resolve")
        return result
    }

    // MARK: - Fork helpers

    func canFork(from message: ChatMessage) -> Bool {
        onForkFromMessage != nil && message.daemonMessageId != nil && !message.isStreaming
    }

    func forkFromMessage(_ daemonMessageId: String) {
        onForkFromMessage?(daemonMessageId)
    }

    var forkFromMessageAction: ((String) -> Void)? {
        guard onForkFromMessage != nil else { return nil }
        return { daemonMessageId in
            forkFromMessage(daemonMessageId)
        }
    }

    // MARK: - Timestamp computation

    /// Pre-compute which message IDs should show a timestamp divider.
    /// Avoids creating a Calendar instance per-message inside the ForEach body.
    /// Uses UUID-based keys so results are stable across array mutations.
    func timestampIds(for list: [ChatMessage]) -> Set<UUID> {
        guard !list.isEmpty else { return [] }
        var result: Set<UUID> = [list[0].id]
        var calendar = Calendar.current
        calendar.timeZone = ChatTimestampTimeZone.resolve()
        for i in 1..<list.count {
            let current = list[i].timestamp
            let previous = list[i - 1].timestamp
            if !calendar.isDate(current, inSameDayAs: previous) || current.timeIntervalSince(previous) > 300 {
                result.insert(list[i].id)
            }
        }
        return result
    }

    // MARK: - Thinking anchor

    var shouldAnchorThinkingToConfirmationChip: Bool {
        assistantActivityPhase == "thinking"
            && assistantActivityAnchor == "assistant_turn"
            && assistantActivityReason == "confirmation_resolved"
    }

    func resolvedThinkingAnchorIndex(for list: [ChatMessage]) -> Int? {
        guard shouldAnchorThinkingToConfirmationChip else { return nil }
        guard !list.isEmpty else { return nil }

        for index in list.indices.reversed() {
            // Decided confirmation chips are usually rendered inline on the
            // preceding assistant bubble.
            if list[index].role == .assistant, list.index(after: index) < list.endIndex {
                let next = list[list.index(after: index)]
                if let nextConfirmation = next.confirmation, nextConfirmation.state != .pending {
                    return index
                }
            }

            // Fallback for standalone decided confirmation bubbles.
            if let confirmation = list[index].confirmation, confirmation.state != .pending {
                let hasPrecedingAssistant = index > list.startIndex
                    && list[list.index(before: index)].role == .assistant
                if !hasPrecedingAssistant {
                    return index
                }
            }
        }

        return nil
    }

    // MARK: - Scroll view content

    /// Computes derived state and wraps the inner equatable content view.
    ///
    /// The outer `MessageListView.body` is cheap — it creates the inner struct
    /// and applies lifecycle modifiers. The expensive `LazyVStack` + `ForEach`
    /// rendering lives in `MessageListContentView` which is guarded by
    /// `Equatable` + `.equatable()`, preventing redundant layout passes.
    @ViewBuilder
    var scrollViewContent: some View {
        let state = derivedState
        let catalogHash = MessageCellView.hashCatalog(providerCatalog)
        MessageListContentView(
            state: state,
            providerCatalog: providerCatalog,
            providerCatalogHash: catalogHash,
            isLoadingMoreMessages: isLoadingMoreMessages,
            isCompacting: isCompacting,
            isInteractionEnabled: isInteractionEnabled,
            containerWidth: containerWidth,
            dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
            activeSurfaceId: taskProgressManager.activeSurfaceId,
            highlightedMessageId: highlightedMessageId,
            mediaEmbedSettings: mediaEmbedSettings,
            hasEverSentMessage: hasEverSentMessage,
            showInspectButton: showInspectButton,
            isTTSEnabled: isTTSEnabled,
            selectedModel: selectedModel,
            configuredProviders: configuredProviders,
            subagentDetailStore: subagentDetailStore,
            assistantStatusText: assistantStatusText,
            scrollState: scrollState,
            onConfirmationAllow: onConfirmationAllow,
            onConfirmationDeny: onConfirmationDeny,
            onAlwaysAllow: onAlwaysAllow,
            onTemporaryAllow: onTemporaryAllow,
            onGuardianAction: onGuardianAction,
            onSurfaceAction: onSurfaceAction,
            onDismissDocumentWidget: onDismissDocumentWidget,
            onForkFromMessage: forkFromMessageAction,
            onInspectMessage: onInspectMessage,
            onRehydrateMessage: onRehydrateMessage,
            onSurfaceRefetch: onSurfaceRefetch,
            onRetryFailedMessage: onRetryFailedMessage,
            onRetryConversationError: onRetryConversationError,
            onAbortSubagent: onAbortSubagent,
            onSubagentTap: onSubagentTap
        )
        .equatable()
    }
}
