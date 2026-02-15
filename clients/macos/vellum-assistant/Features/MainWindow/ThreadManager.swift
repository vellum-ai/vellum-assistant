import Combine
import SwiftUI
import VellumAssistantShared
import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadManager")

@MainActor
final class ThreadManager: ObservableObject, ThreadRestorerDelegate {
    @AppStorage("restoreRecentThreads") private(set) var restoreRecentThreads = false
    @Published var threads: [ThreadModel] = []
    @Published var activeThreadId: UUID? {
        didSet {
            subscribeToActiveViewModel()
            if let activeThreadId {
                sessionRestorer.loadHistoryIfNeeded(threadId: activeThreadId)
            }
        }
    }

    private var chatViewModels: [UUID: ChatViewModel] = [:]
    private let daemonClient: DaemonClient
    private var viewModelCancellable: AnyCancellable?
    private let sessionRestorer: ThreadSessionRestorer

    /// Called when an inline confirmation response should dismiss the floating panel.
    var confirmationDismissHandler: ((String) -> Void)?

    var activeViewModel: ChatViewModel? {
        guard let activeThreadId else { return nil }
        return chatViewModels[activeThreadId]
    }

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        self.sessionRestorer = ThreadSessionRestorer(daemonClient: daemonClient)
        // Create one default thread so the window is never empty
        createThread()
        sessionRestorer.delegate = self
        sessionRestorer.startObserving()
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

    /// Clear the `activeSurfaceId` on a specific thread's ChatViewModel.
    /// Used when switching threads to prevent stale surface context injection.
    func clearActiveSurface(threadId: UUID) {
        chatViewModels[threadId]?.activeSurfaceId = nil
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

    // MARK: - ThreadRestorerDelegate

    func chatViewModel(for threadId: UUID) -> ChatViewModel? {
        chatViewModels[threadId]
    }

    func setChatViewModel(_ vm: ChatViewModel, for threadId: UUID) {
        chatViewModels[threadId] = vm
    }

    func removeChatViewModel(for threadId: UUID) {
        chatViewModels.removeValue(forKey: threadId)
    }

    func makeViewModel() -> ChatViewModel {
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

    func activateThread(_ id: UUID) {
        activeThreadId = id
    }

    // MARK: - Private

    /// Subscribe to the active ChatViewModel's objectWillChange so that
    /// SwiftUI re-evaluates views when the nested view model publishes
    /// changes (new messages, thinking state, errors, etc.).
    private func subscribeToActiveViewModel() {
        viewModelCancellable = activeViewModel?.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }
}
