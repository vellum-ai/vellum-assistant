import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerUnseenStateTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var conversationManager: ConversationManager!
    private var sentMessages: [Any] = []

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

    override func setUp() {
        super.setUp()
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        daemonClient.sendOverride = { [weak self] message in
            self?.sentMessages.append(message)
        }
        conversationManager = ConversationManager(daemonClient: daemonClient)
        conversationManager.createConversation()
    }

    override func tearDown() {
        daemonClient?.sendOverride = nil
        conversationManager = nil
        daemonClient = nil
        sentMessages = []
        super.tearDown()
    }

    func testInactiveStandardThreadMarkedUnseenWhenAssistantReplies() {
        guard let initialThreadId = conversationManager.activeConversationId else {
            XCTFail("Expected an initial active conversation")
            return
        }
        conversationManager.chatViewModel(for: initialThreadId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        conversationManager.createConversation()
        let activeConversationId = conversationManager.activeConversationId
        XCTAssertNotEqual(initialThreadId, activeConversationId)

        guard let vm = conversationManager.chatViewModel(for: initialThreadId) else {
            XCTFail("Expected ChatViewModel for inactive conversation")
            return
        }

        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Background reply")))
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        waitForPropagation()

        guard let updated = conversationManager.conversations.first(where: { $0.id == initialThreadId }) else {
            XCTFail("Expected conversation to exist")
            return
        }

        XCTAssertNil(updated.source, "Regression guard: should work for normal (non-notification) conversations")
        XCTAssertTrue(updated.hasUnseenLatestAssistantMessage)
    }

    func testInactiveThreadMarkedUnseenWhenAssistantContinuesSameMessageAfterSwitch() {
        guard let initialThreadId = conversationManager.activeConversationId,
              let initialVm = conversationManager.chatViewModel(for: initialThreadId),
              let initialIndex = conversationManager.conversations.firstIndex(where: { $0.id == initialThreadId }) else {
            XCTFail("Expected an initial active conversation and VM")
            return
        }

        conversationManager.conversations[initialIndex].conversationId = "session-initial"
        initialVm.conversationId = "session-initial"
        initialVm.messages.append(ChatMessage(role: .user, text: "Seed"))

        initialVm.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "First chunk", conversationId: "session-initial")
        ))
        waitForPropagation()
        XCTAssertFalse(conversationManager.conversations[initialIndex].hasUnseenLatestAssistantMessage)

        conversationManager.createConversation()
        guard let secondaryThreadId = conversationManager.activeConversationId,
              let secondaryIndex = conversationManager.conversations.firstIndex(where: { $0.id == secondaryThreadId }),
              let secondaryVm = conversationManager.chatViewModel(for: secondaryThreadId) else {
            XCTFail("Expected a secondary active conversation and VM")
            return
        }

        conversationManager.conversations[secondaryIndex].conversationId = "session-secondary"
        secondaryVm.conversationId = "session-secondary"
        conversationManager.selectConversation(id: secondaryThreadId)

        initialVm.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: " + second chunk", conversationId: "session-initial")
        ))
        initialVm.handleServerMessage(.messageComplete(
            MessageCompleteMessage(conversationId: "session-initial")
        ))

        waitForPropagation()

        guard let updated = conversationManager.conversations.first(where: { $0.id == initialThreadId }) else {
            XCTFail("Expected conversation to exist")
            return
        }
        XCTAssertTrue(updated.hasUnseenLatestAssistantMessage)
    }

    func testActiveThreadEmitsSeenSignalOnNewMessageAndStreamCompletion() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }),
              let vm = conversationManager.chatViewModel(for: threadId) else {
            XCTFail("Expected active conversation and view model")
            return
        }

        conversationManager.conversations[index].conversationId = "session-realtime"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        vm.conversationId = "session-realtime"

        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Streaming reply", conversationId: "session-realtime")))
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage(conversationId: "session-realtime")))

        waitForPropagation()

        XCTAssertFalse(conversationManager.conversations[index].hasUnseenLatestAssistantMessage)

        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }
        XCTAssertFalse(seenSignals.isEmpty, "Seen signal should be emitted on new message arrival and stream completion")
        XCTAssertEqual(seenSignals.last?.conversationId, "session-realtime")
    }

    func testUnseenVisibleConversationCountExcludesArchivedThreads() {
        // Start with the initial conversation created by setUp
        guard let threadId = conversationManager.activeConversationId,
              conversationManager.conversations.firstIndex(where: { $0.id == threadId }) != nil else {
            XCTFail("Expected an initial active conversation")
            return
        }

        // Seed a user message so createConversation doesn't skip
        conversationManager.chatViewModel(for: threadId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        // Switch away so the initial conversation becomes inactive
        conversationManager.createConversation()
        XCTAssertNotEqual(conversationManager.activeConversationId, threadId)

        // Mark the initial conversation as unseen
        if let idx = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) {
            conversationManager.conversations[idx].hasUnseenLatestAssistantMessage = true
        }
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 1)

        // Archive it — count should drop to 0
        conversationManager.archiveConversation(id: threadId)
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 0)
    }

    func testUnseenVisibleConversationCountExcludesPrivateThreads() {
        // Create a private conversation (this switches activeConversationId to the private thread)
        conversationManager.createPrivateConversation()
        guard let privateId = conversationManager.activeConversationId,
              let idx = conversationManager.conversations.firstIndex(where: { $0.id == privateId }) else {
            XCTFail("Expected a private conversation")
            return
        }

        // Mark the private conversation as unseen
        conversationManager.conversations[idx].hasUnseenLatestAssistantMessage = true

        // Private conversations are excluded from the visible count
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 0)
    }

    func testUnseenVisibleConversationCountIncludesMultipleUnseen() {
        // Start with the initial conversation
        guard let firstId = conversationManager.activeConversationId else {
            XCTFail("Expected an initial active conversation")
            return
        }
        // Seed a user message so createConversation actually creates a new one
        conversationManager.chatViewModel(for: firstId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        // Create a second conversation
        conversationManager.createConversation()
        guard let secondId = conversationManager.activeConversationId, secondId != firstId else {
            XCTFail("Expected a different second conversation")
            return
        }
        // Seed the second conversation too
        conversationManager.chatViewModel(for: secondId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        // Create a third conversation (becomes active)
        conversationManager.createConversation()
        guard let thirdId = conversationManager.activeConversationId, thirdId != secondId else {
            XCTFail("Expected a different third conversation")
            return
        }

        // Mark first and second as unseen
        if let idx = conversationManager.conversations.firstIndex(where: { $0.id == firstId }) {
            conversationManager.conversations[idx].hasUnseenLatestAssistantMessage = true
        }
        if let idx = conversationManager.conversations.firstIndex(where: { $0.id == secondId }) {
            conversationManager.conversations[idx].hasUnseenLatestAssistantMessage = true
        }

        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 2)
    }

    func testSelectingThreadDecrementsUnseenCount() {
        // Start with the initial conversation
        guard let firstId = conversationManager.activeConversationId else {
            XCTFail("Expected an initial active conversation")
            return
        }
        // Seed so createConversation proceeds
        conversationManager.chatViewModel(for: firstId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        // Create a second conversation (becomes active)
        conversationManager.createConversation()
        guard let secondId = conversationManager.activeConversationId, secondId != firstId else {
            XCTFail("Expected a different second conversation")
            return
        }

        // Mark the first (inactive) conversation as unseen and give it a conversationId
        // (selectConversation only clears unseen when conversationId is present)
        if let idx = conversationManager.conversations.firstIndex(where: { $0.id == firstId }) {
            conversationManager.conversations[idx].hasUnseenLatestAssistantMessage = true
            conversationManager.conversations[idx].conversationId = "session-first"
        }
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 1)

        sentMessages.removeAll()

        // Select the unseen conversation — should clear its unseen flag and emit seen signal
        conversationManager.selectConversation(id: firstId)
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 0)

        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }
        XCTAssertFalse(seenSignals.isEmpty, "selectConversation should emit a seen signal to the daemon")
        XCTAssertEqual(seenSignals.last?.conversationId, "session-first")
    }

    func testMarkConversationSeenEmitsSignalAndClearsFlag() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-mark-seen"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = true
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 1)

        sentMessages.removeAll()

        conversationManager.markConversationSeen(threadId: threadId)

        XCTAssertFalse(conversationManager.conversations[index].hasUnseenLatestAssistantMessage,
                       "markConversationSeen should clear the unseen flag")
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 0)

        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }
        XCTAssertFalse(seenSignals.isEmpty, "markConversationSeen should emit a seen signal to the daemon")
        XCTAssertEqual(seenSignals.last?.conversationId, "session-mark-seen")
    }

    func testMarkConversationUnreadEmitsSignalAndSetsFlag() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-mark-unread"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)

        sentMessages.removeAll()

        conversationManager.markConversationUnread(threadId: threadId)
        waitForPropagation()

        XCTAssertTrue(conversationManager.conversations[index].hasUnseenLatestAssistantMessage,
                      "markConversationUnread should set the unseen flag")

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        XCTAssertEqual(unreadSignals.count, 1, "markConversationUnread should emit a single unread signal")
        XCTAssertEqual(unreadSignals.last?.conversationId, "session-mark-unread")
    }

    func testMarkConversationUnreadDoesNotEmitDuplicateSignalForUnreadThread() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-already-unread"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)

        sentMessages.removeAll()

        conversationManager.markConversationUnread(threadId: threadId)

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        XCTAssertTrue(unreadSignals.isEmpty, "Already-unread conversations should not emit duplicate unread signals")
        XCTAssertTrue(conversationManager.conversations[index].hasUnseenLatestAssistantMessage)
    }

    func testMarkConversationUnreadAllowsLiveAssistantReplyWithoutHydratedTimestamp() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }),
              let vm = conversationManager.chatViewModel(for: threadId) else {
            XCTFail("Expected an initial active conversation and view model")
            return
        }

        conversationManager.conversations[index].conversationId = "session-live-unread"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[index].latestAssistantMessageAt = nil
        vm.conversationId = "session-live-unread"

        vm.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Live reply", conversationId: "session-live-unread")
        ))
        waitForPropagation()

        conversationManager.conversations[index].latestAssistantMessageAt = nil
        sentMessages.removeAll()

        conversationManager.markConversationUnread(threadId: threadId)
        waitForPropagation()

        XCTAssertTrue(conversationManager.conversations[index].hasUnseenLatestAssistantMessage,
                      "Live assistant replies should allow unread even before hydration backfills timestamps")

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        XCTAssertEqual(unreadSignals.count, 1)
        XCTAssertEqual(unreadSignals.last?.conversationId, "session-live-unread")
    }

    func testMarkConversationUnreadRollsBackWhenSendFails() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        daemonClient.sendOverride = { _ in
            throw NSError(domain: "ConversationManagerUnseenStateTests", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "offline"
            ])
        }

        conversationManager.conversations[index].conversationId = "session-unread-failure"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)
        conversationManager.conversations[index].lastSeenAssistantMessageAt = Date(timeIntervalSince1970: 9)

        conversationManager.markConversationUnread(threadId: threadId)
        waitForPropagation()

        XCTAssertFalse(conversationManager.conversations[index].hasUnseenLatestAssistantMessage)
        XCTAssertEqual(
            conversationManager.conversations[index].lastSeenAssistantMessageAt,
            Date(timeIntervalSince1970: 9)
        )
    }

    func testUnreadRollbackRequeuesDeferredSeenSignal() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-requeue"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 5)

        // mark-all-seen defers the seen signal
        conversationManager.markAllConversationsSeen()

        // Fail only unread signals so markConversationUnread triggers rollback,
        // while allowing seen signals from commitPendingSeenSignals to succeed.
        daemonClient.sendOverride = { [weak self] message in
            if message is ConversationUnreadSignal {
                throw NSError(domain: "ConversationManagerUnseenStateTests", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "offline"
                ])
            }
            self?.sentMessages.append(message)
        }

        sentMessages.removeAll()

        conversationManager.markConversationUnread(threadId: threadId)
        waitForPropagation()

        // After rollback the deferred seen signal should be re-queued,
        // so committing should emit a seen signal for the session.
        conversationManager.commitPendingSeenSignals()

        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }
        XCTAssertEqual(seenSignals.map(\.conversationId), ["session-requeue"])
    }

    func testMarkConversationUnreadIgnoresThreadsWithoutAssistantReply() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-no-assistant-reply"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[index].latestAssistantMessageAt = nil

        sentMessages.removeAll()

        conversationManager.markConversationUnread(threadId: threadId)

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        XCTAssertTrue(unreadSignals.isEmpty, "Threads without assistant replies should not emit unread signals")
        XCTAssertFalse(conversationManager.conversations[index].hasUnseenLatestAssistantMessage)
    }

    func testAttentionMergePreservesLocalSeenUntilDaemonAcknowledgesIt() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-refresh-seen"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)
        conversationManager.conversations[index].lastSeenAssistantMessageAt = Date(timeIntervalSince1970: 8)

        conversationManager.markConversationSeen(threadId: threadId)

        let staleResponse = makeConversationListResponse(
            conversations: [[
                "id": "session-refresh-seen",
                "title": "Restored conversation",
                "createdAt": 5_000,
                "updatedAt": 6_000,
                "assistantAttention": [
                    "hasUnseenLatestAssistantMessage": true,
                    "latestAssistantMessageAt": 9_000,
                    "lastSeenAssistantMessageAt": 8_000,
                ],
            ]]
        )
        guard let session = staleResponse.conversations.first else {
            XCTFail("Expected response session")
            return
        }

        conversationManager.mergeAssistantAttention(from: session, intoThreadAt: index)

        XCTAssertFalse(
            conversationManager.conversations.first(where: { $0.conversationId == "session-refresh-seen" })?.hasUnseenLatestAssistantMessage ?? true
        )
    }

    func testAppendThreadsPreservesLocalUnreadUntilDaemonAcknowledgesIt() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-refresh-unread"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)
        conversationManager.conversations[index].lastSeenAssistantMessageAt = Date(timeIntervalSince1970: 9)

        conversationManager.markConversationUnread(threadId: threadId)

        let staleResponse = makeConversationListResponse(
            conversations: [[
                "id": "session-refresh-unread",
                "title": "Paginated conversation",
                "createdAt": 5_000,
                "updatedAt": 6_000,
                "assistantAttention": [
                    "hasUnseenLatestAssistantMessage": false,
                    "latestAssistantMessageAt": 9_000,
                    "lastSeenAssistantMessageAt": 9_000,
                ],
            ]]
        )

        conversationManager.appendConversations(from: staleResponse)

        XCTAssertTrue(
            conversationManager.conversations.first(where: { $0.conversationId == "session-refresh-unread" })?.hasUnseenLatestAssistantMessage ?? false
        )
    }

    func testMarkConversationUnreadRemovesPendingSeenSignalForSameSession() {
        guard let firstThreadId = conversationManager.activeConversationId,
              let firstIndex = conversationManager.conversations.firstIndex(where: { $0.id == firstThreadId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[firstIndex].conversationId = "session-first"
        conversationManager.conversations[firstIndex].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[firstIndex].latestAssistantMessageAt = Date(timeIntervalSince1970: 1)
        conversationManager.chatViewModel(for: firstThreadId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        conversationManager.createConversation()

        guard let secondThreadId = conversationManager.activeConversationId,
              let secondIndex = conversationManager.conversations.firstIndex(where: { $0.id == secondThreadId }) else {
            XCTFail("Expected a second active conversation")
            return
        }

        conversationManager.conversations[secondIndex].conversationId = "session-second"
        conversationManager.conversations[secondIndex].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[secondIndex].latestAssistantMessageAt = Date(timeIntervalSince1970: 2)

        sentMessages.removeAll()

        let markedIds = Set(conversationManager.markAllConversationsSeen())
        XCTAssertEqual(markedIds, Set([firstThreadId, secondThreadId]))

        conversationManager.markConversationUnread(threadId: firstThreadId)
        conversationManager.commitPendingSeenSignals()
        waitForPropagation()

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        XCTAssertEqual(unreadSignals.map(\.conversationId), ["session-first"])

        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }
        XCTAssertEqual(seenSignals.map(\.conversationId), ["session-second"])

        XCTAssertTrue(conversationManager.conversations.contains(where: {
            $0.id == firstThreadId && $0.hasUnseenLatestAssistantMessage
        }))
        XCTAssertTrue(conversationManager.conversations.contains(where: {
            $0.id == secondThreadId && !$0.hasUnseenLatestAssistantMessage
        }))
    }

    func testActiveThreadDoesNotEmitSeenSignalOnEveryStreamingDelta() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }),
              let vm = conversationManager.chatViewModel(for: threadId) else {
            XCTFail("Expected active conversation and view model")
            return
        }

        conversationManager.conversations[index].conversationId = "session-streaming"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        vm.conversationId = "session-streaming"

        // First delta creates a new message — should emit one seen signal
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "chunk1", conversationId: "session-streaming")))
        waitForPropagation()

        let signalsAfterFirstDelta = sentMessages.compactMap { $0 as? ConversationSeenSignal }
            .filter { $0.conversationId == "session-streaming" }
        let countAfterFirst = signalsAfterFirstDelta.count

        // Subsequent deltas on the same message should NOT emit additional seen signals
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " chunk2", conversationId: "session-streaming")))
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " chunk3", conversationId: "session-streaming")))
        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: " chunk4", conversationId: "session-streaming")))
        waitForPropagation()

        let signalsAfterMoreDeltas = sentMessages.compactMap { $0 as? ConversationSeenSignal }
            .filter { $0.conversationId == "session-streaming" }
        XCTAssertEqual(signalsAfterMoreDeltas.count, countAfterFirst,
                       "Mid-stream text deltas should not emit additional seen signals (was O(n), should be O(1))")

        // Stream completion should emit one more seen signal
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage(conversationId: "session-streaming")))
        waitForPropagation()

        let signalsAfterComplete = sentMessages.compactMap { $0 as? ConversationSeenSignal }
            .filter { $0.conversationId == "session-streaming" }
        XCTAssertEqual(signalsAfterComplete.count, countAfterFirst + 1,
                       "Stream completion should emit exactly one additional seen signal")
    }

    func testActiveThreadAssistantReplyClearsUnseenAndEmitsSeenSignal() {
        guard let threadId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }),
              let vm = conversationManager.chatViewModel(for: threadId) else {
            XCTFail("Expected active conversation and view model")
            return
        }

        conversationManager.conversations[index].conversationId = "session-active"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = true
        vm.conversationId = "session-active"

        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Visible reply", conversationId: "session-active")))
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage(conversationId: "session-active")))

        waitForPropagation()

        XCTAssertFalse(conversationManager.conversations[index].hasUnseenLatestAssistantMessage)

        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }
        XCTAssertEqual(seenSignals.last?.conversationId, "session-active")
    }

    func testAppendThreadsPreservesAssistantAttentionTimestamps() {
        let response = makeConversationListResponse(
            conversations: [[
                "id": "session-paginated",
                "title": "Paginated conversation",
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

        conversationManager.appendConversations(from: response)

        guard let appendedThread = conversationManager.conversations.first(where: { $0.conversationId == "session-paginated" }) else {
            XCTFail("Expected appended thread")
            return
        }

        XCTAssertFalse(appendedThread.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(appendedThread.latestAssistantMessageAt?.timeIntervalSince1970, 9.0)
        XCTAssertEqual(appendedThread.lastSeenAssistantMessageAt?.timeIntervalSince1970, 9.0)
    }

    func testScheduleConversationCreatedWithUnseenFlag() {
        conversationManager.createScheduleConversation(
            conversationId: "schedule-conv-1",
            scheduleJobId: "sched-1",
            title: "Daily Standup"
        )

        guard let conversation = conversationManager.conversations.first(where: { $0.conversationId == "schedule-conv-1" }) else {
            XCTFail("Expected schedule conversation to be created")
            return
        }

        XCTAssertTrue(conversation.hasUnseenLatestAssistantMessage,
                      "Schedule conversations should start with unread badge")
        XCTAssertEqual(conversation.source, "schedule")
        XCTAssertEqual(conversation.scheduleJobId, "sched-1")
    }

    func testTaskRunConversationCreatedWithUnseenFlag() {
        conversationManager.createTaskRunConversation(
            conversationId: "task-conv-1",
            workItemId: "work-1",
            title: "Run Tests"
        )

        guard let conversation = conversationManager.conversations.first(where: { $0.conversationId == "task-conv-1" }) else {
            XCTFail("Expected task run conversation to be created")
            return
        }

        XCTAssertTrue(conversation.hasUnseenLatestAssistantMessage,
                      "Task run conversations should start with unread badge")
    }

    func testNotificationConversationCreatedWithUnseenFlag() {
        conversationManager.createNotificationConversation(
            conversationId: "notif-conv-1",
            title: "New Alert",
            sourceEventName: "watcher.notification"
        )

        guard let conversation = conversationManager.conversations.first(where: { $0.conversationId == "notif-conv-1" }) else {
            XCTFail("Expected notification conversation to be created")
            return
        }

        XCTAssertTrue(conversation.hasUnseenLatestAssistantMessage,
                      "Notification conversations should start with unread badge")
        XCTAssertEqual(conversation.source, "notification")
    }

    func testBackgroundConversationCreationSkipsDuplicateConversationId() {
        conversationManager.createScheduleConversation(
            conversationId: "dup-conv",
            scheduleJobId: "sched-dup",
            title: "First"
        )
        let countAfterFirst = conversationManager.conversations.count

        conversationManager.createScheduleConversation(
            conversationId: "dup-conv",
            scheduleJobId: "sched-dup",
            title: "Duplicate"
        )

        XCTAssertEqual(conversationManager.conversations.count, countAfterFirst,
                       "Duplicate conversationId should not create a second conversation")
    }

    private func waitForPropagation() {
        let exp = expectation(description: "combine propagation")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }
}
