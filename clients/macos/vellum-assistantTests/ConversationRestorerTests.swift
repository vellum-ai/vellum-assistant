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
    var activatedThreadId: UUID?
    var createThreadCallCount = 0
    var archivedConversationIds: Set<String> = []
    private let daemonClient: DaemonClient

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    func chatViewModel(for threadId: UUID) -> ChatViewModel? {
        viewModels[threadId]
    }

    func existingChatViewModel(for threadId: UUID) -> ChatViewModel? {
        viewModels[threadId]
    }

    func existingChatViewModel(forConversationId conversationId: String) -> ChatViewModel? {
        for (_, vm) in viewModels where vm.conversationId == conversationId {
            return vm
        }
        return nil
    }

    func setChatViewModel(_ vm: ChatViewModel, for threadId: UUID) {
        viewModels[threadId] = vm
    }

    func removeChatViewModel(for threadId: UUID) {
        viewModels.removeValue(forKey: threadId)
    }

    func makeViewModel() -> ChatViewModel {
        ChatViewModel(daemonClient: daemonClient)
    }

    func activateConversation(_ id: UUID) {
        activatedThreadId = id
    }

    func createConversation() {
        createThreadCallCount += 1
        let thread = ConversationModel()
        let vm = makeViewModel()
        conversations.insert(thread, at: 0)
        viewModels[thread.id] = vm
        activatedThreadId = thread.id
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
        intoThreadAt index: Int
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
    func historyResponseRoutesToCorrectThread() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)

        // Set up two conversations with session IDs
        let threadA = ConversationModel(title: "Conversation A", conversationId: "session-A")
        let threadB = ConversationModel(title: "Conversation B", conversationId: "session-B")
        delegate.conversations = [threadA, threadB]

        let vmA = delegate.makeViewModel()
        let vmB = delegate.makeViewModel()
        delegate.viewModels[threadA.id] = vmA
        delegate.viewModels[threadB.id] = vmB

        restorer.delegate = delegate

        // Register pending history for both sessions
        restorer.pendingHistoryByConversationId["session-A"] = threadA.id
        restorer.pendingHistoryByConversationId["session-B"] = threadB.id

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
        #expect(restorer.pendingHistoryByConversationId["session-A"] == threadA.id)
    }

    @Test @MainActor
    func staleHistoryResponseIsDropped() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let thread = ConversationModel(title: "Thread", conversationId: "session-X")
        delegate.conversations = [thread]
        let vm = delegate.makeViewModel()
        delegate.viewModels[thread.id] = vm

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
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let threadA = ConversationModel(title: "A", conversationId: "sa")
        let threadB = ConversationModel(title: "B", conversationId: "sb")
        delegate.conversations = [threadA, threadB]

        let vmA = delegate.makeViewModel()
        let vmB = delegate.makeViewModel()
        delegate.viewModels[threadA.id] = vmA
        delegate.viewModels[threadB.id] = vmB

        // User views thread A, then quickly switches to B —
        // both history requests are in-flight with correct mapping.
        restorer.pendingHistoryByConversationId["sa"] = threadA.id
        restorer.pendingHistoryByConversationId["sb"] = threadB.id

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

    // MARK: - Session Title Updates

    @Test @MainActor
    func sessionTitleUpdatedUpdatesMatchingThread() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let thread = ConversationModel(title: "Untitled", conversationId: "session-1")
        delegate.conversations = [thread]
        delegate.viewModels[thread.id] = delegate.makeViewModel()

        restorer.handleConversationTitleUpdated(makeConversationTitleUpdated(conversationId: "session-1", title: "Plan sprint rollout"))

        #expect(delegate.conversations[0].title == "Plan sprint rollout")
    }

    @Test @MainActor
    func sessionTitleUpdatedIgnoresUnknownSessionId() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let thread = ConversationModel(title: "Untitled", conversationId: "session-1")
        delegate.conversations = [thread]
        delegate.viewModels[thread.id] = delegate.makeViewModel()

        restorer.handleConversationTitleUpdated(makeConversationTitleUpdated(conversationId: "other-session", title: "Should not apply"))

        #expect(delegate.conversations[0].title == "Untitled")
    }

    // MARK: - Session List Restoration

    @Test @MainActor
    func sessionListCreatesRestoredThreads() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        // Start with one empty default thread
        let defaultThread = ConversationModel()
        let defaultVm = delegate.makeViewModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = defaultVm

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Chat 1", updatedAt: 3000),
            (id: "s2", title: "Chat 2", updatedAt: 2000),
        ])
        restorer.handleConversationListResponse(response)

        // Default empty thread should be replaced
        #expect(delegate.conversations.count == 2)
        #expect(delegate.viewModels[defaultThread.id] == nil)

        // Restored conversations have correct session IDs
        #expect(delegate.conversations[0].conversationId == "s1")
        #expect(delegate.conversations[1].conversationId == "s2")
        #expect(delegate.conversations[0].title == "Chat 1")

        // VMs are lazily created — not eagerly allocated during restore
        #expect(delegate.viewModels[delegate.conversations[0].id] == nil)
        #expect(delegate.viewModels[delegate.conversations[1].id] == nil)

        // Most recent thread should be activated
        #expect(delegate.activatedThreadId == delegate.conversations[0].id)
    }

    @Test @MainActor
    func sessionListPreservesAssistantAttentionTimestamps() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversationDicts: [[
            "id": "s-attention",
            "title": "Attention thread",
            "createdAt": 1000,
            "updatedAt": 2000,
            "assistantAttention": [
                "hasUnseenLatestAssistantMessage": true,
                "latestAssistantMessageAt": 4000,
                "lastSeenAssistantMessageAt": 3000,
            ],
        ]])

        restorer.handleConversationListResponse(response)

        guard let restoredThread = delegate.conversations.first(where: { $0.conversationId == "s-attention" }) else {
            Issue.record("Expected restored attention thread")
            return
        }

        #expect(restoredThread.hasUnseenLatestAssistantMessage)
        #expect(restoredThread.latestAssistantMessageAt?.timeIntervalSince1970 == 4.0)
        #expect(restoredThread.lastSeenAssistantMessageAt?.timeIntervalSince1970 == 3.0)
    }

    @Test @MainActor
    func sessionListSkipsWhenRestoreDisabled() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        delegate.restoreRecentConversations = false
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Chat 1", updatedAt: 1000),
        ])
        restorer.handleConversationListResponse(response)

        // Should not modify conversations
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].id == defaultThread.id)
        #expect(delegate.activatedThreadId == nil)
    }

    @Test @MainActor
    func sessionListPreservesNonEmptyDefaultThread() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        // Default thread that has an active session (not empty)
        let activeConversation = ConversationModel(title: "Active")
        let activeVm = delegate.makeViewModel()
        activeVm.conversationId = "active-session"
        delegate.conversations = [activeConversation]
        delegate.viewModels[activeConversation.id] = activeVm

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Restored", updatedAt: 1000),
        ])
        restorer.handleConversationListResponse(response)

        // Active thread is preserved, restored thread prepended
        #expect(delegate.conversations.count == 2)
        #expect(delegate.conversations[1].id == activeConversation.id)
        #expect(delegate.conversations[0].conversationId == "s1")
    }

    @Test @MainActor
    func sessionListRestoresAllAndSetsOffset() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let sessions = (0..<10).map { i in
            (id: "s\(i)", title: "Chat \(i)", updatedAt: 10000 - i)
        }
        restorer.handleConversationListResponse(makeConversationListResponse(conversations: sessions))

        // Client restores all sessions from the response; pagination is server-side
        #expect(delegate.conversations.count == 10)
        #expect(delegate.serverOffset == 10)
    }

    // MARK: - All-Archived Restore

    @Test @MainActor
    func allArchivedSessionsCreatesNewThread() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        // Mark all sessions as archived
        delegate.archivedConversationIds = ["s1", "s2"]

        // Start with one empty default thread
        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Chat 1", updatedAt: 3000),
            (id: "s2", title: "Chat 2", updatedAt: 2000),
        ])
        restorer.handleConversationListResponse(response)

        // Default thread replaced, restored conversations are archived, new thread created
        #expect(delegate.createThreadCallCount == 1)
        // 2 archived conversations + 1 new thread
        #expect(delegate.conversations.count == 3)
        // The new thread should be active
        #expect(delegate.activatedThreadId != nil)
        #expect(delegate.conversations.first(where: { $0.id == delegate.activatedThreadId })?.isArchived == false)
    }

    @Test @MainActor
    func allArchivedWithNonEmptyDefaultDoesNotCreateThread() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        delegate.archivedConversationIds = ["s1"]

        // Default thread has an active session (not empty)
        let activeConversation = ConversationModel(title: "Active")
        let activeVm = delegate.makeViewModel()
        activeVm.conversationId = "active-session"
        delegate.conversations = [activeConversation]
        delegate.viewModels[activeConversation.id] = activeVm

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Archived Chat", updatedAt: 1000),
        ])
        restorer.handleConversationListResponse(response)

        // Default thread preserved, no new thread created
        #expect(delegate.createThreadCallCount == 0)
        #expect(delegate.conversations.count == 2)
        #expect(delegate.conversations.contains(where: { $0.id == activeConversation.id }))
    }

    // MARK: - Conversation Type Mapping

    @Test @MainActor
    func privateThreadTypeIsExcludedFromRestore() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Private Chat", updatedAt: 2000, conversationType: "private"),
        ])
        restorer.handleConversationListResponse(response)

        // Private sessions are filtered out; empty default is removed and a new thread created
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.createThreadCallCount == 1)
    }

    @Test @MainActor
    func nilConversationTypeRestoresAsStandardKind() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Regular Chat", updatedAt: 2000, conversationType: nil),
        ])
        restorer.handleConversationListResponse(response)

        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
    }

    @Test @MainActor
    func standardConversationTypeRestoresAsStandardKind() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Standard Chat", updatedAt: 2000, conversationType: "standard"),
        ])
        restorer.handleConversationListResponse(response)

        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
    }

    // MARK: - Channel Binding Filtering

    @Test @MainActor
    func telegramBoundSessionIsExcludedFromRestore() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Telegram Chat", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "telegram", "externalChatId": "123456"]),
        ])
        restorer.handleConversationListResponse(response)

        // Telegram-bound session filtered out; empty default removed; new thread created
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].conversationId == nil)
        #expect(delegate.createThreadCallCount == 1)
    }

    @Test @MainActor
    func voiceBoundSessionIsExcludedFromRestore() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Voice Call", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "phone", "externalChatId": "call-123"]),
        ])
        restorer.handleConversationListResponse(response)

        // Voice-bound session filtered out; empty default removed; new thread created
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].kind == .standard)
        #expect(delegate.conversations[0].conversationId == nil)
        #expect(delegate.createThreadCallCount == 1)
    }

    @Test @MainActor
    func mixedDesktopVoiceAndTelegramRestoresOnlyDesktop() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Desktop Chat", updatedAt: 4000, conversationType: nil, channelBinding: nil),
            (id: "s2", title: "Telegram Chat", updatedAt: 3000, conversationType: nil,
             channelBinding: ["sourceChannel": "telegram", "externalChatId": "789"]),
            (id: "s3", title: "Voice Call", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "phone", "externalChatId": "call-456"]),
            (id: "s4", title: "Another Desktop Chat", updatedAt: 1000, conversationType: nil, channelBinding: nil),
        ])
        restorer.handleConversationListResponse(response)

        // Only the two desktop sessions should be restored
        #expect(delegate.conversations.count == 2)
        #expect(delegate.conversations[0].conversationId == "s1")
        #expect(delegate.conversations[0].title == "Desktop Chat")
        #expect(delegate.conversations[1].conversationId == "s4")
        #expect(delegate.conversations[1].title == "Another Desktop Chat")
        #expect(delegate.createThreadCallCount == 0)
    }

    @Test @MainActor
    func mixedDesktopAndTelegramRestoresOnlyDesktop() {
        let dc = DaemonClient()
        let restorer = ConversationRestorer(daemonClient: dc)
        let delegate = MockConversationRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ConversationModel()
        delegate.conversations = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Desktop Chat", updatedAt: 3000, conversationType: nil, channelBinding: nil),
            (id: "s2", title: "Telegram Chat", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "telegram", "externalChatId": "789"]),
            (id: "s3", title: "Another Desktop Chat", updatedAt: 1000, conversationType: nil, channelBinding: nil),
        ])
        restorer.handleConversationListResponse(response)

        // Only the two desktop sessions should be restored
        #expect(delegate.conversations.count == 2)
        #expect(delegate.conversations[0].conversationId == "s1")
        #expect(delegate.conversations[0].title == "Desktop Chat")
        #expect(delegate.conversations[1].conversationId == "s3")
        #expect(delegate.conversations[1].title == "Another Desktop Chat")
        #expect(delegate.createThreadCallCount == 0)
    }
}
