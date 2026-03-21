import XCTest
@testable import VellumAssistantShared

#if canImport(UIKit)
@testable import vellum_assistant_ios
#endif

/// Integration tests for conversation lifecycle behaviors from the iOS perspective.
/// Since ConversationModel and ConversationManager are macOS-only, these tests verify the
/// shared conversation lifecycle mechanics that underpin conversation management:
/// conversation creation, conversation info backfill, bootstrap correlation, and conversation reuse.
@MainActor
final class ConversationLifecycleIOSTests: XCTestCase {

    private var mockClient: MockDaemonClient!
    private let connectedCacheKey = "ios_connected_conversations_cache_v1"

    override func setUp() {
        super.setUp()
        mockClient = MockDaemonClient()
        mockClient.isConnected = true
        UserDefaults.standard.removeObject(forKey: connectedCacheKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: connectedCacheKey)
        mockClient = nil
        super.tearDown()
    }

    private func makeConversationListResponse(
        conversations: [[String: Any]],
        hasMore: Bool? = nil
    ) -> ConversationListResponseMessage {
        var payload: [String: Any] = [
            "type": "conversation_list_response",
            "conversations": conversations,
        ]
        if let hasMore {
            payload["hasMore"] = hasMore
        }
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
    }

    // MARK: - Conversation Create (Conversation Bootstrap)

    func testCreateConversationIfNeededSetsBootstrapState() {
        let vm = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        vm.createConversationIfNeeded()

        XCTAssertFalse(vm.isSending, "Message-less conversation creates should not set isSending")
        XCTAssertTrue(vm.isBootstrapping, "Should be bootstrapping after createConversationIfNeeded")
    }

    func testCreateConversationAssignsLocalConversationId() {
        let vm = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        let expectation = XCTestExpectation(description: "conversationId assigned")
        vm.onConversationCreated = { _ in expectation.fulfill() }
        vm.createConversationIfNeeded()
        wait(for: [expectation], timeout: 10.0)

        XCTAssertNotNil(vm.conversationId, "Should have a locally-generated conversation ID")
        XCTAssertFalse(vm.isBootstrapping, "Should no longer be bootstrapping after ID assignment")
    }

    func testCreateConversationWithConversationTypeSetsConversationType() {
        let vm = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        vm.createConversationIfNeeded(conversationType: "private")

        XCTAssertEqual(vm.conversationType, "private")
    }

    func testCreateConversationWithConversationTypeRetainsConversationType() {
        let vm = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        let expectation = XCTestExpectation(description: "conversationId assigned")
        vm.onConversationCreated = { _ in expectation.fulfill() }
        vm.createConversationIfNeeded(conversationType: "private")
        wait(for: [expectation], timeout: 10.0)

        XCTAssertEqual(vm.conversationType, "private")
    }

    // MARK: - Local Conversation ID Assignment

    func testBootstrapAssignsLocalConversationIdAndClearsState() {
        let vm = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        let expectation = XCTestExpectation(description: "conversationId assigned")
        vm.onConversationCreated = { _ in expectation.fulfill() }
        vm.createConversationIfNeeded()
        wait(for: [expectation], timeout: 10.0)

        XCTAssertNotNil(vm.conversationId)
        XCTAssertFalse(vm.isBootstrapping, "Should no longer be bootstrapping after local ID assignment")
        XCTAssertFalse(vm.isSending, "Should reset isSending after message-less conversation create")
    }

    func testConversationInfoDoesNotOverwriteLocallyAssignedId() {
        let vm = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        let expectation = XCTestExpectation(description: "conversationId assigned")
        vm.onConversationCreated = { _ in expectation.fulfill() }
        vm.createConversationIfNeeded()
        wait(for: [expectation], timeout: 10.0)

        let localId = vm.conversationId

        // Receiving a conversation_info after local ID assignment should not overwrite.
        let info = ConversationInfoMessage(conversationId: "wrong-sess", title: "Wrong", correlationId: "wrong-correlation-id")
        vm.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(vm.conversationId, localId, "conversation_info should not overwrite locally-assigned ID")
        XCTAssertFalse(vm.isBootstrapping, "Should not be bootstrapping")
    }

