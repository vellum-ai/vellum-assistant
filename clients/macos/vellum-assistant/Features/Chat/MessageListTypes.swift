import Foundation
import SwiftUI
import VellumAssistantShared

// MARK: - Scroll Suppression Environment

/// Environment key that child views (e.g. AssistantProgressView) call to
/// temporarily suppress auto-scroll-to-bottom during content expansion.
struct SuppressAutoScrollKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var suppressAutoScroll: (() -> Void)? {
        get { self[SuppressAutoScrollKey.self] }
        set { self[SuppressAutoScrollKey.self] = newValue }
    }
}

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
    let activeSubagentFingerprint: Int
    let displayedMessageCount: Int
}

// MARK: - Scroll Geometry Snapshot

/// Lightweight snapshot of scroll geometry for the onScrollGeometryChange
/// handler. Captures values needed for scroll-direction detection,
/// scrollable-content detection, and viewport height tracking.
struct ScrollGeometrySnapshot: Equatable {
    let contentOffsetY: CGFloat
    let contentHeight: CGFloat
    let containerHeight: CGFloat
    let visibleRectHeight: CGFloat
}

// MARK: - Scroll Geometry Dispatcher

/// Coalesces `onScrollGeometryChange` callbacks outside SwiftUI-managed state.
///
/// macOS 26 faults when an `OnScrollGeometryChange` action updates view state
/// multiple times in the same frame. The message list still needs to process
/// the latest geometry snapshot, but the queue bookkeeping itself must not
/// live on `@State` / `@Observable` storage owned by the view.
@MainActor
final class ScrollGeometryUpdateDispatcher {
    static let shared = ScrollGeometryUpdateDispatcher()

    private var pendingSnapshots: [ObjectIdentifier: ScrollGeometrySnapshot] = [:]
    private var scheduledKeys: Set<ObjectIdentifier> = []
    private var generations: [ObjectIdentifier: Int] = [:]

    func enqueue(
        for owner: MessageListScrollState,
        snapshot: ScrollGeometrySnapshot,
        handler: @escaping @MainActor (ScrollGeometrySnapshot) -> Void
    ) {
        let key = ObjectIdentifier(owner)
        pendingSnapshots[key] = snapshot
        guard scheduledKeys.insert(key).inserted else { return }
        let generation = nextGeneration(for: key)
        scheduleDrain(for: key, owner: owner, generation: generation, handler: handler)
    }

    func cancel(for owner: MessageListScrollState) {
        let key = ObjectIdentifier(owner)
        scheduledKeys.remove(key)
        pendingSnapshots[key] = nil
        nextGeneration(for: key)
    }

    @discardableResult
    private func nextGeneration(for key: ObjectIdentifier) -> Int {
        let next = (generations[key] ?? 0) + 1
        generations[key] = next
        return next
    }

    private func scheduleDrain(
        for key: ObjectIdentifier,
        owner: MessageListScrollState,
        generation: Int,
        handler: @escaping @MainActor (ScrollGeometrySnapshot) -> Void
    ) {
        DispatchQueue.main.async { [weak self, weak owner] in
            Task { @MainActor [weak self, weak owner] in
                guard let self else { return }
                guard self.generations[key] == generation else { return }
                guard let owner else {
                    self.pendingSnapshots[key] = nil
                    self.scheduledKeys.remove(key)
                    return
                }
                self.drainNext(for: key, owner: owner, generation: generation, handler: handler)
            }
        }
    }

    private func drainNext(
        for key: ObjectIdentifier,
        owner: MessageListScrollState,
        generation: Int,
        handler: @escaping @MainActor (ScrollGeometrySnapshot) -> Void
    ) {
        guard generations[key] == generation else { return }
        guard let latest = pendingSnapshots[key] else {
            scheduledKeys.remove(key)
            return
        }

        pendingSnapshots[key] = nil
        handler(latest)

        guard pendingSnapshots[key] != nil else {
            scheduledKeys.remove(key)
            return
        }

        scheduleDrain(for: key, owner: owner, generation: generation, handler: handler)
    }
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
    var lastKnownRawMessageCount = 0
    var lastKnownVisibleMessageCount = 0
    var lastKnownLastMessageStreaming = false
    var lastKnownIncompleteToolCallCount = 0
    var lastKnownVisibleIdFingerprint = 0
    var cachedFirstVisibleMessageId: UUID?
    var bodyEvalTimestamps: [CFAbsoluteTime] = []
    var isThrottled = false
    var throttleRecoveryTask: Task<Void, Never>?

    func reset() {
        cachedProjectionKey = nil
        cachedProjection = nil
        messageListVersion = 0
        lastKnownRawMessageCount = 0
        lastKnownVisibleMessageCount = 0
        lastKnownLastMessageStreaming = false
        lastKnownIncompleteToolCallCount = 0
        lastKnownVisibleIdFingerprint = 0
        cachedFirstVisibleMessageId = nil
        bodyEvalTimestamps.removeAll()
        throttleRecoveryTask?.cancel()
        throttleRecoveryTask = nil
        isThrottled = false
    }
}
