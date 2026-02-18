#if canImport(UIKit)
import Combine
import SwiftUI
import VellumAssistantShared

// MARK: - PersistedThread

/// Codable representation of ThreadModel for UserDefaults persistence.
private struct PersistedThread: Codable {
    var id: UUID
    var title: String
    var createdAt: Date
}

// MARK: - IOSThreadStore

/// Manages a list of local chat threads for iOS with JSON persistence via UserDefaults.
/// Each thread owns an independent ChatViewModel instance so threads
/// do not share message history or sending state.
@MainActor
class IOSThreadStore: ObservableObject {
    @Published var threads: [ThreadModel] = []

    /// ViewModels keyed by thread ID, created lazily on first access.
    private var viewModels: [UUID: ChatViewModel] = [:]
    private let daemonClient: any DaemonClientProtocol
    private static let persistenceKey = "ios_threads_v1"
    private var cancellables: Set<AnyCancellable> = []

    init(daemonClient: any DaemonClientProtocol) {
        self.daemonClient = daemonClient
        let loaded = Self.load()
        if loaded.isEmpty {
            // First launch: create a default thread without persisting yet
            let thread = ThreadModel(title: "New Chat")
            threads = [thread]
            save()
        } else {
            threads = loaded
        }
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
    func newThread() -> ThreadModel {
        let thread = ThreadModel(title: "New Chat")
        threads.append(thread)
        save()
        return thread
    }

    func deleteThread(_ thread: ThreadModel) {
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
        let persisted = threads.map { PersistedThread(id: $0.id, title: $0.title, createdAt: $0.createdAt) }
        if let data = try? JSONEncoder().encode(persisted) {
            UserDefaults.standard.set(data, forKey: Self.persistenceKey)
        }
    }

    private static func load() -> [ThreadModel] {
        guard let data = UserDefaults.standard.data(forKey: persistenceKey),
              let persisted = try? JSONDecoder().decode([PersistedThread].self, from: data) else {
            return []
        }
        return persisted.map { ThreadModel(id: $0.id, title: $0.title, createdAt: $0.createdAt) }
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
