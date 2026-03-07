import XCTest
@testable import VellumAssistantShared

#if canImport(UIKit)
@testable import vellum_assistant_ios
#endif

/// Integration tests for thread lifecycle behaviors from the iOS perspective.
/// Since ThreadModel and ThreadManager are macOS-only, these tests verify the
/// shared session lifecycle mechanics that underpin thread management:
/// session creation, session info backfill, bootstrap correlation, and session reuse.
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

    private func makeSessionListResponse(
        sessions: [[String: Any]],
        hasMore: Bool? = nil
    ) -> SessionListResponseMessage {
        var payload: [String: Any] = [
            "type": "session_list_response",
            "sessions": sessions,
        ]
        if let hasMore {
            payload["hasMore"] = hasMore
        }
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(SessionListResponseMessage.self, from: data)
    }

    // MARK: - Session Create (Thread Bootstrap)

    func testCreateSessionIfNeededSetsBootstrapState() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createSessionIfNeeded()

        XCTAssertFalse(vm.isSending, "Message-less session creates should not set isSending")
        XCTAssertTrue(vm.isBootstrapping, "Should be bootstrapping after createSessionIfNeeded")
    }

    func testCreateSessionSendsSessionCreateMessage() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createSessionIfNeeded()

        // Poll until session_create appears in sentMessages (message-driven wait)
        let expectation = XCTestExpectation(description: "session_create sent")
        var cancelled = false
        func poll() {
            guard !cancelled else { return }
            let found = mockClient.sentMessages.contains { $0 is SessionCreateMessage }
            if found {
                expectation.fulfill()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { poll() }
            }
        }
        poll()
        wait(for: [expectation], timeout: 2.0)
        cancelled = true

        let sessionCreates = mockClient.sentMessages.compactMap { $0 as? SessionCreateMessage }
        XCTAssertEqual(sessionCreates.count, 1, "Should send exactly one session_create")
    }

    func testCreateSessionWithThreadTypeSetsThreadType() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createSessionIfNeeded(threadType: "private")

        XCTAssertEqual(vm.threadType, "private")
    }

    func testCreateSessionWithThreadTypeSendsThreadType() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createSessionIfNeeded(threadType: "private")

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

        let sessionCreates = mockClient.sentMessages.compactMap { $0 as? SessionCreateMessage }
        XCTAssertEqual(sessionCreates.first?.threadType, "private")
    }

    // MARK: - Session Info Backfill (Thread Session Assignment)

    func testSessionInfoBackfillsSessionId() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createSessionIfNeeded()

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

        // Extract the correlation ID from the sent message
        let sessionCreates = mockClient.sentMessages.compactMap { $0 as? SessionCreateMessage }
        let correlationId = sessionCreates.first?.correlationId

        // Simulate daemon responding with session_info
        let info = SessionInfoMessage(sessionId: "ios-thread-sess-42", title: "Thread", correlationId: correlationId)
        vm.handleServerMessage(.sessionInfo(info))

        XCTAssertEqual(vm.sessionId, "ios-thread-sess-42")
        XCTAssertFalse(vm.isBootstrapping, "Should no longer be bootstrapping after session_info")
        XCTAssertFalse(vm.isSending, "Should reset isSending after message-less session create")
    }

    func testSessionInfoWithWrongCorrelationIdIsIgnored() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.createSessionIfNeeded()

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

        // Send session_info with a different correlation ID
        let info = SessionInfoMessage(sessionId: "wrong-sess", title: "Wrong", correlationId: "wrong-correlation-id")
        vm.handleServerMessage(.sessionInfo(info))

        XCTAssertNil(vm.sessionId, "Should not accept session_info with mismatched correlation ID")
        XCTAssertTrue(vm.isBootstrapping, "Should still be bootstrapping")
    }

    func testOnSessionCreatedCallbackFiresDuringBackfill() {
        let vm = ChatViewModel(daemonClient: mockClient)
        var capturedSessionId: String?
        vm.onSessionCreated = { sessionId in
            capturedSessionId = sessionId
        }
        vm.createSessionIfNeeded()

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

        let sessionCreates = mockClient.sentMessages.compactMap { $0 as? SessionCreateMessage }
        let correlationId = sessionCreates.first?.correlationId

        let info = SessionInfoMessage(sessionId: "callback-thread-sess", title: "Callback", correlationId: correlationId)
        vm.handleServerMessage(.sessionInfo(info))

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

        // Extract the correlation ID from the sent session_create message
        let sessionCreates = mockClient.sentMessages.compactMap { $0 as? SessionCreateMessage }
        let correlationId = sessionCreates.first?.correlationId

        // Step 2: Session info arrives with matching correlation ID
        let info = SessionInfoMessage(sessionId: "thread-sess-1", title: "New Thread", correlationId: correlationId)
        vm.handleServerMessage(.sessionInfo(info))
        XCTAssertEqual(vm.sessionId, "thread-sess-1")

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
        vm.sessionId = "existing-sess"

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

        vm1.sessionId = "sess-thread-1"
        vm2.sessionId = "sess-thread-2"

        vm1.inputText = "Thread 1 message"
        vm1.sendMessage()

        vm2.inputText = "Thread 2 message"
        vm2.sendMessage()

        XCTAssertEqual(vm1.messages.count, 1)
        XCTAssertEqual(vm1.messages[0].text, "Thread 1 message")

        XCTAssertEqual(vm2.messages.count, 1)
        XCTAssertEqual(vm2.messages[0].text, "Thread 2 message")
    }

    func testSessionBoundDeltasOnlyAffectMatchingViewModel() {
        let vm1 = ChatViewModel(daemonClient: mockClient)
        let vm2 = ChatViewModel(daemonClient: mockClient)

        vm1.sessionId = "sess-a"
        vm2.sessionId = "sess-b"

        // Delta for session A
        let deltaA = AssistantTextDeltaMessage(text: "For A", sessionId: "sess-a")
        vm1.handleServerMessage(.assistantTextDelta(deltaA))
        vm1.flushStreamingBuffer()
        vm2.handleServerMessage(.assistantTextDelta(deltaA))
        vm2.flushStreamingBuffer()

        XCTAssertEqual(vm1.messages.count, 1, "VM1 should accept delta for its session")
        XCTAssertTrue(vm2.messages.isEmpty, "VM2 should ignore delta for a different session")
    }

    // MARK: - Error Recovery in Session

    func testErrorDuringSessionDoesNotDestroyMessages() {
        let vm = ChatViewModel(daemonClient: mockClient)
        vm.sessionId = "sess-error"

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
        let response = makeSessionListResponse(sessions: [[
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

        daemonClient.onSessionListResponse?(response)

        guard let storedThread = store.threads.first(where: { $0.sessionId == "connected-session-1" }) else {
            XCTFail("Expected connected thread")
            return
        }

        XCTAssertTrue(storedThread.isPinned)
        XCTAssertEqual(storedThread.displayOrder, 7)
        XCTAssertTrue(storedThread.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(storedThread.latestAssistantMessageAt?.timeIntervalSince1970, 5.0)
        XCTAssertEqual(storedThread.lastSeenAssistantMessageAt?.timeIntervalSince1970, 4.0)

        let reloadedStore = IOSThreadStore(daemonClient: daemonClient)
        guard let cachedThread = reloadedStore.threads.first(where: { $0.sessionId == "connected-session-1" }) else {
            XCTFail("Expected cached connected thread")
            return
        }

        XCTAssertTrue(cachedThread.isPinned)
        XCTAssertEqual(cachedThread.displayOrder, 7)
        XCTAssertTrue(cachedThread.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(cachedThread.latestAssistantMessageAt?.timeIntervalSince1970, 5.0)
        XCTAssertEqual(cachedThread.lastSeenAssistantMessageAt?.timeIntervalSince1970, 4.0)
    }
    #endif
}
