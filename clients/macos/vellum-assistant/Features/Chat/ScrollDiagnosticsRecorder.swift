import Foundation
import os
import VellumAssistantShared

/// Owns scroll-related diagnostic recording — loop detection and non-finite
/// geometry logging — extracted from `MessageListScrollCoordinator` to keep
/// the coordinator focused on scroll mechanics.
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

    /// Returns `true` when the loop guard is tripped (in cooldown) for the given
    /// conversation, meaning a scroll loop was recently detected. Used by the
    /// scroll coordinator as a circuit breaker to suppress programmatic scrolls.
    func isScrollLoopTripped(conversationId: UUID?) -> Bool {
        let convId = conversationId?.uuidString ?? "unknown"
        return scrollLoopGuard.isTripped(conversationId: convId)
    }

    // MARK: - Non-Finite Geometry Logging

    /// Logs a one-time warning when scroll geometry first becomes non-finite.
    func logNonFiniteGeometryOnce(sanitizer: NumericSanitizer) {
        guard !hasLoggedNonFiniteGeometry, let fields = sanitizer.nonFiniteFields else { return }
        hasLoggedNonFiniteGeometry = true
        scrollCoordinatorLog.warning("Non-finite scroll geometry detected — sanitized fields: \(fields.joined(separator: ", "))")
    }

    // MARK: - Lifecycle

    /// Called from `cancelAllTasks()` (onDisappear). Currently a no-op but
    /// retained so the coordinator's cleanup contract stays consistent.
    func cancel() {}

    /// Resets state for a conversation switch. Resets the scroll loop guard
    /// for the OLD conversation.
    /// Does NOT reset `hasLoggedNonFiniteGeometry` — it's a one-shot per
    /// coordinator instance, not per conversation.
    func reset(oldConversationId: UUID?) {
        if let oldConvId = oldConversationId {
            scrollLoopGuard.reset(conversationId: oldConvId.uuidString)
        }
    }
}