    func testOnConversationCreatedCallbackFiresDuringBackfill() {
        let vm = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        var capturedConversationId: String?
        let expectation = XCTestExpectation(description: "onConversationCreated fired")
        vm.onConversationCreated = { conversationId in
            capturedConversationId = conversationId
            expectation.fulfill()
        }
        vm.createConversationIfNeeded()
        wait(for: [expectation], timeout: 10.0)

        XCTAssertNotNil(capturedConversationId)
    }

    // MARK: - Conversation Lifecycle: Create, Use, Archive Pattern

    func testNewConversationReceivesAndCompletesMessages() {
        let vm = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)

        // Step 1: User sends first message (triggers bootstrap)
        let expectation = XCTestExpectation(description: "conversationId assigned")
        vm.onConversationCreated = { _ in expectation.fulfill() }
        vm.inputText = "Hello new conversation"
        vm.sendMessage()
        XCTAssertEqual(vm.messages.count, 1)
        XCTAssertTrue(vm.isSending)

        wait(for: [expectation], timeout: 10.0)
        XCTAssertNotNil(vm.conversationId)

        // Step 2: Assistant responds
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Welcome!")))
        vm.flushStreamingBuffer()
        XCTAssertEqual(vm.messages.count, 2)
        XCTAssertEqual(vm.messages[1].role, .assistant)

