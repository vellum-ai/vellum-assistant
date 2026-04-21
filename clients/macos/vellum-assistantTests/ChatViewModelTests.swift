import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ChatViewModelTests: XCTestCase {

    private var connectionManager: GatewayConnectionManager!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        // Mark as connected so send-path tests don't hit the disconnected guard.
        // Tests that verify disconnected behaviour explicitly set isConnected = false.
        connectionManager.isConnected = true
        viewModel = ChatViewModel(connectionManager: connectionManager, eventStreamClient: connectionManager.eventStreamClient)
    }

    override func tearDown() {
        viewModel = nil
        connectionManager = nil
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
        // When no conversation exists yet (bootstrapping), rapid-fire is blocked
        viewModel.inputText = "First"
        viewModel.sendMessage()

        viewModel.inputText = "Second"
        viewModel.sendMessage() // Should be ignored since isSending is set by bootstrapConversation and conversationId is nil

        XCTAssertEqual(viewModel.messages.count, 1) // first message only
    }

    func testSendWhileSendingWithConversationAppendsMessage() {
        // When a conversation exists, sending while isSending is allowed (daemon queues)
        viewModel.conversationId = "test-conversation"
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

    func testSendUserMessageClearsStuckCompactingFlag() {
        viewModel.conversationId = "conv-1"
        viewModel.isCompacting = true
        viewModel.inputText = "hello"
        viewModel.sendMessage()
        XCTAssertFalse(viewModel.isCompacting,
                       "Sending a user message must clear a stranded compaction indicator (LUM-1062)")
    }

    func testClearingInputRestoresExistingSuggestion() {
        viewModel.suggestion = "Summarize the last response"

        viewModel.inputText = "Something else"
        XCTAssertEqual(viewModel.suggestion, "Summarize the last response")

        viewModel.inputText = ""
        XCTAssertEqual(viewModel.suggestion, "Summarize the last response")
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

    // MARK: - Conversation Info

    func testConversationInfoStoresConversationId() {
        viewModel.bootstrapCorrelationId = "corr-1"
        let info = ConversationInfoMessage(conversationId: "test-123", title: "Test", correlationId: "corr-1")
        viewModel.handleServerMessage(.conversationInfo(info))
        XCTAssertEqual(viewModel.conversationId, "test-123")
    }

    func testConversationInfoDoesNotOverwriteExistingConversation() {
        viewModel.conversationId = "first-conversation"
        let info = ConversationInfoMessage(conversationId: "second-conversation", title: "Test")
        viewModel.handleServerMessage(.conversationInfo(info))
        XCTAssertEqual(viewModel.conversationId, "first-conversation")
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
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: nil)))

        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[0].isStreaming)
    }

    func testGenerationCancelledWithoutStreamingMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: nil)))

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
        // Set up state directly because GatewayConnectionManager.send() throws in tests
        // (no real socket), which prevents sendMessage() from establishing
        // queue bookkeeping.
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.isSending = true
        viewModel.isThinking = true

        // Add user messages directly — tests don't have a real socket, so
        // sendMessage() throws on connectionManager.send() and clears isSending,
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
        // Set up state directly because GatewayConnectionManager.send() throws in tests.
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
        // Set up state directly because GatewayConnectionManager.send() throws in tests.
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
        // Set up state directly because GatewayConnectionManager.send() throws in tests.
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
        // start of its execution. We test without a conversationId so it goes
        // through the bootstrapConversation path (which is async), preventing
        // the synchronous sendUserMessage throw from re-setting errorText.
        viewModel.errorText = "Previous network error"
        viewModel.inputText = "Retry"
        viewModel.sendMessage()
        XCTAssertNil(viewModel.errorText, "Sending a new message should clear previous error")
    }

    func testSendUserMessageWhenDisconnectedShowsErrorAndClearsState() {
        // Baseline: existing behavior when daemon disconnects between turns
        viewModel.conversationId = "test-conversation"
        connectionManager.isConnected = false

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
        viewModel.conversationId = "test-conversation"
        connectionManager.isConnected = false

        viewModel.regenerateLastMessage()

        XCTAssertNotNil(viewModel.errorText, "Regenerate when disconnected should show error")
        XCTAssertTrue(viewModel.errorText?.contains("assistant") == true)
        XCTAssertFalse(viewModel.isSending, "Regenerate should not set isSending when disconnected")
        XCTAssertFalse(viewModel.isThinking)
    }

    func testRegenerateWhileSendingIsBlocked() {
        viewModel.conversationId = "test-conversation"
        viewModel.isSending = true

        viewModel.regenerateLastMessage()

        // Should do nothing — guard blocks it
        XCTAssertNil(viewModel.errorText, "Regenerate while sending should silently do nothing")
    }

    func testRegenerateClearsStaleConversationError() {
        viewModel.conversationId = "sess-1"
        connectionManager.isConnected = true

        // Simulate a stale conversation error from a previous failure
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

        XCTAssertNil(viewModel.conversationError, "Regenerate should clear stale conversation error")
        // errorText is re-set by the catch block because connection is nil
        // in the test environment, but the original stale error must be gone.
        XCTAssertNotEqual(viewModel.errorText, "Stale error",
                          "Regenerate should clear stale error text")
    }

    func testStopGeneratingWhenDisconnectedResetsAllState() {
        // Set up state directly to establish meaningful queue state, since
        // GatewayConnectionManager.send() throws when connection is nil.
        viewModel.conversationId = "test-conversation"
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
        connectionManager.isConnected = false
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
        // Set up as if we're in a streaming conversation
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.conversationId = "test-conversation"
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial response")))

        viewModel.stopGenerating()

        // isSending stays true until daemon acknowledges
        XCTAssertTrue(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[0].isStreaming)

        // Daemon acknowledges cancellation
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: nil)))
        XCTAssertFalse(viewModel.isSending)
    }

    func testStopGeneratingSuppressesLateDeltas() {
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.conversationId = "test-conversation"
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial")))

        viewModel.stopGenerating()

        // Late-arriving delta after stop should be suppressed
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " late text")))

        // Should still only have the original partial text, no new message
        XCTAssertEqual(viewModel.messages.count, 1) // 1 assistant
        XCTAssertEqual(viewModel.messages[0].text, "Partial")

        // Daemon acknowledges cancellation — clears isCancelling
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: nil)))
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
        viewModel.conversationId = "test-conversation"
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
        // Simulate bootstrap: isSending is true but conversationId is nil
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        XCTAssertTrue(viewModel.isSending)
        XCTAssertNil(viewModel.conversationId)

        viewModel.stopGenerating()

        // Should reset immediately since there's no daemon conversation to cancel
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
    }

    func testStopGeneratingWithNoConversationDoesNothing() {
        // Not sending, no conversation
        viewModel.stopGenerating()
        XCTAssertFalse(viewModel.isSending)
    }

    func testStopGeneratingWhenNotSendingDoesNothing() {
        // Has conversation but not sending
        viewModel.conversationId = "test-conversation"
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

        let queued = MessageQueuedMessage(conversationId: "sess-1", requestId: "req-1", position: 1)
        viewModel.handleServerMessage(.messageQueued(queued))

        XCTAssertEqual(viewModel.pendingQueuedCount, 1)
    }

    func testMessageDequeuedDecrementsPendingCount() {
        // Start with some queued
        let queued1 = MessageQueuedMessage(conversationId: "sess-1", requestId: "req-1", position: 1)
        let queued2 = MessageQueuedMessage(conversationId: "sess-1", requestId: "req-2", position: 2)
        viewModel.handleServerMessage(.messageQueued(queued1))
        viewModel.handleServerMessage(.messageQueued(queued2))
        XCTAssertEqual(viewModel.pendingQueuedCount, 2)

        let dequeued = MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-1")
        viewModel.handleServerMessage(.messageDequeued(dequeued))

        XCTAssertEqual(viewModel.pendingQueuedCount, 1)
    }

    func testMessageDequeuedDoesNotGoBelowZero() {
        XCTAssertEqual(viewModel.pendingQueuedCount, 0)

        let dequeued = MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-1")
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
        let queued = MessageQueuedMessage(conversationId: "sess-1", requestId: "req-1", position: 2)
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
        let queued = MessageQueuedMessage(conversationId: "sess-1", requestId: "req-1", position: 1)
        viewModel.handleServerMessage(.messageQueued(queued))

        let dequeued = MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-1")
        viewModel.handleServerMessage(.messageDequeued(dequeued))

        XCTAssertEqual(viewModel.messages[0].status, .processing)
    }

    /// When a queued message is dequeued, it should leave the queue drawer
    /// (`queuedMessages`) immediately — the drawer filters by `.queued` status,
    /// and the dequeue transitions the message to `.processing`.
    func testMessageDequeuedRemovesMessageFromQueuedMessagesDrawer() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        viewModel.handleServerMessage(.messageQueued(
            MessageQueuedMessage(conversationId: "sess-1", requestId: "req-1", position: 0)
        ))
        XCTAssertEqual(viewModel.queuedMessages.count, 1, "Message should be in the queue drawer before dequeue")

        viewModel.handleServerMessage(.messageDequeued(
            MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-1")
        ))
        XCTAssertTrue(viewModel.queuedMessages.isEmpty, "Message should leave the queue drawer after dequeue")
        XCTAssertEqual(viewModel.messages.count, 1, "Message should still be in the transcript")
        XCTAssertEqual(viewModel.messages[0].status, .processing)
    }

    /// Regression test for the reconnect case: when the daemon reconnects, it
    /// clears `requestIdToMessageId` and `pendingMessageIds`, but local queued
    /// messages remain. The next `message_dequeued` event carries a requestId
    /// that no longer has a mapping, so the old fallback left the message
    /// stuck with `.queued` status and it persisted in the queue drawer. The
    /// head-of-queue fallback transitions it to `.processing` instead.
    func testMessageDequeuedClearsQueueDrawerWhenMappingIsMissing() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        viewModel.handleServerMessage(.messageQueued(
            MessageQueuedMessage(conversationId: "sess-1", requestId: "req-1", position: 0)
        ))
        XCTAssertEqual(viewModel.queuedMessages.count, 1)

        // Simulate the reconnect clearing the requestId mapping while leaving
        // the local queued message intact.
        viewModel.requestIdToMessageId.removeAll()
        viewModel.pendingMessageIds.removeAll()

        viewModel.handleServerMessage(.messageDequeued(
            MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-1")
        ))

        XCTAssertTrue(viewModel.queuedMessages.isEmpty, "Queue drawer must clear even when the requestId mapping is missing")
        XCTAssertEqual(viewModel.messages[0].status, .processing, "Head-of-queue message should transition to .processing")
    }

    /// Head-of-queue fallback must pick the lowest-position queued user
    /// message, not simply the first in chronological order.
    func testMessageDequeuedFallbackPicksLowestPositionQueuedMessage() {
        viewModel.conversationId = "sess-1"

        let older = ChatMessage(role: .user, text: "Older msg (higher pos)", status: .queued(position: 1))
        let head = ChatMessage(role: .user, text: "Head of queue", status: .queued(position: 0))
        viewModel.messages = [older, head]

        // No requestId mapping — exercise the fallback branch.
        viewModel.handleServerMessage(.messageDequeued(
            MessageDequeuedMessage(conversationId: "sess-1", requestId: "unmapped-req")
        ))

        let headAfter = viewModel.messages.first { $0.text == "Head of queue" }
        let olderAfter = viewModel.messages.first { $0.text == "Older msg (higher pos)" }
        XCTAssertEqual(headAfter?.status, .processing, "Lowest-position message should be transitioned to .processing")
        if case .queued(let p) = olderAfter?.status {
            XCTAssertEqual(p, 0, "Remaining queued message should have its position decremented")
        } else {
            XCTFail("Remaining message should still be .queued")
        }
    }

    func testMessageDequeuedKeepsMessagePositionInTranscript() {
        viewModel.bootstrapCorrelationId = "test-correlation-id"
        viewModel.handleServerMessage(.conversationInfo(ConversationInfoMessage(conversationId: "sess-1", title: "Chat", correlationId: "test-correlation-id")))
        viewModel.inputText = "Message A"
        viewModel.sendMessage()
        viewModel.inputText = "Message B"
        viewModel.sendMessage()

        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))

        let indexBeforeDequeue = viewModel.messages.firstIndex(where: { $0.text == "Message B" })
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-B")))
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
        let dequeued = MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-2")
        viewModel.handleServerMessage(.messageDequeued(dequeued))

        // isSending and isThinking must be restored so the UI shows
        // the thinking indicator and stop button
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)
    }

    // MARK: - Processing Status Reset

    func testProcessingStatusResetToSentOnMessageComplete() {
        // Set up conversation and send a message while busy (gets queued)
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
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-B", position: 1)))

        // Assistant responds to A, then handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))

        // Daemon dequeues B — status becomes .processing
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-B")))
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

        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-B")))

        let messageBAfterDequeue = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterDequeue.status, .processing)
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)

        viewModel.handleServerMessage(
            .messageRequestComplete(
                MessageRequestCompleteMessage(
                    conversationId: "sess-1",
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

        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-B")))

        viewModel.handleServerMessage(
            .messageRequestComplete(
                MessageRequestCompleteMessage(
                    conversationId: "sess-1",
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
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-B")))
        let messageBAfterDequeue = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterDequeue.status, .processing)

        // User initiates cancel, then server acknowledges
        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: nil)))

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
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-C", position: 2)))

        // A completes via handoff, B is dequeued and becomes processing
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 2)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-B")))
        let messageBAfterDequeue = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBAfterDequeue.status, .processing)

        // B completes via handoff (C is still queued)
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))

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
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))

        XCTAssertTrue(viewModel.isSending, "isSending must stay true during handoff")
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[0].isStreaming, "Streaming message should be finalized")
    }

    func testGenerationHandoffWithoutStreamingMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

        // Handoff without any prior text deltas
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))

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
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))

        // Second text delta should create a NEW assistant message
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Second response")))
        XCTAssertEqual(viewModel.messages.count, 2, "Second delta should create a new message, not append to first")
        XCTAssertEqual(viewModel.messages[0].text, "First response")
        XCTAssertEqual(viewModel.messages[1].text, "Second response")
    }

    func testThreeMessageBurstWithHandoffTransitions() {
        // Set up conversation
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
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-C", position: 2)))
        XCTAssertEqual(viewModel.pendingQueuedCount, 2)
        if case .queued(let pos) = viewModel.messages[1].status {
            XCTAssertEqual(pos, 1)
        } else {
            XCTFail("Message B should be queued")
        }

        // 5. Assistant responds to A, then generation_handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 2)))

        XCTAssertTrue(viewModel.isSending, "isSending stays true after handoff")
        XCTAssertFalse(viewModel.isThinking, "isThinking cleared after handoff")
        // Assistant message for A should be finalized
        XCTAssertFalse(viewModel.messages[3].isStreaming, "First assistant message should be finalized")

        // 6. Daemon dequeues B (status transitions to .processing)
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-B")))
        let messageBStatus = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBStatus.status, .processing, "Message B should be processing")
        XCTAssertTrue(viewModel.isThinking, "isThinking restored after dequeue")
        XCTAssertTrue(viewModel.isSending)
        XCTAssertEqual(viewModel.pendingQueuedCount, 1)

        // 7. Text delta for B, then generation_handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))

        // Second assistant message finalized
        XCTAssertFalse(viewModel.messages[4].isStreaming, "Second assistant message should be finalized")
        XCTAssertTrue(viewModel.isSending, "isSending stays true — C is still queued")

        // 8. Daemon dequeues C (status transitions to .processing)
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-C")))
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
        // Set up viewModel with a conversation
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
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-C", position: 2)))
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

        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 2)))

        // After handoff: isSending stays true, isThinking cleared, streaming finalized
        XCTAssertTrue(viewModel.isSending, "isSending must stay true during handoff")
        XCTAssertFalse(viewModel.isThinking, "isThinking cleared after handoff")
        XCTAssertFalse(viewModel.messages[3].isStreaming, "Assistant message for A should be finalized")

        // B and C remain queued
        XCTAssertEqual(viewModel.pendingQueuedCount, 2)

        // Simulate messageDequeued for B — first queued goes to .processing
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-B")))
        let messageBStatus = viewModel.messages.first(where: { $0.text == "Message B" })!
        XCTAssertEqual(messageBStatus.status, .processing, "Message B should now be processing")
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking, "isThinking restored after dequeue")
        XCTAssertEqual(viewModel.pendingQueuedCount, 1)

        // Assistant responds to B, then another handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(conversationId: "sess-1", requestId: nil, queuedCount: 1)))
        XCTAssertTrue(viewModel.isSending, "isSending stays true — C is still queued")

        // Simulate messageDequeued for C
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-C")))
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

    // MARK: - Conversation Filtering

    func testTextDeltaFromDifferentConversationIsIgnored() {
        viewModel.conversationId = "my-conversation"
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "foreign", conversationId: "other-conversation")))
        // Should still be thinking — delta was ignored
        XCTAssertTrue(viewModel.isThinking)
        XCTAssertEqual(viewModel.messages.count, 0) // No messages
    }

    func testTextDeltaFromSameConversationIsAccepted() {
        viewModel.conversationId = "my-conversation"
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "hello", conversationId: "my-conversation")))
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].text, "hello")
    }

    func testTextDeltaWithNilConversationIdIsAccepted() {
        viewModel.conversationId = "my-conversation"
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "hello", conversationId: nil)))
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertEqual(viewModel.messages.count, 1)
    }

    func testMessageCompleteFromDifferentConversationIsIgnored() {
        viewModel.conversationId = "my-conversation"
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage(conversationId: "other-conversation")))
        // Should still be sending/thinking — message was ignored
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)
    }

    func testMessageCompleteFromSameConversationIsAccepted() {
        viewModel.conversationId = "my-conversation"
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage(conversationId: "my-conversation")))
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
    }

    // MARK: - Disconnected Send Handling

    func testSendUserMessageWhenDisconnectedShowsError() {
        // Set up a conversation but daemon is disconnected
        viewModel.conversationId = "test-conversation"
        connectionManager.isConnected = false

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
        // Simulate a complete conversation: conversation created, text streamed, completed
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

    // MARK: - Conversation Isolation (Correlation ID)

    func testConversationInfoWithWrongCorrelationIdIsIgnored() {
        // Simulate a ChatViewModel that has sent a conversation_create with a correlation ID.
        // A conversation_info with a different correlation ID should be ignored.
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        // At this point the VM is bootstrapping and has a correlationId set internally.
        XCTAssertNil(viewModel.conversationId)
        XCTAssertTrue(viewModel.isSending)

        // A conversation_info from a different ChatViewModel's request (different correlation ID)
        let foreignInfo = ConversationInfoMessage(conversationId: "foreign-conversation", title: "Foreign", correlationId: "wrong-id")
        viewModel.handleServerMessage(.conversationInfo(foreignInfo))

        // Should NOT have claimed the foreign conversation
        XCTAssertNil(viewModel.conversationId, "Should not claim conversation_info with non-matching correlationId")
    }

    func testConversationInfoWithNilCorrelationIdIsIgnoredWhenBootstrapping() {
        // When a ChatViewModel is bootstrapping (has a correlationId), a conversation_info
        // without any correlationId should also be rejected to prevent cross-contamination.
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertNil(viewModel.conversationId)

        // Legacy conversation_info without correlationId
        let legacyInfo = ConversationInfoMessage(conversationId: "legacy-conversation", title: "Legacy")
        viewModel.handleServerMessage(.conversationInfo(legacyInfo))

        // Should NOT have claimed the legacy conversation
        XCTAssertNil(viewModel.conversationId, "Should not claim conversation_info without correlationId when bootstrapping with one")
    }

    func testConversationInfoWithoutCorrelationIdRejectedWhenNoBootstrap() {
        // After removing backwards compat, conversation_info without a correlationId
        // is rejected even when there is no bootstrap correlationId set.
        let info = ConversationInfoMessage(conversationId: "test-conversation", title: "Test")
        viewModel.handleServerMessage(.conversationInfo(info))

        XCTAssertNil(viewModel.conversationId, "Should reject conversation_info when no bootstrapCorrelationId is set")
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
                       "conversation_error should populate errorText for backward compatibility")
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
                      "conversation_error from a different conversation should be ignored")
        XCTAssertNil(viewModel.errorText)
    }

    func testConversationErrorIgnoredBeforeConversationClaimed() {
        // conversationId is nil — no conversation claimed yet
        XCTAssertNil(viewModel.conversationId)

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-other",
            code: .providerNetwork,
            userMessage: "Connection failed",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertNil(viewModel.conversationError,
                      "conversation_error should be ignored before conversation is claimed")
        XCTAssertNil(viewModel.errorText)
    }

    func testConversationErrorFinalizesStreamingMessage() {
        viewModel.conversationId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial")))
        viewModel.flushStreamingBuffer()
        XCTAssertTrue(viewModel.messages[0].isStreaming)

        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .conversationProcessingFailed,
            userMessage: "Processing failed",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertFalse(viewModel.messages[0].isStreaming,
                        "conversation_error should finalize streaming assistant message")
        XCTAssertEqual(viewModel.messages[0].text, "Partial",
                        "Partial text should be preserved")
    }

    func testConversationErrorResetsProcessingMessagesToSent() {
        // Set up state directly because GatewayConnectionManager.send() throws in tests.
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
                        "conversation_error should reset processing messages to .sent")
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
                      "Sending a new message should clear the conversation error")
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

        // Daemon sends conversation error as part of cancellation cleanup
        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-1",
            code: .conversationAborted,
            userMessage: "Conversation aborted",
            retryable: false
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        // Both errorText and conversationError should be suppressed during cancellation
        // (user-initiated cancel should only show generation_cancelled, never a toast)
        XCTAssertNil(viewModel.errorText,
                      "Conversation error during cancellation should not display errorText")
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
                        "Latest conversation_error should replace previous one")
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
        // Regression: conversation errors arrive through handleServerMessage (stream),
        // not through a singleton callback on GatewayConnectionManager.
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
            GenerationCancelledMessage(conversationId: "sess-1")
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
            data: "iVBORw0KGgo=", sourceType: "tool_block", extractedText: nil, sizeBytes: nil, thumbnailData: nil
        )
        viewModel.handleServerMessage(.messageComplete(
            MessageCompleteMessage(conversationId: nil, attachments: [attachment], attachmentWarnings: ["Attachment was sanitized"])
        ))

        XCTAssertEqual(viewModel.messages.count, 1, "Should add attachments to existing message, not create new")
        XCTAssertEqual(viewModel.messages[0].attachments.count, 1)
        XCTAssertEqual(viewModel.messages[0].attachments[0].filename, "photo.png")
        XCTAssertEqual(viewModel.messages[0].attachments[0].id, "att-1")
        XCTAssertEqual(viewModel.messages[0].attachments[0].sourceType, "tool_block")
        XCTAssertEqual(viewModel.messages[0].attachmentWarnings, ["Attachment was sanitized"])
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
            MessageCompleteMessage(conversationId: nil, attachments: [attachment])
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
            GenerationHandoffMessage(
                conversationId: "sess-1",
                requestId: nil,
                queuedCount: 1,
                attachments: [attachment],
                attachmentWarnings: ["Generated attachment is truncated"]
            )
        ))

        XCTAssertEqual(viewModel.messages[0].attachments.count, 1)
        XCTAssertEqual(viewModel.messages[0].attachments[0].filename, "output.csv")
        XCTAssertEqual(viewModel.messages[0].attachmentWarnings, ["Generated attachment is truncated"])
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
            MessageCompleteMessage(conversationId: nil, attachments: [])
        ))

        // Should have no messages — no extra empty assistant message
        XCTAssertEqual(viewModel.messages.count, 0)
    }

    // MARK: - Subagent Abort

    func testAbortSubagentMarksLocalAsAbortedOn404() async throws {
        viewModel.activeSubagents = [
            SubagentInfo(id: "s1", label: "Test", status: .running)
        ]
        let client = FakeSubagentClient(abortResult: .alreadyTerminal) // simulates 404 / already-terminal
        await viewModel.abortSubagent("s1", client: client)
        XCTAssertEqual(viewModel.activeSubagents.first?.status, .aborted)
    }

    func testAbortSubagentMarksLocalAsAbortedOnSuccess() async throws {
        viewModel.activeSubagents = [
            SubagentInfo(id: "s1", label: "Test", status: .running)
        ]
        let client = FakeSubagentClient(abortResult: .success)
        await viewModel.abortSubagent("s1", client: client)
        XCTAssertEqual(viewModel.activeSubagents.first?.status, .aborted)
    }

    func testAbortSubagentDoesNotDowngradeTerminalStatus() async throws {
        viewModel.activeSubagents = [
            SubagentInfo(id: "s1", label: "Test", status: .completed)
        ]
        let client = FakeSubagentClient(abortResult: .alreadyTerminal)
        await viewModel.abortSubagent("s1", client: client)
        // If the daemon already sent `completed`, don't clobber it to `aborted`.
        XCTAssertEqual(viewModel.activeSubagents.first?.status, .completed)
    }

    func testAbortSubagentLeavesRunningOnNetworkFailure() async throws {
        viewModel.activeSubagents = [
            SubagentInfo(id: "s1", label: "Test", status: .running)
        ]
        let client = FakeSubagentClient(abortResult: .failed)
        await viewModel.abortSubagent("s1", client: client)
        // On a genuine failure (network, timeout, 5xx, non-404 client error)
        // the subagent is possibly still running — do NOT flip the local entry
        // to `.aborted`, otherwise the UI hides the Abort button and blocks retry.
        XCTAssertEqual(viewModel.activeSubagents.first?.status, .running)
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

    func testPopulateFromHistoryReconcilesStaleRunningSubagentToTerminal() {
        viewModel.activeSubagents = [
            SubagentInfo(id: "s-stuck", label: "Stuck", status: .running)
        ]
        // Non-empty text required: HistoryReconstructionService.reconstructMessages
        // skips items with empty text/no tool calls/no attachments/no surfaces/no
        // thinking BEFORE reading `subagentNotification`, so an empty-text fixture
        // never reaches the reconcile branch. Real subagent-notification messages
        // from the daemon carry non-empty notification text.
        let historyItems: [HistoryResponseMessage] = [
            HistoryResponseMessage(
                id: nil, role: "assistant", text: "subagent notification", timestamp: 1000,
                toolCalls: nil, toolCallsBeforeText: nil, attachments: nil,
                textSegments: nil, thinkingSegments: nil, contentOrder: nil, surfaces: nil,
                subagentNotification: HistoryResponseMessageSubagentNotification(
                    subagentId: "s-stuck", label: "Stuck", status: "completed",
                    error: nil, conversationId: "sub-conv-1"
                )
            ),
        ]
        viewModel.populateFromHistory(historyItems, hasMore: false)
        XCTAssertEqual(viewModel.activeSubagents.first(where: { $0.id == "s-stuck" })?.status, .completed,
                       "History's terminal status must overwrite a locally-stuck `.running` entry")
        XCTAssertEqual(viewModel.activeSubagents.first(where: { $0.id == "s-stuck" })?.conversationId, "sub-conv-1",
                       "History's conversationId must be propagated onto the reconciled entry so detail lazy-load works")
    }

    func testPopulateFromHistoryDoesNotOverwriteRunningWithRunning() {
        viewModel.activeSubagents = [
            SubagentInfo(id: "s-live", label: "Live", status: .running, parentMessageId: UUID())
        ]
        let originalParentId = viewModel.activeSubagents[0].parentMessageId
        // Non-empty text required: reconstructMessages skips empty-text entries
        // before reading `subagentNotification`.
        let historyItems: [HistoryResponseMessage] = [
            HistoryResponseMessage(
                id: nil, role: "assistant", text: "subagent notification", timestamp: 1000,
                toolCalls: nil, toolCallsBeforeText: nil, attachments: nil,
                textSegments: nil, thinkingSegments: nil, contentOrder: nil, surfaces: nil,
                subagentNotification: HistoryResponseMessageSubagentNotification(
                    subagentId: "s-live", label: "Live", status: "running",
                    error: nil, conversationId: "sub-conv-live"
                )
            ),
        ]
        viewModel.populateFromHistory(historyItems, hasMore: false)
        // Non-terminal history status must not replace the existing entry
        // (preserving `parentMessageId` and the live in-memory copy).
        XCTAssertEqual(viewModel.activeSubagents.first(where: { $0.id == "s-live" })?.status, .running)
        XCTAssertEqual(viewModel.activeSubagents.first(where: { $0.id == "s-live" })?.parentMessageId, originalParentId)
        // conversationId must still be backfilled even though status was not changed —
        // the live `.subagentSpawned` path does not populate it, so history is the
        // only source for it and the detail panel's lazy-load depends on it.
        XCTAssertEqual(viewModel.activeSubagents.first(where: { $0.id == "s-live" })?.conversationId, "sub-conv-live",
                       "conversationId must be backfilled from history even when status is unchanged")
    }

    func testPopulateFromHistoryBackfillsConversationIdOnExistingEntry() {
        // Seed with a locally-completed entry that has no conversationId —
        // the live `.subagentSpawned` path never populates it, so any entry
        // that was born from a live event has conversationId == nil.
        viewModel.activeSubagents = [
            SubagentInfo(id: "s-done", label: "Done", status: .completed)
        ]
        XCTAssertNil(viewModel.activeSubagents.first(where: { $0.id == "s-done" })?.conversationId)
        // Non-empty text required: reconstructMessages skips empty-text entries
        // before reading `subagentNotification`.
        let historyItems: [HistoryResponseMessage] = [
            HistoryResponseMessage(
                id: nil, role: "assistant", text: "subagent notification", timestamp: 1000,
                toolCalls: nil, toolCallsBeforeText: nil, attachments: nil,
                textSegments: nil, thinkingSegments: nil, contentOrder: nil, surfaces: nil,
                subagentNotification: HistoryResponseMessageSubagentNotification(
                    subagentId: "s-done", label: "Done", status: "completed",
                    error: nil, conversationId: "sub-conv-done"
                )
            ),
        ]
        viewModel.populateFromHistory(historyItems, hasMore: false)
        XCTAssertEqual(viewModel.activeSubagents.first(where: { $0.id == "s-done" })?.conversationId, "sub-conv-done",
                       "populateFromHistory must backfill conversationId onto an existing local entry")
    }

    func testPopulateFromHistoryBackfillsParentMessageIdOnExistingEntry() {
        // Seed a local entry that has no parentMessageId — simulates a live
        // spawn event that was lost (or never populated that field), leaving
        // the detail-panel chip with nowhere to anchor.
        viewModel.activeSubagents = [
            SubagentInfo(id: "s-orphan", label: "Orphan", status: .running)
        ]
        XCTAssertNil(viewModel.activeSubagents.first(where: { $0.id == "s-orphan" })?.parentMessageId)

        // History must contain TWO messages:
        //   1. An assistant message with a `subagent_spawn` tool call whose
        //      result JSON includes `subagentId`. `HistoryReconstructionService`
        //      records this message's UUID in `spawnParentMap[subagentId]`.
        //   2. A subsequent assistant message with a matching
        //      `subagentNotification`. The reconstructed `SubagentInfo` picks
        //      up `parentMessageId` from `spawnParentMap`.
        //
        // The first message needs a stable UUID so the test can assert that
        // the local entry's `parentMessageId` matches it post-reconcile.
        let parentId = UUID()
        let spawnToolCall = HistoryResponseToolCall(
            name: "subagent_spawn",
            input: ["task": AnyCodable("do a thing")],
            result: "{\"subagentId\": \"s-orphan\"}",
            isError: nil
        )
        let historyItems: [HistoryResponseMessage] = [
            HistoryResponseMessage(
                id: parentId.uuidString, role: "assistant", text: "spawning subagent",
                timestamp: 1000, toolCalls: [spawnToolCall], toolCallsBeforeText: nil,
                attachments: nil, textSegments: nil, thinkingSegments: nil,
                contentOrder: nil, surfaces: nil, subagentNotification: nil
            ),
            HistoryResponseMessage(
                id: nil, role: "assistant", text: "subagent notification",
                timestamp: 1100, toolCalls: nil, toolCallsBeforeText: nil,
                attachments: nil, textSegments: nil, thinkingSegments: nil,
                contentOrder: nil, surfaces: nil,
                subagentNotification: HistoryResponseMessageSubagentNotification(
                    subagentId: "s-orphan", label: "Orphan", status: "running",
                    error: nil, conversationId: "sub-conv-orphan"
                )
            ),
        ]
        viewModel.populateFromHistory(historyItems, hasMore: false)
        XCTAssertEqual(viewModel.activeSubagents.first(where: { $0.id == "s-orphan" })?.parentMessageId, parentId,
                       "populateFromHistory must backfill parentMessageId onto an existing local entry")
    }

    // MARK: - Interleaved Text/Tool-Call Segments

    func testTextToolTextCreatesInterleavedSegments() {
        // Text delta → tool call → more text delta
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "What are you working on?")))
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "memory_manage", input: ["key": AnyCodable("task")], conversationId: nil)))
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
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "ui_show", input: [:], conversationId: nil)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " after")))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        // ui_show breaks before reaching tool call append code, so no segment boundary
        XCTAssertEqual(msg.textSegments, ["Before after"])
        XCTAssertEqual(msg.contentOrder, [.text(0)])
    }

    func testToolOnlyMessageHasToolCallInContentOrder() {
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "bash", input: ["command": AnyCodable("ls")], conversationId: nil)))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.textSegments, [])
        XCTAssertEqual(msg.contentOrder, [.toolCall(0)])
    }

    func testPopulateFromHistoryUsesTextSegments() {
        let toolCall = HistoryResponseToolCall(name: "memory_manage", input: ["key": AnyCodable("task")], result: "saved", isError: nil)
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
        let toolCall = HistoryResponseToolCall(name: "bash", input: ["command": AnyCodable("ls")], result: "file.txt", isError: nil)
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
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "bash", input: ["command": AnyCodable("ls")], conversationId: nil)))
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "bash", result: "file.txt", isError: nil, diff: nil, status: nil, conversationId: nil)))
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
        connectionManager.isConnected = false
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
        connectionManager.isConnected = true
        viewModel.errorText = "Failed to send confirmation response."
        XCTAssertFalse(viewModel.isRetryableError,
                        "Non-send error should not show retry button")
    }

    func testRetryButtonAppearsOnlySendFailures() {
        viewModel.conversationId = "sess-1"
        connectionManager.isConnected = false

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
        connectionManager.isConnected = true
        // TODO: sendUserMessage is now fire-and-forget; this test needs rework
        // to simulate a non-connection send failure via the HTTP transport layer.

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
        connectionManager.isConnected = false

        // First, simulate a send failure to cache a message
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertTrue(viewModel.isConnectionError)

        // Now dismiss and reconnect
        viewModel.dismissError()
        connectionManager.isConnected = true

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
        connectionManager.isConnected = false
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        // Message B is in messages[1] but failed to send
        XCTAssertNotNil(viewModel.lastFailedMessageText)
        XCTAssertEqual(viewModel.messages.count, 2)

        // Reconnect and retry while A is still in progress
        connectionManager.isConnected = true
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
        connectionManager.isConnected = false
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messages.count, 2)

        // Reconnect and retry while A is still in progress
        connectionManager.isConnected = true
        viewModel.isSending = true

        // Now disconnect again so the retry fails at the connectivity check
        connectionManager.isConnected = false
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
        connectionManager.isConnected = false
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messages.count, 2)

        // Reconnect and retry while A is still in progress, but make send throw
        connectionManager.isConnected = true
        viewModel.isSending = true
        // TODO: sendUserMessage is now fire-and-forget; retry-send-failure path needs rework
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
        connectionManager.isConnected = false
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertNotNil(viewModel.lastFailedMessageText)

        // Reconnect and retry when NOT sending (no active turn)
        connectionManager.isConnected = true
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
                    conversationId: nil
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
                    conversationId: nil
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
                    conversationId: nil
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
                    conversationId: nil
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
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "bash", input: ["command": AnyCodable("ls")], conversationId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Tool chip is visible, thinking should be false")

        // Tool completes — agent is processing the result but isn't "thinking" yet
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "bash", result: "file.txt", isError: nil, diff: nil, status: nil, conversationId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should not restore after tool result — tool chip indicates activity")
    }

    func testToolResultDoesNotRestoreThinkingWhenNotSending() {
        // If isSending is false (shouldn't happen normally), don't set thinking
        viewModel.isSending = false
        viewModel.isThinking = false
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "bash", result: "ok", isError: nil, diff: nil, status: nil, conversationId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should not restore when not sending")
    }

    func testToolResultDoesNotRestoreThinkingWhenCancelling() {
        viewModel.isSending = true
        viewModel.isCancelling = true
        viewModel.isThinking = false
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "bash", result: "ok", isError: nil, diff: nil, status: nil, conversationId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should not restore during cancellation")
    }

    func testToolUseStartClearsThinkingState() {
        viewModel.isThinking = true
        viewModel.isSending = true
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "bash", input: ["command": AnyCodable("ls")], conversationId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Tool use start should clear thinking since tool chip shows activity")
    }

    func testSuppressedToolDoesNotClearThinking() {
        // ui_show is suppressed (no chip rendered), so thinking should NOT be cleared
        viewModel.isThinking = true
        viewModel.isSending = true
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "ui_show", input: [:], conversationId: nil)))
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
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "bash", input: ["command": AnyCodable("ls")], conversationId: nil)))
        XCTAssertFalse(viewModel.isThinking)

        // First tool completes — no "Thinking" flash between tools
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "bash", result: "files", isError: nil, diff: nil, status: nil, conversationId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should not show between tools")

        // Second tool starts
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(type: "tool_use_start", toolName: "file_read", input: ["path": AnyCodable("foo.txt")], conversationId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should stay false when new tool starts")

        // Second tool completes
        viewModel.handleServerMessage(.toolResult(ToolResultMessage(type: "tool_result", toolName: "file_read", result: "contents", isError: nil, diff: nil, status: nil, conversationId: nil)))
        XCTAssertFalse(viewModel.isThinking, "Thinking should not show after second tool")

        // Message completes
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertFalse(viewModel.isThinking, "Thinking should clear on message complete")
        XCTAssertFalse(viewModel.isSending)
    }

    // MARK: - createConversationIfNeeded (Message-less Conversation Create)

    func testCreateConversationIfNeededSetsBootstrapping() {
        viewModel.createConversationIfNeeded(conversationType: "private")
        XCTAssertFalse(viewModel.isSending, "Message-less conversation creates should not set isSending")
        XCTAssertFalse(viewModel.isThinking, "Should not show thinking for message-less conversation create")
        XCTAssertNotNil(viewModel.bootstrapCorrelationId, "Should set correlation ID")
        XCTAssertEqual(viewModel.conversationType, "private")
        XCTAssertTrue(viewModel.isBootstrapping)
    }

    func testCreateConversationIfNeededNoOpWhenConversationExists() {
        viewModel.conversationId = "existing-conversation"
        viewModel.createConversationIfNeeded(conversationType: "private")
        XCTAssertNil(viewModel.bootstrapCorrelationId, "Should not bootstrap when conversation already exists")
    }

    func testCreateConversationIfNeededNoOpWhenAlreadyBootstrapping() {
        // Start a normal send which bootstraps
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertTrue(viewModel.isSending)
        let originalCorrelationId = viewModel.bootstrapCorrelationId

        // Calling createConversationIfNeeded should be a no-op
        viewModel.createConversationIfNeeded(conversationType: "private")
        XCTAssertEqual(viewModel.bootstrapCorrelationId, originalCorrelationId, "Should not overwrite existing bootstrap")
    }

    func testCreateConversationIfNeededConversationInfoResetsState() {
        viewModel.createConversationIfNeeded(conversationType: "private")
        let correlationId = viewModel.bootstrapCorrelationId!

        // Simulate daemon responding with conversation_info
        let info = ConversationInfoMessage(conversationId: "new-conversation-123", title: "Test", correlationId: correlationId)
        viewModel.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(viewModel.conversationId, "new-conversation-123")
        XCTAssertFalse(viewModel.isSending, "Should reset isSending for message-less create")
        XCTAssertFalse(viewModel.isThinking, "Should reset isThinking for message-less create")
        XCTAssertNil(viewModel.bootstrapCorrelationId, "Should clear correlation ID")
        XCTAssertFalse(viewModel.isBootstrapping)
    }

    func testCreateConversationIfNeededOnConversationCreatedCallback() {
        var callbackConversationId: String?
        viewModel.onConversationCreated = { conversationId in
            callbackConversationId = conversationId
        }

        viewModel.createConversationIfNeeded(conversationType: "private")
        let correlationId = viewModel.bootstrapCorrelationId!

        let info = ConversationInfoMessage(conversationId: "callback-conversation", title: "Test", correlationId: correlationId)
        viewModel.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(callbackConversationId, "callback-conversation", "Should fire onConversationCreated callback")
    }

    func testCreateConversationIfNeededSendsConversationTypeInMessage() {
        viewModel.createConversationIfNeeded(conversationType: "private")

        // Verify the viewModel state was set correctly for the bootstrap
        XCTAssertTrue(viewModel.isBootstrapping, "Should be bootstrapping a conversation")
        XCTAssertEqual(viewModel.conversationType, "private", "conversationType should be set to private")
        XCTAssertNotNil(viewModel.bootstrapCorrelationId, "bootstrapCorrelationId should be set")
    }

    func testCreateConversationIfNeededWithoutConversationType() {
        viewModel.createConversationIfNeeded()
        XCTAssertFalse(viewModel.isSending, "Message-less conversation creates should not set isSending")
        XCTAssertNil(viewModel.conversationType, "conversationType should remain nil when not specified")
    }

    func testConversationTypePassedThroughNormalSend() {
        // Set conversationType before sending
        viewModel.conversationType = "private"
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        // Verify the viewModel bootstrapped with the correct conversationType
        XCTAssertTrue(viewModel.isBootstrapping, "Should be bootstrapping a conversation")
        XCTAssertEqual(viewModel.conversationType, "private", "Normal send should also pass conversationType")
        XCTAssertNotNil(viewModel.bootstrapCorrelationId, "bootstrapCorrelationId should be set")
    }

    func testCreateConversationThenSendMessageUsesClaimedConversation() {
        // Create conversation without message
        viewModel.createConversationIfNeeded(conversationType: "private")
        let correlationId = viewModel.bootstrapCorrelationId!

        // Daemon responds with conversation_info
        let info = ConversationInfoMessage(conversationId: "pre-created-conversation", title: "Test", correlationId: correlationId)
        viewModel.handleServerMessage(.conversationInfo(info))

        // Now send a message — should go directly via sendUserMessage, not bootstrapConversation
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.conversationId, "pre-created-conversation", "Should use the pre-created conversation")
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
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-approve", position: 0)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-approve")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Decision applied.")))

        // Flush the buffer so the text lands on the message (simulates timer fire)
        viewModel.flushStreamingBuffer()
        let assistantIdx = viewModel.messages.firstIndex(where: { $0.role == .assistant })!
        XCTAssertTrue(viewModel.messages[assistantIdx].isStreaming, "Should still be streaming before request complete")

        // messageRequestComplete with runStillActive=false should finalize
        viewModel.handleServerMessage(
            .messageRequestComplete(
                MessageRequestCompleteMessage(
                    conversationId: "sess-1",
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
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(conversationId: "sess-1", requestId: "req-yes", position: 0)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(conversationId: "sess-1", requestId: "req-yes")))
        viewModel.handleServerMessage(
            .messageRequestComplete(
                MessageRequestCompleteMessage(
                    conversationId: "sess-1",
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
            conversationId: "sess-1",
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
            conversationId: "sess-1",
            activityVersion: 2,
            phase: "thinking",
            anchor: "assistant_turn",
            requestId: nil,
            reason: "confirmation_resolved"
        )
        let stale = AssistantActivityStateMessage(
            type: "assistant_activity_state",
            conversationId: "sess-1",
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
        // Set up a conversation with a sending state and a queued message
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
        let cancelled = GenerationCancelledMessage(conversationId: "sess-1")
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
        connectionManager.isConnected = false

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
        // Simulate an in-progress streaming run: conversation exists, isSending is
        // true, and currentAssistantMessageId is set (assistant was mid-stream).
        viewModel.conversationId = "sess-reconnect"
        viewModel.isSending = true
        viewModel.currentAssistantMessageId = UUID()

        // Set up the callback to capture the reconnect history request.
        var reconnectConversationId: String?
        let expectation = XCTestExpectation(description: "onReconnectHistoryNeeded called")
        viewModel.onReconnectHistoryNeeded = { conversationId in
            reconnectConversationId = conversationId
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
        XCTAssertEqual(reconnectConversationId, "sess-reconnect",
                       "onReconnectHistoryNeeded should be called with the conversation ID")
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

    // MARK: - Buffered Text Before Finalize Invariant

    func testMessageCompleteFlushesBufferedText() {
        // Buffered text in streamingDeltaBuffer must appear in the final
        // message when messageComplete arrives.
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Hello ")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "world")))
        // Don't manually flush — messageComplete should flush internally.
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].text, "Hello world",
                       "messageComplete should flush all buffered text")
        XCTAssertFalse(viewModel.messages[0].isStreaming,
                       "Message should no longer be streaming after messageComplete")
    }

    func testToolUseStartFlushesBufferedTextBeforeChip() {
        // Buffered text must be flushed before the tool call chip so that
        // text appears before the chip in contentOrder.
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Searching...")))
        // Don't manually flush — toolUseStart should flush internally.
        viewModel.handleServerMessage(.toolUseStart(ToolUseStartMessage(
            type: "tool_use_start",
            toolName: "bash",
            input: ["command": AnyCodable("ls")],
            conversationId: nil
        )))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.textSegments, ["Searching..."],
                       "Buffered text should be flushed before tool call chip")
        XCTAssertEqual(msg.toolCalls.count, 1)
        // Text must come before tool call in content order.
        XCTAssertEqual(msg.contentOrder, [.text(0), .toolCall(0)],
                       "Text should appear before tool call in contentOrder")
    }

    func testToolUsePreviewStartFlushesBufferedTextBeforeChip() {
        // Buffered text must be flushed before the preview chip so that
        // text appears before the chip in contentOrder.
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Let me check...")))
        // Don't manually flush — toolUsePreviewStart should flush internally.
        viewModel.handleServerMessage(.toolUsePreviewStart(ToolUsePreviewStartMessage(
            type: "tool_use_preview_start",
            toolUseId: "tu-1",
            toolName: "bash",
            conversationId: nil
        )))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.textSegments, ["Let me check..."],
                       "Buffered text should be flushed before preview chip")
        XCTAssertEqual(msg.toolCalls.count, 1)
        XCTAssertEqual(msg.contentOrder, [.text(0), .toolCall(0)],
                       "Text should appear before preview chip in contentOrder")
    }

    func testUiSurfaceShowFlushesBufferedTextBeforeSurface() {
        // Buffered text must be flushed before the inline surface so that
        // text appears before the surface in contentOrder.
        viewModel.conversationId = "sess-surface"
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Here is the result:")))
        // Don't manually flush — uiSurfaceShow should flush internally.
        let surfaceMsg = UiSurfaceShowMessage(
            conversationId: "sess-surface",
            surfaceId: "surface-flush-test",
            surfaceType: "card",
            title: "Test Card",
            data: AnyCodable(["title": "Test Card", "body": "Card body"]),
            actions: nil,
            display: "inline",
            messageId: nil
        )
        viewModel.handleServerMessage(.uiSurfaceShow(surfaceMsg))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.textSegments, ["Here is the result:"],
                       "Buffered text should be flushed before inline surface")
        XCTAssertEqual(msg.inlineSurfaces.count, 1)
        // Text must come before surface in content order.
        XCTAssertTrue(msg.contentOrder.contains(.text(0)),
                      "Content order should include text segment")
        XCTAssertTrue(msg.contentOrder.contains(.surface(0)),
                      "Content order should include surface")
        guard let textIdx = msg.contentOrder.firstIndex(of: .text(0)),
              let surfIdx = msg.contentOrder.firstIndex(of: .surface(0)) else {
            XCTFail("Expected both text and surface in contentOrder")
            return
        }
        XCTAssertTrue(textIdx < surfIdx,
                      "Text should appear before surface in contentOrder")
    }

    func testConversationErrorPreservesBufferedText() {
        // Buffered text must be preserved in the assistant message when an
        // error arrives mid-stream.
        viewModel.conversationId = "sess-err"
        viewModel.isSending = true
        viewModel.isThinking = true
        // Suppress the inline error message so the test stays focused on
        // verifying buffered text preservation, not error message creation.
        viewModel.shouldCreateInlineErrorMessage = { _ in false }

        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial response")))
        // Don't manually flush — conversationError should flush internally.
        let errorMsg = ConversationErrorMessage(
            conversationId: "sess-err",
            code: .conversationProcessingFailed,
            userMessage: "Something went wrong",
            retryable: true
        )
        viewModel.handleServerMessage(.conversationError(errorMsg))

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].text, "Partial response",
                       "Buffered text should be preserved when error arrives mid-stream")
        XCTAssertFalse(viewModel.messages[0].isStreaming,
                       "Message should no longer be streaming after error")
    }

    // MARK: - Full-Chunk Flush Regression

    func testFlushStreamingBufferAppendsFullChunkNotSubdivisions() {
        // Regression test: flushStreamingBuffer must append the entire
        // streamingDeltaBuffer in a single appendTextToCurrentMessage call,
        // producing one contiguous text segment — NOT artificial 3-char
        // subdivisions from the removed typewriter drip queue.

        // Simulate several assistantTextDelta events that accumulate in
        // the buffer without any intermediate flush (e.g., rapid deltas
        // arriving within the throttle window).
        let deltas = ["Here ", "is ", "a ", "longer ", "piece ", "of ", "markdown: ", "**bold** and `code`."]
        for delta in deltas {
            // Directly buffer like the delta handler does, bypassing the
            // scheduled flush timer so nothing drains mid-test.
            viewModel.streamingDeltaBuffer += delta
        }

        // Ensure an assistant message exists for the flush to target.
        let msg = ChatMessage(role: .assistant, text: "", isStreaming: true)
        viewModel.currentAssistantMessageId = msg.id
        viewModel.messages.append(msg)

        // Act: flush the entire buffer in one shot.
        viewModel.flushStreamingBuffer()

        // Assert: the message should contain exactly one text segment with
        // the full concatenated buffer — no 3-char splits.
        let expectedText = deltas.joined()
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].textSegments.count, 1,
                       "Flush should produce exactly one text segment, not multiple subdivisions")
        XCTAssertEqual(viewModel.messages[0].textSegments.first, expectedText,
                       "The single text segment should contain all buffered text")
        XCTAssertTrue(viewModel.streamingDeltaBuffer.isEmpty,
                      "Buffer should be empty after flush")
    }

    // MARK: - Queue Helpers: queuedMessages, tailQueuedMessageId, editQueuedTail

    func test_queuedMessages_filtersUserRoleAndSortsByPosition() {
        // Mix of user / assistant / sent / queued messages — ensure queuedMessages
        // returns only user messages with .queued status, sorted by position.
        let assistantQueued = ChatMessage(role: .assistant, text: "Assistant reply", status: .queued(position: 0))
        let sentUser = ChatMessage(role: .user, text: "Already sent", status: .sent)
        let queuedLater = ChatMessage(role: .user, text: "Third in queue", status: .queued(position: 2))
        let queuedFirst = ChatMessage(role: .user, text: "First in queue", status: .queued(position: 0))
        let queuedMiddle = ChatMessage(role: .user, text: "Second in queue", status: .queued(position: 1))

        viewModel.messages = [assistantQueued, sentUser, queuedLater, queuedFirst, queuedMiddle]

        let result = viewModel.queuedMessages
        XCTAssertEqual(result.count, 3, "Only user-role queued messages should be returned")
        XCTAssertEqual(result.map(\.text), ["First in queue", "Second in queue", "Third in queue"],
                       "Queued messages should be sorted by position ascending")
        XCTAssertTrue(result.allSatisfy { $0.role == .user }, "All returned messages should be user-role")
    }

    func test_tailQueuedMessageId_returnsHighestPositionId() {
        let p0 = ChatMessage(role: .user, text: "m0", status: .queued(position: 0))
        let p1 = ChatMessage(role: .user, text: "m1", status: .queued(position: 1))
        let p2 = ChatMessage(role: .user, text: "m2", status: .queued(position: 2))
        viewModel.messages = [p0, p1, p2]

        XCTAssertEqual(viewModel.tailQueuedMessageId, p2.id,
                       "Tail should be the queued user message with the highest position")

        // And nil when no messages are queued.
        viewModel.messages = [
            ChatMessage(role: .user, text: "Sent", status: .sent),
            ChatMessage(role: .assistant, text: "Reply", status: .sent)
        ]
        XCTAssertNil(viewModel.tailQueuedMessageId,
                     "Tail should be nil when no queued user messages exist")
    }

    func test_tailQueuedMessageId_prefersNewestOnPositionTie() {
        // Repro for Codex P1 feedback on #25289: before `message_queued` acks
        // arrive, multiple queued messages all live at position 0. The tail
        // should be the most recently added (last in chronological order), not
        // the first.
        let first = ChatMessage(role: .user, text: "first", status: .queued(position: 0))
        let second = ChatMessage(role: .user, text: "second", status: .queued(position: 0))
        let third = ChatMessage(role: .user, text: "third", status: .queued(position: 0))
        viewModel.messages = [first, second, third]

        XCTAssertEqual(viewModel.tailQueuedMessageId, third.id,
                       "On a position-0 tie, tail should be the most recently added message")
    }

    func test_editQueuedTail_operatesOnNewestWhenPositionsTie() async {
        // When multiple messages are queued pre-ack (all at position 0),
        // editQueuedTail must pop the NEWEST, not the oldest.
        let mockQueueClient = MockConversationQueueClient()
        mockQueueClient.deleteResult = true

        let connection = GatewayConnectionManager()
        connection.isConnected = true
        let vm = ChatViewModel(
            connectionManager: connection,
            eventStreamClient: connection.eventStreamClient,
            conversationQueueClient: mockQueueClient
        )
        vm.conversationId = "sess-tie"

        let oldest = ChatMessage(role: .user, text: "oldest", status: .queued(position: 0))
        let middle = ChatMessage(role: .user, text: "middle", status: .queued(position: 0))
        let newest = ChatMessage(role: .user, text: "newest", status: .queued(position: 0))
        vm.messages = [oldest, middle, newest]
        vm.requestIdToMessageId = [
            "req-oldest": oldest.id,
            "req-middle": middle.id,
            "req-newest": newest.id
        ]
        vm.pendingQueuedCount = 3

        var composerText = ""
        var composerAttachments: [ChatAttachment] = []
        let textBinding = Binding<String>(
            get: { composerText },
            set: { composerText = $0 }
        )
        let attachmentsBinding = Binding<[ChatAttachment]>(
            get: { composerAttachments },
            set: { composerAttachments = $0 }
        )

        vm.editQueuedTail(into: textBinding, attachments: attachmentsBinding)

        XCTAssertEqual(composerText, "newest",
                       "Composer should receive the newest queued message's text, not the oldest")

        let deadline = ContinuousClock.now + .seconds(2)
        while mockQueueClient.calls.isEmpty && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertEqual(mockQueueClient.calls.count, 1)
        XCTAssertEqual(mockQueueClient.calls.first?.requestId, "req-newest",
                       "delete_queued_message should target the newest queued message on ties")
    }

    func test_editQueuedTail_copiesContentAndDeletesOriginal() async {
        let mockQueueClient = MockConversationQueueClient()
        mockQueueClient.deleteResult = true

        let connection = GatewayConnectionManager()
        connection.isConnected = true
        let vm = ChatViewModel(
            connectionManager: connection,
            eventStreamClient: connection.eventStreamClient,
            conversationQueueClient: mockQueueClient
        )
        vm.conversationId = "sess-edit-tail"

        // Seed tail queued message with text + one attachment, mapped to a requestId.
        let attachment = ChatAttachment(
            id: "att-1",
            filename: "note.txt",
            mimeType: "text/plain",
            data: "ZGF0YQ==",
            thumbnailData: nil,
            dataLength: 8,
            thumbnailImage: nil
        )
        let head = ChatMessage(role: .user, text: "First queued", status: .queued(position: 0))
        var tail = ChatMessage(role: .user, text: "Tail content", status: .queued(position: 1))
        tail.attachments = [attachment]
        vm.messages = [head, tail]
        vm.requestIdToMessageId = ["req-tail": tail.id]
        vm.pendingQueuedCount = 2

        // Bindings the composer would pass.
        var composerText = ""
        var composerAttachments: [ChatAttachment] = []
        let textBinding = Binding<String>(
            get: { composerText },
            set: { composerText = $0 }
        )
        let attachmentsBinding = Binding<[ChatAttachment]>(
            get: { composerAttachments },
            set: { composerAttachments = $0 }
        )

        vm.editQueuedTail(into: textBinding, attachments: attachmentsBinding)

        XCTAssertEqual(composerText, "Tail content",
                       "Composer text binding should receive the tail message text")
        XCTAssertEqual(composerAttachments.count, 1)
        XCTAssertEqual(composerAttachments.first?.id, attachment.id,
                       "Composer attachments binding should receive the tail message attachments")

        // Wait for the async deleteQueuedMessage Task to dispatch the delete call.
        let deadline = ContinuousClock.now + .seconds(2)
        while mockQueueClient.calls.isEmpty && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertEqual(mockQueueClient.calls.count, 1,
                       "editQueuedTail should dispatch exactly one delete_queued_message call")
        XCTAssertEqual(mockQueueClient.calls.first?.conversationId, "sess-edit-tail")
        XCTAssertEqual(mockQueueClient.calls.first?.requestId, "req-tail")
    }

    func test_editQueuedTail_isNoOpWhenNoQueue() async {
        let mockQueueClient = MockConversationQueueClient()
        let connection = GatewayConnectionManager()
        connection.isConnected = true
        let vm = ChatViewModel(
            connectionManager: connection,
            eventStreamClient: connection.eventStreamClient,
            conversationQueueClient: mockQueueClient
        )
        vm.conversationId = "sess-empty"
        vm.messages = [
            ChatMessage(role: .user, text: "Hello", status: .sent),
            ChatMessage(role: .assistant, text: "Hi", status: .sent)
        ]

        var composerText = "unchanged"
        var composerAttachments: [ChatAttachment] = []
        let textBinding = Binding<String>(
            get: { composerText },
            set: { composerText = $0 }
        )
        let attachmentsBinding = Binding<[ChatAttachment]>(
            get: { composerAttachments },
            set: { composerAttachments = $0 }
        )

        vm.editQueuedTail(into: textBinding, attachments: attachmentsBinding)

        // Give any spurious Task a chance to run before asserting no call was made.
        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(composerText, "unchanged", "Text binding should not be modified when queue is empty")
        XCTAssertTrue(composerAttachments.isEmpty, "Attachments binding should not be modified when queue is empty")
        XCTAssertTrue(mockQueueClient.calls.isEmpty, "No delete_queued_message call should be dispatched")
    }

    func test_editQueuedTail_whenComposerNonEmpty_isNoOp() async {
        // Regression guard for the one-click composer-clobber bug: clicking the
        // pencil with an in-progress draft must not overwrite text or
        // attachments, and must not dispatch a delete_queued_message.
        let mockQueueClient = MockConversationQueueClient()
        mockQueueClient.deleteResult = true

        let connection = GatewayConnectionManager()
        connection.isConnected = true
        let vm = ChatViewModel(
            connectionManager: connection,
            eventStreamClient: connection.eventStreamClient,
            conversationQueueClient: mockQueueClient
        )
        vm.conversationId = "sess-guard"

        let queuedAttachment = ChatAttachment(
            id: "queued-att",
            filename: "queued.txt",
            mimeType: "text/plain",
            data: "cXVldWVk",
            thumbnailData: nil,
            dataLength: 6,
            thumbnailImage: nil
        )
        var tail = ChatMessage(role: .user, text: "Tail content", status: .queued(position: 0))
        tail.attachments = [queuedAttachment]
        vm.messages = [tail]
        vm.requestIdToMessageId = ["req-tail": tail.id]
        vm.pendingQueuedCount = 1

        let draftAttachment = ChatAttachment(
            id: "draft-att",
            filename: "draft.txt",
            mimeType: "text/plain",
            data: "ZHJhZnQ=",
            thumbnailData: nil,
            dataLength: 5,
            thumbnailImage: nil
        )

        // Case A: composer has text only.
        var composerText = "in-progress draft"
        var composerAttachments: [ChatAttachment] = []
        var textBinding = Binding<String>(
            get: { composerText },
            set: { composerText = $0 }
        )
        var attachmentsBinding = Binding<[ChatAttachment]>(
            get: { composerAttachments },
            set: { composerAttachments = $0 }
        )

        vm.editQueuedTail(into: textBinding, attachments: attachmentsBinding)

        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(composerText, "in-progress draft",
                       "Composer text must not be overwritten when a draft is present")
        XCTAssertTrue(composerAttachments.isEmpty,
                      "Attachments binding must not be populated when composer has draft text")
        XCTAssertTrue(mockQueueClient.calls.isEmpty,
                      "No delete_queued_message must be dispatched while composer has content")

        // Case B: composer has attachments only (no text).
        composerText = ""
        composerAttachments = [draftAttachment]
        textBinding = Binding<String>(
            get: { composerText },
            set: { composerText = $0 }
        )
        attachmentsBinding = Binding<[ChatAttachment]>(
            get: { composerAttachments },
            set: { composerAttachments = $0 }
        )

        vm.editQueuedTail(into: textBinding, attachments: attachmentsBinding)

        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(composerText, "",
                       "Composer text must remain empty when only attachments are staged")
        XCTAssertEqual(composerAttachments.count, 1)
        XCTAssertEqual(composerAttachments.first?.id, "draft-att",
                       "Staged attachment must not be overwritten by the queued attachment")
        XCTAssertTrue(mockQueueClient.calls.isEmpty,
                      "No delete_queued_message must be dispatched while composer has attachments")

        // Case C: composer has whitespace-only text — still treated as empty,
        // so the guard should permit the overwrite.
        composerText = "   \n  "
        composerAttachments = []
        textBinding = Binding<String>(
            get: { composerText },
            set: { composerText = $0 }
        )
        attachmentsBinding = Binding<[ChatAttachment]>(
            get: { composerAttachments },
            set: { composerAttachments = $0 }
        )

        vm.editQueuedTail(into: textBinding, attachments: attachmentsBinding)

        let deadline = ContinuousClock.now + .seconds(2)
        while mockQueueClient.calls.isEmpty && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertEqual(composerText, "Tail content",
                       "Whitespace-only composer should be treated as empty and accept the overwrite")
        XCTAssertEqual(composerAttachments.count, 1)
        XCTAssertEqual(composerAttachments.first?.id, "queued-att")
        XCTAssertEqual(mockQueueClient.calls.count, 1,
                       "Whitespace-only composer should permit the delete_queued_message dispatch")
    }
}

// MARK: - Mock Queue Client

/// Mock `ConversationQueueClientProtocol` used by queue-drawer tests to record
/// delete_queued_message dispatches without hitting the network.
final class MockConversationQueueClient: ConversationQueueClientProtocol, @unchecked Sendable {
    struct Call: Equatable {
        let conversationId: String
        let requestId: String
    }

    private let queue = DispatchQueue(label: "MockConversationQueueClient.calls")
    private var _calls: [Call] = []
    var calls: [Call] {
        queue.sync { _calls }
    }
    var deleteResult: Bool = true

    init() {}

    func deleteQueuedMessage(conversationId: String, requestId: String) async -> Bool {
        queue.sync {
            _calls.append(Call(conversationId: conversationId, requestId: requestId))
        }
        return deleteResult
    }
}

private struct FakeSubagentClient: SubagentClientProtocol {
    let abortResult: SubagentAbortResult
    func abort(subagentId: String, conversationId: String?) async -> SubagentAbortResult { abortResult }
    func fetchDetail(subagentId: String, conversationId: String) async -> SubagentDetailResponse? { nil }
    func sendMessage(subagentId: String, content: String, conversationId: String?) async -> Bool { true }
}
