import Combine
import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadManager")

@MainActor
final class ThreadManager: ObservableObject {
    @Published var threads: [ThreadModel] = []
    @Published var activeThreadId: UUID? {
        didSet { subscribeToActiveViewModel() }
    }

    private var chatViewModels: [UUID: ChatViewModel] = [:]
    private let daemonClient: DaemonClient
    private var viewModelCancellable: AnyCancellable?

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
    }

    func createThread() {
        let thread = ThreadModel()
        let viewModel = ChatViewModel(daemonClient: daemonClient)
        viewModel.onInlineConfirmationResponse = { [weak self] requestId in
            self?.confirmationDismissHandler?(requestId)
        }
        threads.append(thread)
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
