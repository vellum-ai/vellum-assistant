import XCTest
@testable import VellumAssistantLib

@MainActor
final class ChatViewModelTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        daemonClient = DaemonClient()
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

    func testStopGeneratingResetsState() {
        // Set up as if we're in a streaming session
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.sessionId = "test-session"
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Partial response")))

        viewModel.stopGenerating()

        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[1].isStreaming)
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
}
