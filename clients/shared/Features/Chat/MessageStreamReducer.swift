import Foundation

/// Applies streaming SSE events to a `MessageStore`, producing the new
/// transcript representation introduced by the streaming-message-architecture
/// plan (see `.private/plans/streaming-message-architecture.md`).
///
/// The reducer is **idempotent**: re-delivering an event that has already been
/// applied is a no-op. Idempotency is enforced by tracking the highest `seq`
/// applied per `(messageId, blockIndex)` — events with a `seq` less than or
/// equal to the watermark are silently dropped. Message-level events
/// (`message_open`, `message_close`) use the sentinel block index `-1`.
///
/// As of PR 3, the reducer consumes the new event types from `EventStreamClient`
/// but **the resulting `MessageStore` is unused by any view**. The legacy
/// streaming path on `ChatViewModel` still drives the on-screen transcript.
/// PR 4 flips renderers to read from the store.
///
/// Lifecycle: an instance is owned by `ChatViewModel` (one per chat scope).
/// Call `start()` after construction to begin consuming events; `stop()` to
/// tear down the subscription (or rely on `deinit`, which cancels the task).
@MainActor
public final class MessageStreamReducer {
    /// Sentinel `blockIndex` used to record message-level events in the
    /// per-message watermark table (`message_open`, `message_close`).
    private static let messageLevelBlockIndex = -1

    /// The store this reducer mutates. Owned by the caller.
    public let store: MessageStore

    /// Persistent per-conversation `seq` watermark. Updated for every event
    /// the reducer applies so the next SSE (re)connect can send
    /// `Last-Event-Id` and skip re-applying durable-log replays.
    private let lastAppliedSeqStore: LastAppliedSeqStore

    private let eventStreamClient: EventStreamClient
    private var subscriptionTask: Task<Void, Never>?

    public init(
        store: MessageStore,
        eventStreamClient: EventStreamClient,
        lastAppliedSeqStore: LastAppliedSeqStore = .shared
    ) {
        self.store = store
        self.eventStreamClient = eventStreamClient
        self.lastAppliedSeqStore = lastAppliedSeqStore
    }

    deinit {
        subscriptionTask?.cancel()
    }

    /// Subscribe to the `EventStreamClient` and feed every message into
    /// `apply(event:)`. Safe to call multiple times — re-subscribes after
    /// cancelling the previous task.
    public func start() {
        subscriptionTask?.cancel()
        subscriptionTask = Task { [weak self] in
            guard let self else { return }
            let stream = self.eventStreamClient.subscribe()
            for await message in stream {
                if Task.isCancelled { return }
                self.apply(event: message)
            }
        }
    }

    /// Cancel the active subscription. The store is left as-is.
    public func stop() {
        subscriptionTask?.cancel()
        subscriptionTask = nil
    }

    // MARK: - Apply

    /// Apply a single `ServerMessage` to the underlying `MessageStore`.
    /// Events that are not part of the new streaming protocol are ignored.
    public func apply(event: ServerMessage) {
        switch event {
        case .messageOpen(let msg):
            applyMessageOpen(msg)
        case .blockOpen(let msg):
            applyBlockOpen(msg)
        case .blockClose(let msg):
            applyBlockClose(msg)
        case .messageClose(let msg):
            applyMessageClose(msg)
        case .assistantTextDelta(let msg):
            applyTextDelta(msg)
        case .toolUseStart(let msg):
            applyToolUseStart(msg)
        case .toolInputDelta(let msg):
            applyToolInputDelta(msg)
        case .toolResult(let msg):
            applyToolResult(msg)
        default:
            // All other events are out of scope for the new streaming
            // architecture and intentionally ignored.
            break
        }
    }

    // MARK: - Event handlers

    private func applyMessageOpen(_ msg: MessageOpenMessage) {
        guard shouldApply(messageId: msg.messageId, blockIndex: Self.messageLevelBlockIndex, seq: msg.seq) else { return }
        store.upsertMessage(id: msg.messageId, role: msg.role)
        recordSeq(messageId: msg.messageId, blockIndex: Self.messageLevelBlockIndex, seq: msg.seq, conversationId: msg.conversationId)
    }

    private func applyBlockOpen(_ msg: BlockOpenMessage) {
        guard shouldApply(messageId: msg.messageId, blockIndex: msg.blockIndex, seq: msg.seq) else { return }
        // Ensure the parent message exists. If `message_open` arrived first
        // (the canonical ordering) this is a no-op; otherwise we synthesize a
        // bare snapshot so the block has somewhere to live.
        store.upsertMessage(id: msg.messageId, role: "assistant")
        let kind: BlockSnapshot.Kind = (msg.blockType == "tool_use") ? .toolUse : .text
        store.updateMessage(id: msg.messageId) { snapshot in
            if snapshot.blocks[msg.blockIndex] == nil {
                snapshot.blocks[msg.blockIndex] = BlockSnapshot(
                    type: kind,
                    toolName: msg.toolName,
                    toolUseId: msg.toolUseId
                )
            }
        }
        recordSeq(messageId: msg.messageId, blockIndex: msg.blockIndex, seq: msg.seq, conversationId: msg.conversationId)
    }

    private func applyBlockClose(_ msg: BlockCloseMessage) {
        guard shouldApply(messageId: msg.messageId, blockIndex: msg.blockIndex, seq: msg.seq) else { return }
        store.updateMessage(id: msg.messageId) { snapshot in
            snapshot.blocks[msg.blockIndex]?.isComplete = true
        }
        recordSeq(messageId: msg.messageId, blockIndex: msg.blockIndex, seq: msg.seq, conversationId: msg.conversationId)
    }

