import XCTest
@testable import VellumAssistantShared

#if canImport(UIKit)
@testable import vellum_assistant_ios
#endif

/// Integration tests for thread lifecycle behaviors from the iOS perspective.
/// Since ThreadModel and ThreadManager are macOS-only, these tests verify the
/// shared conversation lifecycle mechanics that underpin thread management:
/// conversation creation, conversation info backfill, bootstrap correlation, and conversation reuse.
@MainActor
final class ThreadLifecycleIOSTests: XCTestCase {

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

    // MARK: - Conversation Create (Thread Bootstrap)

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

    // MARK: - Conversation Info Backfill (Thread Conversation Assignment)

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
        let info = ConversationInfoMessage(conversationId: "ios-thread-sess-42", title: "Thread", correlationId: correlationId)
        vm.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(vm.conversationId, "ios-thread-sess-42")
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

        let info = ConversationInfoMessage(conversationId: "callback-thread-sess", title: "Callback", correlationId: correlationId)
        vm.handleServerMessage(.conversationInfo(info))

        XCTAssertEqual(capturedSessionId, "callback-thread-sess")
    }

    // MARK: - Thread Lifecycle: Create, Use, Archive Pattern

    func testNewSessionReceivesAndCompletesMessages() {
        let vm = ChatViewModel(daemonClient: mockClient)

        // Step 1: User sends first message (triggers bootstrap)
        vm.inputText = "Hello new thread"
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
        let info = ConversationInfoMessage(conversationId: "thread-sess-1", title: "New Thread", correlationId: correlationId)
        vm.handleServerMessage(.conversationInfo(info))
        XCTAssertEqual(vm.conversationId, "thread-sess-1")

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

    // MARK: - Separate Sessions (Thread Isolation)

    func testSeparateViewModelsHaveIndependentState() {
        let vm1 = ChatViewModel(daemonClient: mockClient)
        let vm2 = ChatViewModel(daemonClient: mockClient)

        vm1.conversationId = "sess-thread-1"
        vm2.conversationId = "sess-thread-2"

        vm1.inputText = "Thread 1 message"
        vm1.sendMessage()

        vm2.inputText = "Thread 2 message"
        vm2.sendMessage()

        XCTAssertEqual(vm1.messages.count, 1)
        XCTAssertEqual(vm1.messages[0].text, "Thread 1 message")

        XCTAssertEqual(vm2.messages.count, 1)
        XCTAssertEqual(vm2.messages[0].text, "Thread 2 message")
    }

    func testConversationBoundDeltasOnlyAffectMatchingViewModel() {
        let vm1 = ChatViewModel(daemonClient: mockClient)
        let vm2 = ChatViewModel(daemonClient: mockClient)

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
    func testConnectedThreadsRetainPinAndAttentionMetadataAcrossCacheReload() {
        let daemonClient = DaemonClient()
        let store = IOSThreadStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-1",
            "title": "Connected thread",
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

        guard let storedThread = store.threads.first(where: { $0.conversationId == "connected-session-1" }) else {
            XCTFail("Expected connected thread")
            return
        }

        XCTAssertTrue(storedThread.isPinned)
        XCTAssertEqual(storedThread.displayOrder, 7)
        XCTAssertTrue(storedThread.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(storedThread.latestAssistantMessageAt?.timeIntervalSince1970, 5.0)
        XCTAssertEqual(storedThread.lastSeenAssistantMessageAt?.timeIntervalSince1970, 4.0)

        let reloadedStore = IOSThreadStore(daemonClient: daemonClient)
        guard let cachedThread = reloadedStore.threads.first(where: { $0.conversationId == "connected-session-1" }) else {
            XCTFail("Expected cached connected thread")
            return
        }

        XCTAssertTrue(cachedThread.isPinned)
        XCTAssertEqual(cachedThread.displayOrder, 7)
        XCTAssertTrue(cachedThread.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(cachedThread.latestAssistantMessageAt?.timeIntervalSince1970, 5.0)
        XCTAssertEqual(cachedThread.lastSeenAssistantMessageAt?.timeIntervalSince1970, 4.0)
    }

    func testConnectedThreadMergeAppliesMetadataWhenMatchedViaViewModelSessionId() {
        let daemonClient = DaemonClient()
        let store = IOSThreadStore(daemonClient: daemonClient)

        guard let placeholderThread = store.threads.first else {
            XCTFail("Expected placeholder thread")
            return
        }

        let viewModel = store.viewModel(for: placeholderThread.id)
        viewModel.conversationId = "connected-session-vm"

        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-vm",
            "title": "Connected thread",
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

        XCTAssertEqual(store.threads.count, 1)
        guard let updatedThread = store.threads.first else {
            XCTFail("Expected merged thread")
            return
        }

        XCTAssertEqual(updatedThread.conversationId, "connected-session-vm")
        XCTAssertTrue(updatedThread.isPinned)
        XCTAssertEqual(updatedThread.displayOrder, 9)
        XCTAssertTrue(updatedThread.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(updatedThread.latestAssistantMessageAt?.timeIntervalSince1970, 5.0)
        XCTAssertEqual(updatedThread.lastSeenAssistantMessageAt?.timeIntervalSince1970, 4.0)
    }

    func testOpeningUnreadConnectedThreadMarksItSeenAndEmitsSignal() {
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationSeenSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationSeenSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSThreadStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-2",
            "title": "Unread thread",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 4_000,
            ],
        ]])

        daemonClient.onConversationListResponse?(response)
        guard let storedThread = store.threads.first(where: { $0.conversationId == "connected-session-2" }) else {
            XCTFail("Expected unread connected thread")
            return
        }

        store.markConversationSeenIfNeeded(threadId: storedThread.id)

        guard let updatedThread = store.threads.first(where: { $0.id == storedThread.id }) else {
            XCTFail("Expected updated thread")
            return
        }

        XCTAssertFalse(updatedThread.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(sentSignals.count, 1)
        XCTAssertEqual(sentSignals[0].conversationId, "connected-session-2")
        XCTAssertEqual(sentSignals[0].sourceChannel, "vellum")
        XCTAssertEqual(sentSignals[0].signalType, "ios_conversation_opened")
        XCTAssertEqual(sentSignals[0].confidence, "explicit")
        XCTAssertEqual(sentSignals[0].source, "ui-navigation")
        XCTAssertEqual(sentSignals[0].evidenceText, "User opened conversation in app")

        let reloadedStore = IOSThreadStore(daemonClient: daemonClient)
        guard let cachedThread = reloadedStore.threads.first(where: { $0.conversationId == "connected-session-2" }) else {
            XCTFail("Expected cached connected thread")
            return
        }

        XCTAssertFalse(cachedThread.hasUnseenLatestAssistantMessage)
    }

    func testOpeningAlreadySeenConnectedThreadDoesNotEmitSignal() {
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationSeenSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationSeenSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSThreadStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-3",
            "title": "Seen thread",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 5_000,
            ],
        ]])

        daemonClient.onConversationListResponse?(response)
        guard let storedThread = store.threads.first(where: { $0.conversationId == "connected-session-3" }) else {
            XCTFail("Expected connected thread")
            return
        }

        store.markConversationSeenIfNeeded(threadId: storedThread.id)

        XCTAssertTrue(sentSignals.isEmpty)
        XCTAssertFalse(store.threads.first(where: { $0.id == storedThread.id })?.hasUnseenLatestAssistantMessage ?? true)
    }

    func testMarkingSeenConnectedThreadUnreadUpdatesLocalStateAndEmitsSignal() {
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationUnreadSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationUnreadSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSThreadStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-4",
            "title": "Seen thread",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 5_000,
            ],
        ]])

        daemonClient.onConversationListResponse?(response)
        guard let storedThread = store.threads.first(where: { $0.conversationId == "connected-session-4" }) else {
            XCTFail("Expected connected thread")
            return
        }

        store.markThreadUnread(storedThread)
        waitForAsyncMutation()

        guard let updatedThread = store.threads.first(where: { $0.id == storedThread.id }) else {
            XCTFail("Expected updated thread")
            return
        }

        XCTAssertTrue(updatedThread.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(sentSignals.count, 1)
        XCTAssertEqual(sentSignals[0].conversationId, "connected-session-4")
        XCTAssertEqual(sentSignals[0].sourceChannel, "vellum")
        XCTAssertEqual(sentSignals[0].signalType, "ios_conversation_opened")
        XCTAssertEqual(sentSignals[0].confidence, "explicit")
        XCTAssertEqual(sentSignals[0].source, "ui-navigation")
        XCTAssertEqual(sentSignals[0].evidenceText, "User selected Mark as unread")

        let reloadedStore = IOSThreadStore(daemonClient: daemonClient)
        guard let cachedThread = reloadedStore.threads.first(where: { $0.conversationId == "connected-session-4" }) else {
            XCTFail("Expected cached connected thread")
            return
        }

        XCTAssertTrue(cachedThread.hasUnseenLatestAssistantMessage)
    }

    func testMarkingAlreadyUnreadConnectedThreadUnreadDoesNothing() {
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationUnreadSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationUnreadSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSThreadStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-5",
            "title": "Unread thread",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 4_000,
            ],
        ]])

        daemonClient.onConversationListResponse?(response)
        guard let storedThread = store.threads.first(where: { $0.conversationId == "connected-session-5" }) else {
            XCTFail("Expected unread connected thread")
            return
        }

        store.markThreadUnread(storedThread)

        XCTAssertTrue(sentSignals.isEmpty)
        XCTAssertTrue(store.threads.first(where: { $0.id == storedThread.id })?.hasUnseenLatestAssistantMessage ?? false)
    }

    func testMarkingSeenConnectedThreadUnreadRollsBackWhenSendFails() {
        let daemonClient = DaemonClient()
        daemonClient.sendOverride = { _ in
            throw NSError(domain: "ThreadLifecycleIOSTests", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "offline"
            ])
        }

        let store = IOSThreadStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [[
            "id": "connected-session-unread-failure",
            "title": "Seen thread",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 5_000,
            ],
        ]])

        daemonClient.onConversationListResponse?(response)
        guard let storedThread = store.threads.first(where: { $0.conversationId == "connected-session-unread-failure" }) else {
            XCTFail("Expected connected thread")
            return
        }

        store.markThreadUnread(storedThread)
        waitForAsyncMutation()

        guard let updatedThread = store.threads.first(where: { $0.id == storedThread.id }) else {
            XCTFail("Expected updated thread")
            return
        }

        XCTAssertFalse(updatedThread.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(updatedThread.lastSeenAssistantMessageAt?.timeIntervalSince1970, 5.0)
    }

    func testMarkingThreadWithoutAssistantReplyUnreadDoesNothing() {
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationUnreadSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationUnreadSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSThreadStore(daemonClient: daemonClient)
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
        guard let storedThread = store.threads.first(where: { $0.conversationId == "connected-session-6" }) else {
            XCTFail("Expected connected thread")
            return
        }

        store.markThreadUnread(storedThread)

        XCTAssertTrue(sentSignals.isEmpty)
        XCTAssertFalse(store.threads.first(where: { $0.id == storedThread.id })?.hasUnseenLatestAssistantMessage ?? true)
    }

    func testMarkingThreadWithLoadedAssistantReplyUnreadUsesLocalMessageTimestamp() {
        let daemonClient = DaemonClient()
        var sentSignals: [ConversationUnreadSignal] = []
        daemonClient.sendOverride = { message in
            if let signal = message as? ConversationUnreadSignal {
                sentSignals.append(signal)
            }
        }

        let store = IOSThreadStore(daemonClient: daemonClient)
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
        guard let storedThread = store.threads.first(where: { $0.conversationId == "connected-session-live-assistant" }) else {
            XCTFail("Expected connected thread")
            return
        }

        let vm = store.viewModel(for: storedThread.id)
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(
            text: "Fresh assistant reply",
            conversationId: "connected-session-live-assistant"
        )))
        vm.flushStreamingBuffer()
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage(
            conversationId: "connected-session-live-assistant"
        )))

        store.markThreadUnread(storedThread)
        waitForAsyncMutation()

        guard let updatedThread = store.threads.first(where: { $0.id == storedThread.id }) else {
            XCTFail("Expected updated thread")
            return
        }

        XCTAssertTrue(updatedThread.hasUnseenLatestAssistantMessage)
        XCTAssertNil(updatedThread.lastSeenAssistantMessageAt)
        XCTAssertNotNil(updatedThread.latestAssistantMessageAt)
        XCTAssertEqual(sentSignals.count, 1)

        let reloadedStore = IOSThreadStore(daemonClient: daemonClient)
        guard let cachedThread = reloadedStore.threads.first(where: { $0.conversationId == "connected-session-live-assistant" }) else {
            XCTFail("Expected cached connected thread")
            return
        }

        XCTAssertTrue(cachedThread.hasUnseenLatestAssistantMessage)
        XCTAssertNotNil(cachedThread.latestAssistantMessageAt)
    }

    func testConversationListRefreshPreservesLocalSeenUntilDaemonCatchesUp() {
        let daemonClient = DaemonClient()
        let store = IOSThreadStore(daemonClient: daemonClient)

        let initialResponse = makeConversationListResponse(conversations: [[
            "id": "connected-session-refresh-seen",
            "title": "Unread thread",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 4_000,
            ],
        ]])
        daemonClient.onConversationListResponse?(initialResponse)

        guard let storedThread = store.threads.first(where: { $0.conversationId == "connected-session-refresh-seen" }) else {
            XCTFail("Expected connected thread")
            return
        }

        store.markConversationSeenIfNeeded(threadId: storedThread.id)

        let staleResponse = makeConversationListResponse(conversations: [[
            "id": "connected-session-refresh-seen",
            "title": "Unread thread",
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
            store.threads.first(where: { $0.conversationId == "connected-session-refresh-seen" })?.hasUnseenLatestAssistantMessage ?? true
        )
    }

    func testConversationListRefreshPreservesLocalUnreadUntilDaemonCatchesUp() {
        let daemonClient = DaemonClient()
        let store = IOSThreadStore(daemonClient: daemonClient)

        let initialResponse = makeConversationListResponse(conversations: [[
            "id": "connected-session-refresh-unread",
            "title": "Seen thread",
            "createdAt": 1_000,
            "updatedAt": 2_000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": false,
                "latestAssistantMessageAt": 5_000,
                "lastSeenAssistantMessageAt": 5_000,
            ],
        ]])
        daemonClient.onConversationListResponse?(initialResponse)

        guard let storedThread = store.threads.first(where: { $0.conversationId == "connected-session-refresh-unread" }) else {
            XCTFail("Expected connected thread")
            return
        }

        store.markThreadUnread(storedThread)

        let staleResponse = makeConversationListResponse(conversations: [[
            "id": "connected-session-refresh-unread",
            "title": "Seen thread",
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
            store.threads.first(where: { $0.conversationId == "connected-session-refresh-unread" })?.hasUnseenLatestAssistantMessage ?? false
        )
    }

    func testPinningConnectedThreadUpdatesLocalStateAndEmitsReorder() {
        let daemonClient = DaemonClient()
        var reorderRequests: [ReorderConversationsRequest] = []
        daemonClient.sendOverride = { message in
            if let request = message as? ReorderConversationsRequest {
                reorderRequests.append(request)
            }
        }

        let store = IOSThreadStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [
            [
                "id": "connected-session-pinned",
                "title": "Pinned thread",
                "createdAt": 1_000,
                "updatedAt": 2_000,
                "displayOrder": 0,
                "isPinned": true,
            ],
            [
                "id": "connected-session-unpinned",
                "title": "Unpinned thread",
                "createdAt": 1_000,
                "updatedAt": 3_000,
            ],
        ])

        daemonClient.onConversationListResponse?(response)
        guard let thread = store.threads.first(where: { $0.conversationId == "connected-session-unpinned" }) else {
            XCTFail("Expected unpinned connected thread")
            return
        }

        store.pinThread(thread)

        guard let updatedThread = store.threads.first(where: { $0.id == thread.id }) else {
            XCTFail("Expected updated thread")
            return
        }

        XCTAssertTrue(updatedThread.isPinned)
        XCTAssertEqual(updatedThread.displayOrder, 1)
        XCTAssertEqual(reorderRequests.count, 1)

        let updatesBySessionId = Dictionary(
            uniqueKeysWithValues: reorderRequests[0].updates.map { ($0.conversationId, $0) }
        )
        XCTAssertEqual(updatesBySessionId["connected-session-pinned"]?.displayOrder, 0)
        XCTAssertEqual(updatesBySessionId["connected-session-pinned"]?.isPinned, true)
        XCTAssertEqual(updatesBySessionId["connected-session-unpinned"]?.displayOrder, 1)
        XCTAssertEqual(updatesBySessionId["connected-session-unpinned"]?.isPinned, true)
    }

    func testPinningConnectedThreadSurvivesStaleSessionRefresh() {
        let daemonClient = DaemonClient()
        let store = IOSThreadStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [
            [
                "id": "connected-session-pinned",
                "title": "Pinned thread",
                "createdAt": 1_000,
                "updatedAt": 2_000,
                "displayOrder": 0,
                "isPinned": true,
            ],
            [
                "id": "connected-session-unpinned",
                "title": "Unpinned thread",
                "createdAt": 1_000,
                "updatedAt": 3_000,
            ],
        ])

        daemonClient.onConversationListResponse?(response)
        guard let thread = store.threads.first(where: { $0.conversationId == "connected-session-unpinned" }) else {
            XCTFail("Expected unpinned connected thread")
            return
        }

        store.pinThread(thread)
        daemonClient.onConversationListResponse?(response)

        guard let updatedThread = store.threads.first(where: { $0.id == thread.id }) else {
            XCTFail("Expected updated thread")
            return
        }

        XCTAssertTrue(updatedThread.isPinned)
        XCTAssertEqual(updatedThread.displayOrder, 1)
    }

    func testUnpinningConnectedThreadRecompactsPinnedOrderAndEmitsReorder() {
        let daemonClient = DaemonClient()
        var reorderRequests: [ReorderConversationsRequest] = []
        daemonClient.sendOverride = { message in
            if let request = message as? ReorderConversationsRequest {
                reorderRequests.append(request)
            }
        }

        let store = IOSThreadStore(daemonClient: daemonClient)
        let response = makeConversationListResponse(conversations: [
            [
                "id": "connected-session-first",
                "title": "First pinned thread",
                "createdAt": 1_000,
                "updatedAt": 2_000,
                "displayOrder": 0,
                "isPinned": true,
            ],
            [
                "id": "connected-session-second",
                "title": "Second pinned thread",
                "createdAt": 1_000,
                "updatedAt": 3_000,
                "displayOrder": 1,
                "isPinned": true,
            ],
        ])

        daemonClient.onConversationListResponse?(response)
        guard let thread = store.threads.first(where: { $0.conversationId == "connected-session-first" }) else {
            XCTFail("Expected pinned connected thread")
            return
        }

        store.unpinThread(thread)

        guard let firstThread = store.threads.first(where: { $0.conversationId == "connected-session-first" }),
              let secondThread = store.threads.first(where: { $0.conversationId == "connected-session-second" }) else {
            XCTFail("Expected connected threads")
            return
        }

        XCTAssertFalse(firstThread.isPinned)
        XCTAssertNil(firstThread.displayOrder)
        XCTAssertTrue(secondThread.isPinned)
        XCTAssertEqual(secondThread.displayOrder, 0)
        XCTAssertEqual(reorderRequests.count, 1)

        let updatesBySessionId = Dictionary(
            uniqueKeysWithValues: reorderRequests[0].updates.map { ($0.conversationId, $0) }
        )
        XCTAssertNil(updatesBySessionId["connected-session-first"]?.displayOrder)
        XCTAssertEqual(updatesBySessionId["connected-session-first"]?.isPinned, false)
        XCTAssertEqual(updatesBySessionId["connected-session-second"]?.displayOrder, 0)
        XCTAssertEqual(updatesBySessionId["connected-session-second"]?.isPinned, true)
    }

    func testPinningStandaloneThreadDoesNothing() {
        let store = IOSThreadStore(daemonClient: mockClient)
        let thread = store.threads[0]

        store.pinThread(thread)

        XCTAssertFalse(store.threads[0].isPinned)
        XCTAssertNil(store.threads[0].displayOrder)
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
