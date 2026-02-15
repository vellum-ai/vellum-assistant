import Combine
import VellumAssistantShared
import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadManager")

@MainActor
final class ThreadManager: ObservableObject {
    @Published var threads: [ThreadModel] = []
    @Published var activeThreadId: UUID? {
        didSet {
            subscribeToActiveViewModel()
            loadHistoryForActiveThreadIfNeeded()
        }
    }

    private var chatViewModels: [UUID: ChatViewModel] = [:]
    private let daemonClient: DaemonClient
    private var viewModelCancellable: AnyCancellable?
    private var connectionCancellable: AnyCancellable?

    /// Maps session IDs to thread IDs for in-flight history_request messages,
    /// so rapid tab switches don't cause history from one thread to land in another.
    private var pendingHistoryBySessionId: [String: UUID] = [:]

    /// Called when an inline confirmation response should dismiss the floating panel.
    var confirmationDismissHandler: ((String) -> Void)?

    var activeViewModel: ChatViewModel? {
        guard let activeThreadId else { return nil }
        return chatViewModels[activeThreadId]
    }

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        // Create one default thread so the window is never empty
        createThread()
        observeDaemonConnection()
    }

    func createThread() {
        let thread = ThreadModel()
        let viewModel = makeViewModel()
        threads.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        activeThreadId = thread.id
        log.info("Created thread \(thread.id) with title \"\(thread.title)\"")
    }

    func closeThread(id: UUID) {
        // No-op if only 1 thread remains
        guard threads.count > 1 else { return }

        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }

        // Cancel any active generation so the daemon doesn't keep processing
        // an orphaned request after the view model is removed.
        chatViewModels[id]?.stopGenerating()

        threads.remove(at: index)
        chatViewModels.removeValue(forKey: id)

        // If the closed thread was active, select an adjacent thread
        if activeThreadId == id {
            // Prefer the thread at the same index (next), otherwise fall back to last
            if index < threads.count {
                activeThreadId = threads[index].id
            } else {
                activeThreadId = threads.last?.id
            }
        }

        log.info("Closed thread \(id)")
    }

    func selectThread(id: UUID) {
        guard threads.contains(where: { $0.id == id }) else { return }
        activeThreadId = id
    }

    /// Update confirmation state across ALL chat view models, not just the active one.
    /// This ensures that when the floating panel responds, the originating thread's
    /// inline confirmation is updated even if the user switched threads.
    func updateConfirmationStateAcrossThreads(requestId: String, decision: String) {
        for viewModel in chatViewModels.values {
            viewModel.updateConfirmationState(requestId: requestId, decision: decision)
        }
    }

    /// Returns true if the given ChatViewModel is the one that most recently
    /// received a `toolUseStart` event across all threads. Used to route
    /// `confirmationRequest` messages (which lack a sessionId) to exactly
    /// one ChatViewModel, preventing duplicates and ensuring confirmations
    /// are accepted even in flows that don't go through `sendMessage()`.
    func isLatestToolUseRecipient(_ viewModel: ChatViewModel) -> Bool {
        guard let timestamp = viewModel.lastToolUseReceivedAt else { return false }
        for other in chatViewModels.values where other !== viewModel {
            if let otherTimestamp = other.lastToolUseReceivedAt, otherTimestamp > timestamp {
                return false
            }
        }
        return true
    }

    // MARK: - Session Restoration

    private func observeDaemonConnection() {
        daemonClient.onSessionListResponse = { [weak self] response in
            self?.handleSessionListResponse(response)
        }
        daemonClient.onHistoryResponse = { [weak self] response in
            self?.handleHistoryResponse(response)
        }

        // Fetch session list when daemon connects
        connectionCancellable = daemonClient.$isConnected
            .removeDuplicates()
            .filter { $0 }
            .first()
            .sink { [weak self] _ in
                self?.fetchSessionList()
            }
    }

    private func fetchSessionList() {
        do {
            try daemonClient.sendSessionList()
        } catch {
            log.error("Failed to send session_list: \(error.localizedDescription)")
        }
    }

    private func handleSessionListResponse(_ response: SessionListResponseMessage) {
        guard !response.sessions.isEmpty else { return }

        // Load up to 5 most recent sessions (daemon returns them sorted by updatedAt DESC)
        let recentSessions = Array(response.sessions.prefix(5))

        // Check if the default "New Thread" is still unused
        let defaultThreadIsEmpty = threads.count == 1
            && chatViewModels[threads[0].id]?.messages.isEmpty ?? true
            && chatViewModels[threads[0].id]?.sessionId == nil

        var restoredThreads: [ThreadModel] = []
        for session in recentSessions {
            let thread = ThreadModel(
                title: session.title,
                createdAt: Date(timeIntervalSince1970: TimeInterval(session.updatedAt) / 1000.0),
                sessionId: session.id
            )
            let viewModel = makeViewModel()
            viewModel.sessionId = session.id
            chatViewModels[thread.id] = viewModel
            restoredThreads.append(thread)
        }

        if defaultThreadIsEmpty {
            // Replace the empty default thread with restored sessions
            if let defaultThread = threads.first {
                chatViewModels.removeValue(forKey: defaultThread.id)
            }
            threads = restoredThreads
        } else {
            // Keep the user's active thread, prepend restored sessions
            threads = restoredThreads + threads
        }

        // Activate the most recent thread and load its history
        if let firstThread = restoredThreads.first {
            activeThreadId = firstThread.id
        }

        log.info("Restored \(restoredThreads.count) threads from daemon")
    }

    private func loadHistoryForActiveThreadIfNeeded() {
        guard let activeThreadId else { return }
        guard let thread = threads.first(where: { $0.id == activeThreadId }) else { return }
        guard let sessionId = thread.sessionId else { return }
        guard let viewModel = chatViewModels[activeThreadId] else { return }
        guard !viewModel.isHistoryLoaded else { return }

        pendingHistoryBySessionId[sessionId] = activeThreadId

        do {
            try daemonClient.sendHistoryRequest(sessionId: sessionId)
        } catch {
            log.error("Failed to send history_request: \(error.localizedDescription)")
            pendingHistoryBySessionId.removeValue(forKey: sessionId)
        }
    }

    private func handleHistoryResponse(_ response: HistoryResponseMessage) {
        guard let threadId = pendingHistoryBySessionId.removeValue(forKey: response.sessionId) else { return }

        guard let viewModel = chatViewModels[threadId] else { return }
        viewModel.populateFromHistory(response.messages)
        log.info("Loaded \(response.messages.count) history messages for thread \(threadId)")
    }

    // MARK: - Private

    /// Create a ChatViewModel with standard callback wiring.
    private func makeViewModel() -> ChatViewModel {
        let viewModel = ChatViewModel(daemonClient: daemonClient)
        viewModel.onInlineConfirmationResponse = { [weak self] requestId in
            self?.confirmationDismissHandler?(requestId)
        }
        viewModel.shouldAcceptConfirmation = { [weak self, weak viewModel] in
            guard let self, let viewModel else { return false }
            return self.isLatestToolUseRecipient(viewModel)
        }
        return viewModel
    }

    /// Subscribe to the active ChatViewModel's objectWillChange so that
    /// SwiftUI re-evaluates views when the nested view model publishes
    /// changes (new messages, thinking state, errors, etc.).
    private func subscribeToActiveViewModel() {
        viewModelCancellable = activeViewModel?.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }
}
