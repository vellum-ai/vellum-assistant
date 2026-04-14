import Foundation
import VellumAssistantShared

// MARK: - Transcript Projector

/// Pure projector that transforms the raw chat inputs into a
/// `TranscriptRenderModel`. Mirrors the logic currently spread across
/// `MessageListView+DerivedState.swift` but expressed as a stateless,
/// testable function with no SwiftUI dependencies.
///
/// The projector accepts the same inputs that `MessageListView` already
/// threads through its properties and produces a fully resolved render
/// model that downstream views can consume without re-deriving layout.
enum TranscriptProjector {

    /// Stable UUID for the thinking placeholder row so ForEach maintains
    /// view identity across re-projections. Must not collide with real message IDs.
    private static let thinkingPlaceholderId = UUID(uuidString: "00000000-0000-0000-0000-FFFFFFFFFFFF")!

    // MARK: - Projection

    /// Project the current chat state into a fully resolved render model.
    ///
    /// - Parameters:
    ///   - messages: The full (unfiltered) message array from the model layer.
    ///   - paginatedVisibleMessages: Pre-filtered paginated subset of messages.
    ///   - activeSubagents: Currently active subagent info list.
    ///   - isSending: Whether the user's last message is still being processed.
    ///   - isThinking: Whether the assistant is in a thinking state.
    ///   - isCompacting: Whether context compaction is in progress.
    ///   - assistantStatusText: Current assistant activity status text.
    ///   - assistantActivityPhase: Activity phase string (e.g. "thinking").
    ///   - assistantActivityAnchor: Activity anchor string (e.g. "assistant_turn").
    ///   - assistantActivityReason: Optional activity reason (e.g. "confirmation_resolved").
    ///   - activePendingRequestId: Active pending confirmation request ID.
    ///   - highlightedMessageId: Message ID currently highlighted in the UI.
    static func project(
        messages: [ChatMessage],
        paginatedVisibleMessages: [ChatMessage],
        activeSubagents: [SubagentInfo],
        isSending: Bool,
        isThinking: Bool,
        isCompacting: Bool,
        assistantStatusText: String?,
        assistantActivityPhase: String,
        assistantActivityAnchor: String,
        assistantActivityReason: String?,
        activePendingRequestId: String?,
        highlightedMessageId: UUID?
    ) -> TranscriptRenderModel {
        // Deduplicate visible messages (streaming can produce duplicate IDs).
        let visibleMessages: [ChatMessage] = {
            var seen = Set<UUID>()
            return paginatedVisibleMessages.filter { seen.insert($0.id).inserted }
        }()

        // --- Structural metadata ---

        let timestampSet = timestampIds(for: visibleMessages)
        let latestAssistantId = visibleMessages.last(where: { $0.role == .assistant })?.id

        var hasPrecedingAssistantByIndex = Set<Int>()
        for i in visibleMessages.indices where i > 0 {
            if visibleMessages[i - 1].role == .assistant {
                hasPrecedingAssistantByIndex.insert(i)
            }
        }

        let hasUserMessage = visibleMessages.contains { $0.role == .user }

        let subagentsByParent: [UUID: [SubagentInfo]] = Dictionary(
            grouping: activeSubagents.filter { $0.parentMessageId != nil },
            by: { $0.parentMessageId! }
        )
        let orphanSubagents = activeSubagents.filter { $0.parentMessageId == nil }

        let effectiveStatusText = isCompacting ? "Compacting context\u{2026}" : assistantStatusText

        // --- Content-derived state ---

        let anchoredThinkingIndex = resolvedThinkingAnchorIndex(
            for: visibleMessages,
            phase: assistantActivityPhase,
            anchor: assistantActivityAnchor,
            reason: assistantActivityReason
        )

        var nextDecidedConfirmationByIndex: [Int: ToolConfirmationData] = [:]
        for i in visibleMessages.indices {
            if i + 1 < visibleMessages.count,
               let conf = visibleMessages[i + 1].confirmation,
               conf.state != .pending {
                nextDecidedConfirmationByIndex[i] = conf
            }
        }

        var isConfirmationRenderedInlineByIndex = Set<Int>()
        for i in visibleMessages.indices {
            guard let confirmation = visibleMessages[i].confirmation,
                  confirmation.state == .pending,
                  let confirmationToolUseId = confirmation.toolUseId,
                  !confirmationToolUseId.isEmpty else { continue }
            for j in (0..<i).reversed() {
                let msg = visibleMessages[j]
                guard msg.role == .assistant, msg.confirmation == nil else { continue }
                if msg.toolCalls.contains(where: { $0.toolUseId == confirmationToolUseId && $0.pendingConfirmation != nil }) {
                    isConfirmationRenderedInlineByIndex.insert(i)
                }
                break
            }
        }

        // --- Processing / thinking state ---

        let lastVisible = visibleMessages.last

        let currentTurnMessages: ArraySlice<ChatMessage> = {
            if isSending, let last = visibleMessages.last, last.role == .user {
                let lastNonUser = visibleMessages.last(where: { $0.role != .user })
                let isActivelyProcessing = lastNonUser?.isStreaming == true
                    || lastNonUser?.confirmation?.state == .pending
                if !isActivelyProcessing {
                    return visibleMessages[visibleMessages.endIndex...]
                }
            }
            let lastTurnStart = visibleMessages.indices.reversed().first(where: { idx in
                visibleMessages[idx].role == .user
                    && visibleMessages.index(after: idx) < visibleMessages.endIndex
                    && visibleMessages[visibleMessages.index(after: idx)].role != .user
            })
            if let idx = lastTurnStart {
                return visibleMessages[visibleMessages.index(after: idx)...]
            }
            return visibleMessages[visibleMessages.startIndex...]
        }()

        let hasActiveToolCall = currentTurnMessages.contains(where: {
            $0.toolCalls.contains(where: { !$0.isComplete })
        })

        let wouldShowThinking = isSending
            && (isThinking || !(lastVisible?.isStreaming == true))
            && !hasActiveToolCall
        let lastVisibleIsAssistant = lastVisible?.role == .assistant
        let canInlineProcessing = wouldShowThinking && lastVisibleIsAssistant
        let shouldShowThinkingIndicator = wouldShowThinking && !canInlineProcessing
        let isStreamingWithoutText = isSending
            && (lastVisible?.isStreaming == true)
            && (lastVisible?.text.isEmpty ?? true)
            && !hasActiveToolCall
            && !canInlineProcessing

        // --- Compute prior-turn content heights for dynamic minHeight ---

        let lastUserIdx = visibleMessages.lastIndex(where: { $0.role == .user })
        var priorTurnHeightByIndex: [Int: CGFloat] = [:]
        var accumulatedHeight: CGFloat = 0
        for i in visibleMessages.indices {
            let isInCurrentTurn = lastUserIdx.map { i > $0 } ?? true
            if isInCurrentTurn && visibleMessages[i].role == .assistant {
                priorTurnHeightByIndex[i] = accumulatedHeight
                accumulatedHeight += Self.estimateAssistantRowHeight(visibleMessages[i])
            }
        }

        // --- Build row models ---

        var rows: [TranscriptRowModel] = visibleMessages.enumerated().map { index, message in
            TranscriptRowModel(
                message: message,
                showTimestamp: timestampSet.contains(message.id),
                hasPrecedingAssistant: hasPrecedingAssistantByIndex.contains(index),
                isLatestAssistant: message.id == latestAssistantId,
                isHighlighted: message.id == highlightedMessageId,
                index: index,
                decidedConfirmation: nextDecidedConfirmationByIndex[index],
                isConfirmationRenderedInline: isConfirmationRenderedInlineByIndex.contains(index),
                isAnchoredThinkingRow: index == anchoredThinkingIndex,
                priorTurnContentHeight: priorTurnHeightByIndex[index] ?? 0
            )
        }

        // When thinking indicator should show but no assistant message exists yet,
        // append a synthetic placeholder row so the thinking indicator renders
        // inside the ForEach's minHeight wrapper — same container that will later
        // hold the real assistant message. Eliminates layout jump on transition.
        if shouldShowThinkingIndicator {
            let placeholderMessage = ChatMessage(
                id: Self.thinkingPlaceholderId,
                role: .assistant,
                text: ""
            )
            let placeholder = TranscriptRowModel(
                message: placeholderMessage,
                showTimestamp: false,
                hasPrecedingAssistant: false,
                isLatestAssistant: true,
                isHighlighted: false,
                index: rows.count,
                decidedConfirmation: nil,
                isConfirmationRenderedInline: false,
                isAnchoredThinkingRow: false,
                isThinkingPlaceholder: true,
                priorTurnContentHeight: accumulatedHeight
            )
            rows.append(placeholder)
        }

        return TranscriptRenderModel(
            rows: rows,
            subagentsByParent: subagentsByParent,
            orphanSubagents: orphanSubagents,
            effectiveStatusText: effectiveStatusText,
            canInlineProcessing: canInlineProcessing,
            shouldShowThinkingIndicator: shouldShowThinkingIndicator,
            isStreamingWithoutText: isStreamingWithoutText,
            hasMessages: !visibleMessages.isEmpty,
            hasUserMessage: hasUserMessage,
            hasActiveToolCall: hasActiveToolCall,
            activePendingRequestId: activePendingRequestId,
            isActiveTurn: isSending || isThinking || !["idle", ""].contains(assistantActivityPhase)
        )
    }

