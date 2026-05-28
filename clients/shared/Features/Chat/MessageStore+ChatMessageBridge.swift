import Foundation

/// Bridge from the new `MessageStore` (the streaming-message-architecture
/// reducer's source of truth) to the `ChatMessage` shape that the existing
/// chat renderer consumes.
///
/// The chat view list renders from `ChatViewModel.renderedMessages`, which
/// merges the legacy `messages` array (user bubbles, history rows, system
/// messages, confirmations) with assistant content materialized from
/// `MessageStore` snapshots through this bridge. For any assistant message
/// the daemon emits over the new addressable-event protocol, the
/// `MessageStore` snapshot wins over the legacy row — the legacy bubble
/// created by `appendTextToCurrentMessage` is silently dropped from the
/// merged transcript.
///
/// `MessageStreamReducer` is the sole writer for `MessageStore`, and its
/// `apply()` is idempotent per `(messageId, blockIndex, seq)`. This is what
/// makes the streaming-then-reload duplication symptom structurally
/// impossible: re-applying the same event (e.g. on `Last-Event-Id` reconnect
/// replay from PR 2) is a no-op, and the renderer always reads a single
/// source of truth keyed by the daemon's stable `messageId`.
///
/// Non-assistant rows and history rows that pre-date the new event protocol
/// still flow through the legacy `messages` array, which is why the merge
/// in `ChatViewModel.renderedMessages` is still needed.
@MainActor
extension MessageStore {

    /// Materializes the store's snapshots as a `[ChatMessage]` ordered by
    /// insertion (the order `upsertMessage` first saw each `messageId`).
    ///
    /// Each `MessageSnapshot` becomes one `ChatMessage`:
    /// - `.text` blocks are joined as `textSegments` and placed in
    ///   `contentOrder` interleaved with tool calls in `blockIndex` order.
    /// - `.toolUse` blocks become entries in `toolCalls` with input, result,
    ///   and completion state copied verbatim from the snapshot.
    ///
    /// The resulting `ChatMessage.id` is a deterministic UUID derived from
    /// the daemon's stable `messageId` so the same snapshot always maps to
    /// the same SwiftUI identity across re-renders.
    public var chatMessages: [ChatMessage] {
        orderedMessages.map { snapshot in
            Self.chatMessage(from: snapshot)
        }
    }

    /// Materialize a single `MessageSnapshot` into the legacy `ChatMessage`
    /// shape consumed by the existing renderer.
    static func chatMessage(from snapshot: MessageSnapshot) -> ChatMessage {
        let role: ChatRole = (snapshot.role == "user") ? .user : .assistant

        var textSegments: [String] = []
        var toolCalls: [ToolCallData] = []
        var contentOrder: [ContentBlockRef] = []

        // Walk blocks in `blockIndex` order so rendering matches the wire
        // ordering. The reducer enforces idempotency, so repeated apply()
        // calls converge on the same shape here.
        for (_, block) in snapshot.orderedBlocks {
            switch block.type {
            case .text:
                let segIdx = textSegments.count
                textSegments.append(block.text)
                contentOrder.append(.text(segIdx))
            case .toolUse:
                let tcIdx = toolCalls.count
                let inputDict = block.toolInput ?? [:]
                let inputSummary = HistoryReconstructionService.summarizeToolInputStatic(inputDict)
                let inputFull = ToolCallData.formatAllToolInput(inputDict)
                let inputRawValue = HistoryReconstructionService.extractToolInputStatic(inputDict)
                var toolCall = ToolCallData(
                    toolName: block.toolName ?? "",
                    inputSummary: inputSummary,
                    inputFull: inputFull,
                    inputRawValue: inputRawValue,
                    result: block.toolResult?.result,
                    isError: block.toolResult?.isError ?? false,
                    isComplete: block.isComplete || block.toolResult != nil,
                    arrivedBeforeText: textSegments.isEmpty
                )
                toolCall.toolUseId = block.toolUseId
                toolCall.inputRawDict = inputDict.isEmpty ? nil : inputDict
                if let result = block.toolResult {
                    toolCall.riskLevel = result.riskLevel
                    toolCall.riskReason = result.riskReason
                    toolCall.matchedTrustRuleId = result.matchedTrustRuleId
                    toolCall.approvalMode = result.approvalMode
                    toolCall.approvalReason = result.approvalReason
                    toolCall.riskThreshold = result.riskThreshold
                    toolCall.riskScopeOptions = result.riskScopeOptions
                    toolCall.riskAllowlistOptions = result.riskAllowlistOptions
                    toolCall.riskDirectoryScopeOptions = result.riskDirectoryScopeOptions
                    if let containerized = result.isContainerized { toolCall.isContainerized = containerized }
                }
                toolCalls.append(toolCall)
                contentOrder.append(.toolCall(tcIdx))
            }
        }

        var message = ChatMessage(
            id: Self.deterministicUUID(for: snapshot.id),
            role: role,
            text: "",
            isStreaming: !snapshot.isComplete
        )
        message.textSegments = textSegments
        message.toolCalls = toolCalls
        message.contentOrder = contentOrder
        message.daemonMessageId = snapshot.id
        return message
    }

    /// Maps a daemon `messageId` (UUIDv7 string) to a stable `Foundation.UUID`
    /// usable as `ChatMessage.id`. Deterministic — the same string always
    /// produces the same UUID — so SwiftUI sees a stable identity across
    /// re-renders. UUIDv7 ids parse directly; non-UUID ids fall back to an
    /// FNV-1a hash spread across 16 bytes (collisions astronomically
    /// unlikely within a single conversation).
    static func deterministicUUID(for messageId: String) -> UUID {
        if let parsed = UUID(uuidString: messageId) { return parsed }
        var h: UInt64 = 0xcbf29ce484222325
        let prime: UInt64 = 0x100000001b3
        for b in messageId.utf8 {
            h ^= UInt64(b)
            h = h &* prime
        }
        var bytes = uuid_t(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        withUnsafeMutableBytes(of: &bytes) { buf in
            for i in 0..<16 {
                h ^= h &<< 13
                h ^= h &>> 7
                h ^= h &<< 17
                buf[i] = UInt8(truncatingIfNeeded: h &>> UInt64((i % 8) * 8))
            }
        }
        return UUID(uuid: bytes)
    }
}
