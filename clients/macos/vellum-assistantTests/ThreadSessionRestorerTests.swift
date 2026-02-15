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
}

// MARK: - Helpers

/// Build an IPCSessionListResponse via JSON round-trip.
private func makeSessionListResponse(sessions: [(id: String, title: String, updatedAt: Int)]) -> SessionListResponseMessage {
    let sessionDicts = sessions.map { session -> [String: Any] in
        ["id": session.id, "title": session.title, "updatedAt": session.updatedAt]
    }
    let dict: [String: Any] = ["type": "session_list_response", "sessions": sessionDicts]
    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(SessionListResponseMessage.self, from: data)
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
}
