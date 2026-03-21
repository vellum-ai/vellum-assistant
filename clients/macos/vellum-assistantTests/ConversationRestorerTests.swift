import Foundation
import Testing
@testable import VellumAssistantLib
import VellumAssistantShared

// MARK: - Mock Delegate

@MainActor
final class MockConversationRestorerDelegate: ConversationRestorerDelegate {
    var conversations: [ConversationModel] = []
    var restoreRecentConversations: Bool = true
    var isLoadingMoreConversations: Bool = false
    var hasMoreConversations: Bool = false
    var serverOffset: Int = 0
    var viewModels: [UUID: ChatViewModel] = [:]
    var activatedConversationId: UUID?
    var createConversationCallCount = 0
    var archivedConversationIds: Set<String> = []
    private let daemonClient: GatewayConnectionManager
    private let eventStreamClient: EventStreamClient

    init(daemonClient: GatewayConnectionManager, eventStreamClient: EventStreamClient) {
        self.daemonClient = daemonClient
        self.eventStreamClient = eventStreamClient
    }

    func chatViewModel(for conversationId: UUID) -> ChatViewModel? {
        viewModels[conversationId]
    }

    func existingChatViewModel(for conversationId: UUID) -> ChatViewModel? {
        viewModels[conversationId]
    }

    func existingChatViewModel(forConversationId conversationId: String) -> ChatViewModel? {
        for (_, vm) in viewModels where vm.conversationId == conversationId {
            return vm
        }
        return nil
    }

    func setChatViewModel(_ vm: ChatViewModel, for conversationId: UUID) {
        viewModels[conversationId] = vm
    }

    func removeChatViewModel(for conversationId: UUID) {
        viewModels.removeValue(forKey: conversationId)
    }

    func makeViewModel() -> ChatViewModel {
        ChatViewModel(daemonClient: daemonClient, eventStreamClient: eventStreamClient)
    }

    func activateConversation(_ id: UUID) {
        activatedConversationId = id
    }

    func createConversation() {
        createConversationCallCount += 1
        let conversation = ConversationModel()
        let vm = makeViewModel()
        conversations.insert(conversation, at: 0)
        viewModels[conversation.id] = vm
        activatedConversationId = conversation.id
    }

    func isConversationArchived(_ conversationId: String) -> Bool {
        archivedConversationIds.contains(conversationId)
    }

    func restoreLastActiveConversation() {
        // no-op for tests
    }

    func appendConversations(from response: ConversationListResponseMessage) {
        // no-op for tests
    }

    func mergeAssistantAttention(
        from item: ConversationListResponseItem,
        intoConversationAt index: Int
    ) {
        conversations[index].hasUnseenLatestAssistantMessage =
            item.assistantAttention?.hasUnseenLatestAssistantMessage ?? false
        conversations[index].latestAssistantMessageAt =
            item.assistantAttention?.latestAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
        conversations[index].lastSeenAssistantMessageAt =
            item.assistantAttention?.lastSeenAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
    }
}

// MARK: - Helpers

/// Build a ConversationListResponseMessage via JSON round-trip.
private func makeConversationListResponse(conversations: [(id: String, title: String, createdAt: Int, updatedAt: Int, conversationType: String?, channelBinding: [String: Any]?)]) -> ConversationListResponseMessage {
    let convDicts = conversations.map { conversation -> [String: Any] in
        var dict: [String: Any] = ["id": conversation.id, "title": conversation.title, "createdAt": conversation.createdAt, "updatedAt": conversation.updatedAt]
        if let conversationType = conversation.conversationType {
            dict["conversationType"] = conversationType
        }
        if let channelBinding = conversation.channelBinding {
            dict["channelBinding"] = channelBinding
        }
        return dict
    }
    let dict: [String: Any] = ["type": "conversation_list_response", "conversations": convDicts]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
}

private func makeConversationListResponse(
    conversationDicts: [[String: Any]]
) -> ConversationListResponseMessage {
    let dict: [String: Any] = [
        "type": "conversation_list_response",
        "conversations": conversationDicts,
    ]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(ConversationListResponseMessage.self, from: data)
}