        // Step 3: Message completes
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertFalse(vm.isSending)
        XCTAssertFalse(vm.messages[1].isStreaming)
    }

    func testMultipleMessagesInSameConversation() {
        let vm = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        vm.conversationId = "existing-sess"

        // First exchange
        vm.inputText = "First question"
        vm.sendMessage()
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "First answer")))
        vm.flushStreamingBuffer()
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        // Second exchange
        vm.inputText = "Second question"
        vm.sendMessage()
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Second answer")))
        vm.flushStreamingBuffer()
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertEqual(vm.messages.count, 4)
        XCTAssertEqual(vm.messages[0].role, .user)
        XCTAssertEqual(vm.messages[0].text, "First question")
        XCTAssertEqual(vm.messages[1].role, .assistant)
        XCTAssertEqual(vm.messages[1].text, "First answer")
        XCTAssertEqual(vm.messages[2].role, .user)
        XCTAssertEqual(vm.messages[2].text, "Second question")
        XCTAssertEqual(vm.messages[3].role, .assistant)
        XCTAssertEqual(vm.messages[3].text, "Second answer")
    }

    // MARK: - Separate Conversations (Isolation)

    func testSeparateViewModelsHaveIndependentState() {
        let vm1 = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        let vm2 = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)

        vm1.conversationId = "sess-conv-1"
        vm2.conversationId = "sess-conv-2"

        vm1.inputText = "Conversation 1 message"
        vm1.sendMessage()

        vm2.inputText = "Conversation 2 message"
        vm2.sendMessage()

        XCTAssertEqual(vm1.messages.count, 1)
        XCTAssertEqual(vm1.messages[0].text, "Conversation 1 message")

        XCTAssertEqual(vm2.messages.count, 1)
        XCTAssertEqual(vm2.messages[0].text, "Conversation 2 message")
    }

    func testConversationBoundDeltasOnlyAffectMatchingViewModel() {
        let vm1 = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        let vm2 = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)

        vm1.conversationId = "sess-a"
        vm2.conversationId = "sess-b"

        // Delta for conversation A
        let deltaA = AssistantTextDeltaMessage(text: "For A", conversationId: "sess-a")
        vm1.handleServerMessage(.assistantTextDelta(deltaA))
        vm1.flushStreamingBuffer()
        vm2.handleServerMessage(.assistantTextDelta(deltaA))
        vm2.flushStreamingBuffer()

        XCTAssertEqual(vm1.messages.count, 1, "VM1 should accept delta for its session")
        XCTAssertTrue(vm2.messages.isEmpty, "VM2 should ignore delta for a different session")
    }

    // MARK: - Error Recovery in Conversation

    func testErrorDuringConversationDoesNotDestroyMessages() {
        let vm = ChatViewModel(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        vm.conversationId = "sess-error"

        // Send a message and get a response
        vm.inputText = "Question"
        vm.sendMessage()
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Answer")))
        vm.flushStreamingBuffer()
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertEqual(vm.messages.count, 2)

        // Now an error occurs
        vm.isSending = true
        vm.handleServerMessage(.error(ErrorMessage(message: "Temporary error")))

        // Previous messages should still be intact
        XCTAssertEqual(vm.messages.count, 2)
        XCTAssertEqual(vm.messages[0].text, "Question")
        XCTAssertEqual(vm.messages[1].text, "Answer")
        XCTAssertEqual(vm.errorText, "Temporary error")
    }

    #if canImport(UIKit)
    func testConnectedConversationsRetainPinAndAttentionMetadataAcrossCacheReload() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-1",
            "title": "Connected conversation",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "displayOrder": 7,
            "isPinned": true,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 4_000,
            ],
        ]])

        store.handleConversationListResponse(response)

        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-1" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        XCTAssertTrue(storedConversation.isPinned)
        XCTAssertEqual(storedConversation.displayOrder, 7)
        XCTAssertTrue(storedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(storedConversation.latestAssistantMessageAt?.timeIntervalSince1970, 5.0)
        XCTAssertEqual(storedConversation.lastSeenAssistantMessageAt?.timeIntervalSince1970, 4.0)

        let reloadedStore = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient)
        guard let cachedConversation = reloadedStore.conversations.first(where: { $0.conversationId == "connected-session-1" }) else {
            XCTFail("Expected cached connected conversation")
            return
        }

        XCTAssertTrue(cachedConversation.isPinned)
        XCTAssertEqual(cachedConversation.displayOrder, 7)
        XCTAssertTrue(cachedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(cachedConversation.latestAssistantMessageAt?.timeIntervalSince1970, 5.0)
        XCTAssertEqual(cachedConversation.lastSeenAssistantMessageAt?.timeIntervalSince1970, 4.0)
    }

    func testConnectedConversationMergeAppliesMetadataWhenMatchedViaViewModelConversationId() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient)

        guard let placeholderConversation = store.conversations.first else {
            XCTFail("Expected placeholder conversation")
            return
        }

        let viewModel = store.viewModel(for: placeholderConversation.id)
        viewModel.conversationId = "connected-session-vm"

        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-vm",
            "title": "Connected conversation",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "displayOrder": 9,
            "isPinned": true,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 4_000,
            ],
        ]])

        store.handleConversationListResponse(response)

        XCTAssertEqual(store.conversations.count, 1)
        guard let updatedConversation = store.conversations.first else {
            XCTFail("Expected merged conversation")
            return
        }

        XCTAssertEqual(updatedConversation.conversationId, "connected-session-vm")
        XCTAssertTrue(updatedConversation.isPinned)
        XCTAssertEqual(updatedConversation.displayOrder, 9)
        XCTAssertTrue(updatedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(updatedConversation.latestAssistantMessageAt?.timeIntervalSince1970, 5.0)
        XCTAssertEqual(updatedConversation.lastSeenAssistantMessageAt?.timeIntervalSince1970, 4.0)
    }

    func testOpeningUnreadConnectedConversationMarksItSeenAndEmitsSignal() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let mockListClient = MockConversationListClient()

        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationListClient: mockListClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-2",
            "title": "Unread conversation",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 4_000,
            ],
        ]])

        store.handleConversationListResponse(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-2" }) else {
            XCTFail("Expected unread connected conversation")
            return
        }

        store.markConversationSeenIfNeeded(conversationLocalId: storedConversation.id)
        waitForAsyncMutation()

        guard let updatedConversation = store.conversations.first(where: { $0.id == storedConversation.id }) else {
            XCTFail("Expected updated conversation")
            return
        }

        XCTAssertFalse(updatedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(mockListClient.sentSeenSignals.count, 1)
        XCTAssertEqual(mockListClient.sentSeenSignals[0].conversationId, "connected-session-2")
        XCTAssertEqual(mockListClient.sentSeenSignals[0].sourceChannel, "vellum")
        XCTAssertEqual(mockListClient.sentSeenSignals[0].signalType, "ios_conversation_opened")
        XCTAssertEqual(mockListClient.sentSeenSignals[0].confidence, "explicit")
        XCTAssertEqual(mockListClient.sentSeenSignals[0].source, "ui-navigation")
        XCTAssertEqual(mockListClient.sentSeenSignals[0].evidenceText, "User opened conversation in app")

        let reloadedStore = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient)
        guard let cachedConversation = reloadedStore.conversations.first(where: { $0.conversationId == "connected-session-2" }) else {
            XCTFail("Expected cached connected conversation")
            return
        }

        XCTAssertFalse(cachedConversation.hasUnseenLatestAssistantMessage)
    }

    func testOpeningAlreadySeenConnectedConversationDoesNotEmitSignal() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let mockListClient = MockConversationListClient()

        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationListClient: mockListClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-3",
            "title": "Seen conversation",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 5_000,
            ],
        ]])

        store.handleConversationListResponse(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-3" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        store.markConversationSeenIfNeeded(conversationLocalId: storedConversation.id)

        XCTAssertTrue(mockListClient.sentSeenSignals.isEmpty)
        XCTAssertFalse(store.conversations.first(where: { $0.id == storedConversation.id })?.hasUnseenLatestAssistantMessage ?? true)
    }

    func testMarkingSeenConnectedConversationUnreadUpdatesLocalStateAndEmitsSignal() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let mockUnreadClient = MockConversationUnreadClient()

        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationUnreadClient: mockUnreadClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-4",
            "title": "Seen conversation",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 5_000,
            ],
        ]])

        store.handleConversationListResponse(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-4" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        store.markConversationUnread(storedConversation)
        waitForAsyncMutation()

        guard let updatedConversation = store.conversations.first(where: { $0.id == storedConversation.id }) else {
            XCTFail("Expected updated conversation")
            return
        }

        XCTAssertTrue(updatedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(mockUnreadClient.sentSignals.count, 1)
        XCTAssertEqual(mockUnreadClient.sentSignals[0].conversationId, "connected-session-4")
        XCTAssertEqual(mockUnreadClient.sentSignals[0].sourceChannel, "vellum")
        XCTAssertEqual(mockUnreadClient.sentSignals[0].signalType, "ios_conversation_opened")
        XCTAssertEqual(mockUnreadClient.sentSignals[0].confidence, "explicit")
        XCTAssertEqual(mockUnreadClient.sentSignals[0].source, "ui-navigation")
        XCTAssertEqual(mockUnreadClient.sentSignals[0].evidenceText, "User selected Mark as unread")

        let reloadedStore = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationUnreadClient: mockUnreadClient)
        guard let cachedConversation = reloadedStore.conversations.first(where: { $0.conversationId == "connected-session-4" }) else {
            XCTFail("Expected cached connected conversation")
            return
        }

        XCTAssertTrue(cachedConversation.hasUnseenLatestAssistantMessage)
    }

    func testMarkingAlreadyUnreadConnectedConversationUnreadDoesNothing() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let mockUnreadClient = MockConversationUnreadClient()

        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationUnreadClient: mockUnreadClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-5",
            "title": "Unread conversation",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 4_000,
            ],
        ]])

        store.handleConversationListResponse(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-5" }) else {
            XCTFail("Expected unread connected conversation")
            return
        }

        store.markConversationUnread(storedConversation)

        XCTAssertTrue(mockUnreadClient.sentSignals.isEmpty)
        XCTAssertTrue(store.conversations.first(where: { $0.id == storedConversation.id })?.hasUnseenLatestAssistantMessage ?? false)
    }

    func testMarkingSeenConnectedConversationUnreadRollsBackWhenSendFails() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let mockUnreadClient = MockConversationUnreadClient()
        mockUnreadClient.shouldThrow = true

        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationUnreadClient: mockUnreadClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-unread-failure",
            "title": "Seen conversation",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 5_000,
            ],
        ]])

        store.handleConversationListResponse(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-unread-failure" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        store.markConversationUnread(storedConversation)
        waitForAsyncMutation()

        guard let updatedConversation = store.conversations.first(where: { $0.id == storedConversation.id }) else {
            XCTFail("Expected updated conversation")
            return
        }

        XCTAssertFalse(updatedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(updatedConversation.lastSeenAssistantMessageAt?.timeIntervalSince1970, 5.0)
    }

    func testMarkingConversationWithoutAssistantReplyUnreadDoesNothing() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let mockUnreadClient = MockConversationUnreadClient()

        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationUnreadClient: mockUnreadClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-6",
            "title": "No assistant reply yet",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
            ],
        ]])

        store.handleConversationListResponse(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-6" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        store.markConversationUnread(storedConversation)

        XCTAssertTrue(mockUnreadClient.sentSignals.isEmpty)
        XCTAssertFalse(store.conversations.first(where: { $0.id == storedConversation.id })?.hasUnseenLatestAssistantMessage ?? true)
    }

    func testMarkingConversationWithLoadedAssistantReplyUnreadUsesLocalMessageTimestamp() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let mockUnreadClient = MockConversationUnreadClient()

        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationUnreadClient: mockUnreadClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-live-assistant",
            "title": "Live assistant reply",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
            ],
        ]])

        store.handleConversationListResponse(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-live-assistant" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        let vm = store.viewModel(for: storedConversation.id)
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(
            text: "Fresh assistant reply",
            conversationId: "connected-session-live-assistant"
        )))
        vm.flushStreamingBuffer()
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage(
            conversationId: "connected-session-live-assistant"
        )))

        store.markConversationUnread(storedConversation)
        waitForAsyncMutation()

        guard let updatedConversation = store.conversations.first(where: { $0.id == storedConversation.id }) else {
            XCTFail("Expected updated conversation")
            return
        }

        XCTAssertTrue(updatedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertNil(updatedConversation.lastSeenAssistantMessageAt)
        XCTAssertNotNil(updatedConversation.latestAssistantMessageAt)
        XCTAssertEqual(mockUnreadClient.sentSignals.count, 1)

        let reloadedStore = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationUnreadClient: mockUnreadClient)
        guard let cachedConversation = reloadedStore.conversations.first(where: { $0.conversationId == "connected-session-live-assistant" }) else {
            XCTFail("Expected cached connected conversation")
            return
        }

        XCTAssertTrue(cachedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertNotNil(cachedConversation.latestAssistantMessageAt)
    }

    func testConversationListRefreshPreservesLocalSeenUntilDaemonCatchesUp() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient)

        let initialResponse = makeConversationListResponse(conversations: [[
            "id": "connected-session-refresh-seen",
            "title": "Unread conversation",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 4_000,
            ],
        ]])
        store.handleConversationListResponse(initialResponse)

        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-refresh-seen" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        store.markConversationSeenIfNeeded(conversationLocalId: storedConversation.id)

        let staleResponse = makeConversationListResponse(conversations: [[
            "id": "connected-session-refresh-seen",
            "title": "Unread conversation",
            "createdAt": 1_000,
            "updatedAt": 2_100,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 4_000,
            ],
        ]])
        store.handleConversationListResponse(staleResponse)

        XCTAssertFalse(
            store.conversations.first(where: { $0.conversationId == "connected-session-refresh-seen" })?.hasUnseenLatestAssistantMessage ?? true
        )
    }

    func testConversationListRefreshPreservesLocalUnreadUntilDaemonCatchesUp() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient)

        let initialResponse = makeConversationListResponse(conversations: [[
            "id": "connected-session-refresh-unread",
            "title": "Seen conversation",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 5_000,
            ],
        ]])
        store.handleConversationListResponse(initialResponse)

        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-refresh-unread" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        store.markConversationUnread(storedConversation)

        let staleResponse = makeConversationListResponse(conversations: [[
            "id": "connected-session-refresh-unread",
            "title": "Seen conversation",
            "createdAt": 1_000,
            "updatedAt": 2_100,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 5_000,
            ],
        ]])
        store.handleConversationListResponse(staleResponse)

        XCTAssertTrue(
            store.conversations.first(where: { $0.conversationId == "connected-session-refresh-unread" })?.hasUnseenLatestAssistantMessage ?? false
        )
    }

    func testPinningConnectedConversationUpdatesLocalStateAndEmitsReorder() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let mockListClient = MockConversationListClient()

        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationListClient: mockListClient)
        let response = makeConversationListResponse(conversations: [
            [
                "id": "connected-session-pinned",
                "title": "Pinned conversation",
                "createdAt": 1_000,
                "updatedAt": 2_000,
                "displayOrder": 0,
                "isPinned": true,
            ],
            [
                "id": "connected-session-unpinned",
                "title": "Unpinned conversation",
                "createdAt": 1_000,
                "updatedAt": 3_000,
            ],
        ])

        store.handleConversationListResponse(response)
        guard let conversation = store.conversations.first(where: { $0.conversationId == "connected-session-unpinned" }) else {
            XCTFail("Expected unpinned connected conversation")
            return
        }

        store.pinConversation(conversation)
        waitForAsyncMutation()

        guard let updatedConversation = store.conversations.first(where: { $0.id == conversation.id }) else {
            XCTFail("Expected updated conversation")
            return
        }

        XCTAssertTrue(updatedConversation.isPinned)
        XCTAssertEqual(updatedConversation.displayOrder, 1)
        XCTAssertEqual(mockListClient.reorderRequests.count, 1)

        let updatesByConversationId = Dictionary(
            uniqueKeysWithValues: mockListClient.reorderRequests[0].map { ($0.conversationId, $0) }
        )
        XCTAssertEqual(updatesByConversationId["connected-session-pinned"]?.displayOrder, 0)
        XCTAssertEqual(updatesByConversationId["connected-session-pinned"]?.isPinned, true)
        XCTAssertEqual(updatesByConversationId["connected-session-unpinned"]?.displayOrder, 1)
        XCTAssertEqual(updatesByConversationId["connected-session-unpinned"]?.isPinned, true)
    }

    func testPinningConnectedConversationSurvivesStaleConversationListRefresh() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient)
        let response = makeConversationListResponse(conversations: [
            [
                "id": "connected-session-pinned",
                "title": "Pinned conversation",
                "createdAt": 1_000,
                "updatedAt": 2_000,
                "displayOrder": 0,
                "isPinned": true,
            ],
            [
                "id": "connected-session-unpinned",
                "title": "Unpinned conversation",
                "createdAt": 1_000,
                "updatedAt": 3_000,
            ],
        ])

        store.handleConversationListResponse(response)
        guard let conversation = store.conversations.first(where: { $0.conversationId == "connected-session-unpinned" }) else {
            XCTFail("Expected unpinned connected conversation")
            return
        }

        store.pinConversation(conversation)
        store.handleConversationListResponse(response)

        guard let updatedConversation = store.conversations.first(where: { $0.id == conversation.id }) else {
            XCTFail("Expected updated conversation")
            return
        }

        XCTAssertTrue(updatedConversation.isPinned)
        XCTAssertEqual(updatedConversation.displayOrder, 1)
    }

    func testUnpinningConnectedConversationRecompactsPinnedOrderAndEmitsReorder() {
        let cm = GatewayConnectionManager(); let daemonClient = DaemonClient(connectionManager: cm)
        let mockListClient = MockConversationListClient()

        let store = IOSConversationStore(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient, conversationListClient: mockListClient)
        let response = makeConversationListResponse(conversations: [
            [
                "id": "connected-session-first",
                "title": "First pinned conversation",
                "createdAt": 1_000,
                "updatedAt": 2_000,
                "displayOrder": 0,
                "isPinned": true,
            ],
            [
                "id": "connected-session-second",
                "title": "Second pinned conversation",
                "createdAt": 1_000,
                "updatedAt": 3_000,
                "displayOrder": 1,
                "isPinned": true,
            ],
        ])

        store.handleConversationListResponse(response)
        guard let conversation = store.conversations.first(where: { $0.conversationId == "connected-session-first" }) else {
            XCTFail("Expected pinned connected conversation")
            return
        }

        store.unpinConversation(conversation)
        waitForAsyncMutation()

        guard let firstConversation = store.conversations.first(where: { $0.conversationId == "connected-session-first" }),
              let secondConversation = store.conversations.first(where: { $0.conversationId == "connected-session-second" }) else {
            XCTFail("Expected connected conversations")
            return
        }

        XCTAssertFalse(firstConversation.isPinned)
        XCTAssertNil(firstConversation.displayOrder)
        XCTAssertTrue(secondConversation.isPinned)
        XCTAssertEqual(secondConversation.displayOrder, 0)
        XCTAssertEqual(mockListClient.reorderRequests.count, 1)

        let updatesByConversationId = Dictionary(
            uniqueKeysWithValues: mockListClient.reorderRequests[0].map { ($0.conversationId, $0) }
        )
        XCTAssertNil(updatesByConversationId["connected-session-first"]?.displayOrder)
        XCTAssertEqual(updatesByConversationId["connected-session-first"]?.isPinned, false)
        XCTAssertEqual(updatesByConversationId["connected-session-second"]?.displayOrder, 0)
        XCTAssertEqual(updatesByConversationId["connected-session-second"]?.isPinned, true)
    }

    func testPinningStandaloneConversationDoesNothing() {
        let store = IOSConversationStore(daemonClient: mockClient, eventStreamClient: mockClient.eventStreamClient)
        let conversation = store.conversations[0]

        store.pinConversation(conversation)

        XCTAssertFalse(store.conversations[0].isPinned)
        XCTAssertNil(store.conversations[0].displayOrder)
    }

    private func waitForAsyncMutation() {
        let expectation = XCTestExpectation(description: "async mutation")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)
    }
    #endif
}

