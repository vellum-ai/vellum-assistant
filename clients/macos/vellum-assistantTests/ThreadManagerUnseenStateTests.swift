import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ThreadManagerUnseenStateTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var threadManager: ThreadManager!
    private var sentMessages: [Any] = []

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

    override func setUp() {
        super.setUp()
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        daemonClient.sendOverride = { [weak self] message in
            self?.sentMessages.append(message)
        }
        threadManager = ThreadManager(daemonClient: daemonClient)
        threadManager.createThread()
    }

    override func tearDown() {
        daemonClient?.sendOverride = nil
        threadManager = nil
        daemonClient = nil
        sentMessages = []
        super.tearDown()
    }

    func testInactiveStandardThreadMarkedUnseenWhenAssistantReplies() {
        guard let initialThreadId = threadManager.activeThreadId else {
            XCTFail("Expected an initial active thread")
            return
        }
        threadManager.chatViewModel(for: initialThreadId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        threadManager.createThread()
        let activeThreadId = threadManager.activeThreadId
        XCTAssertNotEqual(initialThreadId, activeThreadId)

        guard let vm = threadManager.chatViewModel(for: initialThreadId) else {
            XCTFail("Expected ChatViewModel for inactive thread")
            return
        }

        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Background reply")))
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        waitForPropagation()

        guard let updated = threadManager.threads.first(where: { $0.id == initialThreadId }) else {
            XCTFail("Expected thread to exist")
            return
        }

        XCTAssertNil(updated.source, "Regression guard: should work for normal (non-notification) threads")
        XCTAssertTrue(updated.hasUnseenLatestAssistantMessage)
    }

    func testInactiveThreadMarkedUnseenWhenAssistantContinuesSameMessageAfterSwitch() {
        guard let initialThreadId = threadManager.activeThreadId,
              let initialVm = threadManager.chatViewModel(for: initialThreadId),
              let initialIndex = threadManager.threads.firstIndex(where: { $0.id == initialThreadId }) else {
            XCTFail("Expected an initial active thread and VM")
            return
        }

        threadManager.threads[initialIndex].sessionId = "session-initial"
        initialVm.sessionId = "session-initial"
        initialVm.messages.append(ChatMessage(role: .user, text: "Seed"))

        initialVm.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "First chunk", sessionId: "session-initial")
        ))
        waitForPropagation()
        XCTAssertFalse(threadManager.threads[initialIndex].hasUnseenLatestAssistantMessage)

        threadManager.createThread()
        guard let secondaryThreadId = threadManager.activeThreadId,
              let secondaryIndex = threadManager.threads.firstIndex(where: { $0.id == secondaryThreadId }),
              let secondaryVm = threadManager.chatViewModel(for: secondaryThreadId) else {
            XCTFail("Expected a secondary active thread and VM")
            return
        }

        threadManager.threads[secondaryIndex].sessionId = "session-secondary"
        secondaryVm.sessionId = "session-secondary"
        threadManager.selectThread(id: secondaryThreadId)

        initialVm.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: " + second chunk", sessionId: "session-initial")
        ))
        initialVm.handleServerMessage(.messageComplete(
            MessageCompleteMessage(sessionId: "session-initial")
        ))

        waitForPropagation()

        guard let updated = threadManager.threads.first(where: { $0.id == initialThreadId }) else {
            XCTFail("Expected thread to exist")
            return
        }
        XCTAssertTrue(updated.hasUnseenLatestAssistantMessage)
    }

    func testActiveThreadEmitsSeenSignalOnNewMessageAndStreamCompletion() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }),
              let vm = threadManager.chatViewModel(for: threadId) else {
            XCTFail("Expected active thread and view model")
            return
        }

        threadManager.threads[index].sessionId = "session-realtime"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = false
        vm.sessionId = "session-realtime"

        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Streaming reply", sessionId: "session-realtime")))
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage(sessionId: "session-realtime")))

        waitForPropagation()

        XCTAssertFalse(threadManager.threads[index].hasUnseenLatestAssistantMessage)

        let seenSignals = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
        XCTAssertFalse(seenSignals.isEmpty, "Seen signal should be emitted on new message arrival and stream completion")
        XCTAssertEqual(seenSignals.last?.conversationId, "session-realtime")
    }

    func testUnseenVisibleConversationCountExcludesArchivedThreads() {
        // Start with the initial thread created by setUp
        guard let threadId = threadManager.activeThreadId,
              threadManager.threads.firstIndex(where: { $0.id == threadId }) != nil else {
            XCTFail("Expected an initial active thread")
            return
        }

        // Seed a user message so createThread doesn't skip
        threadManager.chatViewModel(for: threadId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        // Switch away so the initial thread becomes inactive
        threadManager.createThread()
        XCTAssertNotEqual(threadManager.activeThreadId, threadId)

        // Mark the initial thread as unseen
        if let idx = threadManager.threads.firstIndex(where: { $0.id == threadId }) {
            threadManager.threads[idx].hasUnseenLatestAssistantMessage = true
        }
        XCTAssertEqual(threadManager.unseenVisibleConversationCount, 1)

        // Archive it — count should drop to 0
        threadManager.archiveThread(id: threadId)
        XCTAssertEqual(threadManager.unseenVisibleConversationCount, 0)
    }

    func testUnseenVisibleConversationCountExcludesPrivateThreads() {
        // Create a private thread (this switches activeThreadId to the private thread)
        threadManager.createPrivateThread()
        guard let privateId = threadManager.activeThreadId,
              let idx = threadManager.threads.firstIndex(where: { $0.id == privateId }) else {
            XCTFail("Expected a private thread")
            return
        }

        // Mark the private thread as unseen
        threadManager.threads[idx].hasUnseenLatestAssistantMessage = true

        // Private threads are excluded from the visible count
        XCTAssertEqual(threadManager.unseenVisibleConversationCount, 0)
    }

    func testUnseenVisibleConversationCountIncludesMultipleUnseen() {
        // Start with the initial thread
        guard let firstId = threadManager.activeThreadId else {
            XCTFail("Expected an initial active thread")
            return
        }
        // Seed a user message so createThread actually creates a new one
        threadManager.chatViewModel(for: firstId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        // Create a second thread
        threadManager.createThread()
        guard let secondId = threadManager.activeThreadId, secondId != firstId else {
            XCTFail("Expected a different second thread")
            return
        }
        // Seed the second thread too
        threadManager.chatViewModel(for: secondId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        // Create a third thread (becomes active)
        threadManager.createThread()
        guard let thirdId = threadManager.activeThreadId, thirdId != secondId else {
            XCTFail("Expected a different third thread")
            return
        }

        // Mark first and second as unseen
        if let idx = threadManager.threads.firstIndex(where: { $0.id == firstId }) {
            threadManager.threads[idx].hasUnseenLatestAssistantMessage = true
        }
        if let idx = threadManager.threads.firstIndex(where: { $0.id == secondId }) {
            threadManager.threads[idx].hasUnseenLatestAssistantMessage = true
        }

        XCTAssertEqual(threadManager.unseenVisibleConversationCount, 2)
    }

    func testSelectingThreadDecrementsUnseenCount() {
        // Start with the initial thread
        guard let firstId = threadManager.activeThreadId else {
            XCTFail("Expected an initial active thread")
            return
        }
        // Seed so createThread proceeds
        threadManager.chatViewModel(for: firstId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        // Create a second thread (becomes active)
        threadManager.createThread()
        guard let secondId = threadManager.activeThreadId, secondId != firstId else {
            XCTFail("Expected a different second thread")
            return
        }

        // Mark the first (inactive) thread as unseen and give it a sessionId
        // (selectThread only clears unseen when sessionId is present)
        if let idx = threadManager.threads.firstIndex(where: { $0.id == firstId }) {
            threadManager.threads[idx].hasUnseenLatestAssistantMessage = true
            threadManager.threads[idx].sessionId = "session-first"
        }
        XCTAssertEqual(threadManager.unseenVisibleConversationCount, 1)

        sentMessages.removeAll()

        // Select the unseen thread — should clear its unseen flag and emit seen signal
        threadManager.selectThread(id: firstId)
        XCTAssertEqual(threadManager.unseenVisibleConversationCount, 0)

        let seenSignals = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
        XCTAssertFalse(seenSignals.isEmpty, "selectThread should emit a seen signal to the daemon")
        XCTAssertEqual(seenSignals.last?.conversationId, "session-first")
    }

    func testMarkConversationSeenEmitsSignalAndClearsFlag() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active thread")
            return
        }

        threadManager.threads[index].sessionId = "session-mark-seen"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = true
        XCTAssertEqual(threadManager.unseenVisibleConversationCount, 1)

        sentMessages.removeAll()

        threadManager.markConversationSeen(threadId: threadId)

        XCTAssertFalse(threadManager.threads[index].hasUnseenLatestAssistantMessage,
                       "markConversationSeen should clear the unseen flag")
        XCTAssertEqual(threadManager.unseenVisibleConversationCount, 0)

        let seenSignals = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
        XCTAssertFalse(seenSignals.isEmpty, "markConversationSeen should emit a seen signal to the daemon")
        XCTAssertEqual(seenSignals.last?.conversationId, "session-mark-seen")
    }

    func testMarkConversationUnreadEmitsSignalAndSetsFlag() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active thread")
            return
        }

        threadManager.threads[index].sessionId = "session-mark-unread"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = false
        threadManager.threads[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)

        sentMessages.removeAll()

        threadManager.markConversationUnread(threadId: threadId)
        waitForPropagation()

        XCTAssertTrue(threadManager.threads[index].hasUnseenLatestAssistantMessage,
                      "markConversationUnread should set the unseen flag")

        let unreadSignals = sentMessages.compactMap { $0 as? IPCConversationUnreadSignal }
        XCTAssertEqual(unreadSignals.count, 1, "markConversationUnread should emit a single unread signal")
        XCTAssertEqual(unreadSignals.last?.conversationId, "session-mark-unread")
    }

    func testMarkConversationUnreadDoesNotEmitDuplicateSignalForUnreadThread() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active thread")
            return
        }

        threadManager.threads[index].sessionId = "session-already-unread"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = true
        threadManager.threads[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)

        sentMessages.removeAll()

        threadManager.markConversationUnread(threadId: threadId)

        let unreadSignals = sentMessages.compactMap { $0 as? IPCConversationUnreadSignal }
        XCTAssertTrue(unreadSignals.isEmpty, "Already-unread threads should not emit duplicate unread signals")
        XCTAssertTrue(threadManager.threads[index].hasUnseenLatestAssistantMessage)
    }

    func testMarkConversationUnreadAllowsLiveAssistantReplyWithoutHydratedTimestamp() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }),
              let vm = threadManager.chatViewModel(for: threadId) else {
            XCTFail("Expected an initial active thread and view model")
            return
        }

        threadManager.threads[index].sessionId = "session-live-unread"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = false
        threadManager.threads[index].latestAssistantMessageAt = nil
        vm.sessionId = "session-live-unread"

        vm.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Live reply", sessionId: "session-live-unread")
        ))
        waitForPropagation()

        threadManager.threads[index].latestAssistantMessageAt = nil
        sentMessages.removeAll()

        threadManager.markConversationUnread(threadId: threadId)
        waitForPropagation()

        XCTAssertTrue(threadManager.threads[index].hasUnseenLatestAssistantMessage,
                      "Live assistant replies should allow unread even before hydration backfills timestamps")

        let unreadSignals = sentMessages.compactMap { $0 as? IPCConversationUnreadSignal }
        XCTAssertEqual(unreadSignals.count, 1)
        XCTAssertEqual(unreadSignals.last?.conversationId, "session-live-unread")
    }

    func testMarkConversationUnreadRollsBackWhenSendFails() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active thread")
            return
        }

        daemonClient.sendOverride = { _ in
            throw NSError(domain: "ThreadManagerUnseenStateTests", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "offline"
            ])
        }

        threadManager.threads[index].sessionId = "session-unread-failure"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = false
        threadManager.threads[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)
        threadManager.threads[index].lastSeenAssistantMessageAt = Date(timeIntervalSince1970: 9)

        threadManager.markConversationUnread(threadId: threadId)
        waitForPropagation()

        XCTAssertFalse(threadManager.threads[index].hasUnseenLatestAssistantMessage)
        XCTAssertEqual(
            threadManager.threads[index].lastSeenAssistantMessageAt,
            Date(timeIntervalSince1970: 9)
        )
    }

    func testUnreadRollbackRequeuesDeferredSeenSignal() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active thread")
            return
        }

        threadManager.threads[index].sessionId = "session-requeue"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = true
        threadManager.threads[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 5)

        // mark-all-seen defers the seen signal
        threadManager.markAllThreadsSeen()

        // Fail only unread signals so markConversationUnread triggers rollback,
        // while allowing seen signals from commitPendingSeenSignals to succeed.
        daemonClient.sendOverride = { [weak self] message in
            if message is IPCConversationUnreadSignal {
                throw NSError(domain: "ThreadManagerUnseenStateTests", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "offline"
                ])
            }
            self?.sentMessages.append(message)
        }

        sentMessages.removeAll()

        threadManager.markConversationUnread(threadId: threadId)
        waitForPropagation()

        // After rollback the deferred seen signal should be re-queued,
        // so committing should emit a seen signal for the session.
        threadManager.commitPendingSeenSignals()

        let seenSignals = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
        XCTAssertEqual(seenSignals.map(\.conversationId), ["session-requeue"])
    }

    func testMarkConversationUnreadIgnoresThreadsWithoutAssistantReply() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active thread")
            return
        }

        threadManager.threads[index].sessionId = "session-no-assistant-reply"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = false
        threadManager.threads[index].latestAssistantMessageAt = nil

        sentMessages.removeAll()

        threadManager.markConversationUnread(threadId: threadId)

        let unreadSignals = sentMessages.compactMap { $0 as? IPCConversationUnreadSignal }
        XCTAssertTrue(unreadSignals.isEmpty, "Threads without assistant replies should not emit unread signals")
        XCTAssertFalse(threadManager.threads[index].hasUnseenLatestAssistantMessage)
    }

    func testAttentionMergePreservesLocalSeenUntilDaemonAcknowledgesIt() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active thread")
            return
        }

        threadManager.threads[index].sessionId = "session-refresh-seen"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = true
        threadManager.threads[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)
        threadManager.threads[index].lastSeenAssistantMessageAt = Date(timeIntervalSince1970: 8)

        threadManager.markConversationSeen(threadId: threadId)

        let staleResponse = makeSessionListResponse(
            sessions: [[
                "id": "session-refresh-seen",
                "title": "Restored thread",
                "createdAt": 5_000,
                "updatedAt": 6_000,
                "assistantAttention": [
                    "hasUnseenLatestAssistantMessage": true,
                    "latestAssistantMessageAt": 9_000,
                    "lastSeenAssistantMessageAt": 8_000,
                ],
            ]]
        )
        guard let session = staleResponse.sessions.first else {
            XCTFail("Expected response session")
            return
        }

        threadManager.mergeAssistantAttention(from: session, intoThreadAt: index)

        XCTAssertFalse(
            threadManager.threads.first(where: { $0.sessionId == "session-refresh-seen" })?.hasUnseenLatestAssistantMessage ?? true
        )
    }

    func testAppendThreadsPreservesLocalUnreadUntilDaemonAcknowledgesIt() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active thread")
            return
        }

        threadManager.threads[index].sessionId = "session-refresh-unread"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = false
        threadManager.threads[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)
        threadManager.threads[index].lastSeenAssistantMessageAt = Date(timeIntervalSince1970: 9)

        threadManager.markConversationUnread(threadId: threadId)

        let staleResponse = makeSessionListResponse(
            sessions: [[
                "id": "session-refresh-unread",
                "title": "Paginated thread",
                "createdAt": 5_000,
                "updatedAt": 6_000,
                "assistantAttention": [
                    "hasUnseenLatestAssistantMessage": false,
                    "latestAssistantMessageAt": 9_000,
                    "lastSeenAssistantMessageAt": 9_000,
                ],
            ]]
        )

        threadManager.appendThreads(from: staleResponse)

        XCTAssertTrue(
            threadManager.threads.first(where: { $0.sessionId == "session-refresh-unread" })?.hasUnseenLatestAssistantMessage ?? false
        )
    }

    func testMarkConversationUnreadRemovesPendingSeenSignalForSameSession() {
        guard let firstThreadId = threadManager.activeThreadId,
              let firstIndex = threadManager.threads.firstIndex(where: { $0.id == firstThreadId }) else {
            XCTFail("Expected an initial active thread")
            return
        }

        threadManager.threads[firstIndex].sessionId = "session-first"
        threadManager.threads[firstIndex].hasUnseenLatestAssistantMessage = true
        threadManager.threads[firstIndex].latestAssistantMessageAt = Date(timeIntervalSince1970: 1)
        threadManager.chatViewModel(for: firstThreadId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        threadManager.createThread()

        guard let secondThreadId = threadManager.activeThreadId,
              let secondIndex = threadManager.threads.firstIndex(where: { $0.id == secondThreadId }) else {
            XCTFail("Expected a second active thread")
            return
        }

        threadManager.threads[secondIndex].sessionId = "session-second"
        threadManager.threads[secondIndex].hasUnseenLatestAssistantMessage = true
        threadManager.threads[secondIndex].latestAssistantMessageAt = Date(timeIntervalSince1970: 2)

        sentMessages.removeAll()

        let markedIds = Set(threadManager.markAllThreadsSeen())
        XCTAssertEqual(markedIds, Set([firstThreadId, secondThreadId]))

        threadManager.markConversationUnread(threadId: firstThreadId)
        threadManager.commitPendingSeenSignals()
        waitForPropagation()

        let unreadSignals = sentMessages.compactMap { $0 as? IPCConversationUnreadSignal }
        XCTAssertEqual(unreadSignals.map(\.conversationId), ["session-first"])

        let seenSignals = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
        XCTAssertEqual(seenSignals.map(\.conversationId), ["session-second"])

        XCTAssertTrue(threadManager.threads.contains(where: {
            $0.id == firstThreadId && $0.hasUnseenLatestAssistantMessage
        }))
        XCTAssertTrue(threadManager.threads.contains(where: {
            $0.id == secondThreadId && !$0.hasUnseenLatestAssistantMessage
        }))
    }

    func testActiveThreadDoesNotEmitSeenSignalOnEveryStreamingDelta() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }),
              let vm = threadManager.chatViewModel(for: threadId) else {
            XCTFail("Expected active thread and view model")
            return
        }

        threadManager.threads[index].sessionId = "session-streaming"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = false
        vm.sessionId = "session-streaming"

        // First delta creates a new message — should emit one seen signal
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "chunk1", sessionId: "session-streaming")))
        waitForPropagation()

        let signalsAfterFirstDelta = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
            .filter { $0.conversationId == "session-streaming" }
        let countAfterFirst = signalsAfterFirstDelta.count

        // Subsequent deltas on the same message should NOT emit additional seen signals
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " chunk2", sessionId: "session-streaming")))
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " chunk3", sessionId: "session-streaming")))
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " chunk4", sessionId: "session-streaming")))
        waitForPropagation()

        let signalsAfterMoreDeltas = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
            .filter { $0.conversationId == "session-streaming" }
        XCTAssertEqual(signalsAfterMoreDeltas.count, countAfterFirst,
                       "Mid-stream text deltas should not emit additional seen signals (was O(n), should be O(1))")

        // Stream completion should emit one more seen signal
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage(sessionId: "session-streaming")))
        waitForPropagation()

        let signalsAfterComplete = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
            .filter { $0.conversationId == "session-streaming" }
        XCTAssertEqual(signalsAfterComplete.count, countAfterFirst + 1,
                       "Stream completion should emit exactly one additional seen signal")
    }

    func testActiveThreadAssistantReplyClearsUnseenAndEmitsSeenSignal() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }),
              let vm = threadManager.chatViewModel(for: threadId) else {
            XCTFail("Expected active thread and view model")
            return
        }

        threadManager.threads[index].sessionId = "session-active"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = true
        vm.sessionId = "session-active"

        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Visible reply", sessionId: "session-active")))
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage(sessionId: "session-active")))

        waitForPropagation()

        XCTAssertFalse(threadManager.threads[index].hasUnseenLatestAssistantMessage)

        let seenSignals = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
        XCTAssertEqual(seenSignals.last?.conversationId, "session-active")
    }

    func testAppendThreadsPreservesAssistantAttentionTimestamps() {
        let response = makeSessionListResponse(
            sessions: [[
                "id": "session-paginated",
                "title": "Paginated thread",
                "createdAt": 5_000,
                "updatedAt": 6_000,
                "assistantAttention": [
                    "hasUnseenLatestAssistantMessage": false,
                    "latestAssistantMessageAt": 9_000,
                    "lastSeenAssistantMessageAt": 9_000,
                ],
            ]],
            hasMore: false
        )

        threadManager.appendThreads(from: response)

        guard let appendedThread = threadManager.threads.first(where: { $0.sessionId == "session-paginated" }) else {
            XCTFail("Expected appended thread")
            return
        }

        XCTAssertFalse(appendedThread.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(appendedThread.latestAssistantMessageAt?.timeIntervalSince1970, 9.0)
        XCTAssertEqual(appendedThread.lastSeenAssistantMessageAt?.timeIntervalSince1970, 9.0)
    }

    private func waitForPropagation() {
        let exp = expectation(description: "combine propagation")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }
}
