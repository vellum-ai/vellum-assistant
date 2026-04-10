import Foundation
import SwiftUI
import VellumAssistantShared

// MARK: - Precomputed Cache Key

/// Lightweight key that captures all inputs to `precomputedState`.
/// All fields are O(1) to compare. The `messageListVersion` counter
/// is incremented by `onChange` handlers when structural or content
/// changes occur.
struct PrecomputedCacheKey: Equatable {
    let messageListVersion: Int
    let isSending: Bool
    let isThinking: Bool
    let isCompacting: Bool
    let assistantStatusText: String?
    let assistantActivityPhase: String
    let assistantActivityAnchor: String
    let assistantActivityReason: String?
    let activeSubagentFingerprint: Int
    let displayedMessageCount: Int
}

// MARK: - Bottom Detection

/// Pair of thresholds used by the `onScrollGeometryChange` bottom-detection
/// modifier. Returning a struct with two Bools lets the action closure apply
/// asymmetric hysteresis (30pt leave / 10pt enter) without reading `@State`
/// inside the transform.
struct BottomDetection: Equatable {
    /// Within the wider 30pt dead-zone (leave threshold).
    let nearBottom: Bool
    /// Within the tighter 10pt dead-zone (enter threshold).
    let atBottom: Bool
}

// MARK: - Projection Cache

/// Non-observable cache used by `MessageListView` during body evaluation.
///
/// SwiftUI logs "Modifying state during view update" when a view mutates
/// `@State` / `@Observable` storage while computing its body. The message-list
/// pipeline needs memoization for performance, but those cache writes must not
/// flow through SwiftUI-managed state. This helper keeps the cache off the
/// observation graph while preserving the existing hot-path behavior.
///
/// All derived transcript state flows through `TranscriptProjector` which
/// produces a `TranscriptRenderModel`. This cache gates re-projection with
/// an O(1) `PrecomputedCacheKey` and stores the circuit-breaker state that
/// protects against runaway body evaluations.
@MainActor
final class ProjectionCache {
    var cachedProjectionKey: PrecomputedCacheKey?
    var cachedProjection: TranscriptRenderModel?
    var messageListVersion = 0
    var lastKnownMessagesRevision: UInt64 = 0
    var cachedFirstVisibleMessageId: UUID?
    var bodyEvalTimestamps: [CFAbsoluteTime] = []
    var isThrottled = false
    var throttleRecoveryTask: Task<Void, Never>?

    /// Tracks body evaluation frequency and trips `isThrottled` when
    /// >100 evaluations occur in 2 seconds. This caps layout cost
    /// regardless of the re-evaluation source.
    func recordBodyEvaluation() {
        let now = CFAbsoluteTimeGetCurrent()
        bodyEvalTimestamps.append(now)
        let cutoff = now - 2.0
        if let firstValid = bodyEvalTimestamps.firstIndex(where: { $0 >= cutoff }) {
            bodyEvalTimestamps.removeFirst(firstValid)
        }
        if bodyEvalTimestamps.count > 100 && !isThrottled {
            isThrottled = true
            throttleRecoveryTask?.cancel()
            throttleRecoveryTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled else { return }
                isThrottled = false
                bodyEvalTimestamps.removeAll()
                throttleRecoveryTask = nil
            }
        }
    }

    func reset() {
        cachedProjectionKey = nil
        cachedProjection = nil
        messageListVersion = 0
        lastKnownMessagesRevision = 0
        cachedFirstVisibleMessageId = nil
        bodyEvalTimestamps.removeAll()
        throttleRecoveryTask?.cancel()
        throttleRecoveryTask = nil
        isThrottled = false
    }
}
