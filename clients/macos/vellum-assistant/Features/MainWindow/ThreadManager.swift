import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadManager")

@MainActor
final class ThreadManager: ObservableObject {
    @Published var threads: [ThreadModel] = []
    @Published var activeThreadId: UUID?

    private var chatViewModels: [UUID: ChatViewModel] = [:]
    private let daemonClient: DaemonClient

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
        threads.append(thread)
        chatViewModels[thread.id] = viewModel
        activeThreadId = thread.id
        log.info("Created thread \(thread.id) with title \"\(thread.title)\"")
    }

    func closeThread(id: UUID) {
        // No-op if only 1 thread remains
        guard threads.count > 1 else { return }

        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }

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
}
