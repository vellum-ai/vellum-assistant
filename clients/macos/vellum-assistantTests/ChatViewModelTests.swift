import XCTest
@testable import VellumAssistantLib
import VellumAssistantShared

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
        viewModel = ChatViewModel(daemonClient: daemonClient)
    }

    override func tearDown() {
        viewModel = nil
        daemonClient = nil
        super.tearDown()
    }

    // MARK: - Initialization

    func testInitCreatesGreetingMessage() {
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .assistant)
        XCTAssertTrue(viewModel.messages[0].text.contains("How can I help"))
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

        // Should have greeting + user message
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messages[1].role, .user)
        XCTAssertEqual(viewModel.messages[1].text, "Hello world")
    }

    func testSendMessageClearsInput() {
        viewModel.inputText = "Hello world"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.inputText, "")
    }

    func testSendEmptyMessageDoesNothing() {
        viewModel.inputText = "   "
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messages.count, 1) // Just greeting
    }

    func testSendWhileBootstrappingDoesNothing() {
        // When no session exists yet (bootstrapping), rapid-fire is blocked
        viewModel.inputText = "First"
        viewModel.sendMessage()

        viewModel.inputText = "Second"
        viewModel.sendMessage() // Should be ignored since isSending is set by bootstrapSession and sessionId is nil

        XCTAssertEqual(viewModel.messages.count, 2) // greeting + first only
    }

    func testSendWhileSendingWithSessionAppendsMessage() {
        // When a session exists, sending while isSending is allowed (daemon queues)
        viewModel.sessionId = "test-session"
        viewModel.isSending = true

        viewModel.inputText = "Queued message"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 2) // greeting + queued message
        XCTAssertEqual(viewModel.messages[1].role, .user)
        XCTAssertEqual(viewModel.messages[1].text, "Queued message")
        // Message should have queued status since isSending was true
        if case .queued = viewModel.messages[1].status {
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

    // MARK: - Session Info

    func testSessionInfoStoresSessionId() {
        let info = SessionInfoMessage(sessionId: "test-123", title: "Test")
        viewModel.handleServerMessage(.sessionInfo(info))
        XCTAssertEqual(viewModel.sessionId, "test-123")
    }

    func testSessionInfoDoesNotOverwriteExistingSession() {
        viewModel.sessionId = "first-session"
        let info = SessionInfoMessage(sessionId: "second-session", title: "Test")
        viewModel.handleServerMessage(.sessionInfo(info))
        XCTAssertEqual(viewModel.sessionId, "first-session")
    }

    // MARK: - Streaming Deltas

    func testTextDeltaCreatesAssistantMessage() {
        let delta = AssistantTextDeltaMessage(text: "Hello")
        viewModel.handleServerMessage(.assistantTextDelta(delta))

        // Should have greeting + new assistant message
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messages[1].role, .assistant)
        XCTAssertEqual(viewModel.messages[1].text, "Hello")
        XCTAssertTrue(viewModel.messages[1].isStreaming)
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

        XCTAssertEqual(viewModel.messages.count, 2) // greeting + 1 assistant
        XCTAssertEqual(viewModel.messages[1].text, "Hello world")
        XCTAssertTrue(viewModel.messages[1].isStreaming)
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
        XCTAssertFalse(viewModel.messages[1].isStreaming)
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

        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial")))
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(sessionId: nil)))

        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[1].isStreaming)
    }

    func testGenerationCancelledWithoutStreamingMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

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

    // MARK: - Stop Generating

    func testStopGeneratingKeepsSendingUntilAcknowledged() {
        // Set up as if we're in a streaming session
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.sessionId = "test-session"
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial response")))

        viewModel.stopGenerating()

        // isSending stays true until daemon acknowledges
        XCTAssertTrue(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[1].isStreaming)

        // Daemon acknowledges cancellation
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(sessionId: nil)))
        XCTAssertFalse(viewModel.isSending)
    }

    func testStopGeneratingSuppressesLateDeltas() {
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.sessionId = "test-session"
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial")))

        viewModel.stopGenerating()

        // Late-arriving delta after stop should be suppressed
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " late text")))

        // Should still only have the original partial text, no new message
        XCTAssertEqual(viewModel.messages.count, 2) // greeting + 1 assistant
        XCTAssertEqual(viewModel.messages[1].text, "Partial")

        // Daemon acknowledges cancellation — clears isCancelling
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(sessionId: nil)))
        XCTAssertFalse(viewModel.isSending)

        // After acknowledgment, new deltas should work normally
        viewModel.isSending = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "New response")))
        XCTAssertEqual(viewModel.messages.count, 3)
        XCTAssertEqual(viewModel.messages[2].text, "New response")
    }

    func testStopGeneratingSuppressedByMessageComplete() {
        // If a message_complete arrives instead of generation_cancelled
        // (race between cancel and normal completion), it should also
        // reset the cancelling state.
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.sessionId = "test-session"
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response")))

        viewModel.stopGenerating()

        // Late delta suppressed
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " extra")))
        XCTAssertEqual(viewModel.messages[1].text, "Response")

        // message_complete arrives instead of generation_cancelled
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertFalse(viewModel.isSending)
    }

    func testStopGeneratingDuringBootstrapCancelsLocally() {
        // Simulate bootstrap: isSending is true but sessionId is nil
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        XCTAssertTrue(viewModel.isSending)
        XCTAssertNil(viewModel.sessionId)

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
        viewModel.sessionId = "test-session"
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
        XCTAssertEqual(viewModel.messages.count, 1) // Only the greeting
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
        viewModel.sessionId = "sess-1"
        viewModel.isSending = true
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        // Daemon confirms it's queued at position 2
        let queued = MessageQueuedMessage(sessionId: "sess-1", requestId: "req-1", position: 2)
        viewModel.handleServerMessage(.messageQueued(queued))

        // The user message should have its position updated
        if case .queued(let position) = viewModel.messages[1].status {
            XCTAssertEqual(position, 2)
        } else {
            XCTFail("Expected message to have queued status with position 2")
        }
    }

    func testMessageDequeuedUpdatesMessageStatusToProcessing() {
        // Add a user message with queued status
        viewModel.sessionId = "sess-1"
        viewModel.isSending = true
        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        // Daemon confirms queued then dequeued
        let queued = MessageQueuedMessage(sessionId: "sess-1", requestId: "req-1", position: 1)
        viewModel.handleServerMessage(.messageQueued(queued))

        let dequeued = MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-1")
        viewModel.handleServerMessage(.messageDequeued(dequeued))

        XCTAssertEqual(viewModel.messages[1].status, .processing)
    }

    func testMessageDequeuedRestoresSendingAndThinkingState() {
        // Simulate: message A completes, then queued message B is dequeued
        viewModel.sessionId = "sess-1"
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
        viewModel.handleServerMessage(.sessionInfo(SessionInfoMessage(sessionId: "sess-1", title: "Chat")))
        viewModel.inputText = "Message A"
        viewModel.sendMessage()
        // greeting(0), A(1)

        // Send message B while busy (will be queued)
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        // greeting(0), A(1), B(2)
        XCTAssertEqual(viewModel.messages.count, 3)

        // Daemon confirms B is queued
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))

        // Assistant responds to A, then handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        // Daemon dequeues B — status becomes .processing
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))
        XCTAssertEqual(viewModel.messages[2].status, .processing, "Message B should be processing after dequeue")

        // Assistant responds to B, then message_complete
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        // After message_complete, the processing user message should be reset to .sent
        XCTAssertEqual(viewModel.messages[2].status, .sent, "Message B should be .sent after messageComplete, not .processing")
    }

    func testProcessingStatusResetToSentOnGenerationCancelled() {
        viewModel.handleServerMessage(.sessionInfo(SessionInfoMessage(sessionId: "sess-1", title: "Chat")))
        viewModel.inputText = "Message A"
        viewModel.sendMessage()

        viewModel.inputText = "Message B"
        viewModel.sendMessage()

        // Daemon confirms B is queued, then dequeued
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))
        XCTAssertEqual(viewModel.messages[2].status, .processing)

        // Generation is cancelled
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(sessionId: nil)))

        XCTAssertEqual(viewModel.messages[2].status, .sent, "Message B should be .sent after generationCancelled, not .processing")
    }

    func testProcessingStatusResetToSentOnGenerationHandoff() {
        viewModel.handleServerMessage(.sessionInfo(SessionInfoMessage(sessionId: "sess-1", title: "Chat")))
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
        XCTAssertEqual(viewModel.messages[2].status, .processing)

        // B completes via handoff (C is still queued)
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        // B should be reset to .sent after generationHandoff
        XCTAssertEqual(viewModel.messages[2].status, .sent, "Message B should be .sent after generationHandoff, not .processing")
    }

    // MARK: - Generation Handoff

    func testGenerationHandoffKeepsSendingTrue() {
        viewModel.sessionId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        // Start streaming an assistant message
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial response")))

        // Handoff: generation cut short, queued messages waiting
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        XCTAssertTrue(viewModel.isSending, "isSending must stay true during handoff")
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[1].isStreaming, "Streaming message should be finalized")
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
        viewModel.sessionId = "sess-1"
        viewModel.isSending = true
        viewModel.isThinking = true

        // First text delta creates assistant message
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "First response")))
        XCTAssertEqual(viewModel.messages.count, 2) // greeting + first assistant

        // Handoff clears currentAssistantMessageId
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        // Second text delta should create a NEW assistant message
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Second response")))
        XCTAssertEqual(viewModel.messages.count, 3, "Second delta should create a new message, not append to first")
        XCTAssertEqual(viewModel.messages[1].text, "First response")
        XCTAssertEqual(viewModel.messages[2].text, "Second response")
    }

    func testThreeMessageBurstWithHandoffTransitions() {
        // Set up session
        viewModel.handleServerMessage(.sessionInfo(SessionInfoMessage(sessionId: "sess-1", title: "Chat")))
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
        let greeting = ChatMessage(role: .assistant, text: "Hello!")
        viewModel.messages.append(greeting)

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

        // greeting(0), A(1), B(2), C(3)
        XCTAssertEqual(viewModel.messages.count, 4)

        // 4. Daemon sends messageQueued for B (position 1) and C (position 2)
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-C", position: 2)))
        XCTAssertEqual(viewModel.pendingQueuedCount, 2)
        if case .queued(let pos) = viewModel.messages[2].status {
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
        XCTAssertFalse(viewModel.messages[4].isStreaming, "First assistant message should be finalized")

        // 6. Daemon dequeues B
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))
        XCTAssertEqual(viewModel.messages[2].status, .processing, "Message B should be processing")
        XCTAssertTrue(viewModel.isThinking, "isThinking restored after dequeue")
        XCTAssertTrue(viewModel.isSending)
        XCTAssertEqual(viewModel.pendingQueuedCount, 1)

        // 7. Text delta for B, then generation_handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))

        // Second assistant message finalized
        XCTAssertFalse(viewModel.messages[5].isStreaming, "Second assistant message should be finalized")
        XCTAssertTrue(viewModel.isSending, "isSending stays true — C is still queued")

        // 8. Daemon dequeues C
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-C")))
        XCTAssertEqual(viewModel.messages[3].status, .processing, "Message C should be processing")
        XCTAssertEqual(viewModel.pendingQueuedCount, 0)

        // 9. Text delta for C, then message_complete
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to C")))
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertFalse(viewModel.isSending, "isSending should be false — no more queued messages")
        XCTAssertFalse(viewModel.messages[6].isStreaming, "Third assistant message should be finalized")
    }

    // MARK: - Queue Badges / Status Transitions (handoff → dequeue → complete)

    func testQueueBadgesStatusTransitionsReflectHandoffDequeueComplete() {
        // Set up viewModel with a session
        viewModel.handleServerMessage(.sessionInfo(SessionInfoMessage(sessionId: "sess-1", title: "Chat")))

        // Send message A (direct — not queued)
        viewModel.inputText = "Message A"
        viewModel.sendMessage()
        // greeting(0), A(1)
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)

        // Send messages B and C while busy (both get queued status)
        viewModel.inputText = "Message B"
        viewModel.sendMessage()
        viewModel.inputText = "Message C"
        viewModel.sendMessage()
        // greeting(0), A(1), B(2), C(3)
        XCTAssertEqual(viewModel.messages.count, 4)

        // Both B and C should have .queued status (position 0 initially)
        if case .queued = viewModel.messages[2].status {
            // expected
        } else {
            XCTFail("Message B should have queued status")
        }
        if case .queued = viewModel.messages[3].status {
            // expected
        } else {
            XCTFail("Message C should have queued status")
        }

        // Simulate daemon confirming B and C are queued
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-B", position: 1)))
        viewModel.handleServerMessage(.messageQueued(MessageQueuedMessage(sessionId: "sess-1", requestId: "req-C", position: 2)))
        XCTAssertEqual(viewModel.pendingQueuedCount, 2)

        // Verify positions were updated
        if case .queued(let pos) = viewModel.messages[2].status {
            XCTAssertEqual(pos, 1)
        } else {
            XCTFail("Message B should be queued at position 1")
        }
        if case .queued(let pos) = viewModel.messages[3].status {
            XCTAssertEqual(pos, 2)
        } else {
            XCTFail("Message C should be queued at position 2")
        }

        // Assistant responds to A with text delta, then generation_handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to A")))
        // greeting(0), A(1), B(2), C(3), assistantA(4)
        XCTAssertEqual(viewModel.messages.count, 5)

        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 2)))

        // After handoff: isSending stays true, isThinking cleared, streaming finalized
        XCTAssertTrue(viewModel.isSending, "isSending must stay true during handoff")
        XCTAssertFalse(viewModel.isThinking, "isThinking cleared after handoff")
        XCTAssertFalse(viewModel.messages[4].isStreaming, "Assistant message for A should be finalized")

        // B and C remain queued
        XCTAssertEqual(viewModel.pendingQueuedCount, 2)

        // Simulate messageDequeued for B — first queued goes to .processing
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-B")))
        XCTAssertEqual(viewModel.messages[2].status, .processing, "Message B should now be processing")
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking, "isThinking restored after dequeue")
        XCTAssertEqual(viewModel.pendingQueuedCount, 1)

        // Assistant responds to B, then another handoff
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response to B")))
        viewModel.handleServerMessage(.generationHandoff(GenerationHandoffMessage(sessionId: "sess-1", requestId: nil, queuedCount: 1)))
        XCTAssertTrue(viewModel.isSending, "isSending stays true — C is still queued")

        // Simulate messageDequeued for C
        viewModel.handleServerMessage(.messageDequeued(MessageDequeuedMessage(sessionId: "sess-1", requestId: "req-C")))
        XCTAssertEqual(viewModel.messages[3].status, .processing, "Message C should now be processing")
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
        viewModel.sessionId = "my-session"
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "foreign", sessionId: "other-session")))
        // Should still be thinking — delta was ignored
        XCTAssertTrue(viewModel.isThinking)
        XCTAssertEqual(viewModel.messages.count, 1) // Only greeting
    }

    func testTextDeltaFromSameSessionIsAccepted() {
        viewModel.sessionId = "my-session"
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "hello", sessionId: "my-session")))
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messages[1].text, "hello")
    }

    func testTextDeltaWithNilSessionIdIsAccepted() {
        viewModel.sessionId = "my-session"
        viewModel.isThinking = true
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "hello", sessionId: nil)))
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertEqual(viewModel.messages.count, 2)
    }

    func testMessageCompleteFromDifferentSessionIsIgnored() {
        viewModel.sessionId = "my-session"
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage(sessionId: "other-session")))
        // Should still be sending/thinking — message was ignored
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)
    }

    func testMessageCompleteFromSameSessionIsAccepted() {
        viewModel.sessionId = "my-session"
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage(sessionId: "my-session")))
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
    }

    // MARK: - Disconnected Send Handling

    func testSendUserMessageWhenDisconnectedShowsError() {
        // Set up a session but daemon is disconnected
        viewModel.sessionId = "test-session"
        daemonClient.isConnected = false

        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        // User message should still appear in the list
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messages[1].role, .user)

        // But isSending/isThinking should NOT be set since the send was rejected
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)

        // Error text should be surfaced
        XCTAssertNotNil(viewModel.errorText)
        XCTAssertTrue(viewModel.errorText?.contains("daemon") == true)
    }

    // MARK: - Full Conversation Flow

    func testFullConversationFlow() {
        // Simulate a complete conversation: session created, text streamed, completed
        viewModel.handleServerMessage(.sessionInfo(SessionInfoMessage(sessionId: "sess-1", title: "Chat")))
        XCTAssertEqual(viewModel.sessionId, "sess-1")

        // Thinking starts
        viewModel.isThinking = true
        viewModel.isSending = true
        viewModel.handleServerMessage(.assistantThinkingDelta(AssistantThinkingDeltaMessage(thinking: "Analyzing...")))
        XCTAssertTrue(viewModel.isThinking)

        // Text deltas arrive
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "The answer")))
        XCTAssertFalse(viewModel.isThinking) // Thinking cleared on first text delta
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " is 42.")))
        XCTAssertEqual(viewModel.messages[1].text, "The answer is 42.")
        XCTAssertTrue(viewModel.messages[1].isStreaming)

        // Message completes
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.messages[1].isStreaming)
    }

    // MARK: - Session Isolation (Correlation ID)

    func testSessionInfoWithWrongCorrelationIdIsIgnored() {
        // Simulate a ChatViewModel that has sent a session_create with a correlation ID.
        // A session_info with a different correlation ID should be ignored.
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        // At this point the VM is bootstrapping and has a correlationId set internally.
        XCTAssertNil(viewModel.sessionId)
        XCTAssertTrue(viewModel.isSending)

        // A session_info from a different ChatViewModel's request (different correlation ID)
        let foreignInfo = SessionInfoMessage(sessionId: "foreign-session", title: "Foreign", correlationId: "wrong-id")
        viewModel.handleServerMessage(.sessionInfo(foreignInfo))

        // Should NOT have claimed the foreign session
        XCTAssertNil(viewModel.sessionId, "Should not claim session_info with non-matching correlationId")
    }

    func testSessionInfoWithNilCorrelationIdIsIgnoredWhenBootstrapping() {
        // When a ChatViewModel is bootstrapping (has a correlationId), a session_info
        // without any correlationId should also be rejected to prevent cross-contamination.
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertNil(viewModel.sessionId)

        // Legacy session_info without correlationId
        let legacyInfo = SessionInfoMessage(sessionId: "legacy-session", title: "Legacy")
        viewModel.handleServerMessage(.sessionInfo(legacyInfo))

        // Should NOT have claimed the legacy session
        XCTAssertNil(viewModel.sessionId, "Should not claim session_info without correlationId when bootstrapping with one")
    }

    func testSessionInfoWithoutCorrelationIdAcceptedWhenNoBootstrap() {
        // When a ChatViewModel has no bootstrap correlationId (e.g., backwards compat),
        // it should still accept session_info without a correlationId.
        // Simulate the old behavior: directly set up state without going through
        // bootstrapSession (which would generate a correlationId)
        let info = SessionInfoMessage(sessionId: "test-session", title: "Test")
        viewModel.handleServerMessage(.sessionInfo(info))

        XCTAssertEqual(viewModel.sessionId, "test-session", "Should accept session_info when no correlationId was set")
    }
}
