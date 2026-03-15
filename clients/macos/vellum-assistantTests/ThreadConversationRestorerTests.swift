import Foundation
import Testing
@testable import VellumAssistantLib
import VellumAssistantShared

// MARK: - Mock Delegate

@MainActor
final class MockThreadRestorerDelegate: ThreadRestorerDelegate {
    var threads: [ThreadModel] = []
    var restoreRecentThreads: Bool = true
    var isLoadingMoreThreads: Bool = false
    var hasMoreThreads: Bool = false
    var serverOffset: Int = 0
    var viewModels: [UUID: ChatViewModel] = [:]
    var activatedThreadId: UUID?
    var createThreadCallCount = 0
    var archivedSessionIds: Set<String> = []
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

    func existingChatViewModel(forSessionId sessionId: String) -> ChatViewModel? {
        for (_, vm) in viewModels where vm.sessionId == sessionId {
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

    func activateThread(_ id: UUID) {
        activatedThreadId = id
    }

    func createThread() {
        createThreadCallCount += 1
        let thread = ThreadModel()
        let vm = makeViewModel()
        threads.insert(thread, at: 0)
        viewModels[thread.id] = vm
        activatedThreadId = thread.id
    }

    func isSessionArchived(_ sessionId: String) -> Bool {
        archivedSessionIds.contains(sessionId)
    }

    func restoreLastActiveThread() {
        // no-op for tests
    }

    func appendThreads(from response: SessionListResponseMessage) {
        // no-op for tests
    }

    func mergeAssistantAttention(
        from session: SessionListResponseSession,
        intoThreadAt index: Int
    ) {
        threads[index].hasUnseenLatestAssistantMessage =
            session.assistantAttention?.hasUnseenLatestAssistantMessage ?? false
        threads[index].latestAssistantMessageAt =
            session.assistantAttention?.latestAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
        threads[index].lastSeenAssistantMessageAt =
            session.assistantAttention?.lastSeenAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
    }
}

// MARK: - Helpers

/// Build a SessionListResponseMessage via JSON round-trip.
private func makeSessionListResponse(sessions: [(id: String, title: String, createdAt: Int, updatedAt: Int, conversationType: String?, channelBinding: [String: Any]?)]) -> SessionListResponseMessage {
    let sessionDicts = sessions.map { session -> [String: Any] in
        var dict: [String: Any] = ["id": session.id, "title": session.title, "createdAt": session.createdAt, "updatedAt": session.updatedAt]
        if let conversationType = session.conversationType {
            dict["conversationType"] = conversationType
        }
        if let channelBinding = session.channelBinding {
            dict["channelBinding"] = channelBinding
        }
        return dict
    }
    let dict: [String: Any] = ["type": "session_list_response", "sessions": sessionDicts]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(SessionListResponseMessage.self, from: data)
}

private func makeSessionListResponse(
    sessionDicts: [[String: Any]]
) -> SessionListResponseMessage {
    let dict: [String: Any] = [
        "type": "session_list_response",
        "sessions": sessionDicts,
    ]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(SessionListResponseMessage.self, from: data)
}

/// Convenience overload with conversationType and optional channelBinding.
private func makeSessionListResponse(sessions: [(id: String, title: String, updatedAt: Int, conversationType: String?, channelBinding: [String: Any]?)]) -> SessionListResponseMessage {
    makeSessionListResponse(sessions: sessions.map { ($0.id, $0.title, $0.updatedAt, $0.updatedAt, $0.conversationType, $0.channelBinding) })
}

/// Convenience overload with conversationType but no channelBinding.
private func makeSessionListResponse(sessions: [(id: String, title: String, updatedAt: Int, conversationType: String?)]) -> SessionListResponseMessage {
    makeSessionListResponse(sessions: sessions.map { ($0.id, $0.title, $0.updatedAt, $0.updatedAt, $0.conversationType, nil) })
}

/// Convenience overload without conversationType for existing tests.
private func makeSessionListResponse(sessions: [(id: String, title: String, updatedAt: Int)]) -> SessionListResponseMessage {
    makeSessionListResponse(sessions: sessions.map { ($0.id, $0.title, $0.updatedAt, $0.updatedAt, nil, nil) })
}

/// Build a HistoryResponse via JSON round-trip.
private func makeHistoryResponse(sessionId: String, messages: [(role: String, text: String)], hasMore: Bool = false) -> HistoryResponse {
    let msgDicts = messages.map { msg -> [String: Any] in
        ["role": msg.role, "text": msg.text, "timestamp": 1000.0]
    }
    let dict: [String: Any] = ["type": "history_response", "sessionId": sessionId, "messages": msgDicts, "hasMore": hasMore]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(HistoryResponse.self, from: data)
}

/// Build a SessionTitleUpdatedMessage via JSON round-trip.
private func makeSessionTitleUpdated(sessionId: String, title: String) -> SessionTitleUpdatedMessage {
    let dict: [String: Any] = ["type": "session_title_updated", "sessionId": sessionId, "title": title]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(SessionTitleUpdatedMessage.self, from: data)
}

// MARK: - Tests

@Suite("ThreadSessionRestorer")
struct ThreadSessionRestorerTests {

    // MARK: - History Response Routing

    @Test @MainActor
    func historyResponseRoutesToCorrectThread() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)

        // Set up two threads with session IDs
        let threadA = ThreadModel(title: "Thread A", sessionId: "session-A")
        let threadB = ThreadModel(title: "Thread B", sessionId: "session-B")
        delegate.threads = [threadA, threadB]

        let vmA = delegate.makeViewModel()
        let vmB = delegate.makeViewModel()
        delegate.viewModels[threadA.id] = vmA
        delegate.viewModels[threadB.id] = vmB

        restorer.delegate = delegate

        // Register pending history for both sessions
        restorer.pendingHistoryBySessionId["session-A"] = threadA.id
        restorer.pendingHistoryBySessionId["session-B"] = threadB.id

        // Deliver history for session-B
        let response = makeHistoryResponse(sessionId: "session-B", messages: [
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
        #expect(restorer.pendingHistoryBySessionId["session-B"] == nil)
        #expect(restorer.pendingHistoryBySessionId["session-A"] == threadA.id)
    }

    @Test @MainActor
    func staleHistoryResponseIsDropped() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let thread = ThreadModel(title: "Thread", sessionId: "session-X")
        delegate.threads = [thread]
        let vm = delegate.makeViewModel()
        delegate.viewModels[thread.id] = vm

        // No pending entry for "session-stale"
        let response = makeHistoryResponse(sessionId: "session-stale", messages: [
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
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let threadA = ThreadModel(title: "A", sessionId: "sa")
        let threadB = ThreadModel(title: "B", sessionId: "sb")
        delegate.threads = [threadA, threadB]

        let vmA = delegate.makeViewModel()
        let vmB = delegate.makeViewModel()
        delegate.viewModels[threadA.id] = vmA
        delegate.viewModels[threadB.id] = vmB

        // User views thread A, then quickly switches to B —
        // both history requests are in-flight with correct mapping.
        restorer.pendingHistoryBySessionId["sa"] = threadA.id
        restorer.pendingHistoryBySessionId["sb"] = threadB.id

        // Responses arrive out of order: B first, then A
        restorer.handleHistoryResponse(makeHistoryResponse(sessionId: "sb", messages: [
            (role: "assistant", text: "Response B"),
        ]))
        restorer.handleHistoryResponse(makeHistoryResponse(sessionId: "sa", messages: [
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
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let thread = ThreadModel(title: "Untitled", sessionId: "session-1")
        delegate.threads = [thread]
        delegate.viewModels[thread.id] = delegate.makeViewModel()

        restorer.handleSessionTitleUpdated(makeSessionTitleUpdated(sessionId: "session-1", title: "Plan sprint rollout"))

        #expect(delegate.threads[0].title == "Plan sprint rollout")
    }

    @Test @MainActor
    func sessionTitleUpdatedIgnoresUnknownSessionId() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let thread = ThreadModel(title: "Untitled", sessionId: "session-1")
        delegate.threads = [thread]
        delegate.viewModels[thread.id] = delegate.makeViewModel()

        restorer.handleSessionTitleUpdated(makeSessionTitleUpdated(sessionId: "other-session", title: "Should not apply"))

        #expect(delegate.threads[0].title == "Untitled")
    }

    // MARK: - Session List Restoration

    @Test @MainActor
    func sessionListCreatesRestoredThreads() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        // Start with one empty default thread
        let defaultThread = ThreadModel()
        let defaultVm = delegate.makeViewModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = defaultVm

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Chat 1", updatedAt: 3000),
            (id: "s2", title: "Chat 2", updatedAt: 2000),
        ])
        restorer.handleSessionListResponse(response)

        // Default empty thread should be replaced
        #expect(delegate.threads.count == 2)
        #expect(delegate.viewModels[defaultThread.id] == nil)

        // Restored threads have correct session IDs
        #expect(delegate.threads[0].sessionId == "s1")
        #expect(delegate.threads[1].sessionId == "s2")
        #expect(delegate.threads[0].title == "Chat 1")

        // VMs are lazily created — not eagerly allocated during restore
        #expect(delegate.viewModels[delegate.threads[0].id] == nil)
        #expect(delegate.viewModels[delegate.threads[1].id] == nil)

        // Most recent thread should be activated
        #expect(delegate.activatedThreadId == delegate.threads[0].id)
    }

    @Test @MainActor
    func sessionListPreservesAssistantAttentionTimestamps() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessionDicts: [[
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

        restorer.handleSessionListResponse(response)

        guard let restoredThread = delegate.threads.first(where: { $0.sessionId == "s-attention" }) else {
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
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        delegate.restoreRecentThreads = false
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Chat 1", updatedAt: 1000),
        ])
        restorer.handleSessionListResponse(response)

        // Should not modify threads
        #expect(delegate.threads.count == 1)
        #expect(delegate.threads[0].id == defaultThread.id)
        #expect(delegate.activatedThreadId == nil)
    }

    @Test @MainActor
    func sessionListPreservesNonEmptyDefaultThread() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        // Default thread that has an active session (not empty)
        let activeThread = ThreadModel(title: "Active")
        let activeVm = delegate.makeViewModel()
        activeVm.sessionId = "active-session"
        delegate.threads = [activeThread]
        delegate.viewModels[activeThread.id] = activeVm

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Restored", updatedAt: 1000),
        ])
        restorer.handleSessionListResponse(response)

