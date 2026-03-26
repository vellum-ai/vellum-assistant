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

/// Holds scroll-related tracking values that must persist across body
/// evaluations but must NOT trigger SwiftUI re-renders when updated.
/// These values serve as dead-zone guards and smoothing state — they
/// are never read during body evaluation for rendering purposes.
/// Pattern mirrors non-reactive properties on the coordinator (not @Published).
@MainActor final class ScrollTrackingState {

    // MARK: - Layout Metadata Cache

    /// Cache key for the last computed `CachedMessageLayoutMetadata`.
    var cachedLayoutKey: PrecomputedCacheKey?
    /// Cached structural metadata, returned on cache hit.
    var cachedLayoutMetadata: CachedMessageLayoutMetadata?

    // MARK: - Version Counter (O(1) fingerprint replacement)

    /// Monotonically increasing counter that replaces the O(n) per-body-eval
    /// `computeMessageFingerprint()` hash. Incremented when any of the following
    /// triggers fire:
    /// - raw `messages.count` changes (new message appended, deletion, or
    ///   pagination load — also catches paginated-window shifts)
    /// - visible message count changes (hidden/subagent visibility transitions)
    /// - `isSending` or `isThinking` transitions (activity state change)
    /// - `visibleMessages.last?.isStreaming` transitions (end of streaming)
    /// - A tool call's `isComplete` transitions (observable via messages array
    ///   identity change in SwiftUI)
    ///
    /// Over-invalidation is safe (triggers a recompute); under-invalidation is not.
    var messageListVersion: Int = 0

    /// Cached raw (unfiltered) message count. Detects new arrivals,
    /// deletions, and pagination loads — including cases where the
    /// paginated visible window shifts at a fixed size.
    var lastKnownRawMessageCount: Int = 0
    /// Cached visible (paginated) message count. Detects changes in
    /// message visibility (hidden/subagent transitions) that don't
    /// alter the raw count.
    var lastKnownVisibleMessageCount: Int = 0
    /// Cached streaming state of the last visible message.
    var lastKnownLastMessageStreaming: Bool = false
    /// Cached count of incomplete tool calls across visible messages.
    var lastKnownIncompleteToolCallCount: Int = 0

    // MARK: - Scroll Geometry (non-reactive, updated every scroll tick)

    /// Content height from scroll geometry, used to guard against false
    /// detaches on short conversations that can't scroll.
    var scrollContentHeight: CGFloat = 0
    /// Container (viewport) height from scroll geometry, used alongside
    /// scrollContentHeight to determine if content is scrollable.
    var scrollContainerHeight: CGFloat = 0
    /// Last content offset Y observed by onScrollGeometryChange, used to
    /// determine scroll direction (increasing offset = scrolling toward older content).
    var lastScrollContentOffsetY: CGFloat = 0
}

/// Lightweight key that captures all inputs to `precomputedState`.
/// All fields are O(1) to compare. The `messageListVersion` counter
/// replaces the former O(n) hash-based fingerprint — it is incremented
/// by `onChange` handlers when structural or content changes occur.
struct PrecomputedCacheKey: Equatable {
    let messageListVersion: Int
    let isSending: Bool
    let isThinking: Bool
    let isCompacting: Bool
    let assistantStatusText: String?
    let activeSubagentFingerprint: Int
    let displayedMessageCount: Int
}