/// Convenience overload with conversationType and optional channelBinding.
private func makeConversationListResponse(conversations: [(id: String, title: String, updatedAt: Int, conversationType: String?, channelBinding: [String: Any]?)]) -> ConversationListResponseMessage {
    makeConversationListResponse(conversations: conversations.map { ($0.id, $0.title, $0.updatedAt, $0.updatedAt, $0.conversationType, $0.channelBinding) })
}

/// Convenience overload with conversationType but no channelBinding.
private func makeConversationListResponse(conversations: [(id: String, title: String, updatedAt: Int, conversationType: String?)]) -> ConversationListResponseMessage {
    makeConversationListResponse(conversations: conversations.map { ($0.id, $0.title, $0.updatedAt, $0.updatedAt, $0.conversationType, nil) })
}

/// Convenience overload without conversationType for existing tests.
private func makeConversationListResponse(conversations: [(id: String, title: String, updatedAt: Int)]) -> ConversationListResponseMessage {
    makeConversationListResponse(conversations: conversations.map { ($0.id, $0.title, $0.updatedAt, $0.updatedAt, nil, nil) })
}

/// Build a HistoryResponse via JSON round-trip.
private func makeHistoryResponse(conversationId: String, messages: [(role: String, text: String)], hasMore: Bool = false) -> HistoryResponse {
    let msgDicts = messages.map { msg -> [String: Any] in
        ["role": msg.role, "text": msg.text, "timestamp": 1000.0]
    }
    let dict: [String: Any] = ["type": "history_response", "conversationId": conversationId, "messages": msgDicts, "hasMore": hasMore]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(HistoryResponse.self, from: data)
}

/// Build a ConversationTitleUpdatedMessage via JSON round-trip.
private func makeConversationTitleUpdated(conversationId: String, title: String) -> ConversationTitleUpdatedMessage {
    let dict: [String: Any] = ["type": "conversation_title_updated", "conversationId": conversationId, "title": title]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(ConversationTitleUpdatedMessage.self, from: data)
}

// MARK: - Tests

@Suite("ConversationRestorer")
struct ConversationRestorerTests {

    // MARK: - History Response Routing

