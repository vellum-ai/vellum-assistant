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

    /// Computes all derived values needed by the message list body by
    /// delegating to `TranscriptProjector.project()`.
    ///
    /// The projector produces a `TranscriptRenderModel` (aliased as
    /// `MessageListDerivedState`) from the raw chat inputs. A lightweight
    /// O(1) `PrecomputedCacheKey` gates re-projection so the full O(n)
    /// scan only runs on structural or state changes.
    var derivedState: TranscriptRenderModel {
        os_signpost(.begin, log: stallLog, name: "DerivedState.resolve")
        scrollState.recordBodyEvaluation()
        let cache = scrollState.derivedStateCache

        if cache.isThrottled, let cached = cache.cachedDerivedState {
            os_signpost(.end, log: stallLog, name: "DerivedState.resolve")
            return cached
        }

        // Compute visible messages first so version tracking and projection
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

        // Return cached projection when the key matches and the row count
        // is consistent with the live messages (guards against stale cache
        // after pagination window shifts).
        if key == cache.cachedProjectionKey,
           let cached = cache.cachedProjection,
           cached.rows.count == liveMessages.count {
            os_signpost(.event, log: stallLog, name: "DerivedState.projectionCacheHit")
            cache.cachedDerivedState = cached
            os_signpost(.end, log: stallLog, name: "DerivedState.resolve")
            return cached
        }

        os_signpost(.event, log: stallLog, name: "DerivedState.projectionCacheMiss", "version=%d", cache.messageListVersion)

        let result = TranscriptProjector.project(
            messages: messages,
            paginatedVisibleMessages: liveMessages,
            activeSubagents: activeSubagents,
            isSending: isSending,
            isThinking: isThinking,
            isCompacting: isCompacting,
            assistantStatusText: assistantStatusText,
            assistantActivityPhase: assistantActivityPhase,
            assistantActivityAnchor: assistantActivityAnchor,
            assistantActivityReason: assistantActivityReason,
            activePendingRequestId: activePendingRequestId,
            highlightedMessageId: highlightedMessageId
        )

        cache.cachedProjectionKey = key
        cache.cachedProjection = result
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
            typographyGeneration: typographyObserver.generation,
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
