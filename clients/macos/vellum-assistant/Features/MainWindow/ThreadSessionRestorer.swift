import Combine
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadSessionRestorer")

/// Delegate protocol so the restorer can read and mutate thread state
/// owned by `ThreadManager`.
@MainActor
protocol ThreadRestorerDelegate: AnyObject {
    var threads: [ThreadModel] { get set }
    var restoreRecentThreads: Bool { get }
    func chatViewModel(for threadId: UUID) -> ChatViewModel?
    func setChatViewModel(_ vm: ChatViewModel, for threadId: UUID)
    func removeChatViewModel(for threadId: UUID)
    func makeViewModel() -> ChatViewModel
    func activateThread(_ id: UUID)
    func createThread()
    func isSessionArchived(_ sessionId: String) -> Bool
    func restoreLastActiveThread()
}

/// Handles daemon session restoration: fetching the session list on connect,
/// creating threads for recent sessions, and loading per-thread history on demand.
@MainActor
final class ThreadSessionRestorer {
    /// Maps session IDs to thread IDs for in-flight `history_request` messages,
    /// so rapid tab switches don't cause history from one thread to land in another.
    /// Exposed as internal for `@testable` test access.
    var pendingHistoryBySessionId: [String: UUID] = [:]

    private let daemonClient: DaemonClient
    private var connectionCancellable: AnyCancellable?

    weak var delegate: ThreadRestorerDelegate?

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    func startObserving(skipInitialFetch: Bool = false) {
        daemonClient.onSessionListResponse = { [weak self] response in
            self?.handleSessionListResponse(response)
        }
        daemonClient.onHistoryResponse = { [weak self] response in
            self?.handleHistoryResponse(response)
        }
        daemonClient.onSubagentDetailResponse = { [weak self] response in
            self?.handleSubagentDetailResponse(response)
        }

        // On first launch after onboarding, skip the initial session list fetch
        // so the session restorer doesn't override the wake-up conversation thread.
        // The handlers above are still registered for later use (e.g. history loading).
        guard !skipInitialFetch else { return }

        connectionCancellable = daemonClient.$isConnected
            .removeDuplicates()
            .filter { $0 }
            .first()
            .sink { [weak self] _ in
                self?.fetchSessionList()
            }
    }

    func loadHistoryIfNeeded(threadId: UUID) {
        guard let delegate else { return }
        guard let thread = delegate.threads.first(where: { $0.id == threadId }) else { return }
        guard let sessionId = thread.sessionId else { return }
        guard let viewModel = delegate.chatViewModel(for: threadId) else { return }
        guard !viewModel.isHistoryLoaded else { return }

        pendingHistoryBySessionId[sessionId] = threadId

        do {
            try daemonClient.sendHistoryRequest(sessionId: sessionId)
        } catch {
            log.error("Failed to send history_request: \(error.localizedDescription)")
            pendingHistoryBySessionId.removeValue(forKey: sessionId)
        }
    }

    // MARK: - Response Handlers (internal for testability)

    func handleSessionListResponse(_ response: SessionListResponseMessage) {
        guard let delegate else { return }
        guard delegate.restoreRecentThreads else {
            delegate.restoreLastActiveThread()
            return
        }
        guard !response.sessions.isEmpty else {
            delegate.restoreLastActiveThread()
            return
        }

        let recentSessions = response.sessions.filter { $0.threadType != "private" }

        let defaultThreadIsEmpty = delegate.threads.count == 1
            && delegate.chatViewModel(for: delegate.threads[0].id)?.messages.isEmpty ?? true
            && delegate.chatViewModel(for: delegate.threads[0].id)?.sessionId == nil

        var restoredThreads: [ThreadModel] = []
        for session in recentSessions {
            let kind: ThreadKind = session.threadType == "private" ? .private : .standard
            let binding = session.channelBinding
            let thread = ThreadModel(
                title: session.title,
                createdAt: Date(timeIntervalSince1970: TimeInterval(session.updatedAt) / 1000.0),
                sessionId: session.id,
                isArchived: delegate.isSessionArchived(session.id),
                kind: kind,
                sourceChannel: binding?.sourceChannel,
                displayName: binding?.displayName,
                username: binding?.username,
                externalChatId: binding?.externalChatId
            )
            let viewModel = delegate.makeViewModel()
            viewModel.sessionId = session.id
            delegate.setChatViewModel(viewModel, for: thread.id)
            restoredThreads.append(thread)
        }

        if defaultThreadIsEmpty {
            if let defaultThread = delegate.threads.first {
                delegate.removeChatViewModel(for: defaultThread.id)
            }
            delegate.threads = restoredThreads
        } else {
            delegate.threads = restoredThreads + delegate.threads
        }

        if let firstVisible = restoredThreads.first(where: { !$0.isArchived }) {
            delegate.activateThread(firstVisible.id)
        } else if defaultThreadIsEmpty {
            // All restored threads are archived and the default thread was removed,
            // so create a new empty thread to avoid a blank window.
            delegate.createThread()
        }

        log.info("Restored \(restoredThreads.count) threads from daemon")
        delegate.restoreLastActiveThread()
    }

    func handleHistoryResponse(_ response: HistoryResponseMessage) {
        guard let threadId = pendingHistoryBySessionId.removeValue(forKey: response.sessionId) else { return }
        guard let viewModel = delegate?.chatViewModel(for: threadId) else { return }
        viewModel.populateFromHistory(response.messages)
        log.info("Loaded \(response.messages.count) history messages for thread \(threadId)")
    }

    func handleSubagentDetailResponse(_ response: IPCSubagentDetailResponse) {
        guard let delegate else { return }
        // Find the ChatViewModel that owns this subagent
        for thread in delegate.threads {
            guard let viewModel = delegate.chatViewModel(for: thread.id) else { continue }
            if viewModel.activeSubagents.contains(where: { $0.id == response.subagentId }) {
                viewModel.subagentDetailStore.populateFromDetailResponse(response)
                return
            }
        }
    }

    // MARK: - Private

    private func fetchSessionList() {
        do {
            try daemonClient.sendSessionList()
        } catch {
            log.error("Failed to send session_list: \(error.localizedDescription)")
        }
    }
}
