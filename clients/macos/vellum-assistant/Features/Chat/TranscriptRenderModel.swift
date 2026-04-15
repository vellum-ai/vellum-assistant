import Foundation
import VellumAssistantShared

// MARK: - Transcript Render Model

/// Top-level immutable render model for the entire chat transcript.
/// Expresses the layout as pure data — no SwiftUI state, no caching
/// bookkeeping, no closure callbacks. Produced by `TranscriptProjector`
/// and consumed by `MessageListContentView`.
///
/// - SeeAlso: `TranscriptProjector` which produces this from raw inputs.
struct TranscriptRenderModel: Equatable {
    /// Ordered rows ready for display. Each row wraps a unique message
    /// together with all per-row adornments the view layer needs.
    let rows: [TranscriptRowModel]

    /// Subagents grouped by their parent message ID.
    /// Keyed by the parent message's UUID; value is the ordered list of
    /// subagents that were spawned from that message.
    let subagentsByParent: [UUID: [SubagentInfo]]

    /// Subagents that have no known parent message (e.g. spawned before
    /// any message was streamed).
    let orphanSubagents: [SubagentInfo]

    /// The effective status text to show at the bottom of the transcript
    /// (e.g. "Compacting context..." or the assistant's current activity).
    let effectiveStatusText: String?

    /// Whether the assistant is currently processing after tool calls
    /// completed and the processing indicator can be shown inline on the
    /// latest assistant bubble (instead of a separate thinking row).
    let canInlineProcessing: Bool

    /// Whether a standalone thinking indicator should be shown.
    let shouldShowThinkingIndicator: Bool

    /// Whether the assistant is streaming but has not yet produced any text.
    let isStreamingWithoutText: Bool

    /// Whether the assistant is streaming and has already produced text.
    /// Used to show a subtle inline continuation indicator so the user
    /// knows more content is still being generated.
    let isStreamingWithText: Bool

    /// Whether the transcript has any messages at all.
    let hasMessages: Bool

    /// Whether the transcript contains at least one user message.
    let hasUserMessage: Bool

    /// Whether the current turn has an active (incomplete) tool call.
    let hasActiveToolCall: Bool

    /// The active pending confirmation request ID, if any.
    let activePendingRequestId: String?

    /// Whether the assistant has an active turn in progress (sending,
    /// thinking, streaming, tool running, or awaiting confirmation).
    /// Gates the expanded min-height frame on the last assistant cell so
    /// that idle conversations render at natural height and don't push
    /// content above the viewport.
    let isActiveTurn: Bool
}

// MARK: - Transcript Row Model

/// Per-row render model. Wraps a single `ChatMessage` together with
/// all layout adornments that the current view code derives on the fly
/// inside `MessageListContentView` and `ChatBubble`.
struct TranscriptRowModel: Equatable, Identifiable {
    /// Stable identity — same as the underlying message ID.
    var id: UUID { message.id }

    /// The underlying chat message.
    let message: ChatMessage

    /// When true, a timestamp divider should be rendered above this row.
    let showTimestamp: Bool

    /// When true, the previous message in the transcript was from the
    /// assistant. Used for grouping-related spacing adjustments.
    let hasPrecedingAssistant: Bool

    /// When true, this row is the latest assistant message in the
    /// transcript. Drives avatar placement and inline processing display.
    let isLatestAssistant: Bool

    /// When true, this row should be visually highlighted (e.g. after
    /// an anchor-scroll from a notification deep link).
    let isHighlighted: Bool

    /// Index of this row's message in the projected visible list.
    /// Needed by consumers that reference positional state (e.g.
    /// next-message confirmation lookups, anchored thinking).
    let index: Int

    /// Non-nil when the *next* message in the transcript carries a
    /// decided (non-pending) confirmation that should render as a
    /// compact chip at the bottom of this row's bubble.
    let decidedConfirmation: ToolConfirmationData?

    /// When true, this row's confirmation message is rendered inline
    /// on its matching tool-call bubble (not as a standalone bubble).
    let isConfirmationRenderedInline: Bool

    /// When true, the anchored thinking indicator should attach to
    /// this row (post-confirmation thinking state).
    let isAnchoredThinkingRow: Bool

    /// When true, this row is a synthetic placeholder for the thinking
    /// indicator — no real message content. The thinking indicator renders
    /// inside the ForEach so it shares the same minHeight wrapper that
    /// will later hold the real assistant message.
    var isThinkingPlaceholder: Bool = false
}
