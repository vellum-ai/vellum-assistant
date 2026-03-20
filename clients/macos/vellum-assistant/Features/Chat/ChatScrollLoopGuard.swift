import Foundation

// MARK: - ChatScrollLoopGuard

/// Detects runaway scroll-loop patterns in the chat transcript by tracking
/// rolling counters of scroll-related events per conversation.
///
/// This is a pure helper with no SwiftUI or AppKit dependencies. It accepts
/// monotonic timestamps and event kinds, maintains short rolling counters,
/// and returns a structured aggregate snapshot when thresholds are exceeded.
/// Callers (e.g. `MessageListView`) can forward the snapshot to both
/// `os.Logger` and `ChatDiagnosticsStore`.
///
/// **Thresholds:**
/// - More than 40 `anchorPreferenceChange` events in 2 seconds
/// - More than 15 `scrollToRequested` events in 2 seconds
/// - More than 50 `avatarFollowerUpdate` events in 2 seconds
/// - More than 30 `avatarDisplayYApplied` events in 2 seconds
/// - More than 60 `tailAnchorPreferenceChange` events in 2 seconds
/// - More than 40 `bodyEvaluation` events in 2 seconds
///
/// Once tripped, the guard emits at most one aggregate warning per cooldown
/// window (the same 2-second duration), then re-arms after a quiet window
/// elapses with no events.
final class ChatScrollLoopGuard {

    // MARK: - Event Kinds

    enum EventKind: String, CaseIterable {
        case anchorPreferenceChange
        case scrollToRequested
        case repinAttempt
        case suppressionFlip
        case avatarFollowerUpdate
        case avatarDisplayYApplied
        case tailAnchorPreferenceChange
        case bodyEvaluation
    }

    // MARK: - Aggregate Snapshot

    /// Structured warning payload emitted when the guard trips.
    /// Contains the event counts observed during the detection window
    /// so callers can log or store the same data without re-querying.
    struct AggregateSnapshot: Equatable {
        let conversationId: String
        let windowDuration: TimeInterval
        let counts: [EventKind: Int]
        let trippedBy: EventKind
        let timestamp: TimeInterval
    }

    // MARK: - Thresholds (explicit constants)

    /// Maximum anchor preference change events allowed in the detection window.
    static let anchorThreshold: Int = 40

    /// Maximum scrollTo requests allowed in the detection window.
    static let scrollToThreshold: Int = 15

    /// Maximum updateAvatarFollower() calls allowed in the detection window.
    static let avatarFollowerThreshold: Int = 50

    /// Maximum applyAvatarDisplayY() @State mutations allowed in the detection window.
    static let avatarApplyThreshold: Int = 30

    /// Maximum ConversationTailAnchorYKey preference fires allowed in the detection window.
    static let tailAnchorThreshold: Int = 60

    /// Maximum body evaluations allowed in the detection window.
    static let bodyEvaluationThreshold: Int = 40

    /// Rolling window duration in seconds for event counting.
    static let windowDuration: TimeInterval = 2.0

    /// After tripping, the guard suppresses further warnings for this duration.
    /// The guard re-arms only after a full quiet window elapses with no events.
    static let cooldownDuration: TimeInterval = 2.0

    // MARK: - Internal State

    private struct ConversationState {
        /// Rolling timestamps per event kind within the current window.
        var events: [EventKind: [TimeInterval]] = [:]

        /// Timestamp when the guard last tripped (nil if never tripped or reset).
        var lastTripTime: TimeInterval?

        /// Timestamp of the most recent event of any kind (for quiet-window detection).
        var lastEventTime: TimeInterval?

        /// Whether the guard is currently in cooldown (suppressing warnings).
        var inCooldown: Bool = false
    }

    private var states: [String: ConversationState] = [:]

    // MARK: - Public API

