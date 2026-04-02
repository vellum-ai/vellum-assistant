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
