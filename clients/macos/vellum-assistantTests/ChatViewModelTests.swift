import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ChatViewModelTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        daemonClient = DaemonClient()
        // Mark as connected so send-path tests don't hit the disconnected guard.
        // Tests that verify disconnected behaviour explicitly set isConnected = false.
        daemonClient.isConnected = true
        // Override send() so messages are silently accepted without a real socket.
        daemonClient.sendOverride = { _ in }
        viewModel = ChatViewModel(daemonClient: daemonClient)
    }

    override func tearDown() {
        viewModel = nil
        daemonClient = nil
        super.tearDown()
    }

    // MARK: - Initialization

    func testInitStartsWithEmptyMessages() {
        XCTAssertEqual(viewModel.messages.count, 0)
    }

    func testInitStartsWithEmptyInput() {
        XCTAssertEqual(viewModel.inputText, "")
    }

    func testInitStartsNotSending() {
        XCTAssertFalse(viewModel.isSending)
    }

    func testInitStartsNotThinking() {
        XCTAssertFalse(viewModel.isThinking)
    }

    func testInitStartsWithNoError() {
        XCTAssertNil(viewModel.errorText)
    }

    // MARK: - Send Message

    func testSendMessageAppendsUserMessage() {
        viewModel.inputText = "Hello world"
        viewModel.sendMessage()

        // Should have user message only
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertEqual(viewModel.messages[0].text, "Hello world")
    }

    func testSendMessageClearsInput() {
        viewModel.inputText = "Hello world"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.inputText, "")
    }

    func testSendEmptyMessageDoesNothing() {
        viewModel.inputText = "   "
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messages.count, 0) // No messages added
    }

    func testSendWhileBootstrappingDoesNothing() {
        // When no session exists yet (bootstrapping), rapid-fire is blocked
        viewModel.inputText = "First"
        viewModel.sendMessage()

        viewModel.inputText = "Second"
        viewModel.sendMessage() // Should be ignored since isSending is set by bootstrapConversation and sessionId is nil

        XCTAssertEqual(viewModel.messages.count, 1) // first message only
    }

    func testSendWhileSendingWithSessionAppendsMessage() {
        // When a session exists, sending while isSending is allowed (daemon queues)
        viewModel.conversationId = "test-session"
        viewModel.isSending = true

        viewModel.inputText = "Queued message"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1) // queued message only
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertEqual(viewModel.messages[0].text, "Queued message")
        // Message should have queued status since isSending was true
        if case .queued = viewModel.messages[0].status {
            // Expected
        } else {
            XCTFail("Expected message to have queued status")
        }
    }

    func testSendMessageClearsExistingError() {
        viewModel.errorText = "Previous error"
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertNil(viewModel.errorText)
    }

    func testSendMessageDoesNotPrematurelyDenyPendingConfirmationForExplicitApprovePhrase() {
        viewModel.conversationId = "sess-1"
        var confirmation = ToolConfirmationData(
            requestId: "req-approve",
            toolName: "bash",
            input: ["command": AnyCodable("ls -la")],
            riskLevel: "low",
            diff: nil,
            allowlistOptions: [],
            scopeOptions: [],
            executionTarget: "host",
            persistentDecisionsAllowed: true
        )
        confirmation.state = .pending
        viewModel.messages.append(ChatMessage(role: .assistant, text: "", confirmation: confirmation))

        viewModel.inputText = "approve"
        viewModel.sendMessage()

        XCTAssertEqual(
            viewModel.messages.first(where: { $0.confirmation?.requestId == "req-approve" })?.confirmation?.state,
            .pending,
            "Explicit natural-language approval phrases should keep pending confirmation state until daemon resolution"
        )
    }

    func testSendMessageStillPreemptivelyDeniesPendingConfirmationForRegularFollowUpText() {
        viewModel.conversationId = "sess-1"
        var confirmation = ToolConfirmationData(
            requestId: "req-follow-up",
            toolName: "bash",
            input: ["command": AnyCodable("ls -la")],
            riskLevel: "low",
            diff: nil,
            allowlistOptions: [],
            scopeOptions: [],
            executionTarget: "host",
            persistentDecisionsAllowed: true
        )
        confirmation.state = .pending
        viewModel.messages.append(ChatMessage(role: .assistant, text: "", confirmation: confirmation))

        viewModel.inputText = "can you explain what this command does?"
        viewModel.sendMessage()

        XCTAssertEqual(
            viewModel.messages.first(where: { $0.confirmation?.requestId == "req-follow-up" })?.confirmation?.state,
            .denied,
            "Non-decision follow-up text should keep the existing optimistic auto-deny behavior"
        )
    }

    // MARK: - Session Info

    func testSessionInfoStoresSessionId() {
        viewModel.bootstrapCorrelationId = "corr-1"
        let info = ConversationInfoMessage(conversationId: "test-123", title: "Test", correlationId: "corr-1")
        viewModel.handleServerMessage(.conversationInfo(info))
        XCTAssertEqual(viewModel.conversationId, "test-123")
    }

    func testSessionInfoDoesNotOverwriteExistingSession() {
        viewModel.conversationId = "first-session"
        let info = ConversationInfoMessage(conversationId: "second-session", title: "Test")
        viewModel.handleServerMessage(.conversationInfo(info))
        XCTAssertEqual(viewModel.conversationId, "first-session")
    }

    // MARK: - Streaming Deltas

    func testTextDeltaCreatesAssistantMessage() {
        let delta = AssistantTextDeltaMessage(text: "Hello")
        viewModel.handleServerMessage(.assistantTextDelta(delta))

        // Should have new assistant message only
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .assistant)
        XCTAssertEqual(viewModel.messages[0].text, "Hello")
        XCTAssertTrue(viewModel.messages[0].isStreaming)
    }

    func testTextDeltaClearsThinkingState() {
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Hi")))
        XCTAssertFalse(viewModel.isThinking)
    }

    func testTextDeltasAccumulateInSingleMessage() {
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Hel")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "lo ")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "world")))

        XCTAssertEqual(viewModel.messages.count, 1) // 1 assistant
        XCTAssertEqual(viewModel.messages[0].text, "Hello world")
        XCTAssertTrue(viewModel.messages[0].isStreaming)
    }

    // MARK: - Message Complete

    func testMessageCompleteFinalizesState() {
        viewModel.isSending = true
        viewModel.isThinking = true

        // Start streaming
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response")))

        // Complete
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[0].isStreaming)
    }

    func testMessageCompleteWithoutStreamingMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

        // Complete without any text deltas
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
    }

    // MARK: - Generation Cancelled

    func testGenerationCancelledClearsLoadingState() {
        viewModel.isSending = true
        viewModel.isThinking = true

        // Assistant starts streaming before user cancels
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial")))

        // User initiates cancel, then server acknowledges
        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(sessionId: nil)))

        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[0].isStreaming)
    }

    func testGenerationCancelledWithoutStreamingMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(sessionId: nil)))

        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
    }

    // MARK: - Error Handling

    func testErrorSetsErrorText() {
        viewModel.isSending = true
        viewModel.isThinking = true

        viewModel.handleServerMessage(.error(ErrorMessage(message: "Something failed")))

        XCTAssertEqual(viewModel.errorText, "Something failed")
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
    }

    func testDismissErrorClearsErrorText() {
        viewModel.errorText = "Some error"
        viewModel.dismissError()
        XCTAssertNil(viewModel.errorText)
    }

    func testDismissErrorAlsoClearsConversationError() {
        viewModel.conversationId = "sess-1"
        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerApi,
            userMessage: "API error",
            retryable: false
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))
        XCTAssertNotNil(viewModel.conversationError)
        XCTAssertNotNil(viewModel.errorText)

        viewModel.dismissError()

        XCTAssertNil(viewModel.conversationError,
                      "dismissError() should also clear conversationError")
        XCTAssertNil(viewModel.errorText)
    }

    func testErrorFinalizesStreamingAssistantMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

        // Start streaming an assistant message
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial response")))
        XCTAssertTrue(viewModel.messages[0].isStreaming)

        // Error arrives
        viewModel.handleServerMessage(.error(ErrorMessage(message: "Provider error")))

        // Streaming message should be finalized (not left hanging)
        XCTAssertFalse(viewModel.messages[0].isStreaming, "Error should finalize the streaming assistant message")
        XCTAssertEqual(viewModel.messages[0].text, "Partial response", "Partial text should be preserved")
    }

    func testErrorResetsProcessingMessagesToSent() {
        // Set up state directly because DaemonClient.send() throws in tests
        // (no real socket), which prevents sendMessage() from establishing
        // queue bookkeeping.
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = true

        // Add user messages directly — tests don't have a real socket, so
        // sendMessage() throws on daemonClient.send() and clears isSending,
        // preventing the FIFO mapping that messageQueued/messageDequeued need.
        let messageA = ChatMessage(role: .user, text: "Message A", status: .sent)
        let messageB = ChatMessage(role: .user, text: "Message B", status: .processing)
        viewModel.messages.append(messageA)
        viewModel.messages.append(messageB)
        // A(0), B(1)
        XCTAssertEqual(viewModel.messages[1].status, .processing)

        // Error arrives while B is processing
        viewModel.handleServerMessage(.error(ErrorMessage(message: "Provider failed")))

        // Processing message should be reset to .sent
        XCTAssertEqual(viewModel.messages[1].status, .sent, "Error should reset processing messages to .sent")
    }

    func testErrorDuringCancellationClearsQueueState() {
        // Set up state directly because DaemonClient.send() throws in tests.
        // Simulate the state after a successful cancel send: isCancelling is
        // true, isSending stays true, isThinking is false.
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = false
        viewModel.isCancelling = true

        let messageA = ChatMessage(role: .user, text: "Message A", status: .sent)
        let messageB = ChatMessage(role: .user, text: "Message B", status: .queued(position: 1))
        let messageC = ChatMessage(role: .user, text: "Message C", status: .queued(position: 2))
        viewModel.messages.append(messageA)
        viewModel.messages.append(messageB)
        viewModel.messages.append(messageC)
        viewModel.pendingQueuedCount = 2

        // Daemon sends error events for queued messages during cancellation
        // (abort drops queue without sending message_dequeued events). The
        // error handler's wasCancelling branch force-clears all queue state.
        viewModel.handleServerMessage(.error(ErrorMessage(message: "Request cancelled")))

        XCTAssertFalse(viewModel.isSending, "Error during cancellation should clear isSending")
        XCTAssertEqual(viewModel.pendingQueuedCount, 0, "Error during cancellation should reset pendingQueuedCount")
        // Queued messages should be reset to .sent
        if case .sent = viewModel.messages[1].status {
            // expected
        } else {
            XCTFail("Queued message B should be reset to .sent after cancellation, got \(viewModel.messages[1].status)")
        }
        if case .sent = viewModel.messages[2].status {
            // expected
        } else {
            XCTFail("Queued message C should be reset to .sent after cancellation, got \(viewModel.messages[2].status)")
        }
    }

    func testErrorWithPendingQueuePreservesQueueBookkeeping() {
        // Set up state directly because DaemonClient.send() throws in tests.
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = true

        // Manually add user messages
        let messageA = ChatMessage(role: .user, text: "Message A", status: .sent)
        let messageB = ChatMessage(role: .user, text: "Message B", status: .queued(position: 1))
        viewModel.messages.append(messageA)
        viewModel.messages.append(messageB)
        viewModel.pendingQueuedCount = 1

        // Non-cancellation error while B is still queued
        viewModel.handleServerMessage(.error(ErrorMessage(message: "Provider error for A")))

        // Queue should be preserved so daemon can still drain it
        XCTAssertEqual(viewModel.pendingQueuedCount, 1, "Non-cancellation error should preserve queue when messages are pending")
        XCTAssertTrue(viewModel.isSending, "isSending should stay true when messages are still queued")
    }

    func testErrorWithEmptyQueueClearsAllBookkeeping() {
        // Set up state directly because DaemonClient.send() throws in tests.
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = true

        // Add a user message (simulates a successfully sent message)
        let message = ChatMessage(role: .user, text: "Hello", status: .sent)
        viewModel.messages.append(message)

        // Error with no queued messages
        viewModel.handleServerMessage(.error(ErrorMessage(message: "Network error")))

        XCTAssertFalse(viewModel.isSending, "Error with empty queue should clear isSending")
        XCTAssertFalse(viewModel.isThinking, "Error should clear isThinking")
        XCTAssertEqual(viewModel.errorText, "Network error")
    }

    func testErrorDuringCancellationSuppressesErrorText() {
        // Simulate the state after a successful cancel send so we can test
        // the error handler's isCancelling suppression branch.
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = false
        viewModel.isCancelling = true

        let message = ChatMessage(role: .user, text: "Hello", status: .sent)
        viewModel.messages.append(message)

        // Daemon sends error as part of cancellation cleanup
        viewModel.handleServerMessage(.error(ErrorMessage(message: "Request cancelled")))

        // Error text should NOT be shown when the user intentionally cancelled
        XCTAssertNil(viewModel.errorText, "Error during cancellation should not display error text to user")
    }

    func testSendMessageClearsExistingErrorBeforeSend() {
        // Verify that sendMessage() clears any existing errorText at the
        // start of its execution. We test without a sessionId so it goes
        // through the bootstrapConversation path (which is async), preventing
        // the synchronous sendUserMessage throw from re-setting errorText.
        viewModel.errorText = "Previous network error"
        viewModel.inputText = "Retry"
        viewModel.sendMessage()
        XCTAssertNil(viewModel.errorText, "Sending a new message should clear previous error")
    }

    func testSendUserMessageWhenDisconnectedShowsErrorAndClearsState() {
        // Baseline: existing behavior when daemon disconnects between turns
        viewModel.conversationId = "test-session"
        daemonClient.isConnected = false

        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        // User message should appear in the list
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .user)

        // But sending state should NOT be set
        XCTAssertFalse(viewModel.isSending, "Disconnected send should not set isSending")
        XCTAssertFalse(viewModel.isThinking, "Disconnected send should not set isThinking")

        // Error should mention the assistant
        XCTAssertNotNil(viewModel.errorText)
        XCTAssertTrue(viewModel.errorText?.contains("assistant") == true,
                       "Disconnected error should mention assistant")
    }

    func testRegenerateWhenDisconnectedShowsError() {
        viewModel.conversationId = "test-session"
        daemonClient.isConnected = false

        viewModel.regenerateLastMessage()

        XCTAssertNotNil(viewModel.errorText, "Regenerate when disconnected should show error")
        XCTAssertTrue(viewModel.errorText?.contains("assistant") == true)
        XCTAssertFalse(viewModel.isSending, "Regenerate should not set isSending when disconnected")
        XCTAssertFalse(viewModel.isThinking)
    }

    func testRegenerateWhileSendingIsBlocked() {
        viewModel.conversationId = "test-session"
        viewModel.isSending = true

        viewModel.regenerateLastMessage()

        // Should do nothing — guard blocks it
        XCTAssertNil(viewModel.errorText, "Regenerate while sending should silently do nothing")
    }

    func testRegenerateClearsStaleConversationError() {
        viewModel.conversationId = "sess-1"
        daemonClient.isConnected = true

        // Simulate a stale session error from a previous failure
        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerApi,
            userMessage: "Stale error",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))
        XCTAssertNotNil(viewModel.conversationError)
        XCTAssertNotNil(viewModel.errorText)

        viewModel.regenerateLastMessage()

        XCTAssertNil(viewModel.conversationError, "Regenerate should clear stale session error")
        // errorText is re-set by the catch block because connection is nil
        // in the test environment, but the original stale error must be gone.
        XCTAssertNotEqual(viewModel.errorText, "Stale error",
                          "Regenerate should clear stale error text")
    }

    func testStopGeneratingWhenDisconnectedResetsAllState() {
        // Set up state directly to establish meaningful queue state, since
        // DaemonClient.send() throws when connection is nil.
        viewModel.conversationId = "test-session"
        viewModel.isSending = true
        viewModel.isThinking = true

        // Start streaming
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial")))

        // Add a queued message directly — sendMessage() while disconnected
        // bails before creating queue state.
        let queuedMsg = ChatMessage(role: .user, text: "Queued msg", status: .queued(position: 1))
        viewModel.messages.append(queuedMsg)
        viewModel.pendingQueuedCount = 1

        // Disconnect and stop
        daemonClient.isConnected = false
        viewModel.stopGenerating()

        // Everything should be reset since cancel can't reach daemon
        XCTAssertFalse(viewModel.isSending, "Stop when disconnected should clear isSending")
        XCTAssertFalse(viewModel.isThinking, "Stop when disconnected should clear isThinking")
        XCTAssertEqual(viewModel.pendingQueuedCount, 0, "Stop when disconnected should clear queue count")
        XCTAssertFalse(viewModel.messages[0].isStreaming, "Stop when disconnected should finalize streaming")
        // Queued message should be reset to .sent by stopGenerating
        XCTAssertEqual(viewModel.messages[1].status, .sent, "Queued message should be reset to .sent")
    }

    func testMultipleSequentialErrorsUpdateErrorText() {
        viewModel.isSending = true
        viewModel.isThinking = true

        viewModel.handleServerMessage(.error(ErrorMessage(message: "First error")))
        XCTAssertEqual(viewModel.errorText, "First error")

        // Simulate another send cycle (set state directly)
        viewModel.isSending = true
        viewModel.isThinking = true

        // Second error replaces the first
        viewModel.handleServerMessage(.error(ErrorMessage(message: "Second error")))
        XCTAssertEqual(viewModel.errorText, "Second error", "Latest error should replace previous error text")
    }

    // MARK: - Stop Generating

    func testStopGeneratingKeepsSendingUntilAcknowledged() {
        // Set up as if we're in a streaming session
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.conversationId = "test-session"
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial response")))

        viewModel.stopGenerating()

        // isSending stays true until daemon acknowledges
        XCTAssertTrue(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[0].isStreaming)

        // Daemon acknowledges cancellation
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(sessionId: nil)))
        XCTAssertFalse(viewModel.isSending)
    }

    func testStopGeneratingSuppressesLateDeltas() {
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.conversationId = "test-session"
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial")))

        viewModel.stopGenerating()

        // Late-arriving delta after stop should be suppressed
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " late text")))

        // Should still only have the original partial text, no new message
        XCTAssertEqual(viewModel.messages.count, 1) // 1 assistant
        XCTAssertEqual(viewModel.messages[0].text, "Partial")

        // Daemon acknowledges cancellation — clears isCancelling
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(sessionId: nil)))
        XCTAssertFalse(viewModel.isSending)

        // After acknowledgment, new deltas should work normally
        viewModel.isSending = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "New response")))
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messages[1].text, "New response")
    }

    func testStopGeneratingSuppressedByMessageComplete() {
        // If a message_complete arrives instead of generation_cancelled
        // (race between cancel and normal completion), it should also
        // reset the cancelling state.
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.conversationId = "test-session"
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response")))

        viewModel.stopGenerating()

        // Late delta suppressed
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " extra")))
        XCTAssertEqual(viewModel.messages[0].text, "Response")

        // message_complete arrives instead of generation_cancelled
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertFalse(viewModel.isSending)
    }

    func testStopGeneratingDuringBootstrapCancelsLocally() {
        // Simulate bootstrap: isSending is true but sessionId is nil
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        XCTAssertTrue(viewModel.isSending)
        XCTAssertNil(viewModel.conversationId)

        viewModel.stopGenerating()

        // Should reset immediately since there's no daemon session to cancel
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
    }

    func testStopGeneratingWithNoSessionDoesNothing() {
        // Not sending, no session
        viewModel.stopGenerating()
        XCTAssertFalse(viewModel.isSending)
    }

    func testStopGeneratingWhenNotSendingDoesNothing() {
        // Has session but not sending
        viewModel.conversationId = "test-session"
        viewModel.stopGenerating()
        XCTAssertFalse(viewModel.isSending)
    }

    // MARK: - Thinking Delta

    func testThinkingDeltaKeepsThinkingState() {
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantThinkingDelta(AssistantThinkingDeltaMessage(thinking: "Let me think...")))
        XCTAssertTrue(viewModel.isThinking)
    }

    func testThinkingDeltaDoesNotCreateMessage() {
        viewModel.handleServerMessage(.assistantThinkingDelta(AssistantThinkingDeltaMessage(thinking: "Hmm...")))
        XCTAssertEqual(viewModel.messages.count, 0) // No messages created
    }

    // MARK: - Message Queue

    func testMessageQueuedIncrementsPendingCount() {
        XCTAssertEqual(viewModel.pendingQueuedCount, 0)

        let queued = MessageQueuedMessage(sessionId: "sess-1", requestId: "req-1", position: 1)
        viewModel.handleServerMessage(.messageQueued(queued))

        XCTAssertEqual(viewModel.pendingQueuedCount, 1)
    }

    func testMessageDequeuedDecrementsPendingCount() {
        // Start with some queued
        let queued1 = MessageQueuedMessage(sessionId: "sess-1", requestId: "req-1", position: 1)
        let queued2 = MessageQueuedMessage(sessionId: "sess-1", requestId: "req-2", position: 2)
        viewModel.handleServerMessage(.messageQueued(queued1))
        viewModel.handleServerMessage(.messageQueued(queued2))
        XCTAssertEqual(viewModel.pendingQueuedCount, 2)

        let dequeued = MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-1")
        viewModel.handleServerMessage(.messageDequeued(dequeued))

        XCTAssertEqual(viewModel.pendingQueuedCount, 1)
    }

    func testMessageDequeuedDoesNotGoBelowZero() {
        XCTAssertEqual(viewModel.pendingQueuedCount, 0)

        let dequeued = MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-1")
        viewModel.handleServerMessage(.messageDequeued(dequeued))

        XCTAssertEqual(viewModel.pendingQueuedCount, 0)
    }

    func testMessageQueuedUpdatesMessageStatus() {
        // Add a user message with queued status
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        // Daemon confirms it's queued at position 2
        let queued = MessageQueuedMessage(sessionId: "sess-1", requestId: "req-1", position: 2)
        viewModel.handleServerMessage(.messageQueued(queued))

        // The user message should have its position updated
        if case .queued(let position) = viewModel.messages[0].status {
            XCTAssertEqual(position, 2)
        } else {
            XCTFail("Expected message to have queued status with position 2")
        }
    }

    func testMessageDequeuedUpdatesMessageStatusToProcessing() {
        // Add a user message with queued status
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        // Daemon confirms queued then dequeued
        let queued = MessageQueuedMessage(sessionId: "sess-1", requestId: "req-1", position: 1)
        viewModel.handleServerMessage(.messageQueued(queued))

        let dequeued = MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-1")
        viewModel.handleServerMessage(.messageDequeued(dequeued))

        XCTAssertEqual(viewModel.messages[0].status, .processing)
    }

    func testMessageDequeuedKeepsMessagePositionInTranscript() {
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.inputText = "Message A"
        viewModel.sendMessage()
        viewModel.inputText = "Message B"
        viewModel.sendMessage()

        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        let indexBeforeDequeue = viewModel.messages.firstIndex(where: { $0.text == "Message B" })
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))
        let indexAfterDequeue = viewModel.messages.firstIndex(where: { $0.text == "Message B" })

        XCTAssertEqual(indexBeforeDequeue, indexAfterDequeue, "Dequeued message should stay in place in the transcript")
        if let indexAfterDequeue {
            XCTAssertEqual(viewModel.messages[indexAfterDequeue].status, .processing)
        } else {
            XCTFail("Expected dequeued message to remain in transcript")
        }
    }

    func testMessageDequeuedRestoresSendingAndThinkingState() {
        // Simulate: message A completes, then queued message B is dequeued
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        // Message A completes — clears isSending and isThinking
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)

        // Message B is dequeued and starts processing
        let dequeued = MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-2")
        viewModel.handleServerMessage(.messageDequeued(dequeued))

        // isSending and isThinking must be restored so the UI shows
        // the thinking indicator and stop button
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)
    }

    // MARK: - Processing Status Reset

    func testProcessingStatusResetToSentOnMessageComplete() {
        // Set up session and send a message while busy (gets queued)
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.inputText = "Message A"
        viewModel.sendMessage()
        // A(0)

        // Send message B while busy (will be queued)
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        // A(0), B(1)
        XCTAssertEqual(viewModel.messages.count, 2)

        // Daemon confirms B is queued
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))

        // Assistant responds to A, then handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        // Daemon dequeues B — status becomes .processing
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))
        let messageBAfterDequeue = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterDequeue.status, .processing, "Message B should be processing after dequeue")

        // Assistant responds to B, then message_complete
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        // After message_complete, the processing user message should be reset to .sent
        let messageBAfterComplete = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterComplete.status, .sent, "Message B should be .sent after messageComplete, not .processing")
    }

    func testProcessingStatusResetToSentOnMessageRequestComplete() {
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.inputText = "Message A"
        viewModel.sendMessage()

        viewModel.inputText = "Message B"
        viewModel.sendMessage()

        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))

        let messageBAfterDequeue = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterDequeue.status, .processing)
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)

        viewModel.handleServerMessage(
            .messageRequestComplete(
                MessageRequestCompleteMessage(
                    sessionId: "sess-1",
                    requestId: "req-B",
                    runStillActive: false
                )
            )
        )

        let messageBAfterComplete = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterComplete.status, .sent, "Message B should be .sent after messageRequestComplete")
        XCTAssertFalse(viewModel.isSending, "isSending should clear when request completed and no run remains active")
        XCTAssertFalse(viewModel.isThinking, "isThinking should clear when request completed and no run remains active")
    }

    func testMessageRequestCompleteKeepsBusyStateWhenRunStillActive() {
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.inputText = "Message A"
        viewModel.sendMessage()

        viewModel.inputText = "Message B"
        viewModel.sendMessage()

        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))

        viewModel.handleServerMessage(
            .messageRequestComplete(
                MessageRequestCompleteMessage(
                    sessionId: "sess-1",
                    requestId: "req-B",
                    runStillActive: true
                )
            )
        )

        let messageBAfterComplete = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterComplete.status, .sent, "Message B should be finalized even while another run remains active")
        XCTAssertTrue(viewModel.isSending, "isSending should stay true while runStillActive is true")
        XCTAssertTrue(viewModel.isThinking, "isThinking should stay true while runStillActive is true")
    }

    func testProcessingStatusResetToSentOnGenerationCancelled() {
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.inputText = "Message A"
        viewModel.sendMessage()

        viewModel.inputText = "Message B"
        viewModel.sendMessage()

        // Daemon confirms B is queued, then dequeued
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))
        let messageBAfterDequeue = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterDequeue.status, .processing)

        // User initiates cancel, then server acknowledges
        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(sessionId: nil)))

        let messageBAfterCancel = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterCancel.status, .sent, "Message B should be .sent after generationCancelled, not .processing")
    }

    func testProcessingStatusResetToSentOnGenerationHandoff() {
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.inputText = "Message A"
        viewModel.sendMessage()

        viewModel.inputText = "Message B"
        viewModel.sendMessage()

        viewModel.inputText = "Message C"
        viewModel.sendMessage()

        // Queue B and C
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-C", position: 2)))

        // A completes via handoff, B is dequeued and becomes processing
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 2)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))
        let messageBAfterDequeue = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterDequeue.status, .processing)

        // B completes via handoff (C is still queued)
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        // B should be reset to .sent after generationHandoff
        let messageBAfterHandoff = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterHandoff.status, .sent, "Message B should be .sent after generationHandoff, not .processing")
    }

    // MARK: - Generation Handoff

    func testGenerationHandoffKeepsSendingTrue() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        // Start streaming an assistant message
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial response")))

        // Handoff: generation cut short, queued messages waiting
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        XCTAssertTrue(viewModel.isSending, "isSending must stay true during handoff")
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[0].isStreaming, "Streaming message should be finalized")
    }

    func testGenerationHandoffWithoutStreamingMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

        // Handoff without any prior text deltas
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        XCTAssertTrue(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
    }

    func testGenerationHandoffClearsCurrentAssistantMessageId() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        // First text delta creates assistant message
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "First response")))
        XCTAssertEqual(viewModel.messages.count, 1) // first assistant only

        // Handoff clears currentAssistantMessageId
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        // Second text delta should create a NEW assistant message
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Second response")))
        XCTAssertEqual(viewModel.messages.count, 2, "Second delta should create a new message, not append to first")
        XCTAssertEqual(viewModel.messages[0].text, "First response")
        XCTAssertEqual(viewModel.messages[1].text, "Second response")
    }

    func testThreeMessageBurstWithHandoffTransitions() {
        // Set up session
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = true

        // 1. User sends message A (processed immediately — already in flight)
        //    We just simulate the user message being in messages array
        let messageA = ChatMessage(role: .user, text: "Message A", status: .sent)
        viewModel.messages.append(messageA)

        // 2-3. User sends messages B and C (queued)
        let messageB = ChatMessage(role: .user, text: "Message B", status: .queued(position: 0))
        let messageC = ChatMessage(role: .user, text: "Message C", status: .queued(position: 0))
        viewModel.messages.append(messageB)
        viewModel.messages.append(messageC)

        // 4. Daemon confirms B and C are queued
        //    We need to set up pendingMessageIds so the FIFO mapping works
        // Simulate what sendMessage() would have done for queued messages
        // Since we manually added them, we manually set up the pending IDs
        // Instead, use the messageQueued handler which maps requestId -> messageId
        // We need pendingMessageIds populated for messageQueued to map correctly
        // Let's add them to the pending queue manually
        // viewModel.pendingMessageIds is private, so we simulate via messageQueued
        // Actually, we need to work around private access. Let's use a different approach:
        // The messageQueued handler pops from pendingMessageIds. Since that's private,
        // we can simulate the full flow by sending messages through sendMessage().

        // Let's restart with a cleaner approach using sendMessage for B and C
        viewModel.messages.removeAll()

        // Message A: sent while not busy (direct processing)
        viewModel.isSending = false
        viewModel.isThinking = false
        viewModel.inputText = "Message A"
        viewModel.sendMessage()
        // Now isSending=true, isThinking=true (from sendUserMessage)

        // Messages B and C: sent while busy (will be queued)
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        viewModel.inputText = "Message C"
        viewModel.sendMessage()

        // A(0), B(1), C(2)
        XCTAssertEqual(viewModel.messages.count, 3)

        // 4. Daemon sends messageQueued for B (position 1) and C (position 2)
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-C", position: 2)))
        XCTAssertEqual(viewModel.pendingQueuedCount, 2)
        if case .queued(let pos) = viewModel.messages[1].status {
            XCTAssertEqual(pos, 1)
        } else {
            XCTFail("Message B should be queued")
        }

        // 5. Assistant responds to A, then generation_handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 2)))

        XCTAssertTrue(viewModel.isSending, "isSending stays true after handoff")
        XCTAssertFalse(viewModel.isThinking, "isThinking cleared after handoff")
        // Assistant message for A should be finalized
        XCTAssertFalse(viewModel.messages[3].isStreaming, "First assistant message should be finalized")

        // 6. Daemon dequeues B (status transitions to .processing)
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))
        let messageBStatus = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBStatus.status, .processing, "Message B should be processing")
        XCTAssertTrue(viewModel.isThinking, "isThinking restored after dequeue")
        XCTAssertTrue(viewModel.isSending)
        XCTAssertEqual(viewModel.pendingQueuedCount, 1)

        // 7. Text delta for B, then generation_handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        // Second assistant message finalized
        XCTAssertFalse(viewModel.messages[4].isStreaming, "Second assistant message should be finalized")
        XCTAssertTrue(viewModel.isSending, "isSending stays true — C is still queued")

        // 8. Daemon dequeues C (status transitions to .processing)
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-C")))
        let messageCStatus = viewModel.messages.first(where: { $0.text == "Message C" })!
        XCTAssertEqual(messageCStatus.status, .processing, "Message C should be processing")
        XCTAssertEqual(viewModel.pendingQueuedCount, 0)

        // 9. Text delta for C, then message_complete
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to C")))
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertFalse(viewModel.isSending, "isSending should be false — no more queued messages")
        XCTAssertFalse(viewModel.messages[5].isStreaming, "Third assistant message should be finalized")
    }

    // MARK: - Queue Badges / Status Transitions (handoff → dequeue → complete)

    func testQueueBadgesStatusTransitionsReflectHandoffDequeueComplete() {
        // Set up viewModel with a session
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))

        // Send message A (direct — not queued)
        viewModel.inputText = "Message A"
        viewModel.sendMessage()
        // A(0)
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)

        // Send messages B and C while busy (both get queued status)
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        viewModel.inputText = "Message C"
        viewModel.sendMessage()
        // A(0), B(1), C(2)
        XCTAssertEqual(viewModel.messages.count, 3)

        // Both B and C should have .queued status (position 0 initially)
        if case .queued = viewModel.messages[1].status {
            // expected
        } else {
            XCTFail("Message B should have queued status")
        }
        if case .queued = viewModel.messages[2].status {
            // expected
        } else {
            XCTFail("Message C should have queued status")
        }

        // Simulate daemon confirming B and C are queued
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-C", position: 2)))
        XCTAssertEqual(viewModel.pendingQueuedCount, 2)

        // Verify positions were updated
        if case .queued(let pos) = viewModel.messages[1].status {
            XCTAssertEqual(pos, 1)
        } else {
            XCTFail("Message B should be queued at position 1")
        }
        if case .queued(let pos) = viewModel.messages[2].status {
            XCTAssertEqual(pos, 2)
        } else {
            XCTFail("Message C should be queued at position 2")
        }

        // Assistant responds to A with text delta, then generation_handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        // A(0), B(1), C(2), assistantA(3)
        XCTAssertEqual(viewModel.messages.count, 4)

        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 2)))

        // After handoff: isSending stays true, isThinking cleared, streaming finalized
        XCTAssertTrue(viewModel.isSending, "isSending must stay true during handoff")
        XCTAssertFalse(viewModel.isThinking, "isThinking cleared after handoff")
        XCTAssertFalse(viewModel.messages[3].isStreaming, "Assistant message for A should be finalized")

        // B and C remain queued
        XCTAssertEqual(viewModel.pendingQueuedCount, 2)

        // Simulate messageDequeued for B — first queued goes to .processing
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))
        let messageBStatus = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBStatus.status, .processing, "Message B should now be processing")
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking, "isThinking restored after dequeue")
        XCTAssertEqual(viewModel.pendingQueuedCount, 1)

        // Assistant responds to B, then another handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))
        XCTAssertTrue(viewModel.isSending, "isSending stays true — C is still queued")

        // Simulate messageDequeued for C
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-C")))
        let messageCStatus = viewModel.messages.first(where: { $0.text == "Message C" })!
        XCTAssertEqual(messageCStatus.status, .processing, "Message C should now be processing")
        XCTAssertEqual(viewModel.pendingQueuedCount, 0)

        // Assistant responds to C, then message_complete (no more queued)
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to C")))
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        // isSending should clear when queue is empty and message completes
        XCTAssertFalse(viewModel.isSending, "isSending should be false — no more queued messages")
        XCTAssertFalse(viewModel.isThinking)
    }

    // MARK: - Session Filtering

    func testTextDeltaFromDifferentSessionIsIgnored() {
        viewModel.conversationId = "my-session"
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "foreign", sessionId: "other-session")))
        // Should still be thinking — delta was ignored
        XCTAssertTrue(viewModel.isThinking)
        XCTAssertEqual(viewModel.messages.count, 0) // No messages
    }

    func testTextDeltaFromSameSessionIsAccepted() {
        viewModel.conversationId = "my-session"
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "hello", sessionId: "my-session")))
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].text, "hello")
    }

    func testTextDeltaWithNilSessionIdIsAccepted() {
        viewModel.conversationId = "my-session"
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "hello", sessionId: nil)))
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertEqual(viewModel.messages.count, 1)
    }

    func testMessageCompleteFromDifferentSessionIsIgnored() {
        viewModel.conversationId = "my-session"
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage(sessionId: "other-session")))
        // Should still be sending/thinking — message was ignored
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)
    }

    func testMessageCompleteFromSameSessionIsAccepted() {
        viewModel.conversationId = "my-session"
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage(sessionId: "my-session")))
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
    }

    // MARK: - Disconnected Send Handling

    func testSendUserMessageWhenDisconnectedShowsError() {
        // Set up a session but daemon is disconnected
        viewModel.conversationId = "test-session"
        daemonClient.isConnected = false

        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        // User message should still appear in the list
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .user)

        // But isSending/isThinking should NOT be set since the send was rejected
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)

        // Error text should be surfaced
        XCTAssertNotNil(viewModel.errorText)
        XCTAssertTrue(viewModel.errorText?.contains("assistant") == true)
    }

    // MARK: - Full Conversation Flow

    func testFullConversationFlow() {
        // Simulate a complete conversation: session created, text streamed, completed
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        XCTAssertEqual(viewModel.conversationId, "sess-1")

        // Thinking starts
        viewModel.isThinking = true
        viewModel.isSending = true
        viewModel.handleServerMessage(.assistantThinkingDelta(AssistantThinkingDeltaMessage(thinking: "Analyzing...")))
        XCTAssertTrue(viewModel.isThinking)

        // Text deltas arrive
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "The answer")))
        XCTAssertFalse(viewModel.isThinking) // Thinking cleared on first text delta
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " is 42.")))
        XCTAssertEqual(viewModel.messages[0].text, "The answer is 42.")
        XCTAssertTrue(viewModel.messages[0].isStreaming)

        // Message completes
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.messages[0].isStreaming)
    }

    // MARK: - Session Isolation (Correlation ID)

    func testSessionInfoWithWrongCorrelationIdIsIgnored() {
        // Simulate a ChatViewModel that has sent a session_create with a correlation ID.
        // A session_info with a different correlation ID should be ignored.
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        // At this point the VM is bootstrapping and has a correlationId set internally.
        XCTAssertNil(viewModel.conversationId)
        XCTAssertTrue(viewModel.isSending)

        // A session_info from a different ChatViewModel's request (different correlation ID)
        let foreignInfo = ConversationInfoMessage(conversationId: "foreign-session", title: "Foreign", correlationId: "wrong-id")
        viewModel.handleServerMessage(.conversationInfo(foreignInfo))

        // Should NOT have claimed the foreign session
        XCTAssertNil(viewModel.conversationId, "Should not claim session_info with non-matching correlationId")
    }

    func testSessionInfoWithNilCorrelationIdIsIgnoredWhenBootstrapping() {
        // When a ChatViewModel is bootstrapping (has a correlationId), a session_info
        // without any correlationId should also be rejected to prevent cross-contamination.
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertNil(viewModel.conversationId)

        // Legacy session_info without correlationId
        let legacyInfo = ConversationInfoMessage(conversationId: "legacy-session", title: "Legacy")
        viewModel.handleServerMessage(.conversationInfo(legacyInfo))

        // Should NOT have claimed the legacy session
        XCTAssertNil(viewModel.conversationId, "Should not claim session_info without correlationId when bootstrapping with one")
    }

    func testSessionInfoWithoutCorrelationIdRejectedWhenNoBootstrap() {
        // After removing backwards compat, session_info without a correlationId
        // is rejected even when there is no bootstrap correlationId set.
        let info = ConversationInfoMessage(conversationId: "test-session", title: "Test")
        viewModel.handleServerMessage(.conversationInfo(info))

        XCTAssertNil(viewModel.conversationId, "Should reject session_info when no bootstrapCorrelationId is set")
    }

    // MARK: - Conversation Error (Typed Error State)

    func testConversationErrorSetsTypedErrorState() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerRateLimit,
            userMessage: "Rate limit exceeded",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertNotNil(viewModel.conversationError)
        XCTAssertEqual(viewModel.conversationError?.category, .rateLimit)
        XCTAssertEqual(viewModel.conversationError?.message, "Rate limit exceeded")
        XCTAssertTrue(viewModel.conversationError?.isRetryable == true)
        XCTAssertEqual(viewModel.conversationError?.conversationId, "sess-1")
    }

    func testConversationErrorSetsRecoverySuggestion() {
        viewModel.conversationId = "sess-1"

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerNetwork,
            userMessage: "Connection failed",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertNotNil(viewModel.conversationError?.recoverySuggestion)
        XCTAssertTrue(viewModel.conversationError!.recoverySuggestion.contains("internet"),
                       "Network error should suggest checking internet connection")
    }

    func testConversationErrorClearsThinkingAndSendingState() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerApi,
            userMessage: "API error",
            retryable: false
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.isSending)
    }

    func testConversationErrorAlsoSetsErrorText() {
        viewModel.conversationId = "sess-1"

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerApi,
            userMessage: "Provider returned 500",
            retryable: false
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertEqual(viewModel.errorText, "Provider returned 500",
                       "session_error should populate errorText for backward compatibility")
    }

    func testConversationErrorFromDifferentConversationIsIgnored() {
        viewModel.conversationId = "sess-1"

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-other",
            code: .providerNetwork,
            userMessage: "Connection failed",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertNil(viewModel.conversationError,
                      "session_error from a different session should be ignored")
        XCTAssertNil(viewModel.errorText)
    }

    func testConversationErrorIgnoredBeforeConversationClaimed() {
        // sessionId is nil — no session claimed yet
        XCTAssertNil(viewModel.conversationId)

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-other",
            code: .providerNetwork,
            userMessage: "Connection failed",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertNil(viewModel.conversationError,
                      "session_error should be ignored before session is claimed")
        XCTAssertNil(viewModel.errorText)
    }

    func testConversationErrorFinalizesStreamingMessage() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial")))
        XCTAssertTrue(viewModel.messages[0].isStreaming)

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .conversationProcessingFailed,
            userMessage: "Processing failed",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertFalse(viewModel.messages[0].isStreaming,
                        "session_error should finalize streaming assistant message")
        XCTAssertEqual(viewModel.messages[0].text, "Partial",
                        "Partial text should be preserved")
    }

    func testConversationErrorResetsProcessingMessagesToSent() {
        // Set up state directly because DaemonClient.send() throws in tests.
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = true

        let messageA = ChatMessage(role: .user, text: "Message A", status: .sent)
        let messageB = ChatMessage(role: .user, text: "Message B", status: .processing)
        viewModel.messages.append(messageA)
        viewModel.messages.append(messageB)
        XCTAssertEqual(viewModel.messages[1].status, .processing)

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .conversationProcessingFailed,
            userMessage: "Processing failed",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertEqual(viewModel.messages[1].status, .sent,
                        "session_error should reset processing messages to .sent")
    }

    func testDismissConversationErrorClearsBothErrorStates() {
        viewModel.conversationId = "sess-1"

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerRateLimit,
            userMessage: "Rate limited",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertNotNil(viewModel.conversationError)
        XCTAssertNotNil(viewModel.errorText)

        viewModel.dismissConversationError()

        XCTAssertNil(viewModel.conversationError)
        XCTAssertNil(viewModel.errorText)
    }

    func testSendMessageClearsConversationError() {
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerApi,
            userMessage: "API error",
            retryable: false
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))
        XCTAssertNotNil(viewModel.conversationError)

        viewModel.inputText = "Retry"
        viewModel.sendMessage()

        XCTAssertNil(viewModel.conversationError,
                      "Sending a new message should clear the session error")
    }

    func testAllErrorCategoriesHaveRecoverySuggestions() {
        // Every ConversationErrorCode should produce a non-empty recovery suggestion
        for code in ConversationErrorCode.allCases {
            let category = ConversationErrorCategory(from: code)
            XCTAssertFalse(category.recoverySuggestion.isEmpty,
                           "\(code) should produce a non-empty recovery suggestion")
        }
    }

    func testConversationErrorDuringCancellationSuppressesErrorText() {
        // Simulate the state after a successful cancel send so we can test
        // the conversationError handler's isCancelling suppression branch.
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = false
        viewModel.isCancelling = true

        let message = ChatMessage(role: .user, text: "Hello", status: .sent)
        viewModel.messages.append(message)

        // Daemon sends session error as part of cancellation cleanup
        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .conversationAborted,
            userMessage: "Session aborted",
            retryable: false
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        // Both errorText and conversationError should be suppressed during cancellation
        // (user-initiated cancel should only show generation_cancelled, never a toast)
        XCTAssertNil(viewModel.errorText,
                      "Session error during cancellation should not display errorText")
        XCTAssertNil(viewModel.conversationError,
                      "Conversation error during cancellation should not set typed conversationError")
    }

    func testConversationErrorNonRetryableFlag() {
        viewModel.conversationId = "sess-1"

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerApi,
            userMessage: "Provider error",
            retryable: false
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertEqual(viewModel.conversationError?.isRetryable, false)
        XCTAssertEqual(viewModel.conversationError?.category, .providerApi)
    }

    func testConversationErrorReplacedBySubsequentError() {
        viewModel.conversationId = "sess-1"

        let firstError = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerNetwork,
            userMessage: "Network error",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(firstError))
        XCTAssertEqual(viewModel.conversationError?.category, .providerNetwork)

        let secondError = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerRateLimit,
            userMessage: "Rate limited",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(secondError))
        XCTAssertEqual(viewModel.conversationError?.category, .rateLimit,
                        "Latest session_error should replace previous one")
        XCTAssertEqual(viewModel.conversationError?.message, "Rate limited")
    }

    func testDebugDetailsPassedToConversationError() {
        viewModel.conversationId = "sess-1"

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerApi,
            userMessage: "Provider error",
            retryable: true,
            debugDetails: "Error: 500 Internal Server Error\n  at handler.ts:42"
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertEqual(viewModel.conversationError?.debugDetails,
                        "Error: 500 Internal Server Error\n  at handler.ts:42",
                        "debugDetails should be passed through from server message")
    }

    func testDebugDetailsNilWhenNotProvided() {
        viewModel.conversationId = "sess-1"

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerNetwork,
            userMessage: "Network error",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertNil(viewModel.conversationError?.debugDetails,
                      "debugDetails should be nil when not provided in server message")
    }

    // MARK: - Regression: Cancel semantics and error channel split

    func testCancelSuppressesAllConversationErrorFields() {
        // Regression: cancel must suppress both errorText AND typed conversationError
        viewModel.conversationId = "sess-1"
        viewModel.isCancelling = true

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerApi,
            userMessage: "Server error",
            retryable: true,
            debugDetails: "stack trace here"
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertNil(viewModel.conversationError,
                      "Typed conversationError must be nil during cancel")
        XCTAssertNil(viewModel.errorText,
                      "errorText must be nil during cancel")
    }

    func testConversationErrorDeliveredViaStreamNotCallback() {
        // Regression: session errors arrive through handleServerMessage (stream),
        // not through a singleton callback on DaemonClient.
        viewModel.conversationId = "sess-1"

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .providerRateLimit,
            userMessage: "Rate limited",
            retryable: true
        )

        // Deliver via the same path the subscribe() stream uses
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertNotNil(viewModel.conversationError,
                         "conversationError should be set via handleServerMessage")
        XCTAssertEqual(viewModel.conversationError?.category, .rateLimit)
        XCTAssertEqual(viewModel.conversationError?.isRetryable, true)
    }

    func testGenerationCancelledClearsThinkingState() {
        // Regression: generation_cancelled should clear thinking/sending state
        viewModel.conversationId = "sess-1"
        viewModel.isThinking = true
        viewModel.isSending = true
        viewModel.isCancelling = true

        viewModel.handleServerMessage(.generationCancelled(
            GenerationCancelledMessage(sessionId: "sess-1")
        ))

        XCTAssertFalse(viewModel.isThinking,
                        "generation_cancelled should clear isThinking")
        XCTAssertFalse(viewModel.isSending,
                        "generation_cancelled should clear isSending")
        XCTAssertNil(viewModel.conversationError,
                      "generation_cancelled should not set conversationError")
    }

    // MARK: - Assistant Attachment Ingestion

    func testMessageCompleteWithAttachmentsAddsToExistingMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

        // Stream some text first
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Here is an image")))
        XCTAssertEqual(viewModel.messages.count, 1) // assistant only

        // Complete with attachments
        let attachment = UserMessageAttachment(
            id: "att-1", filename: "photo.png", mimeType: "image/png",
            data: "iVBORw0KGgo=", extractedText: nil, sizeBytes: nil, thumbnailData: nil
        )
        viewModel.handleServerMessage(.messageComplete(
            MessageCompleteMessage(sessionId: nil, attachments: [attachment])
        ))

        XCTAssertEqual(viewModel.messages.count, 1, "Should add attachments to existing message, not create new")
        XCTAssertEqual(viewModel.messages[0].attachments.count, 1)
        XCTAssertEqual(viewModel.messages[0].attachments[0].filename, "photo.png")
        XCTAssertEqual(viewModel.messages[0].attachments[0].id, "att-1")
        XCTAssertFalse(viewModel.messages[0].isStreaming)
    }

    func testMessageCompleteWithAttachmentsCreatesNewMessageWhenNoStreaming() {
        viewModel.isSending = true
        viewModel.isThinking = true

        // Complete with attachments but no prior text deltas (attachment-only turn)
        let attachment = UserMessageAttachment(
            id: "att-1", filename: "report.pdf", mimeType: "application/pdf",
            data: "JVBER", extractedText: nil, sizeBytes: nil, thumbnailData: nil
        )
        viewModel.handleServerMessage(.messageComplete(
            MessageCompleteMessage(sessionId: nil, attachments: [attachment])
        ))

        XCTAssertEqual(viewModel.messages.count, 1, "Should create new assistant message for attachment-only turn")
        XCTAssertEqual(viewModel.messages[0].role, .assistant)
        XCTAssertEqual(viewModel.messages[0].attachments.count, 1)
        XCTAssertEqual(viewModel.messages[0].attachments[0].filename, "report.pdf")
    }

    func testGenerationHandoffWithAttachmentsAddsToExistingMessage() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        // Stream some text
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Generated file")))

        // Handoff with attachments
        let attachment = UserMessageAttachment(
            id: "att-2", filename: "output.csv", mimeType: "text/csv",
            data: "Y29sQQ==", extractedText: nil, sizeBytes: nil, thumbnailData: nil
        )
        viewModel.handleServerMessage(.generationHandoff(
            GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1, attachments: [attachment])
        ))

        XCTAssertEqual(viewModel.messages[0].attachments.count, 1)
        XCTAssertEqual(viewModel.messages[0].attachments[0].filename, "output.csv")
        XCTAssertFalse(viewModel.messages[0].isStreaming)
    }

    func testMessageCompleteWithNilAttachmentsDoesNotCreateMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

        // Complete without attachments (nil)
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        // Should have no messages — no extra empty assistant message
        XCTAssertEqual(viewModel.messages.count, 0)
    }

    func testMessageCompleteWithEmptyAttachmentsDoesNotCreateMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

        // Complete with empty attachments array
        viewModel.handleServerMessage(.messageComplete(
            MessageCompleteMessage(sessionId: nil, attachments: [])
        ))

        // Should have no messages — no extra empty assistant message
        XCTAssertEqual(viewModel.messages.count, 0)
    }

    // MARK: - History Attachment Hydration

    func testPopulateFromHistoryHydratesAssistantAttachments() {
        let attachment = UserMessageAttachment(
            id: "hist-att-1", filename: "chart.png", mimeType: "image/png",
            data: "iVBORw0KGgo=", extractedText: nil, sizeBytes: nil, thumbnailData: nil
        )
        let historyItems: [HistoryResponseMessage] = [
            HistoryResponseMessage(id: nil, role: "user", text: "Show me a chart", timestamp: 1000, toolCalls: nil, toolCallsBeforeText: nil, attachments: nil, textSegments: nil, contentOrder: nil, surfaces: nil, subagentNotification: nil),
            HistoryResponseMessage(id: nil, role: "assistant", text: "Here is your chart", timestamp: 2000, toolCalls: nil, toolCallsBeforeText: nil, attachments: [attachment], textSegments: nil, contentOrder: nil, surfaces: nil, subagentNotification: nil),
        ]

        viewModel.populateFromHistory(historyItems, hasMore: false)

        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messages[1].role, .assistant)
        XCTAssertEqual(viewModel.messages[1].attachments.count, 1)
        XCTAssertEqual(viewModel.messages[1].attachments[0].filename, "chart.png")
        XCTAssertEqual(viewModel.messages[1].attachments[0].id, "hist-att-1")
    }

    func testPopulateFromHistoryIncludesAttachmentOnlyMessages() {
        let attachment = UserMessageAttachment(
            id: "hist-att-2", filename: "report.pdf", mimeType: "application/pdf",
            data: "JVBER", extractedText: nil, sizeBytes: nil, thumbnailData: nil
        )
        let historyItems: [HistoryResponseMessage] = [
            HistoryResponseMessage(id: nil, role: "assistant", text: "", timestamp: 1000, toolCalls: nil, toolCallsBeforeText: nil, attachments: [attachment], textSegments: nil, contentOrder: nil, surfaces: nil, subagentNotification: nil),
        ]

        viewModel.populateFromHistory(historyItems, hasMore: false)

        // Attachment-only message (empty text, no tool calls) should NOT be skipped
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .assistant)
        XCTAssertEqual(viewModel.messages[0].attachments.count, 1)
        XCTAssertEqual(viewModel.messages[0].attachments[0].filename, "report.pdf")
    }

    func testPopulateFromHistorySkipsEmptyMessagesWithNoAttachments() {
        let historyItems: [HistoryResponseMessage] = [
            HistoryResponseMessage(id: nil, role: "assistant", text: "", timestamp: 1000, toolCalls: nil, toolCallsBeforeText: nil, attachments: nil, textSegments: nil, contentOrder: nil, surfaces: nil, subagentNotification: nil),
        ]

        viewModel.populateFromHistory(historyItems, hasMore: false)

        // Empty message with no text, no tool calls, no attachments should be skipped
        XCTAssertEqual(viewModel.messages.count, 0)
    }

    // MARK: - Interleaved Text/Tool-Call Segments

    func testTextToolTextCreatesInterleavedSegments() {
        // Text delta → tool call → more text delta
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "What are you working on?")))
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "memory_manage", input: ["key": AnyCodable("task")], sessionId: nil)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Saved that to memory.")))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.textSegments, ["What are you working on?", "Saved that to memory."])
        XCTAssertEqual(msg.contentOrder, [.text(0), .toolCall(0), .text(1)])
        XCTAssertEqual(msg.text, "What are you working on?Saved that to memory.")
    }

    func testMultipleDeltasSameSegment() {
        // Multiple text deltas without intervening tool call stay in one segment
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Hel")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "lo ")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "world")))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.textSegments, ["Hello world"])
        XCTAssertEqual(msg.contentOrder, [.text(0)])
    }

    func testSuppressedToolsDoNotCreateSegmentBoundary() {
        // ui_show is suppressed and should not create a segment boundary
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Before")))
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "ui_show", input: [:], sessionId: nil)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " after")))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        // ui_show breaks before reaching tool call append code, so no segment boundary
        XCTAssertEqual(msg.textSegments, ["Before after"])
        XCTAssertEqual(msg.contentOrder, [.text(0)])
    }

    func testToolOnlyMessageHasToolCallInContentOrder() {
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "bash", input: ["command": AnyCodable("ls")], sessionId: nil)))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.textSegments, [])
        XCTAssertEqual(msg.contentOrder, [.toolCall(0)])
    }

    func testPopulateFromHistoryUsesTextSegments() {
        let toolCall = HistoryResponseToolCall(name: "memory_manage", input: ["key": AnyCodable("task")], result: "saved", isError: nil, imageData: nil)
        let historyItems: [HistoryResponseMessage] = [
            HistoryResponseMessage(
                id: nil,
                role: "assistant",
                text: "What are you working on?Saved that to memory.",
                timestamp: 1000,
                toolCalls: [toolCall],
                toolCallsBeforeText: nil,
                attachments: nil,
                textSegments: ["What are you working on?", "Saved that to memory."],
                contentOrder: ["text:0", "tool:0", "text:1"],
                surfaces: nil,
                subagentNotification: nil
            ),
        ]

        viewModel.populateFromHistory(historyItems, hasMore: false)

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.textSegments, ["What are you working on?", "Saved that to memory."])
        XCTAssertEqual(msg.contentOrder, [.text(0), .toolCall(0), .text(1)])
    }

    func testPopulateFromHistoryFallsBackToLegacy() {
        let toolCall = HistoryResponseToolCall(name: "bash", input: ["command": AnyCodable("ls")], result: "file.txt", isError: nil, imageData: nil)
        let historyItems: [HistoryResponseMessage] = [
            HistoryResponseMessage(
                id: nil,
                role: "assistant",
                text: "Here are the files.",
                timestamp: 1000,
                toolCalls: [toolCall],
                toolCallsBeforeText: true,
                attachments: nil,
                textSegments: nil,
                contentOrder: nil,
                surfaces: nil,
                subagentNotification: nil
            ),
        ]

        viewModel.populateFromHistory(historyItems, hasMore: false)

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        // Legacy fallback: tools before text
        XCTAssertEqual(msg.contentOrder, [.toolCall(0), .text(0)])
    }

    // MARK: - Adjacent Text Segment Coalescing

    func testMultipleAssistantDeltasWithNoToolBoundariesRemainOneTextSegment() {
        // Multiple assistant text deltas without any tool calls between them
        // should all accumulate into a single text segment.
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Hello ")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "from ")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "the assistant.")))
        // Flush buffered streaming text so assertions can inspect messages.
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.textSegments, ["Hello from the assistant."])
        XCTAssertEqual(msg.contentOrder, [.text(0)])
    }

    func testTextToolTextCreatesSeparateTextSegments() {
        // Text delta → tool call start (flushes automatically) + result → more text delta
        // should produce separate text segments with interleaved content order.
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Let me check.")))
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "bash", input: ["command": AnyCodable("ls")], sessionId: nil)))
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "bash", result: "file.txt", isError: nil, diff: nil, status: nil, sessionId: nil, imageData: nil)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Here are the files.")))
        // Flush the second text delta so it lands in messages.
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        // The data model keeps separate text segments and interleaved contentOrder.
        XCTAssertEqual(msg.textSegments.count, 2)
        XCTAssertEqual(msg.textSegments[0], "Let me check.")
        XCTAssertEqual(msg.textSegments[1], "Here are the files.")
        XCTAssertEqual(msg.contentOrder, [.text(0), .toolCall(0), .text(1)])
        // Note: the view layer (ChatBubble.groupContentBlocks) coalesces these text
        // segments across tool call boundaries so the user can drag-select across them.
        // Tool calls render as EmptyView and produce no visual gap between text runs.
    }

    func testStreamingCompletionPreservesFinalJoinedText() {
        // Streaming deltas followed by message_complete should preserve the
        // full joined text in the message's .text property.
        // message_complete calls flushStreamingBuffer() internally.
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Part one. ")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Part two.")))
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.text, "Part one. Part two.")
        XCTAssertEqual(msg.textSegments, ["Part one. Part two."])
    }

    // MARK: - Retry Button Visibility (Send-Only Errors)

    func testIsRetryableErrorRequiresSendFailure() {
        // A non-send error (e.g. confirmation failure) should NOT make the
        // retry button visible even if lastFailedMessageText is cached from
        // a prior send failure.
        viewModel.conversationId = "sess-1"

        // Simulate a prior connection-error send failure that cached the message.
        // Connection errors show a Retry button via isConnectionError, not isRetryableError.
        viewModel.inputText = "Hello"
        daemonClient.isConnected = false
        viewModel.sendMessage()
        XCTAssertTrue(viewModel.isConnectionError,
                       "Send failure while disconnected should be a connection error")
        XCTAssertFalse(viewModel.isRetryableError,
                        "Connection errors use isConnectionError, not isRetryableError")

        // User dismisses the error
        viewModel.dismissError()
        XCTAssertFalse(viewModel.isRetryableError)
        XCTAssertFalse(viewModel.isConnectionError)

        // Now a non-send error occurs (e.g. confirmation response failure)
        daemonClient.isConnected = true
        viewModel.errorText = "Failed to send confirmation response."
        XCTAssertFalse(viewModel.isRetryableError,
                        "Non-send error should not show retry button")
    }

    func testRetryButtonAppearsOnlySendFailures() {
        viewModel.conversationId = "sess-1"
        daemonClient.isConnected = false

        viewModel.inputText = "Test message"
        viewModel.sendMessage()

        // Connection-error sends use isConnectionError (not isRetryableError).
        XCTAssertTrue(viewModel.isConnectionError,
                       "Send failure while disconnected should be a connection error")
        XCTAssertFalse(viewModel.isRetryableError,
                        "Connection errors should not show Retry button")
        XCTAssertNotNil(viewModel.errorText)
    }

    func testRetryButtonAppearsForNonConnectionSendFailure() {
        viewModel.conversationId = "sess-1"
        daemonClient.isConnected = true
        // Make the send throw to simulate a non-connection send failure
        // (e.g. socket write error while technically connected).
        daemonClient.sendOverride = { _ in throw NSError(domain: "test", code: 1) }

        viewModel.inputText = "Test message"
        viewModel.sendMessage()

        XCTAssertTrue(viewModel.isRetryableError,
                       "Non-connection send failure should show Retry button")
        XCTAssertFalse(viewModel.isConnectionError,
                        "Non-connection send failure should not be a connection error")
        XCTAssertNotNil(viewModel.errorText)
        XCTAssertEqual(viewModel.lastFailedMessageText, "Test message")
    }

    func testRetryButtonNotShownForRegenerateFailure() {
        viewModel.conversationId = "sess-1"
        daemonClient.isConnected = false

        // First, simulate a send failure to cache a message
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertTrue(viewModel.isConnectionError)

        // Now dismiss and reconnect
        viewModel.dismissError()
        daemonClient.isConnected = true

        // Regenerate failure sets errorText but should not trigger retry
        // for the old cached message
        viewModel.regenerateLastMessage()
        // regenerateLastMessage() will fail in the catch block setting errorText
        // but lastFailedSendError is already nil from dismissError()
        XCTAssertFalse(viewModel.isRetryableError,
                        "Regenerate failure should not offer to retry a stale send")
    }

    // MARK: - Retry Queue Bookkeeping

    func testRetryWhileSendingTracksMessageInQueue() {
        viewModel.conversationId = "sess-1"

        // Send message A successfully
        viewModel.inputText = "Message A"
        viewModel.sendMessage()
        XCTAssertTrue(viewModel.isSending)

        // Simulate a send failure for message B (disconnect, then reconnect)
        daemonClient.isConnected = false
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        // Message B is in messages[1] but failed to send
        XCTAssertNotNil(viewModel.lastFailedMessageText)
        XCTAssertEqual(viewModel.messages.count, 2)

        // Reconnect and retry while A is still in progress
        daemonClient.isConnected = true
        viewModel.isSending = true  // A is still in progress
        viewModel.retryLastMessage()

        // The retried message should be tracked in pendingMessageIds
        XCTAssertEqual(viewModel.pendingMessageIds.count, 1,
                        "Retried message should be tracked in pendingMessageIds")
        XCTAssertEqual(viewModel.pendingMessageIds.first, viewModel.messages[1].id,
                        "Pending message ID should match the retried message")

        // The message should have queued status
        if case .queued = viewModel.messages[1].status {
            // expected
        } else {
            XCTFail("Retried message should have queued status when another send is in progress")
        }
    }

    func testRetryWhileSendingRevertsQueuedStatusOnDisconnect() {
        viewModel.conversationId = "sess-1"

        // Send message A successfully
        viewModel.inputText = "Message A"
        viewModel.sendMessage()
        XCTAssertTrue(viewModel.isSending)

        // Send message B which fails (disconnect)
        daemonClient.isConnected = false
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messages.count, 2)

        // Reconnect and retry while A is still in progress
        daemonClient.isConnected = true
        viewModel.isSending = true

        // Now disconnect again so the retry fails at the connectivity check
        daemonClient.isConnected = false
        viewModel.retryLastMessage()

        // The message status should be reverted from .queued back to .sent
        XCTAssertEqual(viewModel.messages[1].status, .sent,
                        "Queued status should be reverted to .sent when retry send fails due to disconnect")
        // pendingMessageIds should be cleaned up
        XCTAssertEqual(viewModel.pendingMessageIds.count, 0,
                        "pendingMessageIds should be cleaned up on retry failure")
    }

    func testRetryWhileSendingRevertsQueuedStatusOnSendThrow() {
        viewModel.conversationId = "sess-1"

        // Send message A successfully
        viewModel.inputText = "Message A"
        viewModel.sendMessage()
        XCTAssertTrue(viewModel.isSending)

        // Send message B which fails (disconnect)
        daemonClient.isConnected = false
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messages.count, 2)

        // Reconnect and retry while A is still in progress, but make send throw
        daemonClient.isConnected = true
        viewModel.isSending = true
        daemonClient.sendOverride = { _ in throw NSError(domain: "test", code: 1) }
        viewModel.retryLastMessage()

        // The message status should be reverted from .queued back to .sent
        XCTAssertEqual(viewModel.messages[1].status, .sent,
                        "Queued status should be reverted to .sent when retry send throws")
        // pendingMessageIds should be cleaned up
        XCTAssertEqual(viewModel.pendingMessageIds.count, 0,
                        "pendingMessageIds should be cleaned up on retry send failure")
    }

    func testRetryWhenNotSendingDoesNotTrackInQueue() {
        viewModel.conversationId = "sess-1"

        // Send a message that fails
        daemonClient.isConnected = false
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertNotNil(viewModel.lastFailedMessageText)

        // Reconnect and retry when NOT sending (no active turn)
        daemonClient.isConnected = true
        viewModel.isSending = false
        viewModel.retryLastMessage()

        // Should not be tracked in pendingMessageIds since it's sent directly
        XCTAssertEqual(viewModel.pendingMessageIds.count, 0,
                        "Retried message should not be tracked when no other send is in progress")
    }

    // MARK: - Confirmation State Reconciliation

    func testToolResultPermissionDeniedDowngradesApprovedConfirmation() {
        viewModel.isSending = true

        // Build an assistant turn with one pending tool call.
        viewModel.handleServerMessage(
            .toolUseStart(
                ToolUseStartMessage(
                    type: "tool_use_start",
                    toolName: "computer_use_click",
                    input: ["x": AnyCodable(100), "y": AnyCodable(200)],
                    sessionId: nil
                )
            )
        )

        var confirmation = ToolConfirmationData(
            requestId: "req-accessibility",
            toolName: "computer_use_click",
            input: ["x": AnyCodable(100), "y": AnyCodable(200)],
            riskLevel: "high",
            diff: nil,
            allowlistOptions: [],
            scopeOptions: [],
            executionTarget: nil,
            persistentDecisionsAllowed: true
        )
        confirmation.state = .approved
        viewModel.messages.append(ChatMessage(role: .assistant, text: "", confirmation: confirmation))

        viewModel.handleServerMessage(
            .toolResult(
                ToolResultMessage(
                    type: "tool_result",
                    toolName: "computer_use_click",
                    result: "Accessibility permission not granted",
                    isError: true,
                    diff: nil,
                    status: nil,
                    sessionId: nil,
                    imageData: nil
                )
            )
        )

        XCTAssertEqual(
            viewModel.messages.last?.confirmation?.state,
            .denied,
            "Permission-denied execution errors should not leave confirmation in approved state"
        )
    }

    func testToolResultNonPermissionErrorKeepsApprovedConfirmation() {
        viewModel.isSending = true

        viewModel.handleServerMessage(
            .toolUseStart(
                ToolUseStartMessage(
                    type: "tool_use_start",
                    toolName: "computer_use_click",
                    input: ["x": AnyCodable(100), "y": AnyCodable(200)],
                    sessionId: nil
                )
            )
        )

        var confirmation = ToolConfirmationData(
            requestId: "req-non-permission",
            toolName: "computer_use_click",
            input: ["x": AnyCodable(100), "y": AnyCodable(200)],
            riskLevel: "high",
            diff: nil,
            allowlistOptions: [],
            scopeOptions: [],
            executionTarget: nil,
            persistentDecisionsAllowed: true
        )
        confirmation.state = .approved
        viewModel.messages.append(ChatMessage(role: .assistant, text: "", confirmation: confirmation))

        viewModel.handleServerMessage(
            .toolResult(
                ToolResultMessage(
                    type: "tool_result",
                    toolName: "computer_use_click",
                    result: "Action failed: target element disappeared",
                    isError: true,
                    diff: nil,
                    status: nil,
                    sessionId: nil,
                    imageData: nil
                )
            )
        )

        XCTAssertEqual(
            viewModel.messages.last?.confirmation?.state,
            .approved,
            "Non-permission failures should preserve the user's approval decision"
        )
    }

    // MARK: - Thinking Indicator During Tool Execution

    func testToolResultRestoresThinkingState() {
        // Simulate agent running: text arrived (clears thinking), then tool runs
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Let me check.")))
        XCTAssertFalse(viewModel.isThinking, "Text delta should clear thinking")

        // Tool starts
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "bash", input: ["command": AnyCodable("ls")], sessionId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Tool chip is visible, thinking should be false")

        // Tool completes — agent is processing the result but isn't "thinking" yet
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "bash", result: "file.txt", isError: nil, diff: nil, status: nil, sessionId: nil, imageData: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should not restore after tool result — tool chip indicates activity")
    }

    func testToolResultDoesNotRestoreThinkingWhenNotSending() {
        // If isSending is false (shouldn't happen normally), don't set thinking
        viewModel.isSending = false
        viewModel.isThinking = false
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "bash", result: "ok", isError: nil, diff: nil, status: nil, sessionId: nil, imageData: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should not restore when not sending")
    }

    func testToolResultDoesNotRestoreThinkingWhenCancelling() {
        viewModel.isSending = true
        viewModel.isCancelling = true
        viewModel.isThinking = false
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "bash", result: "ok", isError: nil, diff: nil, status: nil, sessionId: nil, imageData: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should not restore during cancellation")
    }

    func testToolUseStartClearsThinkingState() {
        viewModel.isThinking = true
        viewModel.isSending = true
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "bash", input: ["command": AnyCodable("ls")], sessionId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Tool use start should clear thinking since tool chip shows activity")
    }

    func testSuppressedToolDoesNotClearThinking() {
        // ui_show is suppressed (no chip rendered), so thinking should NOT be cleared
        viewModel.isThinking = true
        viewModel.isSending = true
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "ui_show", input: [:], sessionId: nil)))
        XCTAssertTrue(viewModel.isThinking, "Suppressed tools should not clear thinking state")
    }

    func testThinkingCycleThroughMultipleTools() {
        // Full cycle: thinking → text → tool1 → result → tool2 → result → complete
        // Thinking should NOT re-appear between tools — only the tool chip shows activity
        viewModel.isSending = true
        viewModel.isThinking = true

        // Agent writes some text
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Working on it.")))
        XCTAssertFalse(viewModel.isThinking)

        // First tool starts
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "bash", input: ["command": AnyCodable("ls")], sessionId: nil)))
        XCTAssertFalse(viewModel.isThinking)

        // First tool completes — no "Thinking" flash between tools
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "bash", result: "files", isError: nil, diff: nil, status: nil, sessionId: nil, imageData: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should not show between tools")

        // Second tool starts
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "file_read", input: ["path": AnyCodable("foo.txt")], sessionId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should stay false when new tool starts")

        // Second tool completes
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "file_read", result: "contents", isError: nil, diff: nil, status: nil, sessionId: nil, imageData: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should not show after second tool")

        // Message completes
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertFalse(viewModel.isThinking, "Thinking should clear on message complete")
        XCTAssertFalse(viewModel.isSending)
    }

    // MARK: - createConversationIfNeeded (Message-less Session Create)

    func testCreateSessionIfNeededSetsBootstrapping() {
        viewModel.createConversationIfNeeded(conversationType: "private")
        XCTAssertFalse(viewModel.isSending, "Message-less session creates should not set isSending")
        XCTAssertFalse(viewModel.isThinking, "Should not show thinking for message-less session create")
        XCTAssertNotNil(viewModel.bootstrapCorrelationId, "Should set correlation ID")
        XCTAssertEqual(viewModel.conversationType, "private")
        XCTAssertTrue(viewModel.isBootstrapping)
    }

    func testCreateSessionIfNeededNoOpWhenSessionExists() {
        viewModel.conversationId = "existing-session"
        viewModel.createConversationIfNeeded(conversationType: "private")
        XCTAssertNil(viewModel.bootstrapCorrelationId, "Should not bootstrap when session already exists")
    }

    func testCreateSessionIfNeededNoOpWhenAlreadyBootstrapping() {
        // Start a normal send which bootstraps
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertTrue(viewModel.isSending)
        let originalCorrelationId = viewModel.bootstrapCorrelationId

        // Calling createConversationIfNeeded should be a no-op
        viewModel.createConversationIfNeeded(conversationType: "private")
        XCTAssertEqual(viewModel.bootstrapCorrelationId, originalCorrelationId, "Should not overwrite existing bootstrap")
    }

    func testCreateSessionIfNeededSessionInfoResetsState() {
        viewModel.createConversationIfNeeded(conversationType: "private")
        let correlationId = viewModel.bootstrapCorrelationId!

        // Simulate daemon responding with session_info
        let info = ConversationInfoMessage(conversationId: "new-session-123", title: "Test", correlationId: correlationId)
        viewModel.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(viewModel.conversationId, "new-session-123")
        XCTAssertFalse(viewModel.isSending, "Should reset isSending for message-less create")
        XCTAssertFalse(viewModel.isThinking, "Should reset isThinking for message-less create")
        XCTAssertNil(viewModel.bootstrapCorrelationId, "Should clear correlation ID")
        XCTAssertFalse(viewModel.isBootstrapping)
    }

    func testCreateSessionIfNeededOnSessionCreatedCallback() {
        var callbackSessionId: String?
        viewModel.onConversationCreated = { sessionId in
            callbackSessionId = sessionId
        }

        viewModel.createConversationIfNeeded(conversationType: "private")
        let correlationId = viewModel.bootstrapCorrelationId!

        let info = ConversationInfoMessage(conversationId: "callback-session", title: "Test", correlationId: correlationId)
        viewModel.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(callbackSessionId, "callback-session", "Should fire onConversationCreated callback")
    }

    func testCreateSessionIfNeededSendsConversationTypeInMessage() {
        var capturedMessages: [Any] = []
        daemonClient.sendOverride = { msg in
            capturedMessages.append(msg)
        }

        viewModel.createConversationIfNeeded(conversationType: "private")

        // Allow the async Task in bootstrapConversation to execute
        let expectation = XCTestExpectation(description: "session_create sent")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        let sessionCreates = capturedMessages.compactMap { $0 as? ConversationCreateMessage }
        XCTAssertEqual(sessionCreates.count, 1, "Should send exactly one session_create")
        XCTAssertEqual(sessionCreates.first?.conversationType, "private", "session_create should include conversationType")
        XCTAssertNotNil(sessionCreates.first?.correlationId, "session_create should include correlationId")
    }

    func testCreateSessionIfNeededWithoutConversationType() {
        viewModel.createConversationIfNeeded()
        XCTAssertFalse(viewModel.isSending, "Message-less session creates should not set isSending")
        XCTAssertNil(viewModel.conversationType, "conversationType should remain nil when not specified")
    }

    func testConversationTypePassedThroughNormalSend() {
        var capturedMessages: [Any] = []
        daemonClient.sendOverride = { msg in
            capturedMessages.append(msg)
        }

        // Set conversationType before sending
        viewModel.conversationType = "private"
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        // Allow the async Task in bootstrapConversation to execute
        let expectation = XCTestExpectation(description: "session_create sent")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        let sessionCreates = capturedMessages.compactMap { $0 as? ConversationCreateMessage }
        XCTAssertEqual(sessionCreates.count, 1)
        XCTAssertEqual(sessionCreates.first?.conversationType, "private", "Normal send should also pass conversationType")
    }

    func testCreateSessionThenSendMessageUsesClaimedSession() {
        // Create session without message
        viewModel.createConversationIfNeeded(conversationType: "private")
        let correlationId = viewModel.bootstrapCorrelationId!

        // Daemon responds with session_info
        let info = ConversationInfoMessage(conversationId: "pre-created-session", title: "Test", correlationId: correlationId)
        viewModel.handleServerMessage(.conversationInfo(info))

        // Now send a message — should go directly via sendUserMessage, not bootstrapConversation
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.conversationId, "pre-created-session", "Should use the pre-created session")
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertEqual(viewModel.messages[0].text, "Hello")
    }

    // MARK: - Send Direct Queued Message

    // MARK: - Streaming State Finalization on messageRequestComplete

    func testMessageRequestCompleteFinalizesAssistantStream() {
        // Simulate inline approval consumption: text delta creates an assistant
        // message, then messageRequestComplete with runStillActive=false should
        // flush the buffer and finalize the streaming state.
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = true

        // Inline approval: queued → dequeued → text delta → request complete
        viewModel.inputText = "approve"
        viewModel.sendMessage()
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-approve", position: 0)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-approve")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Decision applied.")))

        // Flush the buffer so the text lands on the message (simulates timer fire)
        viewModel.flushStreamingBuffer()
        let assistantIdx = viewModel.messages.firstIndex(where: { $0.role == .assistant })!
        XCTAssertTrue(viewModel.messages[assistantIdx].isStreaming, "Should still be streaming before request complete")

        // messageRequestComplete with runStillActive=false should finalize
        viewModel.handleServerMessage(
            .messageRequestComplete(
                MessageRequestCompleteMessage(
                    sessionId: "sess-1",
                    requestId: "req-approve",
                    runStillActive: false
                )
            )
        )

        XCTAssertFalse(viewModel.messages[assistantIdx].isStreaming, "Streaming should be finalized after request complete")
        XCTAssertEqual(viewModel.messages[assistantIdx].text, "Decision applied.")
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
    }

    func testMessageRequestCompletePreservesAgentStreamWhenRunStillActive() {
        // When runStillActive=true, the agent's in-flight streaming message must
        // NOT be finalized — the agent is still producing text deltas.
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = true

        // Agent starts streaming its response
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Working on your request...")))
        viewModel.flushStreamingBuffer()
        let agentMsgIdx = viewModel.messages.firstIndex(where: { $0.role == .assistant })!
        XCTAssertTrue(viewModel.messages[agentMsgIdx].isStreaming)

        // Inline approval arrives mid-stream: queued → dequeued → request complete (no delta)
        viewModel.inputText = "yes"
        viewModel.sendMessage()
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-yes", position: 0)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-yes")))
        viewModel.handleServerMessage(
            .messageRequestComplete(
                MessageRequestCompleteMessage(
                    sessionId: "sess-1",
                    requestId: "req-yes",
                    runStillActive: true
                )
            )
        )

        // The agent's assistant message should still be streaming
        XCTAssertTrue(viewModel.messages[agentMsgIdx].isStreaming,
                       "Agent's streaming message must not be finalized when runStillActive=true")
        XCTAssertTrue(viewModel.isSending, "isSending should remain true while agent is active")
        XCTAssertTrue(viewModel.isThinking, "isThinking should remain true while agent is active")
    }

    // MARK: - Assistant Activity State

    func testAssistantActivityStateTracksConfirmationResolvedAnchor() {
        viewModel.conversationId = "sess-1"
        let activity = AssistantActivityStateMessage(
            type: "assistant_activity_state",
            sessionId: "sess-1",
            activityVersion: 1,
            phase: "thinking",
            anchor: "assistant_turn",
            requestId: nil,
            reason: "confirmation_resolved"
        )

        viewModel.handleServerMessage(.assistantActivityState(activity))

        XCTAssertEqual(viewModel.assistantActivityPhase, "thinking")
        XCTAssertEqual(viewModel.assistantActivityAnchor, "assistant_turn")
        XCTAssertEqual(viewModel.assistantActivityReason, "confirmation_resolved")
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)
    }

    func testAssistantActivityStateIgnoresStaleVersions() {
        viewModel.conversationId = "sess-1"
        let newer = AssistantActivityStateMessage(
            type: "assistant_activity_state",
            sessionId: "sess-1",
            activityVersion: 2,
            phase: "thinking",
            anchor: "assistant_turn",
            requestId: nil,
            reason: "confirmation_resolved"
        )
        let stale = AssistantActivityStateMessage(
            type: "assistant_activity_state",
            sessionId: "sess-1",
            activityVersion: 1,
            phase: "idle",
            anchor: "global",
            requestId: nil,
            reason: "message_complete"
        )

        viewModel.handleServerMessage(.assistantActivityState(newer))
        viewModel.handleServerMessage(.assistantActivityState(stale))

        XCTAssertEqual(viewModel.assistantActivityPhase, "thinking")
        XCTAssertEqual(viewModel.assistantActivityAnchor, "assistant_turn")
        XCTAssertEqual(viewModel.assistantActivityReason, "confirmation_resolved")
    }

    // MARK: - Send Direct Queued Message

    func testSendDirectQueuedMessageSavesContentAndStops() {
        // Set up a session with a sending state and a queued message
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        // Add an assistant message (current generation)
        viewModel.messages.append(ChatMessage(role: .assistant, text: "Working...", isStreaming: true))

        // Add a queued user message
        let queuedId = UUID()
        viewModel.messages.append(ChatMessage(id: queuedId, role: .user, text: "Jump ahead", status: .queued(position: 1)))

        viewModel.sendDirectQueuedMessage(messageId: queuedId)

        // The queued message should be removed from the messages array
        XCTAssertFalse(viewModel.messages.contains(where: { $0.id == queuedId }))

        // Pending send-direct state should be stored
        XCTAssertEqual(viewModel.pendingSendDirectText, "Jump ahead")

        // isCancelling should be set (daemon cancel sent)
        XCTAssertTrue(viewModel.isCancelling)
    }

    func testSendDirectDispatcheAfterGenerationCancelled() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.isCancelling = true

        // Simulate pending send-direct
        viewModel.pendingSendDirectText = "Jump ahead"
        viewModel.pendingSendDirectAttachments = nil

        // Simulate generationCancelled arriving
        let cancelled = GenerationCancelledMessage(sessionId: "sess-1")
        viewModel.handleServerMessage(.generationCancelled(cancelled))

        // After cancellation, the pending text should have been dispatched
        XCTAssertNil(viewModel.pendingSendDirectText)
        // isSending should be true again (sendMessage was called)
        XCTAssertTrue(viewModel.isSending)
        // The dispatched message should appear in messages
        XCTAssertTrue(viewModel.messages.contains(where: { $0.role == .user && $0.text == "Jump ahead" }))
    }

    func testSendDirectDispatchesAfterDisconnectedCancel() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true

        // Add a queued message
        let queuedId = UUID()
        viewModel.messages.append(ChatMessage(id: queuedId, role: .user, text: "Urgent", status: .queued(position: 1)))

        // Disconnect daemon
        daemonClient.isConnected = false

        viewModel.sendDirectQueuedMessage(messageId: queuedId)

        // Disconnected path resets immediately and dispatches
        XCTAssertNil(viewModel.pendingSendDirectText)
        // The dispatched message should be in messages
        XCTAssertTrue(viewModel.messages.contains(where: { $0.role == .user && $0.text == "Urgent" }))
    }

    func testSendDirectIgnoresNonQueuedMessage() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true

        // Add a sent (non-queued) user message
        let sentId = UUID()
        viewModel.messages.append(ChatMessage(id: sentId, role: .user, text: "Already sent", status: .sent))

        viewModel.sendDirectQueuedMessage(messageId: sentId)

        // Should be a no-op — pendingSendDirectText stays nil
        XCTAssertNil(viewModel.pendingSendDirectText)
        // Message should still be there (not removed)
        XCTAssertTrue(viewModel.messages.contains(where: { $0.id == sentId }))
    }

    func testSendDirectIgnoresUnknownMessageId() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true

        viewModel.sendDirectQueuedMessage(messageId: UUID())

        XCTAssertNil(viewModel.pendingSendDirectText)
    }

    // MARK: - Reconnect Streaming Race Regression

    func testReconnectDuringStreamingTriggersHistoryCatchUp() {
        // Simulate an in-progress streaming run: session exists, isSending is
        // true, and currentAssistantMessageId is set (assistant was mid-stream).
        viewModel.conversationId = "sess-reconnect"
        viewModel.isSending = true
        viewModel.currentAssistantMessageId = UUID()

        // Set up the callback to capture the reconnect history request.
        var reconnectSessionId: String?
        let expectation = XCTestExpectation(description: "onReconnectHistoryNeeded called")
        viewModel.onReconnectHistoryNeeded = { sessionId in
            reconnectSessionId = sessionId
            expectation.fulfill()
        }

        // Fire the reconnect notification — the observer clears streaming state
        // immediately and schedules a 500ms-debounced history catch-up.
        NotificationCenter.default.post(name: .daemonDidReconnect, object: nil)

        // Wait for the debounced reconnect handler (500ms) plus margin.
        wait(for: [expectation], timeout: 2.0)

        // The observer should have cleared currentAssistantMessageId immediately
        // and then triggered the catch-up callback after debounce.
        XCTAssertNil(viewModel.currentAssistantMessageId,
                     "Reconnect should clear currentAssistantMessageId")
        XCTAssertEqual(reconnectSessionId, "sess-reconnect",
                       "onReconnectHistoryNeeded should be called with the session ID")
    }

    func testPopulateFromHistoryResetsStreamingState() {
        // Simulate mid-stream state: an assistant message is being built,
        // the delta buffer has accumulated text, and a flush task is scheduled.
        let staleId = UUID()
        viewModel.currentAssistantMessageId = staleId
        viewModel.streamingDeltaBuffer = "partial response text"
        viewModel.streamingFlushTask = Task { @MainActor in
            // Simulate a pending flush — should be cancelled by populateFromHistory.
        }

        // Call populateFromHistory with an empty history payload.
        viewModel.populateFromHistory([], hasMore: false)

        XCTAssertNil(viewModel.currentAssistantMessageId,
                     "populateFromHistory should clear currentAssistantMessageId")
        XCTAssertTrue(viewModel.streamingDeltaBuffer.isEmpty,
                      "populateFromHistory should clear streamingDeltaBuffer")
        XCTAssertNil(viewModel.streamingFlushTask,
                     "populateFromHistory should cancel and nil out streamingFlushTask")
    }

    func testTextDeltaIgnoredDuringHistoryLoad() {
        // Set isLoadingHistory to true to simulate an in-progress history load.
        viewModel.isLoadingHistory = true
        let initialMessageCount = viewModel.messages.count

        // Send a text delta while history is loading — should be dropped.
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "stale delta")))

        XCTAssertTrue(viewModel.streamingDeltaBuffer.isEmpty,
                      "Text deltas should not accumulate in the buffer during history load")
        XCTAssertEqual(viewModel.messages.count, initialMessageCount,
                       "No new messages should be created during history load")
    }

    func testFlushDiscardsStaleBuffer() {
        // Set currentAssistantMessageId to a UUID that doesn't correspond to
        // any message in the messages array (stale reference after a history
        // replacement or reconnect).
        let staleId = UUID()
        viewModel.currentAssistantMessageId = staleId
        viewModel.streamingDeltaBuffer = "orphaned buffer text"
        let initialMessageCount = viewModel.messages.count

        // Flush should detect the stale ID and discard the buffer instead of
        // creating an orphan assistant message.
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, initialMessageCount,
                       "Stale flush should not create a new message")
        XCTAssertNil(viewModel.currentAssistantMessageId,
                     "Stale flush should reset currentAssistantMessageId to nil")
    }
}