    /// Records an event and returns an aggregate snapshot if the guard trips.
    ///
    /// - Parameters:
    ///   - kind: The type of scroll-related event.
    ///   - conversationId: The conversation this event belongs to.
    ///   - timestamp: Monotonic timestamp (e.g. `ProcessInfo.processInfo.systemUptime`).
    /// - Returns: An `AggregateSnapshot` if thresholds are exceeded and the guard
    ///   is not in cooldown; `nil` otherwise.
    @discardableResult
    func record(
        _ kind: EventKind,
        conversationId: String,
        timestamp: TimeInterval
    ) -> AggregateSnapshot? {
        var state = states[conversationId] ?? ConversationState()

        // Prune events outside the rolling window.
        let windowStart = timestamp - Self.windowDuration
        for eventKind in EventKind.allCases {
            state.events[eventKind] = (state.events[eventKind] ?? []).filter { $0 > windowStart }
        }

        // Append the new event.
        state.events[kind, default: []].append(timestamp)

        // Re-arm cooldown only after a full quiet window with no events.
        if state.inCooldown, let lastEvent = state.lastEventTime {
            if timestamp - lastEvent >= Self.cooldownDuration {
                state.inCooldown = false
            }
        }

        // Track the latest event time (must come after the cooldown check).
        state.lastEventTime = timestamp

        // Check thresholds.
        let anchorCount = state.events[.anchorPreferenceChange]?.count ?? 0
        let scrollToCount = state.events[.scrollToRequested]?.count ?? 0
        let avatarFollowerCount = state.events[.avatarFollowerUpdate]?.count ?? 0
        let avatarApplyCount = state.events[.avatarDisplayYApplied]?.count ?? 0
        let tailAnchorCount = state.events[.tailAnchorPreferenceChange]?.count ?? 0
        let bodyEvalCount = state.events[.bodyEvaluation]?.count ?? 0

        var trippedBy: EventKind?
        if anchorCount > Self.anchorThreshold {
            trippedBy = .anchorPreferenceChange
        } else if scrollToCount > Self.scrollToThreshold {
            trippedBy = .scrollToRequested
        } else if avatarFollowerCount > Self.avatarFollowerThreshold {
            trippedBy = .avatarFollowerUpdate
        } else if avatarApplyCount > Self.avatarApplyThreshold {
            trippedBy = .avatarDisplayYApplied
        } else if tailAnchorCount > Self.tailAnchorThreshold {
            trippedBy = .tailAnchorPreferenceChange
        } else if bodyEvalCount > Self.bodyEvaluationThreshold {
            trippedBy = .bodyEvaluation
        }

        var snapshot: AggregateSnapshot?

        if let trippedKind = trippedBy, !state.inCooldown {
            // Build the aggregate counts for all event kinds.
            var counts: [EventKind: Int] = [:]
            for eventKind in EventKind.allCases {
                let count = state.events[eventKind]?.count ?? 0
                if count > 0 {
                    counts[eventKind] = count
                }
            }

            snapshot = AggregateSnapshot(
                conversationId: conversationId,
                windowDuration: Self.windowDuration,
                counts: counts,
                trippedBy: trippedKind,
                timestamp: timestamp
            )

            state.lastTripTime = timestamp
            state.inCooldown = true
        }

        states[conversationId] = state
        return snapshot
    }

    /// Resets all tracking state for a conversation.
    func reset(conversationId: String) {
        states.removeValue(forKey: conversationId)
    }

    /// Resets all tracking state for all conversations.
    func resetAll() {
        states.removeAll()
    }

    /// Returns the current rolling event counts for a conversation.
    /// Used by `DebugStateWriter` to include hot-path rates in `debug-state.json`.
    func currentCounts(conversationId: String) -> [EventKind: Int] {
        guard let state = states[conversationId] else { return [:] }
        var counts: [EventKind: Int] = [:]
        for kind in EventKind.allCases {
            let count = state.events[kind]?.count ?? 0
            if count > 0 {
                counts[kind] = count
            }
        }
        return counts
    }

    /// Returns true when the guard has tripped for this conversation and is
    /// still in cooldown. Callers can use this as a circuit breaker to suppress
    /// further scroll-to calls until the cascade subsides.
    func isTripped(conversationId: String) -> Bool {
        guard let state = states[conversationId] else { return false }
        return state.inCooldown
    }
}

// MARK: - Hashable conformance for EventKind (dictionary key)

extension ChatScrollLoopGuard.EventKind: Hashable {}
