import SwiftUI
import XCTest
@testable import VellumAssistantShared

/// Integration tests for ChatViewModel from the iOS perspective.
/// Exercises the shared state machine: initialization, message send/receive flow,
/// streaming deltas, conversation lifecycle, error handling, and attachment validation.
@MainActor
final class ChatViewModelIOSTests: XCTestCase {

    private var mockClient: GatewayConnectionManager!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        mockClient = GatewayConnectionManager()
        mockClient.isConnected = true
        viewModel = ChatViewModel(connectionManager: mockClient, eventStreamClient: mockClient.eventStreamClient)
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

    func testClearingInputRestoresExistingSuggestion() {
        viewModel.suggestion = "Summarize the last response"

        viewModel.inputText = "Something else"
        XCTAssertEqual(viewModel.suggestion, "Summarize the last response")

        viewModel.inputText = ""
        XCTAssertEqual(viewModel.suggestion, "Summarize the last response")
    }

    // Note: testSendMessageRecordsInMockClient was removed because GatewayConnectionManager
    // no longer has sentMessages. Verifying that messages are dispatched upstream
    // requires a mock EventStreamClient.

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

    func testConversationInfoClearsBootstrapState() async {
        // Simulate a bootstrap scenario
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertTrue(viewModel.isSending)

        // Wait for bootstrap to complete — the bootstrap flow sets conversationId
        // inside a Task { @MainActor }, so we yield via Task.sleep to let it run.
        await waitForBootstrap()

        // Bootstrap should have created a conversation ID locally and cleared bootstrap state
        XCTAssertNotNil(viewModel.conversationId)
        XCTAssertNil(viewModel.bootstrapCorrelationId)
        // Note: verifying the message was dispatched upstream requires a mock EventStreamClient
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
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage(messageId: "msg-1")))

        XCTAssertFalse(viewModel.isSending)
        XCTAssertFalse(viewModel.isThinking)
        XCTAssertFalse(viewModel.messages[0].isStreaming)
    }

    func testMessageCompleteWithoutStreamingMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true

        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage(messageId: "msg-1")))

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

    func testFullMessageCycle() async {
        // 1. Send a user message
        viewModel.inputText = "Tell me about iOS"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .user)
        XCTAssertTrue(viewModel.isSending)

        // Wait for bootstrap to complete
        await waitForBootstrap()

        // 2. Bootstrap should have created a conversation ID locally
        XCTAssertNotNil(viewModel.conversationId)
        // Note: verifying the message was dispatched upstream requires a mock EventStreamClient

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
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage(messageId: "msg-1")))
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

    func testRespondToAlwaysAllowSendsHighRiskDecision() async {
        let mockInteraction = MockInteractionClient()
        mockInteraction.results = [.success]

        let vm = ChatViewModel(connectionManager: mockClient, eventStreamClient: mockClient.eventStreamClient, interactionClient: mockInteraction)
        vm.conversationId = "sess-hr"

        vm.respondToAlwaysAllow(
            requestId: "req-1",
            selectedPattern: "rm -rf *",
            selectedScope: "project",
            decision: "always_allow_high_risk"
        )

        await waitForMockCalls(mockInteraction, count: 1)

        XCTAssertEqual(mockInteraction.calls.count, 1)
        XCTAssertEqual(mockInteraction.calls[0].decision, "always_allow_high_risk")
        XCTAssertEqual(mockInteraction.calls[0].selectedPattern, "rm -rf *")
        XCTAssertEqual(mockInteraction.calls[0].selectedScope, "project")
    }

    func testRespondToAlwaysAllowSendsDefaultDecision() async {
        let mockInteraction = MockInteractionClient()
        mockInteraction.results = [.success]

        let vm = ChatViewModel(connectionManager: mockClient, eventStreamClient: mockClient.eventStreamClient, interactionClient: mockInteraction)
        vm.conversationId = "sess-default"

        vm.respondToAlwaysAllow(
            requestId: "req-2",
            selectedPattern: "npm test",
            selectedScope: "project"
        )

        await waitForMockCalls(mockInteraction, count: 1)

        XCTAssertEqual(mockInteraction.calls.count, 1)
        XCTAssertEqual(mockInteraction.calls[0].decision, "always_allow")
    }

    func testRespondToAlwaysAllowFallsBackWhenSendFails() async {
        let mockInteraction = MockInteractionClient()
        // First call (always_allow_high_risk) fails, fallback (allow) also fails
        mockInteraction.results = [.failed, .failed]

        let vm = ChatViewModel(connectionManager: mockClient, eventStreamClient: mockClient.eventStreamClient, interactionClient: mockInteraction)
        vm.conversationId = "sess-fallback"

        // Seed a confirmation message so revertConfirmationInFlight can find it
        let confirmation = ToolConfirmationData(
            requestId: "req-3",
            toolName: "bash",
            input: ["command": AnyCodable("npm install")],
            riskLevel: "high",
            diff: nil,
            allowlistOptions: [],
            scopeOptions: [],
            executionTarget: nil,
            persistentDecisionsAllowed: true
        )
        let msg = ChatMessage(role: .assistant, text: "Run npm install?", confirmation: confirmation)
        vm.messages.append(msg)

        vm.respondToAlwaysAllow(
            requestId: "req-3",
            selectedPattern: "npm install",
            selectedScope: "project",
            decision: "always_allow_high_risk"
        )

        await waitForMockCalls(mockInteraction, count: 2)

        // Both attempts failed — confirmation should be reverted to pending
        XCTAssertEqual(mockInteraction.calls.count, 2)
        XCTAssertEqual(mockInteraction.calls[0].decision, "always_allow_high_risk")
        XCTAssertEqual(mockInteraction.calls[1].decision, "allow")
        XCTAssertEqual(vm.messages[0].confirmation?.state, .pending)
    }

    func testRespondToAlwaysAllowConnectedSendFailureFallsBackToAllow() async {
        let mockInteraction = MockInteractionClient()
        // First call (always_allow_high_risk) fails, fallback (allow) succeeds
        mockInteraction.results = [.failed, .success]

        let vm = ChatViewModel(connectionManager: mockClient, eventStreamClient: mockClient.eventStreamClient, interactionClient: mockInteraction)
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

        await waitForMockCalls(mockInteraction, count: 2)

        // First attempted decision should be always_allow_high_risk (the one that failed)
        XCTAssertEqual(mockInteraction.calls.count, 2)
        XCTAssertEqual(mockInteraction.calls[0].decision, "always_allow_high_risk")

        // Fallback should be a one-time "allow"
        XCTAssertEqual(mockInteraction.calls[1].decision, "allow")

        // The fallback succeeded, so errorText should reflect the preference-not-saved message
        XCTAssertEqual(vm.errorText, "Preference could not be saved. This action was allowed once.")
    }

    // MARK: - Helpers

    /// Wait for the bootstrap Task to set conversationId. Uses async Task.sleep
    /// to yield the main actor, giving the bootstrap Task a chance to execute.
    /// GCD-based polling (DispatchQueue.main.asyncAfter + XCTestExpectation) is
    /// unreliable because XCTest's wait(for:timeout:) doesn't always pump the
    /// Swift concurrency cooperative executor.
    private func waitForBootstrap(timeout: TimeInterval = 5.0) async {
        let deadline = ContinuousClock.now + .seconds(timeout)
        while viewModel.conversationId == nil && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    /// Poll until the mock's call count reaches the expected value.
    /// Uses Task.sleep to yield the main actor cooperatively, avoiding the
    /// main-actor scheduling issues that XCTestExpectation + fulfillment(of:)
    /// can cause when the production code spawns unstructured Tasks with
    /// sequential async calls.
    private func waitForMockCalls(_ mock: MockInteractionClient, count: Int, timeout: TimeInterval = 5.0) async {
        let deadline = ContinuousClock.now + .seconds(timeout)
        while mock.calls.count < count && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    // MARK: - Queue Helpers: queuedMessages, tailQueuedMessageId, editQueuedTail

    func test_queuedMessages_filtersUserRoleAndSortsByPosition() {
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

        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(composerText, "unchanged", "Text binding should not be modified when queue is empty")
        XCTAssertTrue(composerAttachments.isEmpty, "Attachments binding should not be modified when queue is empty")
        XCTAssertTrue(mockQueueClient.calls.isEmpty, "No delete_queued_message call should be dispatched")
    }
}

// MARK: - Test Doubles

/// Mock `InteractionClientProtocol` that records calls and returns configurable results.
@MainActor
private final class MockInteractionClient: InteractionClientProtocol {
    struct Call {
        let requestId: String
        let decision: String
        let selectedPattern: String?
        let selectedScope: String?
    }

    private(set) var calls: [Call] = []
    /// Return values for successive calls. Last value repeats for any extra calls.
    var results: [ConfirmationSendResult] = [.success]

    func sendConfirmationResponse(requestId: String, decision: String, selectedPattern: String?, selectedScope: String?) async -> ConfirmationSendResult {
        let result = calls.count < results.count ? results[calls.count] : results.last ?? .success
        calls.append(Call(requestId: requestId, decision: decision, selectedPattern: selectedPattern, selectedScope: selectedScope))
        return result
    }

    func sendSecretResponse(requestId: String, value: String?, delivery: String?) async -> Bool {
        true
    }
}

/// Mock `ConversationQueueClientProtocol` used by queue-drawer tests to record
/// delete_queued_message dispatches without hitting the network.
private final class MockConversationQueueClient: ConversationQueueClientProtocol, @unchecked Sendable {
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
