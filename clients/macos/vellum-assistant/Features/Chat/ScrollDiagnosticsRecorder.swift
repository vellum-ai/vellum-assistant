import Foundation
import os

/// Owns all scroll-related diagnostic recording — loop detection, transcript
/// snapshot capture, and non-finite geometry logging — extracted from
/// `MessageListScrollCoordinator` to keep the coordinator focused on scroll
/// mechanics.
///
/// **`@MainActor`** because it owns `Task`s and writes to the `@MainActor`
/// `ChatDiagnosticsStore`. Not an `ObservableObject` — it has no reactive
/// state that drives view re-renders.
@MainActor
final class ScrollDiagnosticsRecorder {

    // MARK: - Properties

    /// Detects runaway scroll-loop patterns and emits one aggregate warning
    /// per cooldown window instead of per-frame log spam.
    var scrollLoopGuard = ChatScrollLoopGuard()

    /// One-shot flag: logs a warning the first time anchor, tail, or viewport
    /// geometry is non-finite during a render pass.
    var hasLoggedNonFiniteGeometry: Bool = false

    /// Debounced task for transcript snapshot updates, coalescing rapid scroll
    /// events into a single snapshot capture per 150ms window.
    private var snapshotDebounceTask: Task<Void, Never>?

    // MARK: - Loop Event Recording

