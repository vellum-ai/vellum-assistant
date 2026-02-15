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
        threads.append(thread)
        chatViewModels[thread.id] = viewModel
        activeThreadId = thread.id
        log.info("Created thread \(thread.id) with title \"\(thread.title)\"")
    }

    func closeThread(id: UUID) {
        // No-op if only 1 visible thread remains
        let visibleThreads = threads.filter { !$0.isHidden }
        guard visibleThreads.count > 1 else { return }

        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }

        // Cancel any active generation so the daemon doesn't keep processing
        // an orphaned request after the view model is removed.
        chatViewModels[id]?.stopGenerating()

        // Mark as hidden instead of removing
        threads[index].isHidden = true

        // Save sessionId from ChatViewModel back to ThreadModel before cleanup
        // This ensures chat history can be restored when the thread is unhidden
        if let sessionId = chatViewModels[id]?.sessionId {
            threads[index].sessionId = sessionId
        }

        // Clean up the ChatViewModel to prevent memory leaks
        // The view model will be recreated if the thread is restored via showThread()
        chatViewModels.removeValue(forKey: id)

        // If the closed thread was active, select an adjacent visible thread
        if activeThreadId == id {
            let remainingVisible = threads.filter { !$0.isHidden }
            // Find the next visible thread after the current index, or fall back to last visible
            let nextVisible = remainingVisible.first(where: { threads.firstIndex(of: $0) ?? 0 > index })
                ?? remainingVisible.last
            activeThreadId = nextVisible?.id
        }

        log.info("Closed thread \(id)")
    }

    func showThread(id: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }
        threads[index].isHidden = false

        // Recreate the ChatViewModel if it was cleaned up when the thread was hidden
        if chatViewModels[id] == nil {
            let viewModel = makeViewModel()
            // Restore sessionId if this thread had one
            if let sessionId = threads[index].sessionId {
                viewModel.sessionId = sessionId
            }
            chatViewModels[id] = viewModel
        }

        activeThreadId = id
        log.info("Showed thread \(id)")
    }

    func selectThread(id: UUID) {
        guard threads.contains(where: { $0.id == id }) else { return }
        activeThreadId = id
    }

    func deleteThread(id: UUID) {
        // No-op if only 1 visible thread remains (don't delete the last thread)
        let visibleThreads = threads.filter { !$0.isHidden }
        guard visibleThreads.count > 1 || threads.first(where: { $0.id == id })?.isHidden == true else { return }

        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }

        // Cancel any active generation
        chatViewModels[id]?.stopGenerating()

        // Clean up ChatViewModel
        chatViewModels.removeValue(forKey: id)

        // Remove thread from array
        threads.remove(at: index)

        // If the deleted thread was active, select an adjacent visible thread
        if activeThreadId == id {
            let remainingVisible = threads.filter { !$0.isHidden }
            activeThreadId = remainingVisible.last?.id
        }

        log.info("Deleted thread \(id)")
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
