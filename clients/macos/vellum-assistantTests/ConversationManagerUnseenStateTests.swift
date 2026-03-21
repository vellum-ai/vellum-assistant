import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerUnseenStateTests: XCTestCase {

    private var cm: GatewayConnectionManager!
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
        cm = GatewayConnectionManager()
        daemonClient = DaemonClient(connectionManager: cm)
        daemonClient.isConnected = true
        conversationManager = ConversationManager(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient)
        conversationManager.createConversation()
    }

    override func tearDown() {
        conversationManager = nil
        daemonClient = nil
        cm = nil
        sentMessages = []
        super.tearDown()
    }

    func testInactiveStandardConversationMarkedUnseenWhenAssistantReplies() {
        guard let initialConversationId = conversationManager.activeConversationId else {
            XCTFail("Expected an initial active conversation")
            return
        }
        conversationManager.chatViewModel(for: initialConversationId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        conversationManager.createConversation()
        let activeConversationId = conversationManager.activeConversationId
        XCTAssertNotEqual(initialConversationId, activeConversationId)

        guard let vm = conversationManager.chatViewModel(for: initialConversationId) else {
            XCTFail("Expected ChatViewModel for inactive conversation")
            return
        }

        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Background reply")))
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        waitForPropagation()

        guard let updated = conversationManager.conversations.first(where: { $0.id == initialConversationId }) else {
            XCTFail("Expected conversation to exist")
            return
        }

        XCTAssertNil(updated.source, "Regression guard: should work for normal (non-notification) conversations")
        XCTAssertTrue(updated.hasUnseenLatestAssistantMessage)
    }

    func testInactiveConversationMarkedUnseenWhenAssistantContinuesSameMessageAfterSwitch() {
        guard let initialConversationId = conversationManager.activeConversationId,
              let initialVm = conversationManager.chatViewModel(for: initialConversationId),
              let initialIndex = conversationManager.conversations.firstIndex(where: { $0.id == initialConversationId }) else {
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
        guard let secondaryConversationId = conversationManager.activeConversationId,
              let secondaryIndex = conversationManager.conversations.firstIndex(where: { $0.id == secondaryConversationId }),
              let secondaryVm = conversationManager.chatViewModel(for: secondaryConversationId) else {
            XCTFail("Expected a secondary active conversation and VM")
            return
        }

        conversationManager.conversations[secondaryIndex].conversationId = "session-secondary"
        secondaryVm.conversationId = "session-secondary"
        conversationManager.selectConversation(id: secondaryConversationId)

        initialVm.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: " + second chunk", conversationId: "session-initial")
        ))
        initialVm.handleServerMessage(.messageComplete(
            MessageCompleteMessage(conversationId: "session-initial")
        ))

        waitForPropagation()

        guard let updated = conversationManager.conversations.first(where: { $0.id == initialConversationId }) else {
            XCTFail("Expected conversation to exist")
            return
        }
        XCTAssertTrue(updated.hasUnseenLatestAssistantMessage)
    }

    func testActiveConversationEmitsSeenSignalOnNewMessageAndStreamCompletion() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }),
              let vm = conversationManager.chatViewModel(for: conversationId) else {
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

    func testUnseenVisibleConversationCountExcludesArchivedConversations() {
        // Start with the initial conversation created by setUp
        guard let conversationId = conversationManager.activeConversationId,
              conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) != nil else {
            XCTFail("Expected an initial active conversation")
            return
        }

        // Seed a user message so createConversation doesn't skip
        conversationManager.chatViewModel(for: conversationId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        // Switch away so the initial conversation becomes inactive
        conversationManager.createConversation()
        XCTAssertNotEqual(conversationManager.activeConversationId, conversationId)

        // Mark the initial conversation as unseen
        if let idx = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) {
            conversationManager.conversations[idx].hasUnseenLatestAssistantMessage = true
        }
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 1)

        // Archive it — count should drop to 0
        conversationManager.archiveConversation(id: conversationId)
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 0)
    }

    func testUnseenVisibleConversationCountExcludesPrivateConversations() {
        // Create a private conversation (this switches activeConversationId to the private conversation)
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

    func testSelectingConversationDecrementsUnseenCount() {
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
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-mark-seen"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = true
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 1)

        sentMessages.removeAll()

        conversationManager.markConversationSeen(conversationId: conversationId)

        XCTAssertFalse(conversationManager.conversations[index].hasUnseenLatestAssistantMessage,
                       "markConversationSeen should clear the unseen flag")
        XCTAssertEqual(conversationManager.unseenVisibleConversationCount, 0)

        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }
        XCTAssertFalse(seenSignals.isEmpty, "markConversationSeen should emit a seen signal to the daemon")
        XCTAssertEqual(seenSignals.last?.conversationId, "session-mark-seen")
    }

    func testMarkConversationUnreadEmitsSignalAndSetsFlag() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-mark-unread"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)

        sentMessages.removeAll()

        conversationManager.markConversationUnread(conversationId: conversationId)
        waitForPropagation()

        XCTAssertTrue(conversationManager.conversations[index].hasUnseenLatestAssistantMessage,
                      "markConversationUnread should set the unseen flag")

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        XCTAssertEqual(unreadSignals.count, 1, "markConversationUnread should emit a single unread signal")
        XCTAssertEqual(unreadSignals.last?.conversationId, "session-mark-unread")
    }

    func testMarkConversationUnreadDoesNotEmitDuplicateSignalForUnreadConversation() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-already-unread"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)

        sentMessages.removeAll()

        conversationManager.markConversationUnread(conversationId: conversationId)

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        XCTAssertTrue(unreadSignals.isEmpty, "Already-unread conversations should not emit duplicate unread signals")
        XCTAssertTrue(conversationManager.conversations[index].hasUnseenLatestAssistantMessage)
    }

    func testMarkConversationUnreadAllowsLiveAssistantReplyWithoutHydratedTimestamp() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }),
              let vm = conversationManager.chatViewModel(for: conversationId) else {
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

        conversationManager.markConversationUnread(conversationId: conversationId)
        waitForPropagation()

        XCTAssertTrue(conversationManager.conversations[index].hasUnseenLatestAssistantMessage,
                      "Live assistant replies should allow unread even before hydration backfills timestamps")

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        XCTAssertEqual(unreadSignals.count, 1)
        XCTAssertEqual(unreadSignals.last?.conversationId, "session-live-unread")
    }

    func testMarkConversationUnreadRollsBackWhenSendFails() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-unread-failure"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)
        conversationManager.conversations[index].lastSeenAssistantMessageAt = Date(timeIntervalSince1970: 9)

        conversationManager.markConversationUnread(conversationId: conversationId)
        waitForPropagation()

        XCTAssertFalse(conversationManager.conversations[index].hasUnseenLatestAssistantMessage)
        XCTAssertEqual(
            conversationManager.conversations[index].lastSeenAssistantMessageAt,
            Date(timeIntervalSince1970: 9)
        )
    }

    func testUnreadRollbackRequeuesDeferredSeenSignal() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-requeue"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 5)

        // mark-all-seen defers the seen signal
        conversationManager.markAllConversationsSeen()

        sentMessages.removeAll()

        conversationManager.markConversationUnread(conversationId: conversationId)
        waitForPropagation()

        // After rollback the deferred seen signal should be re-queued,
        // so committing should emit a seen signal for the session.
        conversationManager.commitPendingSeenSignals()

        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }
        XCTAssertEqual(seenSignals.map(\.conversationId), ["session-requeue"])
    }

    func testMarkConversationUnreadIgnoresConversationsWithoutAssistantReply() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-no-assistant-reply"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[index].latestAssistantMessageAt = nil

        sentMessages.removeAll()

        conversationManager.markConversationUnread(conversationId: conversationId)

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        XCTAssertTrue(unreadSignals.isEmpty, "Conversations without assistant replies should not emit unread signals")
        XCTAssertFalse(conversationManager.conversations[index].hasUnseenLatestAssistantMessage)
    }

    func testAttentionMergePreservesLocalSeenUntilDaemonAcknowledgesIt() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-refresh-seen"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)
        conversationManager.conversations[index].lastSeenAssistantMessageAt = Date(timeIntervalSince1970: 8)

        conversationManager.markConversationSeen(conversationId: conversationId)

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
        guard let conversation = staleResponse.conversations.first else {
            XCTFail("Expected response conversation")
            return
        }

        conversationManager.mergeAssistantAttention(from: conversation, intoConversationAt: index)

        XCTAssertFalse(
            conversationManager.conversations.first(where: { $0.conversationId == "session-refresh-seen" })?.hasUnseenLatestAssistantMessage ?? true
        )
    }

    func testAppendConversationsPreservesLocalUnreadUntilDaemonAcknowledgesIt() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[index].conversationId = "session-refresh-unread"
        conversationManager.conversations[index].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[index].latestAssistantMessageAt = Date(timeIntervalSince1970: 9)
        conversationManager.conversations[index].lastSeenAssistantMessageAt = Date(timeIntervalSince1970: 9)

        conversationManager.markConversationUnread(conversationId: conversationId)

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

    func testMarkConversationUnreadRemovesPendingSeenSignalForSameConversation() {
        guard let firstConversationId = conversationManager.activeConversationId,
              let firstIndex = conversationManager.conversations.firstIndex(where: { $0.id == firstConversationId }) else {
            XCTFail("Expected an initial active conversation")
            return
        }

        conversationManager.conversations[firstIndex].conversationId = "session-first"
        conversationManager.conversations[firstIndex].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[firstIndex].latestAssistantMessageAt = Date(timeIntervalSince1970: 1)
        conversationManager.chatViewModel(for: firstConversationId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        conversationManager.createConversation()

        guard let secondConversationId = conversationManager.activeConversationId,
              let secondIndex = conversationManager.conversations.firstIndex(where: { $0.id == secondConversationId }) else {
            XCTFail("Expected a second active conversation")
            return
        }

        conversationManager.conversations[secondIndex].conversationId = "session-second"
        conversationManager.conversations[secondIndex].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[secondIndex].latestAssistantMessageAt = Date(timeIntervalSince1970: 2)

        sentMessages.removeAll()

        let markedIds = Set(conversationManager.markAllConversationsSeen())
        XCTAssertEqual(markedIds, Set([firstConversationId, secondConversationId]))

        conversationManager.markConversationUnread(conversationId: firstConversationId)
        conversationManager.commitPendingSeenSignals()
        waitForPropagation()

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        XCTAssertEqual(unreadSignals.map(\.conversationId), ["session-first"])

        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }
        XCTAssertEqual(seenSignals.map(\.conversationId), ["session-second"])

        XCTAssertTrue(conversationManager.conversations.contains(where: {
            $0.id == firstConversationId && $0.hasUnseenLatestAssistantMessage
        }))
        XCTAssertTrue(conversationManager.conversations.contains(where: {
            $0.id == secondConversationId && !$0.hasUnseenLatestAssistantMessage
        }))
    }

    func testActiveConversationDoesNotEmitSeenSignalOnEveryStreamingDelta() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }),
              let vm = conversationManager.chatViewModel(for: conversationId) else {
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

    func testActiveConversationAssistantReplyClearsUnseenAndEmitsSeenSignal() {
        guard let conversationId = conversationManager.activeConversationId,
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }),
              let vm = conversationManager.chatViewModel(for: conversationId) else {
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

    func testAppendConversationsPreservesAssistantAttentionTimestamps() {
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

        guard let appendedConversation = conversationManager.conversations.first(where: { $0.conversationId == "session-paginated" }) else {
            XCTFail("Expected appended conversation")
            return
        }

        XCTAssertFalse(appendedConversation.hasUnseenLatestAssistantMessage)
        XCTAssertEqual(appendedConversation.latestAssistantMessageAt?.timeIntervalSince1970, 9.0)
        XCTAssertEqual(appendedConversation.lastSeenAssistantMessageAt?.timeIntervalSince1970, 9.0)
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

    func testNotificationIntentMarksInactiveConversationUnseen() {
        conversationManager.createScheduleConversation(
            conversationId: "notif-reuse-1",
            scheduleJobId: "sched-reuse-1",
            title: "Reuse Target"
        )

        guard let idx = conversationManager.conversations.firstIndex(where: { $0.conversationId == "notif-reuse-1" }) else {
            XCTFail("Expected conversation to exist")
            return
        }

        // Simulate previously seen state with stale recency
        conversationManager.conversations[idx].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[idx].lastInteractedAt = Date(timeIntervalSince1970: 1000)

        // Ensure the active conversation is a different one (the default from setUp)
        XCTAssertNotEqual(conversationManager.conversations[idx].id, conversationManager.activeConversationId)

        conversationManager.handleNotificationIntentForExistingConversation(daemonConversationId: "notif-reuse-1")

        XCTAssertTrue(conversationManager.conversations[idx].hasUnseenLatestAssistantMessage,
                      "Inactive conversation should be marked unseen after notification intent")
        XCTAssertNotNil(conversationManager.conversations[idx].latestAssistantMessageAt,
                        "latestAssistantMessageAt should be set")
        XCTAssertTrue(
            abs(conversationManager.conversations[idx].latestAssistantMessageAt!.timeIntervalSinceNow) < 1.0,
            "latestAssistantMessageAt should be recent (within last second)"
        )
        XCTAssertTrue(
            abs(conversationManager.conversations[idx].lastInteractedAt.timeIntervalSinceNow) < 1.0,
            "lastInteractedAt should be updated so the conversation sorts to the top of the sidebar"
        )
    }

    func testNotificationIntentSkipsUnseenBadgeForActiveConversation() {
        conversationManager.createScheduleConversation(
            conversationId: "notif-active-1",
            scheduleJobId: "sched-active-1",
            title: "Active Target"
        )

        guard let conversation = conversationManager.conversations.first(where: { $0.conversationId == "notif-active-1" }) else {
            XCTFail("Expected conversation to exist")
            return
        }

        conversationManager.selectConversation(id: conversation.id)

        // Re-find index after selectConversation (may have shifted due to removeAbandonedEmptyConversation)
        guard let idx = conversationManager.conversations.firstIndex(where: { $0.conversationId == "notif-active-1" }) else {
            XCTFail("Expected conversation to still exist after selection")
            return
        }

        conversationManager.conversations[idx].hasUnseenLatestAssistantMessage = false
        conversationManager.conversations[idx].lastInteractedAt = Date(timeIntervalSince1970: 1000)

        conversationManager.handleNotificationIntentForExistingConversation(daemonConversationId: "notif-active-1")

        XCTAssertFalse(conversationManager.conversations[idx].hasUnseenLatestAssistantMessage,
                       "Active conversation should not be marked unseen — user is looking at it")
        XCTAssertTrue(
            abs(conversationManager.conversations[idx].lastInteractedAt.timeIntervalSinceNow) < 1.0,
            "lastInteractedAt should still be updated for active conversations so sidebar order reflects the notification"
        )
    }

    func testNotificationIntentNoopsForUnknownConversation() {
        let countBefore = conversationManager.conversations.count

        conversationManager.handleNotificationIntentForExistingConversation(daemonConversationId: "nonexistent")

        XCTAssertEqual(conversationManager.conversations.count, countBefore,
                       "Unknown conversation ID should not change conversation count")
    }

    func testNotificationIntentDoesNotSendDaemonSignal() {
        conversationManager.createScheduleConversation(
            conversationId: "notif-no-signal",
            scheduleJobId: "sched-no-signal",
            title: "No Signal Target"
        )

        guard let idx = conversationManager.conversations.firstIndex(where: { $0.conversationId == "notif-no-signal" }) else {
            XCTFail("Expected conversation to exist")
            return
        }

        // Mark as seen and switch away
        conversationManager.conversations[idx].hasUnseenLatestAssistantMessage = false

        sentMessages.removeAll()

        conversationManager.handleNotificationIntentForExistingConversation(daemonConversationId: "notif-no-signal")

        let unreadSignals = sentMessages.compactMap { $0 as? ConversationUnreadSignal }
        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }

        XCTAssertTrue(unreadSignals.isEmpty,
                      "handleNotificationIntentForExistingConversation should not emit conversation_unread_signal")
        XCTAssertTrue(seenSignals.isEmpty,
                      "handleNotificationIntentForExistingConversation should not emit conversation_seen_signal")
    }

    func testNotificationIntentTriggersHistoryRequest() {
        conversationManager.createScheduleConversation(
            conversationId: "notif-history-1",
            scheduleJobId: "sched-history-1",
            title: "History Target"
        )

        guard conversationManager.conversations.firstIndex(where: { $0.conversationId == "notif-history-1" }) != nil else {
            XCTFail("Expected conversation to exist")
            return
        }

        sentMessages.removeAll()

        conversationManager.handleNotificationIntentForExistingConversation(daemonConversationId: "notif-history-1")

        let historyRequests = sentMessages.compactMap { $0 as? HistoryRequestMessage }
        XCTAssertFalse(historyRequests.isEmpty,
                       "handleNotificationIntentForExistingConversation should trigger a history request")
        XCTAssertEqual(historyRequests.first?.conversationId, "notif-history-1",
                       "History request should target the correct conversation")
    }

    func testNotificationIntentRemovesPendingSeenSignal() {
        // Create a background conversation and mark it unseen
        conversationManager.createScheduleConversation(
            conversationId: "notif-seen-race",
            scheduleJobId: "sched-seen-race",
            title: "Seen Race Target"
        )

        guard let idx = conversationManager.conversations.firstIndex(where: { $0.conversationId == "notif-seen-race" }) else {
            XCTFail("Expected conversation to exist")
            return
        }

        conversationManager.conversations[idx].hasUnseenLatestAssistantMessage = true
        conversationManager.conversations[idx].latestAssistantMessageAt = Date(timeIntervalSince1970: 1)

        // Mark all seen — this defers the seen signal in pendingSeenConversationIds
        conversationManager.markAllConversationsSeen()

        // A notification intent arrives during the undo window
        conversationManager.handleNotificationIntentForExistingConversation(daemonConversationId: "notif-seen-race")

        // Commit the pending seen signals — should NOT include the notification conversation
        sentMessages.removeAll()
        conversationManager.commitPendingSeenSignals()

        let seenSignals = sentMessages.compactMap { $0 as? ConversationSeenSignal }
        XCTAssertFalse(seenSignals.contains(where: { $0.conversationId == "notif-seen-race" }),
                       "Pending seen signal should be removed when a notification intent marks the conversation unseen")
        XCTAssertTrue(conversationManager.conversations[idx].hasUnseenLatestAssistantMessage,
                      "Conversation should remain unseen after notification intent")
    }

    func testNotificationIntentQueuesCatchUpWhenVMBusy() {
        conversationManager.createScheduleConversation(
            conversationId: "notif-busy-1",
            scheduleJobId: "sched-busy-1",
            title: "Busy Target"
        )

        guard let idx = conversationManager.conversations.firstIndex(where: { $0.conversationId == "notif-busy-1" }) else {
            XCTFail("Expected conversation to exist")
            return
        }

        let localId = conversationManager.conversations[idx].id

        guard let vm = conversationManager.chatViewModel(for: localId) else {
            XCTFail("Expected ChatViewModel")
            return
        }

        // Simulate a busy VM
        vm.isSending = true
        waitForPropagation()

        sentMessages.removeAll()

        // Notification arrives while VM is busy — should NOT trigger history request yet
        conversationManager.handleNotificationIntentForExistingConversation(daemonConversationId: "notif-busy-1")

        let historyRequestsDuringBusy = sentMessages.compactMap { $0 as? HistoryRequestMessage }
        XCTAssertTrue(historyRequestsDuringBusy.isEmpty,
                      "History request should be deferred while VM is busy")

        // VM finishes — should trigger the queued catch-up
        sentMessages.removeAll()
        vm.isSending = false
        waitForPropagation()

        let historyRequestsAfterIdle = sentMessages.compactMap { $0 as? HistoryRequestMessage }
        XCTAssertFalse(historyRequestsAfterIdle.isEmpty,
                       "Queued history request should fire when VM becomes idle")
        XCTAssertEqual(historyRequestsAfterIdle.first?.conversationId, "notif-busy-1",
                       "Deferred history request should target the correct conversation")
    }

    private func waitForPropagation() {
        let exp = expectation(description: "combine propagation")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }
}