    @Test @MainActor
    func historyResponseRoutesToCorrectConversation() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)

        // Set up two conversations with conversation IDs
        let conversationA = ConversationModel(title: "Conversation A", conversationId: "session-A")
        let conversationB = ConversationModel(title: "Conversation B", conversationId: "session-B")
        delegate.conversations = [conversationA, conversationB]

        let vmA = delegate.makeViewModel()
        let vmB = delegate.makeViewModel()
        delegate.viewModels[conversationA.id] = vmA
        delegate.viewModels[conversationB.id] = vmB

        restorer.delegate = delegate

        // Register pending history for both conversations
        restorer.pendingHistoryByConversationId["session-A"] = conversationA.id
        restorer.pendingHistoryByConversationId["session-B"] = conversationB.id

        // Deliver history for session-B
        let response = makeHistoryResponse(conversationId: "session-B", messages: [
            (role: "user", text: "Hello"),
            (role: "assistant", text: "Hi there"),
        ])
        restorer.handleHistoryResponse(response)

        // session-B's view model should have history loaded
        #expect(vmB.isHistoryLoaded)
        #expect(vmB.messages.count == 2)

        // session-A should NOT have been affected
        #expect(!vmA.isHistoryLoaded)
        #expect(vmA.messages.isEmpty)

        // session-B should be removed from pending, session-A should remain
        #expect(restorer.pendingHistoryByConversationId["session-B"] == nil)
        #expect(restorer.pendingHistoryByConversationId["session-A"] == conversationA.id)
    }

    @Test @MainActor
    func staleHistoryResponseIsDropped() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let conversation = ConversationModel(title: "Conversation", conversationId: "session-X")
        delegate.conversations = [conversation]
        let vm = delegate.makeViewModel()
        delegate.viewModels[conversation.id] = vm

        // No pending entry for "session-stale"
        let response = makeHistoryResponse(conversationId: "session-stale", messages: [
            (role: "user", text: "Should not appear"),
        ])
        restorer.handleHistoryResponse(response)

        // The view model should be untouched
        #expect(!vm.isHistoryLoaded)
        #expect(vm.messages.isEmpty)
    }

    @Test @MainActor
    func rapidTabSwitchDoesNotCrossContaminate() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let conversationA = ConversationModel(title: "A", conversationId: "sa")
        let conversationB = ConversationModel(title: "B", conversationId: "sb")
        delegate.conversations = [conversationA, conversationB]

        let vmA = delegate.makeViewModel()
        let vmB = delegate.makeViewModel()
        delegate.viewModels[conversationA.id] = vmA
        delegate.viewModels[conversationB.id] = vmB

        // User views conversation A, then quickly switches to B —
        // both history requests are in-flight with correct mapping.
        restorer.pendingHistoryByConversationId["sa"] = conversationA.id
        restorer.pendingHistoryByConversationId["sb"] = conversationB.id

        // Responses arrive out of order: B first, then A
        restorer.handleHistoryResponse(makeHistoryResponse(conversationId: "sb", messages: [
            (role: "assistant", text: "Response B"),
        ]))
        restorer.handleHistoryResponse(makeHistoryResponse(conversationId: "sa", messages: [
            (role: "user", text: "Request A"),
            (role: "assistant", text: "Response A"),
        ]))

        // Each VM should have its own history only
        #expect(vmA.messages.count == 2)
        #expect(vmB.messages.count == 1)
        #expect(vmA.isHistoryLoaded)
        #expect(vmB.isHistoryLoaded)
    }

    // MARK: - Conversation Title Updates

    @Test @MainActor
    func conversationTitleUpdatedUpdatesMatchingConversation() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let conversation = ConversationModel(title: "Untitled", conversationId: "session-1")
        delegate.conversations = [conversation]
        delegate.viewModels[conversation.id] = delegate.makeViewModel()

        restorer.handleConversationTitleUpdated(makeConversationTitleUpdated(conversationId: "session-1", title: "Plan sprint rollout"))

        #expect(delegate.conversations[0].title == "Plan sprint rollout")
    }

    @Test @MainActor
    func conversationTitleUpdatedIgnoresUnknownConversationId() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let conversation = ConversationModel(title: "Untitled", conversationId: "session-1")
        delegate.conversations = [conversation]
        delegate.viewModels[conversation.id] = delegate.makeViewModel()

        restorer.handleConversationTitleUpdated(makeConversationTitleUpdated(conversationId: "other-session", title: "Should not apply"))

        #expect(delegate.conversations[0].title == "Untitled")
    }

    @Test @MainActor
    func cachedForkParentIsClearedWhenServerOmitsIt() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let conversation = ConversationModel(
            title: "Cached thread",
            conversationId: "session-1",
            forkParent: ConversationForkParent(
                conversationId: "session-parent",
                messageId: "msg-parent",
                title: "Parent"
            )
        )
        let vm = delegate.makeViewModel()
        vm.conversationId = "session-1"
        delegate.conversations = [conversation]
        delegate.viewModels[conversation.id] = vm

        restorer.handleConversationListResponse(
            makeConversationListResponse(conversations: [
                (id: "session-1", title: "Cached thread", updatedAt: 1_700_000_100, conversationType: "standard")
            ])
        )

        #expect(delegate.conversations[0].forkParent == nil)
    }

    // MARK: - Conversation List Restoration

    @Test @MainActor
    func conversationListCreatesRestoredConversations() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        // Start with one empty default conversation
        let defaultConversation = ConversationModel()
        let defaultVm = delegate.makeViewModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = defaultVm

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Chat 1", updatedAt: 3000),
            (id: "s2", title: "Chat 2", updatedAt: 2000),
        ])
        restorer.handleConversationListResponse(response)

        // Default empty conversation should be replaced
        #expect(delegate.conversations.count == 2)
        #expect(delegate.viewModels[defaultConversation.id] == nil)

        // Restored conversations have correct conversation IDs
        #expect(delegate.conversations[0].conversationId == "s1")
        #expect(delegate.conversations[1].conversationId == "s2")
        #expect(delegate.conversations[0].title == "Chat 1")

        // VMs are lazily created — not eagerly allocated during restore
        #expect(delegate.viewModels[delegate.conversations[0].id] == nil)
        #expect(delegate.viewModels[delegate.conversations[1].id] == nil)

        // Most recent conversation should be activated
        #expect(delegate.activatedConversationId == delegate.conversations[0].id)
    }

    @Test @MainActor
    func conversationListPreservesAssistantAttentionTimestamps() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversationDicts: [[
            "id": "s-attention",
            "title": "Attention conversation",
            "createdAt": 1000,
            "updatedAt": 2000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 4000,
                "lastSeenAssistantMessageAt": 3000,
            ],
        ]])

        restorer.handleConversationListResponse(response)

        guard let restoredConversation = delegate.conversations.first(where: { $0.conversationId == "s-attention" }) else {
            Issue.record("Expected restored attention conversation")
            return
        }

        #expect(restoredConversation.hasUnseenLatestAssistantMessage)
        #expect(restoredConversation.latestAssistantMessageAt?.timeIntervalSince1970 == 4.0)
        #expect(restoredConversation.lastSeenAssistantMessageAt?.timeIntervalSince1970 == 3.0)
    }

    @Test @MainActor
    func conversationListSkipsWhenRestoreDisabled() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        delegate.restoreRecentConversations = false
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Chat 1", updatedAt: 1000),
        ])
        restorer.handleConversationListResponse(response)

        // Should not modify conversations
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].id == defaultConversation.id)
        #expect(delegate.activatedConversationId == nil)
    }

    @Test @MainActor
    func conversationListPreservesNonEmptyDefaultConversation() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        // Default conversation that has an active conversation (not empty)
        let activeConversation = ConversationModel(title: "Active")
        let activeVm = delegate.makeViewModel()
        activeVm.conversationId = "active-session"
        delegate.conversations = [activeConversation]
        delegate.viewModels[activeConversation.id] = activeVm

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Restored", updatedAt: 1000),
        ])
        restorer.handleConversationListResponse(response)

        // Active conversation is preserved, restored conversation prepended
        #expect(delegate.conversations.count == 2)
        #expect(delegate.conversations[1].id == activeConversation.id)
        #expect(delegate.conversations[0].conversationId == "s1")
    }

    @Test @MainActor
    func conversationListRestoresAllAndSetsOffset() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let restoredConversations = (0..<10).map { i in
            (id: "s\(i)", title: "Chat \(i)", updatedAt: 10000 - i)
        }
        restorer.handleConversationListResponse(makeConversationListResponse(conversations: restoredConversations))

        // Client restores all conversations from the response; pagination is server-side
        #expect(delegate.conversations.count == 10)
        #expect(delegate.serverOffset == 10)
    }

    // MARK: - All-Archived Restore

    @Test @MainActor
    func allArchivedConversationsCreatesNewConversation() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        // Mark all conversations as archived
        delegate.archivedConversationIds = ["s1", "s2"]

        // Start with one empty default conversation
        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Chat 1", updatedAt: 3000),
            (id: "s2", title: "Chat 2", updatedAt: 2000),
        ])
        restorer.handleConversationListResponse(response)

        // Default conversation replaced, restored conversations are archived, new conversation created
        #expect(delegate.createConversationCallCount == 1)
        // 2 archived conversations + 1 new conversation
        #expect(delegate.conversations.count == 3)
        // The new conversation should be active
        #expect(delegate.activatedConversationId != nil)
        #expect(delegate.conversations.first(where: { $0.id == delegate.activatedConversationId })?.isArchived == false)
    }

    @Test @MainActor
    func allArchivedWithNonEmptyDefaultDoesNotCreateConversation() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        delegate.archivedConversationIds = ["s1"]

        // Default conversation has an active conversation (not empty)
        let activeConversation = ConversationModel(title: "Active")
        let activeVm = delegate.makeViewModel()
        activeVm.conversationId = "active-session"
        delegate.conversations = [activeConversation]
        delegate.viewModels[activeConversation.id] = activeVm

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Archived Chat", updatedAt: 1000),
        ])
        restorer.handleConversationListResponse(response)

        // Default conversation preserved, no new conversation created
        #expect(delegate.createConversationCallCount == 0)
        #expect(delegate.conversations.count == 2)
        #expect(delegate.conversations.contains(where: { $0.id == activeConversation.id }))
    }

    // MARK: - Conversation Type Mapping

    @Test @MainActor
    func privateConversationTypeIsExcludedFromRestore() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Private Chat", updatedAt: 2000, conversationType: "private"),
        ])
        restorer.handleConversationListResponse(response)

        // Private conversations are filtered out; empty default is removed and a new conversation created
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.createConversationCallCount == 1)
    }

    @Test @MainActor
    func nilConversationTypeRestoresAsStandardKind() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Regular Chat", updatedAt: 2000, conversationType: nil),
        ])
        restorer.handleConversationListResponse(response)

        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
    }

    @Test @MainActor
    func standardConversationTypeRestoresAsStandardKind() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Standard Chat", updatedAt: 2000, conversationType: "standard"),
        ])
        restorer.handleConversationListResponse(response)

        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
    }

    // MARK: - Channel Binding Filtering

    @Test @MainActor
    func telegramBoundConversationIsExcludedFromRestore() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Telegram Chat", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "telegram", "externalChatId": "123456"]),
        ])
        restorer.handleConversationListResponse(response)

        // Telegram-bound conversation filtered out; empty default removed; new conversation created
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].conversationId == nil)
        #expect(delegate.createConversationCallCount == 1)
    }

    @Test @MainActor
    func voiceBoundConversationIsExcludedFromRestore() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Voice Call", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "phone", "externalChatId": "call-123"]),
        ])
        restorer.handleConversationListResponse(response)

        // Voice-bound conversation filtered out; empty default removed; new conversation created
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].conversationId == nil)
        #expect(delegate.createConversationCallCount == 1)
    }

    @Test @MainActor
    func mixedDesktopVoiceAndTelegramRestoresOnlyDesktop() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Desktop Chat", updatedAt: 4000, conversationType: nil, channelBinding: nil),
            (id: "s2", title: "Telegram Chat", updatedAt: 3000, conversationType: nil,
             channelBinding: ["sourceChannel": "telegram", "externalChatId": "789"]),
            (id: "s3", title: "Voice Call", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "phone", "externalChatId": "call-456"]),
            (id: "s4", title: "Another Desktop Chat", updatedAt: 1000, conversationType: nil, channelBinding: nil),
        ])
        restorer.handleConversationListResponse(response)

        // Only the two desktop conversations should be restored
        #expect(delegate.conversations.count == 2)
        #expect(delegate.conversations[0].conversationId == "s1")
        #expect(delegate.conversations[0].title == "Desktop Chat")
        #expect(delegate.conversations[1].conversationId == "s4")
        #expect(delegate.conversations[1].title == "Another Desktop Chat")
        #expect(delegate.createConversationCallCount == 0)
    }

    @Test @MainActor
    func mixedDesktopAndTelegramRestoresOnlyDesktop() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Desktop Chat", updatedAt: 3000, conversationType: nil, channelBinding: nil),
            (id: "s2", title: "Telegram Chat", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "telegram", "externalChatId": "789"]),
            (id: "s3", title: "Another Desktop Chat", updatedAt: 1000, conversationType: nil, channelBinding: nil),
        ])
        restorer.handleConversationListResponse(response)

        // Only the two desktop conversations should be restored
        #expect(delegate.conversations.count == 2)
        #expect(delegate.conversations[0].conversationId == "s1")
        #expect(delegate.conversations[0].title == "Desktop Chat")
        #expect(delegate.conversations[1].conversationId == "s3")
        #expect(delegate.conversations[1].title == "Another Desktop Chat")
        #expect(delegate.createConversationCallCount == 0)
    }
}
