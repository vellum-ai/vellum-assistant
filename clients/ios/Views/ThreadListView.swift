#if canImport(UIKit)
import Combine
import SwiftUI
import VellumAssistantShared

// MARK: - IOSThread

/// Represents a single chat thread on iOS.
struct IOSThread: Identifiable {
    let id: UUID
    var title: String
    let createdAt: Date
    /// When non-nil, this thread is backed by a daemon session (Connected mode).
    var sessionId: String?

    init(id: UUID = UUID(), title: String = "New Chat", createdAt: Date = Date(), sessionId: String? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.sessionId = sessionId
    }
}

// MARK: - PersistedThread

/// Codable representation of IOSThread for UserDefaults persistence.
private struct PersistedThread: Codable {
    var id: UUID
    var title: String
    var createdAt: Date
}

// MARK: - IOSThreadStore

/// Manages a list of chat threads for iOS.
///
/// In Standalone mode: threads are persisted locally via UserDefaults.
/// In Connected mode: threads are loaded from the daemon (shared with macOS).
/// Each thread owns an independent ChatViewModel instance.
@MainActor
class IOSThreadStore: ObservableObject {
    @Published var threads: [IOSThread] = []
    @Published var isConnectedMode: Bool = false

    /// ViewModels keyed by thread ID, created lazily on first access.
    private var viewModels: [UUID: ChatViewModel] = [:]
    private let daemonClient: any DaemonClientProtocol
    private static let persistenceKey = "ios_threads_v1"
    private var cancellables: Set<AnyCancellable> = []
    /// Maps daemon session IDs to thread IDs for history loading.
    private var pendingHistoryBySessionId: [String: UUID] = [:]

    init(daemonClient: any DaemonClientProtocol) {
        self.daemonClient = daemonClient

        if let daemon = daemonClient as? DaemonClient {
            // Connected mode — load threads from daemon
            isConnectedMode = true
            let defaultThread = IOSThread()
            threads = [defaultThread]
            setupDaemonCallbacks(daemon)
        } else {
            // Standalone mode — load from local persistence
            let loaded = Self.load()
            if loaded.isEmpty {
                let thread = IOSThread()
                threads = [thread]
                save()
            } else {
                threads = loaded
            }
        }
    }

    // MARK: - Daemon Thread Sync

    private func setupDaemonCallbacks(_ daemon: DaemonClient) {
        daemon.onSessionListResponse = { [weak self] response in
            self?.handleSessionListResponse(response)
        }
        daemon.onHistoryResponse = { [weak self] response in
            self?.handleHistoryResponse(response)
        }

        // Fetch session list once connected
        daemon.$isConnected
            .removeDuplicates()
            .filter { $0 }
            .first()
            .sink { [weak self] _ in
                guard let self else { return }
                try? daemon.sendSessionList()
            }
            .store(in: &cancellables)
    }

    private func handleSessionListResponse(_ response: SessionListResponseMessage) {
        guard !response.sessions.isEmpty else { return }

        let recentSessions = Array(response.sessions.filter { $0.threadType != "private" }.prefix(10))

        var restoredThreads: [IOSThread] = []
        for session in recentSessions {
            let thread = IOSThread(
                title: session.title,
                createdAt: Date(timeIntervalSince1970: TimeInterval(session.updatedAt) / 1000.0),
                sessionId: session.id
            )
            let vm = ChatViewModel(daemonClient: daemonClient)
            vm.sessionId = session.id
            viewModels[thread.id] = vm
            restoredThreads.append(thread)
        }

        // Replace the default empty thread with daemon threads
        let defaultIsEmpty = threads.count == 1
            && viewModels[threads[0].id]?.messages.isEmpty ?? true
            && viewModels[threads[0].id]?.sessionId == nil
        if defaultIsEmpty, let defaultThread = threads.first {
            viewModels.removeValue(forKey: defaultThread.id)
        }
        threads = restoredThreads
    }

    private func handleHistoryResponse(_ response: HistoryResponseMessage) {
        guard let threadId = pendingHistoryBySessionId.removeValue(forKey: response.sessionId) else { return }
        guard let vm = viewModels[threadId] else { return }
        vm.populateFromHistory(response.messages)
    }

    /// Load history for a daemon-backed thread when first selected.
    func loadHistoryIfNeeded(for threadId: UUID) {
        guard let thread = threads.first(where: { $0.id == threadId }),
              let sessionId = thread.sessionId,
              let daemon = daemonClient as? DaemonClient,
              let vm = viewModels[threadId],
              !vm.isHistoryLoaded else { return }

        pendingHistoryBySessionId[sessionId] = threadId
        try? daemon.sendHistoryRequest(sessionId: sessionId)
    }