    private func applyMessageClose(_ msg: MessageCloseMessage) {
        guard shouldApply(messageId: msg.messageId, blockIndex: Self.messageLevelBlockIndex, seq: msg.seq) else { return }
        store.updateMessage(id: msg.messageId) { snapshot in
            snapshot.isComplete = true
        }
        recordSeq(messageId: msg.messageId, blockIndex: Self.messageLevelBlockIndex, seq: msg.seq, conversationId: msg.conversationId)
    }

    private func applyTextDelta(_ msg: AssistantTextDeltaMessage) {
        guard let messageId = msg.messageId, let blockIndex = msg.blockIndex else {
            // Synthetic / pre-anchor deltas are scoped to the legacy renderer.
            return
        }
        guard shouldApply(messageId: messageId, blockIndex: blockIndex, seq: msg.seq) else { return }
        // The block may not have been opened yet if a text delta beats its
        // `block_open` event under network reordering. Lazily materialize a
        // text block so the chunk isn't dropped.
        store.upsertMessage(id: messageId, role: "assistant")
        store.updateMessage(id: messageId) { snapshot in
            if snapshot.blocks[blockIndex] == nil {
                snapshot.blocks[blockIndex] = BlockSnapshot(type: .text)
            }
            snapshot.blocks[blockIndex]?.text.append(msg.text)
        }
        if let seq = msg.seq {
            recordSeq(messageId: messageId, blockIndex: blockIndex, seq: seq, conversationId: msg.conversationId)
        }
    }

    private func applyToolUseStart(_ msg: ToolUseStartMessage) {
        guard let messageId = msg.messageId, let blockIndex = msg.blockIndex else { return }
        guard shouldApply(messageId: messageId, blockIndex: blockIndex, seq: msg.seq) else { return }
        store.upsertMessage(id: messageId, role: "assistant")
        store.updateMessage(id: messageId) { snapshot in
            if snapshot.blocks[blockIndex] == nil {
                snapshot.blocks[blockIndex] = BlockSnapshot(type: .toolUse)
            }
            snapshot.blocks[blockIndex]?.type = .toolUse
            snapshot.blocks[blockIndex]?.toolName = msg.toolName
            snapshot.blocks[blockIndex]?.toolUseId = msg.toolUseId
            snapshot.blocks[blockIndex]?.toolInput = msg.input
        }
        if let seq = msg.seq {
            recordSeq(messageId: messageId, blockIndex: blockIndex, seq: seq, conversationId: msg.conversationId)
        }
    }

    private func applyToolInputDelta(_ msg: ToolInputDeltaMessage) {
        guard let messageId = msg.messageId, let blockIndex = msg.blockIndex else { return }
        guard shouldApply(messageId: messageId, blockIndex: blockIndex, seq: msg.seq) else { return }
        store.upsertMessage(id: messageId, role: "assistant")
        store.updateMessage(id: messageId) { snapshot in
            if snapshot.blocks[blockIndex] == nil {
                snapshot.blocks[blockIndex] = BlockSnapshot(type: .toolUse, toolName: msg.toolName, toolUseId: msg.toolUseId)
            }
            snapshot.blocks[blockIndex]?.toolInputJson.append(msg.content)
        }
        if let seq = msg.seq {
            recordSeq(messageId: messageId, blockIndex: blockIndex, seq: seq, conversationId: msg.conversationId)
        }
    }

    private func applyToolResult(_ msg: ToolResultMessage) {
        guard let messageId = msg.messageId, let blockIndex = msg.blockIndex else { return }
        guard shouldApply(messageId: messageId, blockIndex: blockIndex, seq: msg.seq) else { return }
        store.upsertMessage(id: messageId, role: "assistant")
        store.updateMessage(id: messageId) { snapshot in
            if snapshot.blocks[blockIndex] == nil {
                snapshot.blocks[blockIndex] = BlockSnapshot(type: .toolUse, toolName: msg.toolName, toolUseId: msg.toolUseId)
            }
            snapshot.blocks[blockIndex]?.toolResult = msg
        }
        if let seq = msg.seq {
            recordSeq(messageId: messageId, blockIndex: blockIndex, seq: seq, conversationId: msg.conversationId)
        }
    }

    // MARK: - Idempotency

    /// Returns `true` when the event should be applied. The contract:
    /// - If `seq` is `nil` (legacy daemon pre-PR-1), apply unconditionally —
    ///   we cannot deduplicate without a sequence number. The legacy renderer
    ///   already tolerates duplicates.
    /// - Otherwise, drop events whose `seq` is `<=` the recorded watermark.
    private func shouldApply(messageId: String, blockIndex: Int, seq: Int?) -> Bool {
        guard let seq else { return true }
        if let watermark = store.messages[messageId]?.seqWatermarks[blockIndex],
           seq <= watermark {
            return false
        }
        return true
    }

    private func recordSeq(messageId: String, blockIndex: Int, seq: Int, conversationId: String?) {
        store.updateMessage(id: messageId) { snapshot in
            if let existing = snapshot.seqWatermarks[blockIndex], existing >= seq {
                return
            }
            snapshot.seqWatermarks[blockIndex] = seq
        }
        // Persist the per-conversation watermark so the next SSE (re)connect
        // can send `Last-Event-Id` and skip durable-log replays the client
        // has already applied (see `LastAppliedSeqStore`).
        if let conversationId, !conversationId.isEmpty {
            lastAppliedSeqStore.setSeq(seq, forConversation: conversationId)
        }
    }
}
