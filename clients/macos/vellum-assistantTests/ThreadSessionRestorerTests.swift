import Foundation
import Testing
@testable import VellumAssistantLib
import VellumAssistantShared

// MARK: - Mock Delegate

@MainActor
final class MockThreadRestorerDelegate: ThreadRestorerDelegate {
    var threads: [ThreadModel] = []
    var restoreRecentThreads: Bool = true
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
}

// MARK: - Helpers

/// Build an IPCSessionListResponse via JSON round-trip.
private func makeSessionListResponse(sessions: [(id: String, title: String, updatedAt: Int, threadType: String?)]) -> SessionListResponseMessage {
    let sessionDicts = sessions.map { session -> [String: Any] in
        var dict: [String: Any] = ["id": session.id, "title": session.title, "updatedAt": session.updatedAt]
        if let threadType = session.threadType {
            dict["threadType"] = threadType
        }
        return dict
    }
    let dict: [String: Any] = ["type": "session_list_response", "sessions": sessionDicts]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(SessionListResponseMessage.self, from: data)
}

/// Convenience overload without threadType for existing tests.
private func makeSessionListResponse(sessions: [(id: String, title: String, updatedAt: Int)]) -> SessionListResponseMessage {
    makeSessionListResponse(sessions: sessions.map { ($0.id, $0.title, $0.updatedAt, nil) })
}

/// Build an IPCHistoryResponse via JSON round-trip.
private func makeHistoryResponse(sessionId: String, messages: [(role: String, text: String)]) -> HistoryResponseMessage {
    let msgDicts = messages.map { msg -> [String: Any] in
        ["role": msg.role, "text": msg.text, "timestamp": 1000.0]
    }
    let dict: [String: Any] = ["type": "history_response", "sessionId": sessionId, "messages": msgDicts]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(HistoryResponseMessage.self, from: data)
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

        // View models were created and assigned session IDs
        let vm1 = delegate.viewModels[delegate.threads[0].id]
        let vm2 = delegate.viewModels[delegate.threads[1].id]
        #expect(vm1?.sessionId == "s1")
        #expect(vm2?.sessionId == "s2")

        // Most recent thread should be activated
        #expect(delegate.activatedThreadId == delegate.threads[0].id)
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
    func sessionListCapsAtFive() {
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

        // Only 5 sessions should be restored
        #expect(delegate.threads.count == 5)
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
            (id: "s1", title: "Private Chat", updatedAt: 2000, threadType: "private"),
        ])
        restorer.handleSessionListResponse(response)

        // Private sessions are filtered out; empty default is removed and a new thread created
        #expect(delegate.threads.count == 1)
        #expect(delegate.threads[0].kind == .standard)
        #expect(delegate.createThreadCallCount == 1)
    }

    @Test @MainActor
    func nilThreadTypeRestoresAsStandardKind() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Regular Chat", updatedAt: 2000, threadType: nil),
        ])
        restorer.handleSessionListResponse(response)

        #expect(delegate.threads.count == 1)
        #expect(delegate.threads[0].kind == .standard)
    }

    @Test @MainActor
    func standardThreadTypeRestoresAsStandardKind() {
        let dc = DaemonClient()
        let restorer = ThreadSessionRestorer(daemonClient: dc)
        let delegate = MockThreadRestorerDelegate(daemonClient: dc)
        restorer.delegate = delegate

        let defaultThread = ThreadModel()
        delegate.threads = [defaultThread]
        delegate.viewModels[defaultThread.id] = delegate.makeViewModel()

        let response = makeSessionListResponse(sessions: [
            (id: "s1", title: "Standard Chat", updatedAt: 2000, threadType: "standard"),
        ])
        restorer.handleSessionListResponse(response)

        #expect(delegate.threads.count == 1)
        #expect(delegate.threads[0].kind == .standard)
    }
}
