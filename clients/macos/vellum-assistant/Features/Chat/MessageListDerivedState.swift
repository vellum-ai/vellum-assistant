import Foundation
import VellumAssistantShared

// MARK: - Cached Message Layout Metadata

/// Structural metadata cached behind a version-counter key on
/// `ScrollTrackingState`. Contains only fields derived from message IDs,
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
    let displayMessageIds: [UUID]
    let messageIndexById: [UUID: Int]
    let showTimestamp: Set<UUID>
    let hasPrecedingAssistantByIndex: Set<Int>
    let hasUserMessage: Bool
    let latestAssistantId: UUID?
    let subagentsByParent: [UUID: [SubagentInfo]]
    let orphanSubagents: [SubagentInfo]
    let effectiveStatusText: String?

    // --- Live content-derived state (always fresh) ---
    let displayMessageById: [UUID: ChatMessage]
    let activePendingRequestId: String?
    let nextDecidedConfirmationByIndex: [Int: ToolConfirmationData]
    let isConfirmationRenderedInlineByIndex: Set<Int>
    let anchoredThinkingIndex: Int?
    let hasActiveToolCall: Bool
    let canInlineProcessing: Bool
    let shouldShowThinkingIndicator: Bool
    let hasMessages: Bool
}