    /// Return the ChatViewModel for the given thread, creating it if necessary.
    func viewModel(for threadId: UUID) -> ChatViewModel {
        if let existing = viewModels[threadId] {
            return existing
        }
        let vm = ChatViewModel(daemonClient: daemonClient)
        viewModels[threadId] = vm
        observeForTitleGeneration(vm: vm, threadId: threadId)
        return vm
    }

    /// Watch for the first completed assistant reply to auto-title the thread.
    private func observeForTitleGeneration(vm: ChatViewModel, threadId: UUID) {
        // Find the thread's default title; skip if already customized.
        guard threads.first(where: { $0.id == threadId })?.title == "New Chat" else { return }

        vm.$messages
            .dropFirst()
            .compactMap { messages -> String? in
                // Trigger once we have at least one user message and the first assistant
                // reply has finished streaming (isStreaming == false).
                guard let firstUser = messages.first(where: { $0.role == .user }),
                      !firstUser.text.isEmpty,
                      messages.contains(where: { $0.role == .assistant && !$0.isStreaming }) else {
                    return nil
                }
                return firstUser.text
            }
            .first()
            .sink { [weak self] firstUserMessage in
                guard let self else { return }
                Task {
                    if let title = await TitleGenerator.shared.generateTitle(
                        for: threadId,
                        firstUserMessage: firstUserMessage
                    ) {
                        await MainActor.run {
                            self.updateTitle(title, for: threadId)
                        }
                    }
                }
            }
            .store(in: &cancellables)
    }

    @discardableResult
    func newThread() -> IOSThread {
        let thread = IOSThread()
        threads.append(thread)
        save()
        return thread
    }

    func deleteThread(_ thread: IOSThread) {
        viewModels.removeValue(forKey: thread.id)
        threads.removeAll { $0.id == thread.id }
        // Always keep at least one thread.
        if threads.isEmpty {
            newThread()
        } else {
            save()
        }
    }

    func updateTitle(_ title: String, for threadId: UUID) {
        guard let idx = threads.firstIndex(where: { $0.id == threadId }) else { return }
        threads[idx].title = title
        save()
    }

    // MARK: - Persistence

    private func save() {
        // Don't persist daemon-synced threads — they're loaded on connect.
        guard !isConnectedMode else { return }
        let persisted = threads.map { PersistedThread(id: $0.id, title: $0.title, createdAt: $0.createdAt) }
        if let data = try? JSONEncoder().encode(persisted) {
            UserDefaults.standard.set(data, forKey: Self.persistenceKey)
        }
    }

    private static func load() -> [IOSThread] {
        guard let data = UserDefaults.standard.data(forKey: persistenceKey),
              let persisted = try? JSONDecoder().decode([PersistedThread].self, from: data) else {
            return []
        }
        return persisted.map { IOSThread(id: $0.id, title: $0.title, createdAt: $0.createdAt) }
    }
}

// MARK: - ThreadListView

struct ThreadListView: View {
    @StateObject private var store: IOSThreadStore
    @State private var selectedThreadId: UUID?

    init(daemonClient: any DaemonClientProtocol) {
        _store = StateObject(wrappedValue: IOSThreadStore(daemonClient: daemonClient))
    }

    var body: some View {
        NavigationSplitView {
            threadList
        } detail: {
            detailView
        }
    }

    // MARK: - Sidebar

    private var threadList: some View {
        List(store.threads, selection: $selectedThreadId) { thread in
            NavigationLink(value: thread.id) {
                Label(thread.title, systemImage: "bubble.left")
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    store.deleteThread(thread)
                    if selectedThreadId == thread.id {
                        selectedThreadId = store.threads.first?.id
                    }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .navigationTitle("Chats")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    store.newThread()
                    // Auto-select the newly created thread.
                    selectedThreadId = store.threads.last?.id
                } label: {
                    Image(systemName: "square.and.pencil")
                }
            }
        }
        .onAppear {
            // Select the first thread automatically on launch.
            if selectedThreadId == nil {
                selectedThreadId = store.threads.first?.id
            }
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private var detailView: some View {
        if let selectedId = selectedThreadId,
           store.threads.contains(where: { $0.id == selectedId }) {
            ThreadChatView(viewModel: store.viewModel(for: selectedId))
                .onAppear {
                    store.loadHistoryIfNeeded(for: selectedId)
                }
        } else {
            Text("Select a chat")
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - ThreadChatView

/// Thin wrapper around ChatContentView for a thread-owned ChatViewModel.
struct ThreadChatView: View {
    @ObservedObject var viewModel: ChatViewModel

    var body: some View {
        ChatContentView(viewModel: viewModel)
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
    }
}

#endif
