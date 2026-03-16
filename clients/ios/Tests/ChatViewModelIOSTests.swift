import XCTest
@testable import VellumAssistantShared

/// Integration tests for ChatViewModel from the iOS perspective.
/// Exercises the shared state machine: initialization, message send/receive flow,
/// streaming deltas, conversation lifecycle, error handling, and attachment validation.
@MainActor
final class ChatViewModelIOSTests: XCTestCase {

    private var mockClient: MockDaemonClient!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockDaemonClient()
        mockClient.isConnected = true
        viewModel = ChatViewModel(daemonClient: mockClient)
    }

    override func tearDown() {
        viewModel = nil
        mockClient = nil
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

    func testInitStartsWithNoConversationId() {
        XCTAssertNil(viewModel.conversationId)
    }

    func testInitStartsWithNoPendingAttachments() {
        XCTAssertTrue(viewModel.pendingAttachments.isEmpty)
    }

    func testInitStartsWithDefaultModel() {
        XCTAssertEqual(viewModel.selectedModel, "claude-opus-4-6")
    }

    // MARK: - Send Message

    func testSendMessageAppendsUserMessage() {
        viewModel.inputText = "Hello from iOS"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertEqual(viewModel.messages[0].text, "Hello from iOS")
    }

    func testSendMessageClearsInput() {
        viewModel.inputText = "Test message"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.inputText, "")
    }

    func testSendEmptyMessageDoesNothing() {
        viewModel.inputText = "   "
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messages.count, 0)
    }

    func testSendWhileBootstrappingDoesNothing() {
        viewModel.inputText = "First"
        viewModel.sendMessage()

        viewModel.inputText = "Second"
        viewModel.sendMessage()

        // Only first message should be present since bootstrapping blocks rapid-fire
        XCTAssertEqual(viewModel.messages.count, 1)
    }

    func testSendWhileSendingWithConversationAppendsQueuedMessage() {
        viewModel.conversationId = "test-session"
        viewModel.isSending = true

        viewModel.inputText = "Queued message"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertEqual(viewModel.messages[0].text, "Queued message")
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

    func testSendMessageRecordsInMockClient() throws {
        viewModel.conversationId = "sess-abc"
        viewModel.inputText = "Test"
        viewModel.sendMessage()

        // The mock client should have recorded the sent message
        XCTAssertGreaterThanOrEqual(mockClient.sentMessages.count, 1)
    }

    // MARK: - Conversation Info

    func testConversationInfoStoresConversationId() {
        viewModel.bootstrapCorrelationId = "corr-1"
        let info = ConversationInfoMessage(conversationId: "ios-sess-123", title: "iOS Test", correlationId: "corr-1")
        viewModel.handleServerMessage(.conversationInfo(info))
        XCTAssertEqual(viewModel.conversationId, "ios-sess-123")
    }

    func testConversationInfoDoesNotOverwriteExistingConversation() {
        viewModel.conversationId = "first-session"
        let info = ConversationInfoMessage(conversationId: "second-session", title: "Test")
        viewModel.handleServerMessage(.conversationInfo(info))
        XCTAssertEqual(viewModel.conversationId, "first-session")
    }

    func testConversationInfoClearsBootstrapState() {
        // Simulate a bootstrap scenario
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertTrue(viewModel.isSending)

        // Poll until session_create appears in sentMessages (message-driven wait)
        let expectation = XCTestExpectation(description: "session_create sent")
        var cancelled = false
        func poll() {
            guard !cancelled else { return }
            if !mockClient.sentMessages.isEmpty {
                expectation.fulfill()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { poll() }
            }
        }
        poll()
        wait(for: [expectation], timeout: 2.0)
        cancelled = true

        // Extract the correlation ID from the sent conversation_create message
        let conversationCreates = mockClient.sentMessages.compactMap { $0 as? ConversationCreateMessage }
        let correlationId = conversationCreates.first?.correlationId

        // Conversation info arrives with matching correlation ID
        let info = ConversationInfoMessage(conversationId: "new-sess", title: "Test", correlationId: correlationId)
        viewModel.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(viewModel.conversationId, "new-sess")
    }

    // MARK: - Streaming Deltas

    func testTextDeltaCreatesAssistantMessage() {
        let delta = AssistantTextDeltaMessage(text: "Hello iOS user")
        viewModel.handleServerMessage(.assistantTextDelta(delta))
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .assistant)
        XCTAssertEqual(viewModel.messages[0].text, "Hello iOS user")
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
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].text, "Hello world")
    }

    func testTextDeltaAfterUserMessageCreatesNewAssistantMessage() {
        viewModel.conversationId = "sess-1"
        viewModel.inputText = "Question"
        viewModel.sendMessage()

        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Answer")))
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertEqual(viewModel.messages[1].role, .assistant)
        XCTAssertEqual(viewModel.messages[1].text, "Answer")
    }

    // MARK: - Message Complete

    func testMessageCompleteFinalizesState() {
        viewModel.isSending = true
        viewModel.isThinking = true

        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Response")))
        viewModel.flushStreamingBuffer()
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[0].isStreaming)
    }

    func testMessageCompleteWithoutStreamingMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

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
        viewModel.flushStreamingBuffer()

        // User initiates cancel, then server acknowledges
        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: nil)))

        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[0].isStreaming)
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

    func testStopGeneratingSetsCancellingState() {
        viewModel.conversationId = "sess-stop"
        viewModel.isSending = true

        viewModel.stopGenerating()

        XCTAssertTrue(viewModel.isCancelling)
    }

    // MARK: - Full Send/Receive Cycle

    func testFullMessageCycle() {
        // 1. Send a user message
        viewModel.inputText = "Tell me about iOS"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertTrue(viewModel.isSending)

        // Poll until conversation_create appears in sentMessages (message-driven wait)
        let expectation = XCTestExpectation(description: "conversation_create sent")
        var cancelled = false
        func poll() {
            guard !cancelled else { return }
            if !mockClient.sentMessages.isEmpty {
                expectation.fulfill()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { poll() }
            }
        }
        poll()
        wait(for: [expectation], timeout: 2.0)
        cancelled = true

        // Extract the correlation ID from the sent conversation_create message
        let conversationCreates = mockClient.sentMessages.compactMap { $0 as? ConversationCreateMessage }
        let correlationId = conversationCreates.first?.correlationId

        // 2. Conversation info arrives with matching correlation ID
        let info = ConversationInfoMessage(conversationId: "cycle-sess", title: "iOS Chat", correlationId: correlationId)
        viewModel.handleServerMessage(.conversationInfo(info))
        XCTAssertEqual(viewModel.conversationId, "cycle-sess")

        // 3. Assistant starts streaming
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "iOS is ")))
        viewModel.flushStreamingBuffer()
        XCTAssertEqual(viewModel.messages.count, 2)
        XCTAssertTrue(viewModel.messages[1].isStreaming)
        XCTAssertFalse(viewModel.isThinking)

        // 4. More deltas arrive
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "great!")))
        viewModel.flushStreamingBuffer()
        XCTAssertEqual(viewModel.messages[1].text, "iOS is great!")

        // 5. Message completes
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.messages[1].isStreaming)
    }

    // MARK: - Callback Hooks

    func testOnFirstUserMessageCallbackFires() {
        var capturedText: String?
        viewModel.onFirstUserMessage = { text in
            capturedText = text
        }

        viewModel.inputText = "Hello callback"
        viewModel.sendMessage()

        XCTAssertEqual(capturedText, "Hello callback")
    }

    func testOnFirstUserMessageCallbackFiresOnlyOnce() {
        var callCount = 0
        viewModel.onFirstUserMessage = { _ in
            callCount += 1
        }

        viewModel.conversationId = "sess-callback"
        viewModel.inputText = "First"
        viewModel.sendMessage()

        viewModel.inputText = "Second"
        viewModel.sendMessage()

        XCTAssertEqual(callCount, 1, "onFirstUserMessage should fire only once")
    }

    func testOnConversationCreatedCallbackFires() {
        var capturedConversationId: String?
        viewModel.onConversationCreated = { conversationId in
            capturedConversationId = conversationId
        }

        viewModel.bootstrapCorrelationId = "corr-cb"
        let info = ConversationInfoMessage(conversationId: "callback-sess", title: "Test", correlationId: "corr-cb")
        viewModel.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(capturedConversationId, "callback-sess")
    }

    // MARK: - Cancelling Suppresses Deltas

    func testCancellingSuppressesIncomingDeltas() {
        viewModel.isCancelling = true
        viewModel.conversationId = "sess-cancel"

        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Should be suppressed")))

        XCTAssertEqual(viewModel.messages.count, 0, "Deltas should be suppressed when cancelling")
    }

    // MARK: - Always Allow Decision Plumbing

    func testRespondToAlwaysAllowSendsHighRiskDecision() {
        viewModel.conversationId = "sess-hr"

        viewModel.respondToAlwaysAllow(
            requestId: "req-1",
            selectedPattern: "rm -rf *",
            selectedScope: "project",
            decision: "always_allow_high_risk"
        )

        // Verify the sent message carries the high-risk decision
        let confirmations = mockClient.sentMessages.compactMap { $0 as? ConfirmationResponseMessage }
        XCTAssertEqual(confirmations.count, 1)
        XCTAssertEqual(confirmations[0].decision, "always_allow_high_risk")
        XCTAssertEqual(confirmations[0].selectedPattern, "rm -rf *")
        XCTAssertEqual(confirmations[0].selectedScope, "project")
    }

    func testRespondToAlwaysAllowSendsDefaultDecision() {
        viewModel.conversationId = "sess-default"

        viewModel.respondToAlwaysAllow(
            requestId: "req-2",
            selectedPattern: "npm test",
            selectedScope: "project"
        )

        // Default decision should be "always_allow"
        let confirmations = mockClient.sentMessages.compactMap { $0 as? ConfirmationResponseMessage }
        XCTAssertEqual(confirmations.count, 1)
        XCTAssertEqual(confirmations[0].decision, "always_allow")
    }

    func testRespondToAlwaysAllowFailsWhenDisconnected() {
        viewModel.conversationId = "sess-fallback"
        mockClient.isConnected = false

        viewModel.respondToAlwaysAllow(
            requestId: "req-3",
            selectedPattern: "npm install",
            selectedScope: "project",
            decision: "always_allow_high_risk"
        )

        // Should set error text when daemon is not connected
        XCTAssertNotNil(viewModel.errorText)
        // No messages should have been sent
        let confirmations = mockClient.sentMessages.compactMap { $0 as? ConfirmationResponseMessage }
        XCTAssertTrue(confirmations.isEmpty)
    }

    func testRespondToAlwaysAllowConnectedSendFailureFallsBackToAllow() {
        // Use a test double that fails the first send but succeeds on the second.
        let failOnceClient = FailOnceDaemonClient()
        failOnceClient.isConnected = true
        let vm = ChatViewModel(daemonClient: failOnceClient)
        vm.conversationId = "sess-fail-once"

        // Seed a confirmation message so the fallback path can update its state
        let confirmation = ToolConfirmationData(
            requestId: "req-fail",
            toolName: "bash",
            input: ["command": AnyCodable("rm -rf *")],
            riskLevel: "high",
            diff: nil,
            allowlistOptions: [],
            scopeOptions: [],
            executionTarget: nil,
            persistentDecisionsAllowed: true
        )
        let msg = ChatMessage(role: .assistant, text: "Run rm -rf?", confirmation: confirmation)
        vm.messages.append(msg)

        vm.respondToAlwaysAllow(
            requestId: "req-fail",
            selectedPattern: "rm -rf *",
            selectedScope: "project",
            decision: "always_allow_high_risk"
        )

        // First attempted decision should be always_allow_high_risk (the one that failed)
        XCTAssertEqual(failOnceClient.allAttemptedMessages.count, 2)
        let first = failOnceClient.allAttemptedMessages[0] as? ConfirmationResponseMessage
        XCTAssertEqual(first?.decision, "always_allow_high_risk")

        // Fallback should be a one-time "allow"
        let second = failOnceClient.allAttemptedMessages[1] as? ConfirmationResponseMessage
        XCTAssertEqual(second?.decision, "allow")

        // The fallback succeeded, so errorText should reflect the preference-not-saved message
        XCTAssertEqual(vm.errorText, "Preference could not be saved. This action was allowed once.")

        // The client was connected the whole time — no disconnected error
        XCTAssertTrue(failOnceClient.isConnected)
    }
}

// MARK: - Test Doubles

/// A `DaemonClientProtocol` implementation that throws on the first `send` call
/// and succeeds on subsequent calls. Used to test the connected send-failure
/// fallback path in `respondToAlwaysAllow`.
@MainActor
private final class FailOnceDaemonClient: DaemonClientProtocol {
    var isConnected: Bool = false

    /// All messages attempted (including failed ones).
    private(set) var allAttemptedMessages: [Any] = []

    /// Messages that were successfully sent (after the first failure).
    private(set) var sentMessages: [Any] = []

    private var sendCount = 0

    func subscribe() -> AsyncStream<ServerMessage> {
        AsyncStream { _ in }
    }

    func send<T: Encodable>(_ message: T) throws {
        allAttemptedMessages.append(message)
        sendCount += 1
        if sendCount == 1 {
            throw NSError(domain: "TestSendFailure", code: 1, userInfo: [NSLocalizedDescriptionKey: "Simulated first-send failure"])
        }
        sentMessages.append(message)
    }

    func connect() async throws {
        isConnected = true
    }

    func disconnect() {
        isConnected = false
    }

    func startSSE() {}
    func stopSSE() {}
}