    /// Records a scroll-related event into the loop guard and emits a
    /// diagnostic warning if the guard trips.
    func recordScrollLoopEvent(
        _ kind: ChatScrollLoopGuard.EventKind,
        conversationId: UUID?,
        isNearBottom: Bool = false,
        scrollViewportHeight: CGFloat = .infinity,
        anchorMessageId: UUID? = nil,
        hasReceivedScrollEvent: Bool,
        isAtBottom: Bool
    ) {
        let convId = conversationId?.uuidString ?? "unknown"
        let timestamp = ProcessInfo.processInfo.systemUptime

        if let snapshot = scrollLoopGuard.record(kind, conversationId: convId, timestamp: timestamp) {
            // Log the full event histogram (all event kinds, including zeros)
            // for post-mortem analysis — not just the kinds with non-zero counts.
            let fullHistogram = ChatScrollLoopGuard.EventKind.allCases
                .map { "\($0.rawValue)=\(snapshot.counts[$0] ?? 0)" }
                .joined(separator: " ")
            scrollCoordinatorLog.warning(
                "Scroll loop detected — trippedBy=\(snapshot.trippedBy.rawValue) window=\(snapshot.windowDuration)s \(fullHistogram) isNearBottom=\(isNearBottom) hasReceivedScrollEvent=\(hasReceivedScrollEvent) anchorMessageId=\(String(describing: anchorMessageId)) isAtBottom=\(isAtBottom) viewportHeight=\(scrollViewportHeight)"
            )
            var sanitizer = NumericSanitizer()
            let safeViewportHeight = sanitizer.sanitize(scrollViewportHeight, field: "viewportHeight")
            logNonFiniteGeometryOnce(sanitizer: sanitizer)
            ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                kind: .scrollLoopDetected,
                conversationId: convId,
                reason: "trippedBy=\(snapshot.trippedBy.rawValue) \(fullHistogram)",
                isPinnedToBottom: isNearBottom,
                isUserScrolling: hasReceivedScrollEvent,
                scrollOffsetY: 0,
                viewportHeight: safeViewportHeight,
                nonFiniteFields: sanitizer.nonFiniteFields
            ))
        }
    }

    // MARK: - Transcript Snapshot

    /// Schedules a debounced transcript snapshot capture.
    func scheduleTranscriptSnapshot(
        conversationId: UUID?,
        messages: [ChatMessage],
        isNearBottom: Bool,
        scrollViewportHeight: CGFloat,
        containerWidth: CGFloat,
        anchorMessageId: UUID?,
        highlightedMessageId: UUID?,
        hasReceivedScrollEvent: Bool,
        isPaginationInFlight: Bool,
        isSuppressed: Bool,
        suppression: ScrollSuppression,
        isAtBottom: Bool
    ) {
        snapshotDebounceTask?.cancel()
        snapshotDebounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled, let self else { return }
            self.updateTranscriptSnapshot(
                conversationId: conversationId,
                messages: messages,
                isNearBottom: isNearBottom,
                scrollViewportHeight: scrollViewportHeight,
                containerWidth: containerWidth,
                anchorMessageId: anchorMessageId,
                highlightedMessageId: highlightedMessageId,
                hasReceivedScrollEvent: hasReceivedScrollEvent,
                isPaginationInFlight: isPaginationInFlight,
                isSuppressed: isSuppressed,
                suppression: suppression,
                isAtBottom: isAtBottom
            )
        }
    }

    /// Captures a point-in-time transcript snapshot into `ChatDiagnosticsStore`.
    private func updateTranscriptSnapshot(
        conversationId: UUID?,
        messages: [ChatMessage],
        isNearBottom: Bool,
        scrollViewportHeight: CGFloat,
        containerWidth: CGFloat,
        anchorMessageId: UUID?,
        highlightedMessageId: UUID?,
        hasReceivedScrollEvent: Bool,
        isPaginationInFlight: Bool,
        isSuppressed: Bool,
        suppression: ScrollSuppression,
        isAtBottom: Bool
    ) {
        guard let convId = conversationId else { return }
        let totalToolCalls = messages.reduce(0) { $0 + $1.toolCalls.count }

        var sanitizer = NumericSanitizer()
        let safeViewportHeight = sanitizer.sanitize(scrollViewportHeight, field: "scrollViewportHeight")
        let safeContainerWidth = sanitizer.sanitize(containerWidth, field: "containerWidth")
        logNonFiniteGeometryOnce(sanitizer: sanitizer)

        let guardCounts = scrollLoopGuard.currentCounts(conversationId: convId.uuidString)
        let guardCountsStringKeyed: [String: Int]? = guardCounts.isEmpty ? nil : Dictionary(
            uniqueKeysWithValues: guardCounts.map { ($0.key.rawValue, $0.value) }
        )

        ChatDiagnosticsStore.shared.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: convId.uuidString,
            capturedAt: Date(),
            messageCount: messages.count,
            toolCallCount: totalToolCalls,
            isPinnedToBottom: isNearBottom,
            isUserScrolling: hasReceivedScrollEvent,
            scrollOffsetY: 0,
            contentHeight: nil,
            viewportHeight: safeViewportHeight,
            isNearBottom: isNearBottom,
            hasReceivedScrollEvent: hasReceivedScrollEvent,
            isPaginationInFlight: isPaginationInFlight,
            suppressionReason: isSuppressed ? suppression.reasonDescriptions.joined(separator: ",") : nil,
            anchorMessageId: anchorMessageId?.uuidString,
            highlightedMessageId: highlightedMessageId?.uuidString,
            anchorMinY: 0,
            scrollViewportHeight: safeViewportHeight,
            containerWidth: safeContainerWidth,
            scrollLoopGuardCounts: guardCountsStringKeyed,
            nonFiniteFields: sanitizer.nonFiniteFields
        ))
    }

    // MARK: - Non-Finite Geometry Logging

    /// Logs a one-time warning when scroll geometry first becomes non-finite.
    func logNonFiniteGeometryOnce(sanitizer: NumericSanitizer) {
        guard !hasLoggedNonFiniteGeometry, let fields = sanitizer.nonFiniteFields else { return }
        hasLoggedNonFiniteGeometry = true
        scrollCoordinatorLog.warning("Non-finite scroll geometry detected — sanitized fields: \(fields.joined(separator: ", "))")
    }

    // MARK: - Lifecycle

    /// Cancels the snapshot debounce task. Called from `cancelAllTasks()` (onDisappear).
    /// Does NOT reset `hasLoggedNonFiniteGeometry` — that flag persists across
    /// the coordinator's lifetime, not per conversation.
    func cancel() {
        snapshotDebounceTask?.cancel()
        snapshotDebounceTask = nil
    }

    /// Resets state for a conversation switch. Cancels the snapshot debounce task
    /// and resets the scroll loop guard for the OLD conversation.
    /// Does NOT reset `hasLoggedNonFiniteGeometry` — it's a one-shot per
    /// coordinator instance, not per conversation.
    func reset(oldConversationId: UUID?) {
        snapshotDebounceTask?.cancel()
        snapshotDebounceTask = nil
        if let oldConvId = oldConversationId {
            scrollLoopGuard.reset(conversationId: oldConvId.uuidString)
        }
    }
}
