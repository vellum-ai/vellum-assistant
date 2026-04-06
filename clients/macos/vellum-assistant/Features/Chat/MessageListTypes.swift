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
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]

    func enqueue(
        for owner: MessageListScrollState,
        snapshot: ScrollGeometrySnapshot,
        handler: @escaping @MainActor (ScrollGeometrySnapshot) -> Void
    ) {
        let key = ObjectIdentifier(owner)
        pendingSnapshots[key] = snapshot
        guard tasks[key] == nil else { return }

        tasks[key] = Task { @MainActor [weak self, weak owner] in
            guard let self else { return }
            defer {
                self.tasks[key] = nil
                self.pendingSnapshots[key] = nil
            }

            while !Task.isCancelled {
                await Task.yield()
                guard owner != nil else { return }
                guard let latest = self.pendingSnapshots[key] else { return }
                self.pendingSnapshots[key] = nil
                handler(latest)
                guard self.pendingSnapshots[key] != nil else { return }
            }
        }
    }

    func cancel(for owner: MessageListScrollState) {
        let key = ObjectIdentifier(owner)
        tasks[key]?.cancel()
        tasks[key] = nil
        pendingSnapshots[key] = nil
    }
}

// MARK: - Cached Message Layout Metadata

/// Structural metadata cached behind a version-counter key on
/// `MessageListScrollState`. Contains only fields derived from message IDs,
/// roles, timestamps, and subagent identity — never mutable content like
/// text segments or confirmation states. Cache invalidation is gated by
/// `refreshMessageListVersionIfNeeded()` which tracks structural changes.
struct CachedMessageLayoutMetadata {
    let displayMessageIds: [UUID]
    let messageIndexById: [UUID: Int]
    let showTimestamp: Set<UUID>
    let hasPrecedingAssistantByIndex: Set<Int>
    let hasUserMessage: Bool
    let latestAssistantId: UUID?
    let subagentsByParent: [UUID: [SubagentInfo]]
    let orphanSubagents: [SubagentInfo]
    let effectiveStatusText: String?
}

// MARK: - Message List Derived State

/// All derived values needed by the message list body. Combines cached
/// structural metadata (from `CachedMessageLayoutMetadata`) with live
/// content-derived state computed fresh each body evaluation. Content
/// fields (message data, confirmation placement, thinking indicators)
/// are always live so SwiftUI's `.equatable()` diffing sees every mutation.
struct MessageListDerivedState {
    // --- Cached structural metadata (from CachedMessageLayoutMetadata) ---
    let messageIndexById: [UUID: Int]
    let showTimestamp: Set<UUID>
    let hasPrecedingAssistantByIndex: Set<Int>
    let hasUserMessage: Bool
    let latestAssistantId: UUID?
    let subagentsByParent: [UUID: [SubagentInfo]]
    let orphanSubagents: [SubagentInfo]
    let effectiveStatusText: String?

    // --- Live content-derived state (always fresh) ---
    let displayMessages: [ChatMessage]
    let activePendingRequestId: String?
    let nextDecidedConfirmationByIndex: [Int: ToolConfirmationData]
    let isConfirmationRenderedInlineByIndex: Set<Int>
    let anchoredThinkingIndex: Int?
    let hasActiveToolCall: Bool
    let canInlineProcessing: Bool
    let shouldShowThinkingIndicator: Bool
    let hasMessages: Bool
}

// MARK: - Derived-State Cache

/// Non-observable cache used by `MessageListView` during body evaluation.
///
/// SwiftUI logs "Modifying state during view update" when a view mutates
/// `@State` / `@Observable` storage while computing its body. The message-list
/// pipeline needs memoization for performance, but those cache writes must not
/// flow through SwiftUI-managed state. This helper keeps the cache off the
/// observation graph while preserving the existing hot-path behavior.
@MainActor
final class MessageListDerivedStateCache {
    var cachedLayoutKey: PrecomputedCacheKey?
    var cachedLayoutMetadata: CachedMessageLayoutMetadata?
    var messageListVersion = 0
    var lastKnownRawMessageCount = 0
    var lastKnownVisibleMessageCount = 0
    var lastKnownLastMessageStreaming = false
    var lastKnownIncompleteToolCallCount = 0
    var lastKnownVisibleIdFingerprint = 0
    var cachedFirstVisibleMessageId: UUID?
    var bodyEvalTimestamps: [CFAbsoluteTime] = []
    var isThrottled = false
    var cachedDerivedState: MessageListDerivedState?
    var throttleRecoveryTask: Task<Void, Never>?

    func reset() {
        cachedLayoutKey = nil
        cachedLayoutMetadata = nil
        messageListVersion = 0
        lastKnownRawMessageCount = 0
        lastKnownVisibleMessageCount = 0
        lastKnownLastMessageStreaming = false
        lastKnownIncompleteToolCallCount = 0
        lastKnownVisibleIdFingerprint = 0
        cachedFirstVisibleMessageId = nil
        cachedDerivedState = nil
        bodyEvalTimestamps.removeAll()
        throttleRecoveryTask?.cancel()
        throttleRecoveryTask = nil
        isThrottled = false
    }
}