@MainActor
private final class MockConversationListClient: ConversationListClientProtocol {
    private(set) var sentSeenSignals: [ConversationSeenSignal] = []
    private(set) var reorderRequests: [[ReorderConversationsRequestUpdate]] = []

    func fetchConversationList(offset: Int, limit: Int) async -> ConversationListResponse? { nil }
    func switchConversation(conversationId: String) async -> Bool { true }
    func renameConversation(conversationId: String, name: String) async -> Bool { true }
    func clearAllConversations() async -> Bool { true }
    func cancelGeneration(conversationId: String) async -> Bool { true }
    func undoLastMessage(conversationId: String) async -> Int? { nil }
    func searchConversations(query: String, limit: Int?, maxMessagesPerConversation: Int?) async -> ConversationSearchResponse? { nil }

    func reorderConversations(updates: [ReorderConversationsRequestUpdate]) async -> Bool {
        reorderRequests.append(updates)
        return true
    }

    func sendConversationSeen(_ signal: ConversationSeenSignal) async -> Bool {
        sentSeenSignals.append(signal)
        return true
    }
}

@MainActor
private final class MockConversationUnreadClient: ConversationUnreadClientProtocol {
    var shouldThrow = false
    private(set) var sentSignals: [ConversationUnreadSignal] = []

    func sendConversationUnread(_ signal: ConversationUnreadSignal) async throws {
        sentSignals.append(signal)
        if shouldThrow {
            throw NSError(domain: "MockConversationUnreadClient", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "simulated failure"
            ])
        }
    }
}