    // MARK: - Timestamp computation

    /// Pre-compute which message IDs should show a timestamp divider.
    /// A timestamp is shown for the first message and whenever there is a
    /// day boundary or >5 minute gap between consecutive messages.
    ///
    /// Mirrors `MessageListView.timestampIds(for:)`.
    static func timestampIds(for list: [ChatMessage]) -> Set<UUID> {
        guard !list.isEmpty else { return [] }
        var result: Set<UUID> = [list[0].id]
        var calendar = Calendar.current
        calendar.timeZone = ChatTimestampTimeZone.resolve()
        for i in 1..<list.count {
            let current = list[i].timestamp
            let previous = list[i - 1].timestamp
            if !calendar.isDate(current, inSameDayAs: previous) || current.timeIntervalSince(previous) > 300 {
                result.insert(list[i].id)
            }
        }
        return result
    }

    // MARK: - Height estimation

    /// Estimate the rendered height of an assistant message row.
    private static func estimateAssistantRowHeight(_ message: ChatMessage) -> CGFloat {
        if message.confirmation != nil {
            return 150
        }
        let toolCallHeight = CGFloat(message.toolCalls.count) * 60
        let textLines = max(1, CGFloat(message.text.count) / 60)
        let textHeight = min(textLines * 20, 200)
        return toolCallHeight + textHeight + 40
    }

