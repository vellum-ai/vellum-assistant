import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - TranscriptProjectorTests
//
// Locks current transcript projection behavior before any consumer
// switches over. Each test mirrors a specific derivation in
// MessageListView+DerivedState.swift to ensure the projector
// reproduces identical results.

@MainActor
final class TranscriptProjectorTests: XCTestCase {

    // MARK: - Helpers

    /// Build a simple ChatMessage with the given role, text, and timestamp.
    private func makeMessage(
        id: UUID = UUID(),
        role: ChatRole = .assistant,
        text: String = "Hello",
        timestamp: Date = Date(),
        isStreaming: Bool = false,
        confirmation: ToolConfirmationData? = nil,
        toolCalls: [ToolCallData] = []
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            role: role,
            text: text,
            timestamp: timestamp,
            isStreaming: isStreaming,
            confirmation: confirmation,
            toolCalls: toolCalls
        )
    }

    /// Build a default projection from the given messages with sensible defaults.
    private func project(
        messages: [ChatMessage],
        paginatedVisibleMessages: [ChatMessage]? = nil,
        activeSubagents: [SubagentInfo] = [],
        isSending: Bool = false,
        isThinking: Bool = false,
        isCompacting: Bool = false,
        assistantStatusText: String? = nil,
        assistantActivityPhase: String = "",
        assistantActivityAnchor: String = "",
        assistantActivityReason: String? = nil,
        activePendingRequestId: String? = nil,
        highlightedMessageId: UUID? = nil
    ) -> TranscriptRenderModel {
        TranscriptProjector.project(
            messages: messages,
            paginatedVisibleMessages: paginatedVisibleMessages ?? messages,
            activeSubagents: activeSubagents,
            isSending: isSending,
            isThinking: isThinking,
            isCompacting: isCompacting,
            assistantStatusText: assistantStatusText,
            assistantActivityPhase: assistantActivityPhase,
            assistantActivityAnchor: assistantActivityAnchor,
            assistantActivityReason: assistantActivityReason,
            activePendingRequestId: activePendingRequestId,
            highlightedMessageId: highlightedMessageId
        )
    }

    // MARK: - Empty State

    func testEmptyMessagesProducesEmptyModel() {
        let model = project(messages: [])
        XCTAssertTrue(model.rows.isEmpty)
        XCTAssertFalse(model.hasMessages)
        XCTAssertFalse(model.hasUserMessage)
    }

    // MARK: - Timestamp Grouping

    func testFirstMessageAlwaysShowsTimestamp() {
        let msg = makeMessage(text: "Hi")
        let model = project(messages: [msg])
        XCTAssertTrue(model.rows[0].showTimestamp)
    }

    func testMessagesWithinFiveMinutesSameDay_NoExtraTimestamp() {
        let base = Date()
        let msg1 = makeMessage(role: .user, text: "Hello", timestamp: base)
        let msg2 = makeMessage(role: .assistant, text: "Hi there", timestamp: base.addingTimeInterval(60))
        let msg3 = makeMessage(role: .user, text: "How are you?", timestamp: base.addingTimeInterval(200))

        let model = project(messages: [msg1, msg2, msg3])
        XCTAssertEqual(model.rows.count, 3)
        XCTAssertTrue(model.rows[0].showTimestamp, "First message always shows timestamp")
        XCTAssertFalse(model.rows[1].showTimestamp, "Within 5 minutes, no timestamp")
        XCTAssertFalse(model.rows[2].showTimestamp, "Within 5 minutes, no timestamp")
    }

    func testMessagesOverFiveMinutesApart_ShowTimestamp() {
        let base = Date()
        let msg1 = makeMessage(role: .user, text: "Hello", timestamp: base)
        let msg2 = makeMessage(role: .assistant, text: "Hi", timestamp: base.addingTimeInterval(301))

        let model = project(messages: [msg1, msg2])
        XCTAssertTrue(model.rows[0].showTimestamp)
        XCTAssertTrue(model.rows[1].showTimestamp, "Over 5 minute gap should show timestamp")
    }

    func testMessagesAcrossDayBoundary_ShowTimestamp() {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
        let yesterdayLate = calendar.date(byAdding: .hour, value: 23, to: yesterday)!

        let msg1 = makeMessage(role: .user, text: "Last night", timestamp: yesterdayLate)
        let msg2 = makeMessage(role: .assistant, text: "Good morning", timestamp: today.addingTimeInterval(1))

        let model = project(messages: [msg1, msg2])
        XCTAssertTrue(model.rows[0].showTimestamp)
        XCTAssertTrue(model.rows[1].showTimestamp, "Day boundary should show timestamp")
    }

    // MARK: - Latest Assistant Message

    func testLatestAssistantMessageIsMarked() {
        let msg1 = makeMessage(role: .user, text: "Hi")
        let msg2 = makeMessage(role: .assistant, text: "Hello")
        let msg3 = makeMessage(role: .user, text: "Thanks")
        let msg4 = makeMessage(role: .assistant, text: "You're welcome")

        let model = project(messages: [msg1, msg2, msg3, msg4])
        XCTAssertFalse(model.rows[0].isLatestAssistant)
        XCTAssertFalse(model.rows[1].isLatestAssistant, "Not the last assistant message")
        XCTAssertFalse(model.rows[2].isLatestAssistant, "User message")
        XCTAssertTrue(model.rows[3].isLatestAssistant, "Last assistant in list")
    }

    func testNoAssistantMessages_NoneMarkedLatest() {
        let msg1 = makeMessage(role: .user, text: "Hi")
        let msg2 = makeMessage(role: .user, text: "Hello?")

        let model = project(messages: [msg1, msg2])
        XCTAssertFalse(model.rows[0].isLatestAssistant)
        XCTAssertFalse(model.rows[1].isLatestAssistant)
    }

    // MARK: - Preceding Assistant Grouping

    func testHasPrecedingAssistant() {
        let msg1 = makeMessage(role: .assistant, text: "Hi")
        let msg2 = makeMessage(role: .user, text: "Thanks")
        let msg3 = makeMessage(role: .assistant, text: "More info")
        let msg4 = makeMessage(role: .assistant, text: "Continued")

        let model = project(messages: [msg1, msg2, msg3, msg4])
        XCTAssertFalse(model.rows[0].hasPrecedingAssistant, "First message has no predecessor")
        XCTAssertTrue(model.rows[1].hasPrecedingAssistant, "Preceded by assistant")
        XCTAssertFalse(model.rows[2].hasPrecedingAssistant, "Preceded by user")
        XCTAssertTrue(model.rows[3].hasPrecedingAssistant, "Preceded by assistant")
    }

    // MARK: - Highlighted State

    func testHighlightedMessageId() {
        let targetId = UUID()
        let msg1 = makeMessage(role: .user, text: "Hi")
        let msg2 = makeMessage(id: targetId, role: .assistant, text: "Hello")

        let model = project(messages: [msg1, msg2], highlightedMessageId: targetId)
        XCTAssertFalse(model.rows[0].isHighlighted)
        XCTAssertTrue(model.rows[1].isHighlighted)
    }

    // MARK: - Pending Confirmation Inline Detection

    func testPendingConfirmationRenderedInline() {
        let toolUseId = "tool-use-123"
        let assistantMsg = makeMessage(
            role: .assistant,
            text: "Running command",
            toolCalls: [
                ToolCallData(
                    toolName: "bash",
                    inputSummary: "ls -la",
                    toolUseId: toolUseId,
                    pendingConfirmation: ToolConfirmationData(
                        requestId: "req-1",
                        toolName: "bash",
                        riskLevel: "medium",
                        toolUseId: toolUseId
                    )
                )
            ]
        )
        let confirmationMsg = makeMessage(
            role: .assistant,
            text: "",
            confirmation: ToolConfirmationData(
                requestId: "req-1",
                toolName: "bash",
                riskLevel: "medium",
                toolUseId: toolUseId,
                state: .pending
            )
        )

        let model = project(messages: [assistantMsg, confirmationMsg])
        XCTAssertFalse(model.rows[0].isConfirmationRenderedInline)
        XCTAssertTrue(model.rows[1].isConfirmationRenderedInline,
                      "Pending confirmation with matching toolUseId on preceding assistant should be inline")
    }

    func testDecidedConfirmationAsChipOnPrecedingAssistant() {
        let assistantMsg = makeMessage(role: .assistant, text: "I'll run this")
        let confirmationMsg = makeMessage(
            role: .assistant,
            text: "",
            confirmation: ToolConfirmationData(
                requestId: "req-1",
                toolName: "bash",
                riskLevel: "medium",
                state: .approved
            )
        )

        let model = project(messages: [assistantMsg, confirmationMsg])
        XCTAssertNotNil(model.rows[0].decidedConfirmation,
                        "Preceding assistant row should carry decided confirmation chip")
        XCTAssertEqual(model.rows[0].decidedConfirmation?.state, .approved)
    }

    // MARK: - Anchored Thinking Indicator

    func testAnchoredThinkingRow_AfterDecidedConfirmation() {
        let assistantMsg = makeMessage(role: .assistant, text: "Checking permissions")
        let confirmationMsg = makeMessage(
            role: .assistant,
            text: "",
            confirmation: ToolConfirmationData(
                requestId: "req-1",
                toolName: "bash",
                riskLevel: "medium",
                state: .approved
            )
        )

        let model = project(
            messages: [assistantMsg, confirmationMsg],
            assistantActivityPhase: "thinking",
            assistantActivityAnchor: "assistant_turn",
            assistantActivityReason: "confirmation_resolved"
        )

        XCTAssertTrue(model.rows[0].isAnchoredThinkingRow,
                       "Anchored thinking should attach to the assistant message preceding the decided confirmation")
        XCTAssertFalse(model.rows[1].isAnchoredThinkingRow)
    }

    func testAnchoredThinkingRow_NotSetWhenNotConfirmationResolved() {
        let msg = makeMessage(role: .assistant, text: "Hello")
        let model = project(
            messages: [msg],
            assistantActivityPhase: "thinking",
            assistantActivityAnchor: "assistant_turn",
            assistantActivityReason: nil
        )
        XCTAssertFalse(model.rows[0].isAnchoredThinkingRow)
    }

    // MARK: - Streaming Without Text

    func testStreamingWithoutText_SelectsCorrectState() {
        let streamingMsg = makeMessage(
            role: .assistant,
            text: "",
            isStreaming: true
        )

        let model = project(
            messages: [streamingMsg],
            isSending: true,
            isThinking: false
        )

        // Streaming with empty text, no active tool calls, and isThinking=false
        // should surface the standalone streaming-without-text state.
        XCTAssertTrue(model.isStreamingWithoutText)
        XCTAssertFalse(model.canInlineProcessing)
    }

    func testStreamingAssistantNoText_CanInlineProcessing() {
        let streamingMsg = makeMessage(
            role: .assistant,
            text: "",
            isStreaming: true
        )

        let model = project(
            messages: [streamingMsg],
            isSending: true,
            isThinking: true
        )

        // isSending=true, isThinking=true, no active tool calls, last visible is assistant
        // -> wouldShowThinking=true, lastVisibleIsAssistant=true -> canInlineProcessing=true
        XCTAssertTrue(model.canInlineProcessing)
        XCTAssertFalse(model.shouldShowThinkingIndicator,
                       "Inline processing should suppress standalone thinking indicator")
    }

    // MARK: - Row Identity Stability

    func testRowIdentityStableWhenLastAssistantStreamsNewText() {
        let msgId = UUID()
        let msg1 = makeMessage(role: .user, text: "Hi")
        let msg2 = makeMessage(id: msgId, role: .assistant, text: "Hel", isStreaming: true)

        let model1 = project(messages: [msg1, msg2], isSending: true)

        // Simulate new text arriving on the same message
        let msg2Updated = makeMessage(id: msgId, role: .assistant, text: "Hello, how can I help?", isStreaming: true)
        let model2 = project(messages: [msg1, msg2Updated], isSending: true)

        XCTAssertEqual(model1.rows.count, model2.rows.count, "Row count should be stable")
        XCTAssertEqual(model1.rows[0].id, model2.rows[0].id, "First row identity stable")
        XCTAssertEqual(model1.rows[1].id, model2.rows[1].id, "Streaming row identity stable")
        XCTAssertEqual(model1.rows[1].id, msgId, "Row ID matches message ID")
    }

    // MARK: - Subagent Grouping

    func testSubagentsGroupedByParentMessage() {
        let parentId = UUID()
        let msg = makeMessage(id: parentId, role: .assistant, text: "Spawning workers")

        let subagents = [
            SubagentInfo(id: "sub-1", label: "Worker 1", parentMessageId: parentId),
            SubagentInfo(id: "sub-2", label: "Worker 2", parentMessageId: parentId),
            SubagentInfo(id: "sub-3", label: "Orphan"),
        ]

        let model = project(messages: [msg], activeSubagents: subagents)
        XCTAssertEqual(model.subagentsByParent[parentId]?.count, 2)
        XCTAssertEqual(model.orphanSubagents.count, 1)
        XCTAssertEqual(model.orphanSubagents[0].id, "sub-3")
    }

    // MARK: - Compacting Status

    func testCompactingOverridesStatusText() {
        let msg = makeMessage(role: .assistant, text: "Hi")
        let model = project(
            messages: [msg],
            isCompacting: true,
            assistantStatusText: "Running tool"
        )
        XCTAssertEqual(model.effectiveStatusText, "Compacting context\u{2026}")
    }

    func testNonCompactingPassesThroughStatusText() {
        let msg = makeMessage(role: .assistant, text: "Hi")
        let model = project(
            messages: [msg],
            assistantStatusText: "Running tool"
        )
        XCTAssertEqual(model.effectiveStatusText, "Running tool")
    }

    // MARK: - Has User Message

    func testHasUserMessage() {
        let msg1 = makeMessage(role: .assistant, text: "Welcome")
        let msg2 = makeMessage(role: .user, text: "Hi")

        let modelNoUser = project(messages: [msg1])
        XCTAssertFalse(modelNoUser.hasUserMessage)

        let modelWithUser = project(messages: [msg1, msg2])
        XCTAssertTrue(modelWithUser.hasUserMessage)
    }

    // MARK: - Active Tool Call Detection

    func testHasActiveToolCall_IncompleteToolInCurrentTurn() {
        let userMsg = makeMessage(role: .user, text: "Do something")
        let assistantMsg = makeMessage(
            role: .assistant,
            text: "Running...",
            toolCalls: [
                ToolCallData(toolName: "bash", inputSummary: "ls", isComplete: false)
            ]
        )

        let model = project(messages: [userMsg, assistantMsg], isSending: true)
        XCTAssertTrue(model.hasActiveToolCall)
    }

    func testNoActiveToolCall_AllComplete() {
        let userMsg = makeMessage(role: .user, text: "Do something")
        let assistantMsg = makeMessage(
            role: .assistant,
            text: "Done",
            toolCalls: [
                ToolCallData(toolName: "bash", inputSummary: "ls", isComplete: true)
            ]
        )

        let model = project(messages: [userMsg, assistantMsg], isSending: true)
        XCTAssertFalse(model.hasActiveToolCall)
    }

    // MARK: - Thinking Indicator

    func testThinkingIndicator_WhenSendingAndThinking_LastIsUser() {
        let userMsg = makeMessage(role: .user, text: "Question")

        let model = project(
            messages: [userMsg],
            isSending: true,
            isThinking: true
        )

        // Last visible is user, so canInlineProcessing=false, shouldShowThinkingIndicator=true
        XCTAssertTrue(model.shouldShowThinkingIndicator)
        XCTAssertFalse(model.canInlineProcessing)
    }

    func testThinkingIndicator_SuppressedByActiveToolCall() {
        let userMsg = makeMessage(role: .user, text: "Run it")
        let assistantMsg = makeMessage(
            role: .assistant,
            text: "",
            toolCalls: [
                ToolCallData(toolName: "bash", inputSummary: "ls", isComplete: false)
            ]
        )

        let model = project(
            messages: [userMsg, assistantMsg],
            isSending: true,
            isThinking: true
        )

        // Active tool call suppresses thinking indicator entirely
        XCTAssertFalse(model.shouldShowThinkingIndicator)
        XCTAssertFalse(model.canInlineProcessing)
    }

    // MARK: - Duplicate Message Deduplication

    func testDuplicateMessageIdsAreDeduped() {
        let sharedId = UUID()
        let msg1 = makeMessage(id: sharedId, role: .assistant, text: "First")
        let msg2 = makeMessage(id: sharedId, role: .assistant, text: "Duplicate")

        let model = project(messages: [msg1, msg2])
        XCTAssertEqual(model.rows.count, 1, "Duplicate IDs should be deduped")
        XCTAssertEqual(model.rows[0].message.text, "First", "First occurrence wins")
    }

    // MARK: - Active Pending Request ID Pass-Through

    func testActivePendingRequestIdPassedThrough() {
        let msg = makeMessage(role: .assistant, text: "Hi")
        let model = project(messages: [msg], activePendingRequestId: "req-42")
        XCTAssertEqual(model.activePendingRequestId, "req-42")
    }

    // MARK: - Index Correctness

    func testRowIndicesMatchPositionInVisibleList() {
        let msgs = (0..<5).map { i in
            makeMessage(role: i % 2 == 0 ? .user : .assistant, text: "Message \(i)")
        }
        let model = project(messages: msgs)
        for (i, row) in model.rows.enumerated() {
            XCTAssertEqual(row.index, i, "Row index should match position in rows array")
        }
    }

    // MARK: - Streaming With Text (continuation indicator)

    func testStreamingWithText_SetWhenStreamingAndTextExists() {
        let msg = makeMessage(role: .assistant, text: "got 3,300 messages scanned", isStreaming: true)
        let model = project(messages: [msg], isSending: true)
        XCTAssertTrue(model.isStreamingWithText)
    }

    func testStreamingWithText_FalseWhenTextEmpty() {
        let msg = makeMessage(role: .assistant, text: "", isStreaming: true)
        let model = project(messages: [msg], isSending: true)
        XCTAssertFalse(model.isStreamingWithText)
    }

    func testStreamingWithText_FalseWhenNotSending() {
        let msg = makeMessage(role: .assistant, text: "some text", isStreaming: true)
        let model = project(messages: [msg], isSending: false)
        XCTAssertFalse(model.isStreamingWithText)
    }

    func testStreamingWithText_FalseWhenNotStreaming() {
        let msg = makeMessage(role: .assistant, text: "some text", isStreaming: false)
        let model = project(messages: [msg], isSending: true)
        XCTAssertFalse(model.isStreamingWithText)
    }

    func testStreamingWithText_FalseWhenToolCallActive() {
        let tool = ToolCallData(toolName: "gmail_search", inputSummary: "scanning", isComplete: false)
        let msg = makeMessage(role: .assistant, text: "scanning inbox...", isStreaming: true, toolCalls: [tool])
        let model = project(messages: [msg], isSending: true)
        XCTAssertFalse(model.isStreamingWithText)
    }
}

// MARK: - ToolCallData convenience init for tests

private extension ToolCallData {
    init(toolName: String, inputSummary: String, isComplete: Bool = false, toolUseId: String? = nil, pendingConfirmation: ToolConfirmationData? = nil) {
        self.init(
            toolName: toolName,
            inputSummary: inputSummary,
            isError: false,
            isComplete: isComplete
        )
        self.toolUseId = toolUseId
        self.pendingConfirmation = pendingConfirmation
    }
}
