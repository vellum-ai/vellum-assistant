import Foundation
import Testing
@testable import VellumAssistantLib
import VellumAssistantShared

// MARK: - Mock Delegate

@MainActor
final class MockConversationRestorerDelegate: ConversationRestorerDelegate {
    var conversations: [ConversationModel] = []
    var groups: [ConversationGroup] = []
    var daemonSupportsGroups: Bool = false
    var restoreRecentConversations: Bool = true
    var isLoadingMoreConversations: Bool = false
    var hasMoreConversations: Bool = false
    var serverOffset: Int = 0
    var viewModels: [UUID: ChatViewModel] = [:]
    var activatedConversationId: UUID?
    var createConversationCallCount = 0
    var archivedConversationIds: Set<String> = []
    var loadedHistoryReconciliationRequests: [(localId: UUID, daemonConversationId: String)] = []
    var mergedConversationRows: [ConversationListResponseItem] = []
    private let connectionManager: GatewayConnectionManager
    private let eventStreamClient: EventStreamClient

    init(connectionManager: GatewayConnectionManager, eventStreamClient: EventStreamClient) {
        self.connectionManager = connectionManager
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
        ChatViewModel(connectionManager: connectionManager, eventStreamClient: eventStreamClient)
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

    func reconcileLoadedConversationHistory(localId: UUID, daemonConversationId: String) {
        loadedHistoryReconciliationRequests.append((localId, daemonConversationId))
    }

    func applyAssistantAttention(
        from item: ConversationListResponseItem,
        into conversation: inout ConversationModel
    ) {
        conversation.hasUnseenLatestAssistantMessage =
            item.assistantAttention?.hasUnseenLatestAssistantMessage ?? false
        conversation.latestAssistantMessageAt =
            item.assistantAttention?.latestAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
        conversation.lastSeenAssistantMessageAt =
            item.assistantAttention?.lastSeenAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
    }

    func mergeAssistantAttention(
        from item: ConversationListResponseItem,
        intoConversationAt index: Int
    ) {
        var conversation = conversations[index]
        applyAssistantAttention(from: item, into: &conversation)
        conversations[index] = conversation
    }

    func mergeConversationRow(from item: ConversationListResponseItem) {
        mergedConversationRows.append(item)
        guard let index = conversations.firstIndex(where: { $0.conversationId == item.id }) else { return }
        var conversation = conversations[index]
        if conversation.title == "New Conversation" {
            conversation.title = item.title
        }
        applyAssistantAttention(from: item, into: &conversation)
        conversations[index] = conversation
    }
}

private struct NoopConversationHistoryClient: ConversationHistoryClientProtocol {
    func fetchHistory(
        conversationId: String,
        limit: Int?,
        beforeTimestamp: Double?,
        mode: String?,
        maxTextChars: Int?,
        maxToolResultChars: Int?
    ) async -> HistoryResponse? {
        nil
    }
}

private actor RecordingConversationListClient: ConversationListClientProtocol {
    private(set) var fetchRequests: [(offset: Int, limit: Int, conversationType: String?, archiveStatus: String?)] = []

    func fetchConversationList(offset: Int, limit: Int, conversationType: String?, archiveStatus: String?) async -> ConversationListResponse? {
        fetchRequests.append((offset: offset, limit: limit, conversationType: conversationType, archiveStatus: archiveStatus))
        return ConversationListResponse(
            type: "conversation_list_response",
            conversations: [],
            hasMore: false,
            nextOffset: nil,
            groups: nil
        )
    }

    func switchConversation(conversationId: String) async -> Bool { true }
    func renameConversation(conversationId: String, name: String) async -> Bool { true }
    func clearAllConversations() async -> Bool { true }
    func cancelGeneration(conversationId: String) async -> Bool { true }
    func undoLastMessage(conversationId: String) async -> Int? { nil }
    func searchConversations(query: String, limit: Int?, maxMessagesPerConversation: Int?) async -> ConversationSearchResponse? { nil }
    func reorderConversations(updates: [ReorderConversationsRequestUpdate]) async -> Bool { true }
    func sendConversationSeen(_ signal: ConversationSeenSignal) async -> Bool { true }
}

/// Records single-conversation fetches and returns a preconfigured item per id,
/// so tests can assert a metadata sync tag patches one row instead of draining
/// the full paginated list.
private actor RecordingConversationDetailClient: ConversationDetailClientProtocol {
    private(set) var fetchedConversationIds: [String] = []
    private let items: [String: ConversationListResponseItem]

    init(items: [String: ConversationListResponseItem] = [:]) {
        self.items = items
    }

    func fetchConversation(conversationId: String) async -> ConversationListResponseItem? {
        fetchedConversationIds.append(conversationId)
        return items[conversationId]
    }
}

/// Mock that returns paged responses (`hasMore=true` until the configured
/// total is exhausted) so tests can verify the restorer drains every page
/// instead of stopping at the first.
private actor PagedConversationListClient: ConversationListClientProtocol {
    /// Total rows per (conversationType, archiveStatus) bucket. The archived
    /// bucket is keyed on `archiveStatus == "archived"` (with
    /// `conversationType == nil`); everything else keys on
    /// `conversationType` with `archiveStatus == nil`.
    private let totalForeground: Int
    private let totalBackground: Int
    private let totalArchived: Int
    private(set) var fetchRequests: [(offset: Int, limit: Int, conversationType: String?, archiveStatus: String?)] = []

    init(totalForeground: Int, totalBackground: Int, totalArchived: Int = 0) {
        self.totalForeground = totalForeground
        self.totalBackground = totalBackground
        self.totalArchived = totalArchived
    }

    func fetchConversationList(offset: Int, limit: Int, conversationType: String?, archiveStatus: String?) async -> ConversationListResponse? {
        fetchRequests.append((offset: offset, limit: limit, conversationType: conversationType, archiveStatus: archiveStatus))
        let total: Int
        let prefix: String
        if archiveStatus == "archived" {
            total = totalArchived
            prefix = "archived"
        } else if conversationType == "background" {
            total = totalBackground
            prefix = "background"
        } else {
            total = totalForeground
            prefix = "fg"
        }
        let remaining = max(0, total - offset)
        let pageCount = min(remaining, limit)
        let items: [ConversationListResponseItem] = (0..<pageCount).map { i in
            let dict: [String: Any] = [
                "id": "\(prefix)-\(offset + i)",
                "title": "row \(offset + i)",
                "updatedAt": 1_700_000_000 + offset + i,
            ]
            let data = try! JSONSerialization.data(withJSONObject: dict)
            return try! JSONDecoder().decode(ConversationListResponseItem.self, from: data)
        }
        let nextOffset = offset + pageCount
        return ConversationListResponse(
            type: "conversation_list_response",
            conversations: items,
            hasMore: nextOffset < total,
            nextOffset: nextOffset,
            groups: nil
        )
    }

    func switchConversation(conversationId: String) async -> Bool { true }
    func renameConversation(conversationId: String, name: String) async -> Bool { true }
    func clearAllConversations() async -> Bool { true }
    func cancelGeneration(conversationId: String) async -> Bool { true }
    func undoLastMessage(conversationId: String) async -> Int? { nil }
    func searchConversations(query: String, limit: Int?, maxMessagesPerConversation: Int?) async -> ConversationSearchResponse? { nil }
    func reorderConversations(updates: [ReorderConversationsRequestUpdate]) async -> Bool { true }
    func sendConversationSeen(_ signal: ConversationSeenSignal) async -> Bool { true }
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

/// Build a single ConversationListResponseItem via JSON round-trip, used to
/// stub `RecordingConversationDetailClient` responses.
private func makeConversationItem(id: String, title: String, updatedAt: Int = 1_700_000_000, hasUnseen: Bool? = nil) -> ConversationListResponseItem {
    var dict: [String: Any] = ["id": id, "title": title, "updatedAt": updatedAt]
    if let hasUnseen {
        dict["assistantAttention"] = ["hasUnseenLatestAssistantMessage": hasUnseen]
    }
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(ConversationListResponseItem.self, from: data)
}

// MARK: - Tests

@Suite("ConversationRestorer")
struct ConversationRestorerTests {

    // MARK: - History Response Routing

    @Test @MainActor
    func historyResponseRoutesToCorrectConversation() async {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)

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
        await restorer.awaitPendingHistoryReconstructions()

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
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
    func rapidTabSwitchDoesNotCrossContaminate() async {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
        await restorer.awaitPendingHistoryReconstructions()

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
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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

        // Cold launch stays on the draft VM — no auto-activation from the restored list.
        #expect(delegate.activatedConversationId == nil)
    }

    @Test @MainActor
    func conversationListPreservesAssistantAttentionTimestamps() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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
    func nilConversationTypeRestoresConversation() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Regular Chat", updatedAt: 2000, conversationType: nil),
        ])
        restorer.handleConversationListResponse(response)

        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].conversationType == nil)
    }

    @Test @MainActor
    func standardConversationTypeRestoresConversationType() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Standard Chat", updatedAt: 2000, conversationType: "standard"),
        ])
        restorer.handleConversationListResponse(response)

        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].conversationType == "standard")
    }

    // MARK: - Channel Binding Filtering

    @Test @MainActor
    func telegramBoundConversationIsIncludedInRestore() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Telegram Chat", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "telegram", "externalChatId": "123456"]),
        ])
        restorer.handleConversationListResponse(response)

        // Telegram-bound conversation is included with originChannel populated
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].conversationId == "s1")
        #expect(delegate.conversations[0].originChannel == "telegram")
        #expect(delegate.createConversationCallCount == 0)
    }

    @Test @MainActor
    func voiceBoundConversationIsIncludedInRestore() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let defaultConversation = ConversationModel()
        delegate.conversations = [defaultConversation]
        delegate.viewModels[defaultConversation.id] = delegate.makeViewModel()

        let response = makeConversationListResponse(conversations: [
            (id: "s1", title: "Voice Call", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "phone", "externalChatId": "call-123"]),
        ])
        restorer.handleConversationListResponse(response)

        // Voice-bound conversation is included with originChannel populated
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].conversationId == "s1")
        #expect(delegate.conversations[0].originChannel == "phone")
        #expect(delegate.createConversationCallCount == 0)
    }

    @Test @MainActor
    func mixedDesktopVoiceAndTelegramRestoresAll() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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

        // All four conversations should be restored with correct originChannel values
        #expect(delegate.conversations.count == 4)
        #expect(delegate.conversations[0].originChannel == nil)
        #expect(delegate.conversations[1].originChannel == "telegram")
        #expect(delegate.conversations[2].originChannel == "phone")
        #expect(delegate.conversations[3].originChannel == nil)
        #expect(delegate.createConversationCallCount == 0)
    }

    @Test @MainActor
    func mixedDesktopAndTelegramRestoresAll() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
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

        // All three conversations should be restored with correct originChannel values
        #expect(delegate.conversations.count == 3)
        #expect(delegate.conversations[1].originChannel == "telegram")
        #expect(delegate.createConversationCallCount == 0)
    }

    // MARK: - Invalidation Refetch Preserves Selection

    /// Verifies that a conversation list refresh (triggered by invalidation refetch)
    /// preserves the selected conversation's local ID, loaded history, and view model.
    @Test @MainActor
    func refreshPreservesSelectedConversationThroughInvalidationRefetch() async {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        // GIVEN two restored conversations with the selected one having loaded history
        let conversationA = ConversationModel(title: "Chat A", conversationId: "sa")
        let conversationB = ConversationModel(title: "Chat B", conversationId: "sb")
        delegate.conversations = [conversationA, conversationB]

        let vmA = delegate.makeViewModel()
        vmA.conversationId = "sa"
        delegate.viewModels[conversationA.id] = vmA
        delegate.activatedConversationId = conversationA.id

        // AND conversation A has history loaded via the restorer
        restorer.pendingHistoryByConversationId["sa"] = conversationA.id
        restorer.handleHistoryResponse(makeHistoryResponse(
            conversationId: "sa",
            messages: [(role: "user", text: "Hello")]
        ))
        await restorer.awaitPendingHistoryReconstructions()

        let vmB = delegate.makeViewModel()
        vmB.conversationId = "sb"
        delegate.viewModels[conversationB.id] = vmB

        // AND we capture the pre-refresh state
        let selectedIdBefore = delegate.activatedConversationId
        let localIdA = conversationA.id
        let localIdB = conversationB.id
        #expect(vmA.isHistoryLoaded)
        #expect(vmA.messages.count == 1)

        // WHEN a conversation list response arrives (simulating invalidation refetch)
        let refreshResponse = makeConversationListResponse(conversations: [
            (id: "sa", title: "Chat A (updated)", updatedAt: 5000),
            (id: "sb", title: "Chat B", updatedAt: 4000),
        ])
        restorer.handleConversationListResponse(refreshResponse)

        // THEN the selected conversation ID is unchanged
        #expect(delegate.activatedConversationId == selectedIdBefore)

        // AND the local UUIDs for existing conversations are preserved (not replaced)
        #expect(delegate.conversations.contains(where: { $0.id == localIdA }))
        #expect(delegate.conversations.contains(where: { $0.id == localIdB }))

        // AND the view model for the selected conversation still has its loaded history
        let vmAfter = delegate.viewModels[localIdA]
        #expect(vmAfter === vmA)
        #expect(vmAfter?.isHistoryLoaded == true)
        #expect(vmAfter?.messages.count == 1)

        // AND user-set titles are preserved (not overwritten by the server)
        let conversationAfter = delegate.conversations.first(where: { $0.id == localIdA })
        #expect(conversationAfter?.title == "Chat A")

        // AND mutable metadata (lastInteractedAt) was refreshed from the server
        let expectedDate = Date(timeIntervalSince1970: TimeInterval(5000) / 1000.0)
        #expect(conversationAfter?.lastInteractedAt == expectedDate)
    }

    @Test @MainActor
    func refreshRequestsLatestHistoryReconciliationWhenLatestMessageTimestampChanges() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let conversation = ConversationModel(title: "Chat A", conversationId: "sa")
        delegate.conversations = [conversation]

        let firstRefresh = makeConversationListResponse(conversationDicts: [[
            "id": "sa",
            "title": "Chat A",
            "updatedAt": 2_000,
            "lastMessageAt": 2_000,
        ]])
        restorer.handleConversationListResponse(firstRefresh)

        #expect(delegate.loadedHistoryReconciliationRequests.count == 1)
        #expect(delegate.loadedHistoryReconciliationRequests.first?.localId == conversation.id)
        #expect(delegate.loadedHistoryReconciliationRequests.first?.daemonConversationId == "sa")

        restorer.handleConversationListResponse(firstRefresh)
        #expect(delegate.loadedHistoryReconciliationRequests.count == 1)

        restorer.handleConversationListResponse(makeConversationListResponse(conversationDicts: [[
            "id": "sa",
            "title": "Chat A",
            "updatedAt": 3_000,
            "lastMessageAt": 3_000,
        ]]))
        #expect(delegate.loadedHistoryReconciliationRequests.count == 2)
    }

    /// Verifies that a default-titled conversation gets its title updated
    /// from the server during an invalidation refetch.
    @Test @MainActor
    func refreshUpdatesDefaultTitleFromServer() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        // GIVEN a conversation with the default title
        let conversation = ConversationModel(title: "New Conversation", conversationId: "s1")
        delegate.conversations = [conversation]
        let vm = delegate.makeViewModel()
        vm.conversationId = "s1"
        delegate.viewModels[conversation.id] = vm

        // WHEN a conversation list response arrives with an updated title
        let refreshResponse = makeConversationListResponse(conversations: [
            (id: "s1", title: "Renamed Chat", updatedAt: 5000),
        ])
        restorer.handleConversationListResponse(refreshResponse)

        // THEN the title is updated from the server
        let updated = delegate.conversations.first(where: { $0.id == conversation.id })
        #expect(updated?.title == "Renamed Chat")
    }

    /// Verifies that scheduleInvalidationRefetch uses trailing-edge debounce:
    /// rapid calls reset the timer so only the final call fires.
    @Test @MainActor
    func invalidationRefetchDebouncesCancelsPriorSchedule() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        // GIVEN a conversation already exists
        let conversation = ConversationModel(title: "Chat", conversationId: "s1")
        delegate.conversations = [conversation]
        let vm = delegate.makeViewModel()
        vm.conversationId = "s1"
        delegate.viewModels[conversation.id] = vm

        // WHEN scheduleInvalidationRefetch is called twice rapidly
        restorer.scheduleInvalidationRefetch()
        restorer.scheduleInvalidationRefetch()

        // THEN the conversation state is unchanged (debounce hasn't fired yet)
        #expect(delegate.conversations.count == 1)
        #expect(delegate.conversations[0].id == conversation.id)
    }

    @Test @MainActor
    func syncMessageRouteQueuesActiveConversationHistoryWithoutListRefetch() async {
        let dc = GatewayConnectionManager()
        let listClient = RecordingConversationListClient()
        let restorer = ConversationRestorer(
            connectionManager: dc,
            eventStreamClient: dc.eventStreamClient,
            conversationHistoryClient: NoopConversationHistoryClient(),
            conversationListClient: listClient
        )
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let active = ConversationModel(title: "Active", conversationId: "conv-active")
        let inactive = ConversationModel(title: "Inactive", conversationId: "conv-inactive")
        delegate.conversations = [active, inactive]

        restorer.handleSyncRoutes(
            [
                .conversationMessages(conversationId: "conv-active"),
                .conversationMessages(conversationId: "conv-inactive"),
            ],
            activeConversationId: "conv-active"
        )

        // Only the active conversation's history is reconciled.
        #expect(restorer.pendingHistoryByConversationId["conv-active"] == active.id)
        #expect(restorer.pendingHistoryByConversationId["conv-inactive"] == nil)

        try? await Task.sleep(nanoseconds: 500_000_000)
        // A messages-only change doesn't alter the list shape, so the full
        // paginated list is never refetched (previously this drained 3 streams).
        #expect(await listClient.fetchRequests.isEmpty)
    }

    @Test @MainActor
    func syncMetadataRoutePatchesSingleRowWithoutListRefetch() async {
        let dc = GatewayConnectionManager()
        let listClient = RecordingConversationListClient()
        let detailClient = RecordingConversationDetailClient(items: [
            "conv-1": makeConversationItem(id: "conv-1", title: "Renamed", updatedAt: 5_000, hasUnseen: true)
        ])
        let restorer = ConversationRestorer(
            connectionManager: dc,
            eventStreamClient: dc.eventStreamClient,
            conversationHistoryClient: NoopConversationHistoryClient(),
            conversationListClient: listClient,
            conversationDetailClient: detailClient
        )
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let conversation = ConversationModel(title: "Original", conversationId: "conv-1")
        delegate.conversations = [conversation]

        restorer.handleSyncRoutes([.conversationMetadata(conversationId: "conv-1")], activeConversationId: nil)

        try? await Task.sleep(nanoseconds: 500_000_000)

        // The single-conversation endpoint was hit for exactly the changed row...
        #expect(await detailClient.fetchedConversationIds == ["conv-1"])
        // ...and the full paginated list was NOT refetched.
        #expect(await listClient.fetchRequests.isEmpty)
        // The row was patched in place (attention merged from the fetched item).
        #expect(delegate.mergedConversationRows.map(\.id) == ["conv-1"])
        #expect(delegate.conversations.first(where: { $0.conversationId == "conv-1" })?.hasUnseenLatestAssistantMessage == true)
    }

    @Test @MainActor
    func syncConversationListRouteTriggersRecentRefetchNotSingleRow() async {
        let dc = GatewayConnectionManager()
        let listClient = RecordingConversationListClient()
        let detailClient = RecordingConversationDetailClient()
        let restorer = ConversationRestorer(
            connectionManager: dc,
            eventStreamClient: dc.eventStreamClient,
            conversationHistoryClient: NoopConversationHistoryClient(),
            conversationListClient: listClient,
            conversationDetailClient: detailClient
        )
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        restorer.handleSyncRoutes([.conversationList], activeConversationId: nil)

        try? await Task.sleep(nanoseconds: 500_000_000)

        // A shape change triggers a cheap page-1 refetch of the 3 streams
        // (foreground, background, archived) — NOT a full paginated drain, and
        // NOT the single-conversation endpoint (RecordingConversationListClient
        // returns one empty page per stream, so exactly 3 requests).
        #expect(await listClient.fetchRequests.count == 3)
        #expect(await listClient.fetchRequests.allSatisfy { $0.offset == 0 })
        #expect(await detailClient.fetchedConversationIds.isEmpty)
    }

    @Test @MainActor
    func invalidationRefetchFetchesRecentPageOnlyAndPreservesExistingRows() async {
        let dc = GatewayConnectionManager()
        // totalForeground 450 / background 700 means a full drain would paginate
        // (3 + 4 pages); a page-1-only refetch must issue exactly one request
        // per stream at offset 0.
        let listClient = PagedConversationListClient(totalForeground: 450, totalBackground: 700)
        let restorer = ConversationRestorer(
            connectionManager: dc,
            eventStreamClient: dc.eventStreamClient,
            conversationHistoryClient: NoopConversationHistoryClient(),
            conversationListClient: listClient
        )
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        // Seed two already-loaded rows that the page-1 fetch will NOT return,
        // plus sentinel pagination state that a recent refetch must not reset.
        delegate.conversations = [
            ConversationModel(title: "Old 1", conversationId: "old-1"),
            ConversationModel(title: "Old 2", conversationId: "old-2"),
        ]
        delegate.serverOffset = 999
        delegate.hasMoreConversations = true

        restorer.scheduleInvalidationRefetch()
        // 250ms debounce + the (fast, non-paginating) 3-stream page-1 fetch.
        try? await Task.sleep(nanoseconds: 800_000_000)

        let requests = await listClient.fetchRequests
        // Exactly one request per stream, all at offset 0 — no pagination loop.
        #expect(requests.count == 3)
        #expect(requests.allSatisfy { $0.offset == 0 })
        #expect(requests.contains { $0.conversationType == nil && $0.archiveStatus == nil })
        #expect(requests.contains { $0.conversationType == "background" })
        #expect(requests.contains { $0.archiveStatus == "archived" })

        // The out-of-window rows are preserved (merge, not replace)...
        #expect(delegate.conversations.contains { $0.conversationId == "old-1" })
        #expect(delegate.conversations.contains { $0.conversationId == "old-2" })
        // ...and the recent page-1 rows were merged in.
        #expect(delegate.conversations.contains { $0.conversationId == "fg-0" })

        // Pagination state is untouched by the recent refetch.
        #expect(delegate.serverOffset == 999)
        #expect(delegate.hasMoreConversations == true)
    }

    @Test @MainActor
    func fetchConversationListPaginatesUntilHasMoreIsFalse() async {
        let dc = GatewayConnectionManager()
        let listClient = PagedConversationListClient(totalForeground: 450, totalBackground: 700)
        let restorer = ConversationRestorer(
            connectionManager: dc,
            eventStreamClient: dc.eventStreamClient,
            conversationHistoryClient: NoopConversationHistoryClient(),
            conversationListClient: listClient
        )
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        // Cold-start full drain — the path that paginates every stream to
        // exhaustion. The invalidation path is now page-1-only, so exercise the
        // drain directly via fetchConversationList().
        restorer.fetchConversationList()

        // Give the pagination loop enough time to drain both endpoints.
        try? await Task.sleep(nanoseconds: 1_500_000_000)

        // Foreground (archiveStatus == nil → daemon active default): 450 rows
        // -> ceil(450/200) = 3 pages (offsets 0, 200, 400).
        // Background: 700 rows -> ceil(700/200) = 4 pages (offsets 0, 200, 400, 600).
        // Archived: 0 rows -> 1 page (the empty response terminates the loop).
        let requests = await listClient.fetchRequests
        let foregroundRequests = requests.filter {
            $0.conversationType == nil && $0.archiveStatus == nil
        }
        let backgroundRequests = requests.filter { $0.conversationType == "background" }
        let archivedRequests = requests.filter { $0.archiveStatus == "archived" }
        #expect(foregroundRequests.count == 3)
        #expect(backgroundRequests.count == 4)
        #expect(archivedRequests.count == 1)
        #expect(foregroundRequests.map(\.offset) == [0, 200, 400])
        #expect(backgroundRequests.map(\.offset) == [0, 200, 400, 600])
        #expect(archivedRequests.allSatisfy { $0.archiveStatus == "archived" })

        // After draining, every row from both endpoints should be present and
        // the sidebar's "Load More" affordance should be disabled.
        #expect(delegate.conversations.count == 1150)
        #expect(delegate.hasMoreConversations == false)
        #expect(delegate.serverOffset == 450)
    }

    @Test @MainActor
    func fetchConversationListMergesArchivedStream() async {
        let dc = GatewayConnectionManager()
        let listClient = PagedConversationListClient(
            totalForeground: 10,
            totalBackground: 5,
            totalArchived: 7
        )
        let restorer = ConversationRestorer(
            connectionManager: dc,
            eventStreamClient: dc.eventStreamClient,
            conversationHistoryClient: NoopConversationHistoryClient(),
            conversationListClient: listClient
        )
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        // Cold-start full drain — exercised directly (the invalidation path is
        // page-1-only and would not paginate the archived stream).
        restorer.fetchConversationList()
        try? await Task.sleep(nanoseconds: 1_500_000_000)

        let requests = await listClient.fetchRequests
        let archivedRequests = requests.filter { $0.archiveStatus == "archived" }
        // Archived: 7 rows -> 1 page (totalArchived <= pageSize).
        #expect(archivedRequests.count == 1)
        // Foreground stream is unaware of archived rows — pass `archiveStatus`
        // explicitly only when the caller wants archived.
        let foregroundRequests = requests.filter {
            $0.conversationType == nil && $0.archiveStatus == nil
        }
        #expect(foregroundRequests.allSatisfy { $0.archiveStatus == nil })

        // Merged: 10 foreground + 5 background + 7 archived = 22 rows.
        #expect(delegate.conversations.count == 22)
        // serverOffset reflects the foreground DB cursor only — archived rows
        // don't shift the loadMore offset.
        #expect(delegate.serverOffset == 10)
    }

    @Test @MainActor
    func broadSyncRefreshQueuesActiveConversationHistory() {
        let dc = GatewayConnectionManager()
        let restorer = ConversationRestorer(
            connectionManager: dc,
            eventStreamClient: dc.eventStreamClient,
            conversationHistoryClient: NoopConversationHistoryClient()
        )
        let delegate = MockConversationRestorerDelegate(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        restorer.delegate = delegate

        let active = ConversationModel(title: "Active", conversationId: "conv-active")
        delegate.conversations = [active]

        restorer.handleBroadSyncRefresh(activeConversationId: "conv-active")

        #expect(restorer.pendingHistoryByConversationId["conv-active"] == active.id)
    }
}