    // MARK: - Thinking anchor

    /// Determines whether the thinking indicator should be anchored to a
    /// confirmation chip row.
    ///
    /// Mirrors `MessageListView.shouldAnchorThinkingToConfirmationChip`
    /// and `resolvedThinkingAnchorIndex(for:)`.
    static func resolvedThinkingAnchorIndex(
        for list: [ChatMessage],
        phase: String,
        anchor: String,
        reason: String?
    ) -> Int? {
        let shouldAnchor = phase == "thinking"
            && anchor == "assistant_turn"
            && reason == "confirmation_resolved"
        guard shouldAnchor else { return nil }
        guard !list.isEmpty else { return nil }

        for index in list.indices.reversed() {
            // Decided confirmation chips are usually rendered inline on the
            // preceding assistant bubble.
            if list[index].role == .assistant, list.index(after: index) < list.endIndex {
                let next = list[list.index(after: index)]
                if let nextConfirmation = next.confirmation, nextConfirmation.state != .pending {
                    return index
                }
            }

            // Fallback for standalone decided confirmation bubbles.
            if let confirmation = list[index].confirmation, confirmation.state != .pending {
                let hasPrecedingAssistant = index > list.startIndex
                    && list[list.index(before: index)].role == .assistant
                if !hasPrecedingAssistant {
                    return index
                }
            }
        }

        return nil
    }
}
