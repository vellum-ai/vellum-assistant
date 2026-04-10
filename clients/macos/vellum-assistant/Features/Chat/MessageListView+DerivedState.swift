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

    /// Checks whether the shared message model has published a new snapshot
    /// since the last body evaluation and, if so, bumps the projection cache
    /// version. This exact signal covers content-only edits to an already-
    /// streaming message, which count/ID heuristics can miss.
    func refreshMessageListVersionIfNeeded(messagesRevision: UInt64) {
        let cache = projectionCache
        if messagesRevision != cache.lastKnownMessagesRevision {
            cache.lastKnownMessagesRevision = messagesRevision
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
    /// The projector produces a `TranscriptRenderModel` from the raw
    /// chat inputs. A lightweight O(1) `PrecomputedCacheKey` gates
    /// re-projection so the full O(n) scan only runs on structural or
    /// state changes.
    var derivedState: TranscriptRenderModel {
        os_signpost(.begin, log: stallLog, name: "DerivedState.resolve")
        let cache = projectionCache

        // Compute visible messages first so version tracking and projection
        // both operate on the same filtered set.
        let liveMessages = visibleMessages
        cache.cachedFirstVisibleMessageId = liveMessages.first?.id
        refreshMessageListVersionIfNeeded(messagesRevision: messagesRevision)

        let key = PrecomputedCacheKey(
            messageListVersion: cache.messageListVersion,
            isSending: isSending,
            isThinking: isThinking,
            isCompacting: isCompacting,
            assistantStatusText: assistantStatusText,
            assistantActivityPhase: assistantActivityPhase,
            assistantActivityAnchor: assistantActivityAnchor,
            assistantActivityReason: assistantActivityReason,
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
            layoutMetrics: layoutMetrics,
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
            viewportHeight: viewportHeight,
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
