import Foundation

/// In-memory snapshot of a single content block within an assistant message.
///
/// A block is either a streamed text block (`type == .text`) or a tool
/// invocation block (`type == .toolUse`). Mirrors the daemon's wire-protocol
/// block model so the reducer can populate fields verbatim from incoming
/// `block_open`, `assistant_text_delta`, `tool_use_start`, `tool_input_delta`,
/// `tool_result`, and `block_close` events.
///
/// Idempotency invariant: every mutation in `MessageStreamReducer` is gated on
/// the `seq` watermark stored in `MessageSnapshot`, so re-applying a delivered
/// event is a no-op.
public struct BlockSnapshot: Sendable {
    public enum Kind: Sendable, Equatable {
        case text
        case toolUse
    }

    public var type: Kind
    /// Accumulated text content for `.text` blocks. Empty for `.toolUse` blocks.
    public var text: String
    /// Tool name for `.toolUse` blocks. `nil` for `.text` blocks.
    public var toolName: String?
    /// Stable tool-use id from the agent (correlates with confirmations and results).
    public var toolUseId: String?
    /// Accumulated raw input JSON streamed via `tool_input_delta`. Note this is
    /// the streamed partial JSON shape — final structured input is delivered by
    /// `tool_use_start` and stored in `toolInput`.
    public var toolInputJson: String
    /// Structured input record produced by the model (populated from `tool_use_start`).
    public var toolInput: [String: AnyCodable]?
    /// Final tool result payload (populated from `tool_result`).
    public var toolResult: ToolResultMessage?
    /// True after a matching `block_close` event has been observed.
    public var isComplete: Bool

    public init(
        type: Kind,
        text: String = "",
        toolName: String? = nil,
        toolUseId: String? = nil,
        toolInputJson: String = "",
        toolInput: [String: AnyCodable]? = nil,
        toolResult: ToolResultMessage? = nil,
        isComplete: Bool = false
    ) {
        self.type = type
        self.text = text
        self.toolName = toolName
        self.toolUseId = toolUseId
        self.toolInputJson = toolInputJson
        self.toolInput = toolInput
        self.toolResult = toolResult
        self.isComplete = isComplete
    }
}

/// In-memory snapshot of a single assistant message, indexed by `messageId`.
///
/// Holds the message-level metadata declared by `message_open` plus the array
/// of content blocks declared by `block_open` / closed by `block_close`. The
/// `seqWatermarks` table tracks the highest `seq` applied per block (with
/// `-1` reserved as the message-level watermark) so the reducer can ignore
/// out-of-order or duplicate events.
public struct MessageSnapshot: Sendable {
    /// Stable assistant-message id declared by `message_open`.
    public let id: String
    /// "assistant".
    public var role: String
    /// Blocks indexed by `blockIndex`. Sparse during streaming; entries are
    /// created on first `block_open` for a given index.
    public var blocks: [Int: BlockSnapshot]
    /// True after a matching `message_close` event has been observed.
    public var isComplete: Bool
    /// Highest `seq` applied per `(messageId, blockIndex)`. The sentinel
    /// `blockIndex == -1` records message-level events (`message_open`,
    /// `message_close`). New events with `seq <= watermark` are dropped.
    public var seqWatermarks: [Int: Int]

    public init(
        id: String,
        role: String = "assistant",
        blocks: [Int: BlockSnapshot] = [:],
        isComplete: Bool = false,
        seqWatermarks: [Int: Int] = [:]
    ) {
        self.id = id
        self.role = role
        self.blocks = blocks
        self.isComplete = isComplete
        self.seqWatermarks = seqWatermarks
    }

    /// Ordered view of the blocks for rendering (sorted by `blockIndex`).
    public var orderedBlocks: [(index: Int, block: BlockSnapshot)] {
        blocks.keys.sorted().map { ($0, blocks[$0]!) }
    }
}

/// Reactive store of `MessageSnapshot` values keyed by `messageId`.
///
/// Designed to be the new source of truth for the chat transcript, replacing
/// the legacy `messages` array on `ChatViewModel`. As of PR 3, the store is
/// populated by `MessageStreamReducer` from the SSE event stream but is **not
/// rendered by any view** — UI continues to read from the legacy state. PR 4
/// in the streaming-message-architecture plan flips renderers to consume this
/// store.
///
/// Mutations happen exclusively on the main actor (so SwiftUI observers see
/// consistent snapshots), matching the existing store pattern in this
/// directory (see `ContactsStore`, `DirectoryStore`, `SettingsStore`).
@MainActor @Observable
public final class MessageStore {

    /// Snapshots keyed by `messageId`.
    public var messages: [String: MessageSnapshot] = [:]

    /// Insertion order of `messageId` for stable rendering. Populated when a
    /// message is first inserted via `upsertMessage`.
    public var messageOrder: [String] = []

    public init() {}

    // MARK: - Convenience accessors

    public func message(id: String) -> MessageSnapshot? {
        messages[id]
    }

    /// Ordered messages for rendering. Insertion order is preserved across
    /// updates so streaming bubbles don't reshuffle as new blocks arrive.
    public var orderedMessages: [MessageSnapshot] {
        messageOrder.compactMap { messages[$0] }
    }

    // MARK: - Mutation helpers
    //
    // Called by `MessageStreamReducer`. Public so tests can exercise the store
    // directly, but production callers should always route through the reducer
    // to preserve the seq-watermark idempotency invariant.

    /// Insert an empty message snapshot if one does not already exist.
    /// Returns `true` if a new snapshot was inserted, `false` if the id was
    /// already present (idempotent re-application).
    @discardableResult
    public func upsertMessage(id: String, role: String) -> Bool {
        if messages[id] != nil { return false }
        messages[id] = MessageSnapshot(id: id, role: role)
        messageOrder.append(id)
        return true
    }

    public func updateMessage(id: String, mutate: (inout MessageSnapshot) -> Void) {
        guard var snapshot = messages[id] else { return }
        mutate(&snapshot)
        messages[id] = snapshot
    }

    /// Reset the store. Used when switching conversations or on logout.
    public func reset() {
        messages.removeAll()
        messageOrder.removeAll()
    }
}