        // Active thread is preserved, restored thread prepended
        #expect(delegate.threads.count == 2)
        #expect(delegate.threads[1].id == activeThread.id)
        #expect(delegate.threads[0].sessionId == "s1")
    }

    @Test @MainActor
    func sessionListRestoresAllAndSetsOffset() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let sessions = (0..<10).map { i in
            (id: "s\(i)", title: "Chat \(i)", updatedAt: 10000 - i)
        }
        restorer.handleSessionListResponse(makeSessionListResponse(sessions: sessions))

        // Client restores all sessions from the response; pagination is server-side
        #expect(delegate.threads.count == 10)
        #expect(delegate.serverOffset == 10)
    }

    // MARK: - All-Archived Restore

    @Test @MainActor
    func allArchivedSessionsCreatesNewThread() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        // Mark all sessions as archived
        delegate.archivedSessionIds = ["s1", "s2"]

        // Start with one empty default thread
        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Chat 1", updatedAt: 3000),
            (id: "s2", title: "Chat 2", updatedAt: 2000),
        ])
        restorer.handleSessionListResponse(response)

        // Default thread replaced, restored threads are archived, new thread created
        #expect(delegate.createThreadCallCount == 1)
        // 2 archived threads + 1 new thread
        #expect(delegate.threads.count == 3)
        // The new thread should be active
        #expect(delegate.activatedThreadId != nil)
        #expect(delegate.threads.first(where: { $0.id == delegate.activatedThreadId })?.isArchived == false)
    }

    @Test @MainActor
    func allArchivedWithNonEmptyDefaultDoesNotCreateThread() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        delegate.archivedSessionIds = ["s1"]

        // Default thread has an active session (not empty)
        let activeThread = ThreadModel(title: "Active")
        let activeVm = delegate.makeViewModel()
        activeVm.sessionId = "active-session"
        delegate.threads = [activeThread]
        delegate.viewModels[activeThread.id] = activeVm

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Archived Chat", updatedAt: 1000),
        ])
        restorer.handleSessionListResponse(response)

        // Default thread preserved, no new thread created
        #expect(delegate.createThreadCallCount == 0)
        #expect(delegate.threads.count == 2)
        #expect(delegate.threads.contains(where: { $0.id == activeThread.id }))
    }

    // MARK: - Thread Type Mapping

    @Test @MainActor
    func privateThreadTypeIsExcludedFromRestore() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Private Chat", updatedAt: 2000, conversationType: "private"),
        ])
        restorer.handleSessionListResponse(response)

        // Private sessions are filtered out; empty default is removed and a new thread created
        #expect(delegate.threads.count == 1)
        #expect(delegate.threads[0].kind == .standard)
        #expect(delegate.createThreadCallCount == 1)
    }

    @Test @MainActor
    func nilConversationTypeRestoresAsStandardKind() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Regular Chat", updatedAt: 2000, conversationType: nil),
        ])
        restorer.handleSessionListResponse(response)

        #expect(delegate.threads.count == 1)
        #expect(delegate.threads[0].kind == .standard)
    }

    @Test @MainActor
    func standardConversationTypeRestoresAsStandardKind() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Standard Chat", updatedAt: 2000, conversationType: "standard"),
        ])
        restorer.handleSessionListResponse(response)

        #expect(delegate.threads.count == 1)
        #expect(delegate.threads[0].kind == .standard)
    }

    // MARK: - Channel Binding Filtering

    @Test @MainActor
    func telegramBoundSessionIsExcludedFromRestore() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Telegram Chat", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "telegram", "externalChatId": "123456"]),
        ])
        restorer.handleSessionListResponse(response)

        // Telegram-bound session filtered out; empty default removed; new thread created
        #expect(delegate.threads.count == 1)
        #expect(delegate.threads[0].kind == .standard)
        #expect(delegate.threads[0].sessionId == nil)
        #expect(delegate.createThreadCallCount == 1)
    }

    @Test @MainActor
    func voiceBoundSessionIsExcludedFromRestore() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Voice Call", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "phone", "externalChatId": "call-123"]),
        ])
        restorer.handleSessionListResponse(response)

        // Voice-bound session filtered out; empty default removed; new thread created
        #expect(delegate.threads.count == 1)
        #expect(delegate.threads[0].kind == .standard)
        #expect(delegate.threads[0].sessionId == nil)
        #expect(delegate.createThreadCallCount == 1)
    }

    @Test @MainActor
    func mixedDesktopVoiceAndTelegramRestoresOnlyDesktop() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Desktop Chat", updatedAt: 4000, conversationType: nil, channelBinding: nil),
            (id: "s2", title: "Telegram Chat", updatedAt: 3000, conversationType: nil,
             channelBinding: ["sourceChannel": "telegram", "externalChatId": "789"]),
            (id: "s3", title: "Voice Call", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "phone", "externalChatId": "call-456"]),
            (id: "s4", title: "Another Desktop Chat", updatedAt: 1000, conversationType: nil, channelBinding: nil),
        ])
        restorer.handleSessionListResponse(response)

        // Only the two desktop sessions should be restored
        #expect(delegate.threads.count == 2)
        #expect(delegate.threads[0].sessionId == "s1")
        #expect(delegate.threads[0].title == "Desktop Chat")
        #expect(delegate.threads[1].sessionId == "s4")
        #expect(delegate.threads[1].title == "Another Desktop Chat")
        #expect(delegate.createThreadCallCount == 0)
    }

    @Test @MainActor
    func mixedDesktopAndTelegramRestoresOnlyDesktop() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Desktop Chat", updatedAt: 3000, conversationType: nil, channelBinding: nil),
            (id: "s2", title: "Telegram Chat", updatedAt: 2000, conversationType: nil,
             channelBinding: ["sourceChannel": "telegram", "externalChatId": "789"]),
            (id: "s3", title: "Another Desktop Chat", updatedAt: 1000, conversationType: nil, channelBinding: nil),
        ])
        restorer.handleSessionListResponse(response)

        // Only the two desktop sessions should be restored
        #expect(delegate.threads.count == 2)
        #expect(delegate.threads[0].sessionId == "s1")
        #expect(delegate.threads[0].title == "Desktop Chat")
        #expect(delegate.threads[1].sessionId == "s3")
        #expect(delegate.threads[1].title == "Another Desktop Chat")
        #expect(delegate.createThreadCallCount == 0)
    }
}
