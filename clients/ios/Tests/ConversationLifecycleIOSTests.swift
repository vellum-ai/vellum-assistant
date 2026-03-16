import XCTest
@testable import VellumAssistantShared

#if canImport(UIKit)
@testable import vellum_assistant_ios
#endif

/// Integration tests for conversation lifecycle behaviors from the iOS perspective.
/// Since ThreadModel and ThreadManager are macOS-only, these tests verify the
/// shared conversation lifecycle mechanics that underpin conversation management:
/// conversation creation, conversation info backfill, bootstrap correlation, and conversation reuse.
@MainActor
final class ConversationLifecycleIOSTests: XCTestCase {

    private var mockClient: MockDaemonClient!
    private let connectedCacheKey = "ios_connected_threads_cache_v1"

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
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createConversationIfNeeded()

        XCTAssertFalse(vm.isSending, "Message-less conversation creates should not set isSending")
        XCTAssertTrue(vm.isBootstrapping, "Should be bootstrapping after createConversationIfNeeded")
    }

    func testCreateConversationSendsConversationCreateMessage() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createConversationIfNeeded()

        // Poll until conversation_create appears in sentMessages (message-driven wait)
        let expectation = XCTestExpectation(description: "conversation_create sent")
        var cancelled = false
        func poll() {
            guard !cancelled else { return }
            let found = mockClient.sentMessages.contains { $0 is ConversationCreateMessage }
            if found {
                expectation.fulfill()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { poll() }
            }
        }
        poll()
        wait(for: [expectation], timeout: 2.0)
        cancelled = true

        let conversationCreates = mockClient.sentMessages.compactMap { $0 as? ConversationCreateMessage }
        XCTAssertEqual(conversationCreates.count, 1, "Should send exactly one conversation_create")
    }

    func testCreateConversationWithConversationTypeSetsConversationType() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createConversationIfNeeded(conversationType: "private")

        XCTAssertEqual(vm.conversationType, "private")
    }

    func testCreateConversationWithConversationTypeSendsConversationType() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createConversationIfNeeded(conversationType: "private")

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

        let conversationCreates = mockClient.sentMessages.compactMap { $0 as? ConversationCreateMessage }
        XCTAssertEqual(conversationCreates.first?.conversationType, "private")
    }

    // MARK: - Conversation Info Backfill (Conversation Assignment)

    func testConversationInfoBackfillsConversationId() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createConversationIfNeeded()

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

        // Extract the correlation ID from the sent message
        let conversationCreates = mockClient.sentMessages.compactMap { $0 as? ConversationCreateMessage }
        let correlationId = conversationCreates.first?.correlationId

        // Simulate daemon responding with conversation_info
        let info = ConversationInfoMessage(conversationId: "ios-conv-sess-42", title: "Conversation", correlationId: correlationId)
        vm.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(vm.conversationId, "ios-conv-sess-42")
        XCTAssertFalse(vm.isBootstrapping, "Should no longer be bootstrapping after conversation_info")
        XCTAssertFalse(vm.isSending, "Should reset isSending after message-less conversation create")
    }

    func testConversationInfoWithWrongCorrelationIdIsIgnored() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createConversationIfNeeded()

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

        // Send conversation_info with a different correlation ID
        let info = ConversationInfoMessage(conversationId: "wrong-sess", title: "Wrong", correlationId: "wrong-correlation-id")
        vm.handleServerMessage(.conversationInfo(info))

        XCTAssertNil(vm.conversationId, "Should not accept conversation_info with mismatched correlation ID")
        XCTAssertTrue(vm.isBootstrapping, "Should still be bootstrapping")
    }

    func testOnSessionCreatedCallbackFiresDuringBackfill() {
        let vm = ChatViewModel(daemonClient: mockClient)
        var capturedSessionId: String?
        vm.onConversationCreated = { sessionId in
            capturedSessionId = sessionId
        }
        vm.createConversationIfNeeded()

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

        let conversationCreates = mockClient.sentMessages.compactMap { $0 as? ConversationCreateMessage }
        let correlationId = conversationCreates.first?.correlationId

        let info = ConversationInfoMessage(conversationId: "callback-conv-sess", title: "Callback", correlationId: correlationId)
        vm.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(capturedSessionId, "callback-conv-sess")
    }

    // MARK: - Conversation Lifecycle: Create, Use, Archive Pattern

    func testNewSessionReceivesAndCompletesMessages() {
        let vm = ChatViewModel(daemonClient: mockClient)

        // Step 1: User sends first message (triggers bootstrap)
        vm.inputText = "Hello new conversation"
        vm.sendMessage()
        XCTAssertEqual(vm.messages.count, 1)
        XCTAssertTrue(vm.isSending)

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

        // Step 2: Conversation info arrives with matching correlation ID
        let info = ConversationInfoMessage(conversationId: "conv-sess-1", title: "New Conversation", correlationId: correlationId)
        vm.handleServerMessage(.conversationInfo(info))
        XCTAssertEqual(vm.conversationId, "conv-sess-1")

        // Step 3: Assistant responds
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Welcome!")))
        vm.flushStreamingBuffer()
        XCTAssertEqual(vm.messages.count, 2)
        XCTAssertEqual(vm.messages[1].role, .assistant)

        // Step 4: Message completes
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertFalse(vm.isSending)
        XCTAssertFalse(vm.messages[1].isStreaming)
    }

    func testMultipleMessagesInSameSession() {
        let vm = ChatViewModel(daemonClient: mockClient)
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

    // MARK: - Separate Sessions (Conversation Isolation)

    func testSeparateViewModelsHaveIndependentState() {
        let vm1 = ChatViewModel(daemonClient: mockClient)
        let vm2 = ChatViewModel(daemonClient: mockClient)

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
        let vm1 = ChatViewModel(daemonClient: mockClient)
        let vm2 = ChatViewModel(daemonClient: mockClient)

        vm1.conversationId = "sess-a"
        vm2.conversationId = "sess-b"

        // Delta for conversation A
        let deltaA = AssistantTextDeltaMessage(text: "For A", sessionId: "sess-a")
        vm1.handleServerMessage(.assistantTextDelta(deltaA))
        vm1.flushStreamingBuffer()
        vm2.handleServerMessage(.assistantTextDelta(deltaA))
        vm2.flushStreamingBuffer()

        XCTAssertEqual(vm1.messages.count, 1, "VM1 should accept delta for its session")
        XCTAssertTrue(vm2.messages.isEmpty, "VM2 should ignore delta for a different session")
    }

    // MARK: - Error Recovery in Conversation

    func testErrorDuringSessionDoesNotDestroyMessages() {
        let vm = ChatViewModel(daemonClient: mockClient)
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
        let daemonClient = DaemonClient()
        let store = IOSConversationStore(daemonClient: daemonClient)
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

        daemonClient.onConversationListResponse?(response)

        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-1" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        XCTAssertTrue(storedConversation.isPinned)
        XCTAssertEqual(storedConversation.displayOrder, 7)
        XCTAssertTrue(storedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(storedConversation.latestAssistantMessageAt?.timeIntervalSince1970, 5.0)
        XCTAssertEqual(storedConversation.lastSeenAssistantMessageAt?.timeIntervalSince1970, 4.0)

        let reloadedStore = IOSConversationStore(daemonClient: daemonClient)
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

    func testConnectedConversationMergeAppliesMetadataWhenMatchedViaViewModelSessionId() {
        let daemonClient = DaemonClient()
        let store = IOSConversationStore(daemonClient: daemonClient)

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

        daemonClient.onConversationListResponse?(response)

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
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationSeenSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationSeenSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSConversationStore(daemonClient: daemonClient)
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

        daemonClient.onConversationListResponse?(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-2" }) else {
            XCTFail("Expected unread connected conversation")
            return
        }

        store.markConversationSeenIfNeeded(conversationLocalId: storedConversation.id)

        guard let updatedConversation = store.conversations.first(where: { $0.id == storedConversation.id }) else {
            XCTFail("Expected updated conversation")
            return
        }

        XCTAssertFalse(updatedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(sentSignals.count, 1)
        XCTAssertEqual(sentSignals[0].conversationId, "connected-session-2")
        XCTAssertEqual(sentSignals[0].sourceChannel, "vellum")
        XCTAssertEqual(sentSignals[0].signalType, "ios_conversation_opened")
        XCTAssertEqual(sentSignals[0].confidence, "explicit")
        XCTAssertEqual(sentSignals[0].source, "ui-navigation")
        XCTAssertEqual(sentSignals[0].evidenceText, "User opened conversation in app")

        let reloadedStore = IOSConversationStore(daemonClient: daemonClient)
        guard let cachedConversation = reloadedStore.conversations.first(where: { $0.conversationId == "connected-session-2" }) else {
            XCTFail("Expected cached connected conversation")
            return
        }

        XCTAssertFalse(cachedConversation.hasUnseenLatestAssistantMessage)
    }

    func testOpeningAlreadySeenConnectedConversationDoesNotEmitSignal() {
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationSeenSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationSeenSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSConversationStore(daemonClient: daemonClient)
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

        daemonClient.onConversationListResponse?(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-3" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        store.markConversationSeenIfNeeded(conversationLocalId: storedConversation.id)

        XCTAssertTrue(sentSignals.isEmpty)
        XCTAssertFalse(store.conversations.first(where: { $0.id == storedConversation.id })?.hasUnseenLatestAssistantMessage ?? true)
    }

    func testMarkingSeenConnectedConversationUnreadUpdatesLocalStateAndEmitsSignal() {
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationUnreadSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationUnreadSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSConversationStore(daemonClient: daemonClient)
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

        daemonClient.onConversationListResponse?(response)
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
        XCTAssertEqual(sentSignals.count, 1)
        XCTAssertEqual(sentSignals[0].conversationId, "connected-session-4")
        XCTAssertEqual(sentSignals[0].sourceChannel, "vellum")
        XCTAssertEqual(sentSignals[0].signalType, "ios_conversation_opened")
        XCTAssertEqual(sentSignals[0].confidence, "explicit")
        XCTAssertEqual(sentSignals[0].source, "ui-navigation")
        XCTAssertEqual(sentSignals[0].evidenceText, "User selected Mark as unread")

        let reloadedStore = IOSConversationStore(daemonClient: daemonClient)
        guard let cachedConversation = reloadedStore.conversations.first(where: { $0.conversationId == "connected-session-4" }) else {
            XCTFail("Expected cached connected conversation")
            return
        }

        XCTAssertTrue(cachedConversation.hasUnseenLatestAssistantMessage)
    }

    func testMarkingAlreadyUnreadConnectedConversationUnreadDoesNothing() {
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationUnreadSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationUnreadSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSConversationStore(daemonClient: daemonClient)
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

        daemonClient.onConversationListResponse?(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-5" }) else {
            XCTFail("Expected unread connected conversation")
            return
        }

        store.markConversationUnread(storedConversation)

        XCTAssertTrue(sentSignals.isEmpty)
        XCTAssertTrue(store.conversations.first(where: { $0.id == storedConversation.id })?.hasUnseenLatestAssistantMessage ?? false)
    }

    func testMarkingSeenConnectedConversationUnreadRollsBackWhenSendFails() {
        let daemonClient = DaemonClient()
        daemonClient.sendOverride = { _ in
            throw NSError(domain: "ConversationLifecycleIOSTests", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "offline"
            ])
        }

        let store = IOSConversationStore(daemonClient: daemonClient)
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

        daemonClient.onConversationListResponse?(response)
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
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationUnreadSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationUnreadSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSConversationStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-6",
            "title": "No assistant reply yet",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
            ],
        ]])

        daemonClient.onConversationListResponse?(response)
        guard let storedConversation = store.conversations.first(where: { $0.conversationId == "connected-session-6" }) else {
            XCTFail("Expected connected conversation")
            return
        }

        store.markConversationUnread(storedConversation)

        XCTAssertTrue(sentSignals.isEmpty)
        XCTAssertFalse(store.conversations.first(where: { $0.id == storedConversation.id })?.hasUnseenLatestAssistantMessage ?? true)
    }

    func testMarkingConversationWithLoadedAssistantReplyUnreadUsesLocalMessageTimestamp() {
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationUnreadSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationUnreadSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSConversationStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-live-assistant",
            "title": "Live assistant reply",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
            ],
        ]])

        daemonClient.onConversationListResponse?(response)
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
        XCTAssertEqual(sentSignals.count, 1)

        let reloadedStore = IOSConversationStore(daemonClient: daemonClient)
        guard let cachedConversation = reloadedStore.conversations.first(where: { $0.conversationId == "connected-session-live-assistant" }) else {
            XCTFail("Expected cached connected conversation")
            return
        }

        XCTAssertTrue(cachedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertNotNil(cachedConversation.latestAssistantMessageAt)
    }

    func testConversationListRefreshPreservesLocalSeenUntilDaemonCatchesUp() {
        let daemonClient = DaemonClient()
        let store = IOSConversationStore(daemonClient: daemonClient)

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
        daemonClient.onConversationListResponse?(initialResponse)

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
        daemonClient.onConversationListResponse?(staleResponse)

        XCTAssertFalse(
            store.conversations.first(where: { $0.conversationId == "connected-session-refresh-seen" })?.hasUnseenLatestAssistantMessage ?? true
        )
    }

    func testConversationListRefreshPreservesLocalUnreadUntilDaemonCatchesUp() {
        let daemonClient = DaemonClient()
        let store = IOSConversationStore(daemonClient: daemonClient)

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
        daemonClient.onConversationListResponse?(initialResponse)

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
        daemonClient.onConversationListResponse?(staleResponse)

        XCTAssertTrue(
            store.conversations.first(where: { $0.conversationId == "connected-session-refresh-unread" })?.hasUnseenLatestAssistantMessage ?? false
        )
    }

    func testPinningConnectedConversationUpdatesLocalStateAndEmitsReorder() {
        let daemonClient = DaemonClient()
        var reorderRequests: [ReorderConversationsRequest] = []
        daemonClient.sendOverride = { message in
            if let request = message as? ReorderConversationsRequest {
                reorderRequests.append(request)
            }
        }

        let store = IOSConversationStore(daemonClient: daemonClient)
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

        daemonClient.onConversationListResponse?(response)
        guard let conversation = store.conversations.first(where: { $0.conversationId == "connected-session-unpinned" }) else {
            XCTFail("Expected unpinned connected conversation")
            return
        }

        store.pinConversation(conversation)

        guard let updatedConversation = store.conversations.first(where: { $0.id == conversation.id }) else {
            XCTFail("Expected updated conversation")
            return
        }

        XCTAssertTrue(updatedConversation.isPinned)
        XCTAssertEqual(updatedConversation.displayOrder, 1)
        XCTAssertEqual(reorderRequests.count, 1)

        let updatesBySessionId = Dictionary(
            uniqueKeysWithValues: reorderRequests[0].updates.map { ($0.conversationId, $0) }
        )
        XCTAssertEqual(updatesBySessionId["connected-session-pinned"]?.displayOrder, 0)
        XCTAssertEqual(updatesBySessionId["connected-session-pinned"]?.isPinned, true)
        XCTAssertEqual(updatesBySessionId["connected-session-unpinned"]?.displayOrder, 1)
        XCTAssertEqual(updatesBySessionId["connected-session-unpinned"]?.isPinned, true)
    }

    func testPinningConnectedConversationSurvivesStaleSessionRefresh() {
        let daemonClient = DaemonClient()
        let store = IOSConversationStore(daemonClient: daemonClient)
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

        daemonClient.onConversationListResponse?(response)
        guard let conversation = store.conversations.first(where: { $0.conversationId == "connected-session-unpinned" }) else {
            XCTFail("Expected unpinned connected conversation")
            return
        }

        store.pinConversation(conversation)
        daemonClient.onConversationListResponse?(response)

        guard let updatedConversation = store.conversations.first(where: { $0.id == conversation.id }) else {
            XCTFail("Expected updated conversation")
            return
        }

        XCTAssertTrue(updatedConversation.isPinned)
        XCTAssertEqual(updatedConversation.displayOrder, 1)
    }

    func testUnpinningConnectedConversationRecompactsPinnedOrderAndEmitsReorder() {
        let daemonClient = DaemonClient()
        var reorderRequests: [ReorderConversationsRequest] = []
        daemonClient.sendOverride = { message in
            if let request = message as? ReorderConversationsRequest {
                reorderRequests.append(request)
            }
        }

        let store = IOSConversationStore(daemonClient: daemonClient)
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

        daemonClient.onConversationListResponse?(response)
        guard let conversation = store.conversations.first(where: { $0.conversationId == "connected-session-first" }) else {
            XCTFail("Expected pinned connected conversation")
            return
        }

        store.unpinConversation(conversation)

        guard let firstConversation = store.conversations.first(where: { $0.conversationId == "connected-session-first" }),
              let secondConversation = store.conversations.first(where: { $0.conversationId == "connected-session-second" }) else {
            XCTFail("Expected connected conversations")
            return
        }

        XCTAssertFalse(firstConversation.isPinned)
        XCTAssertNil(firstConversation.displayOrder)
        XCTAssertTrue(secondConversation.isPinned)
        XCTAssertEqual(secondConversation.displayOrder, 0)
        XCTAssertEqual(reorderRequests.count, 1)

        let updatesBySessionId = Dictionary(
            uniqueKeysWithValues: reorderRequests[0].updates.map { ($0.conversationId, $0) }
        )
        XCTAssertNil(updatesBySessionId["connected-session-first"]?.displayOrder)
        XCTAssertEqual(updatesBySessionId["connected-session-first"]?.isPinned, false)
        XCTAssertEqual(updatesBySessionId["connected-session-second"]?.displayOrder, 0)
        XCTAssertEqual(updatesBySessionId["connected-session-second"]?.isPinned, true)
    }

    func testPinningStandaloneConversationDoesNothing() {
        let store = IOSConversationStore(daemonClient: mockClient)
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
