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
    /// Tracks the most recent activity (message sent/received). Defaults to createdAt.
    var lastActivityAt: Date
    /// When non-nil, this thread is backed by a daemon session (Connected mode).
    var sessionId: String?
    var isArchived: Bool
    /// Private threads are excluded from the normal thread list and persist only
    /// for the current session. They match the macOS "temporary chat" behavior.
    var isPrivate: Bool

    init(id: UUID = UUID(), title: String = "New Chat", createdAt: Date = Date(), lastActivityAt: Date? = nil, sessionId: String? = nil, isArchived: Bool = false, isPrivate: Bool = false) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.lastActivityAt = lastActivityAt ?? createdAt
        self.sessionId = sessionId
        self.isArchived = isArchived
        self.isPrivate = isPrivate
    }
}

// MARK: - PersistedThread

/// Codable representation of IOSThread for UserDefaults persistence.
private struct PersistedThread: Codable {
    var id: UUID
    var title: String
    var createdAt: Date
    var lastActivityAt: Date?
    var isArchived: Bool?
    var isPrivate: Bool?
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
    /// True while an additional page of threads is being fetched from the daemon.
    @Published var isLoadingMoreThreads: Bool = false
    /// Whether the daemon indicated more sessions exist beyond what is currently loaded.
    @Published var hasMoreThreads: Bool = false

    /// ViewModels keyed by thread ID, created lazily on first access.
    private var viewModels: [UUID: ChatViewModel] = [:]
    private let daemonClient: any DaemonClientProtocol
    private static let persistenceKey = "ios_threads_v1"
    private var cancellables: Set<AnyCancellable> = []
    /// Maps daemon session IDs to thread IDs for history loading.
    private var pendingHistoryBySessionId: [String: UUID] = [:]
    /// Tracks thread IDs that already have an activity-tracking observer to avoid duplicates.
    private var observedActivityThreadIds: Set<UUID> = []
    /// Number of threads per page when listing sessions from the daemon.
    private static let threadPageSize = 50
    /// Current offset used for the next page fetch; advances by `threadPageSize` on each load.
    private var threadListOffset: Int = 0

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

    /// Initializer for secondary stores (e.g. the Private Threads settings panel)
    /// that need access to the daemon client for sending messages but should not
    /// register global session-list callbacks that would clobber the main store's
    /// handlers. In standalone mode, loads persisted threads from UserDefaults.
    init(daemonClient: any DaemonClientProtocol, registerDaemonCallbacks: Bool) {
        self.daemonClient = daemonClient

        if daemonClient is DaemonClient {
            isConnectedMode = true
            // No default thread — secondary stores start empty and show only
            // what has been created within the current session.
            threads = []
        } else {
            let loaded = Self.load()
            threads = loaded
        }

        if registerDaemonCallbacks, let daemon = daemonClient as? DaemonClient {
            setupDaemonCallbacks(daemon)
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
        daemon.onSubagentDetailResponse = { [weak self] response in
            self?.handleSubagentDetailResponse(response)
        }

        // Fetch session list once connected. Try immediately if already connected,
        // otherwise wait for the daemonDidReconnect notification.
        if daemon.isConnected {
            threadListOffset = 0
            try? daemon.sendSessionList(offset: 0, limit: Self.threadPageSize)
        }

        NotificationCenter.default.publisher(for: .daemonDidReconnect)
            .sink { [weak self, weak daemon] _ in
                guard let self, let daemon else { return }
                // Reset pagination state on reconnect so the list refreshes from page 1.
                self.threadListOffset = 0
                self.hasMoreThreads = false
                try? daemon.sendSessionList(offset: 0, limit: Self.threadPageSize)
            }
            .store(in: &cancellables)
    }

    private func handleSessionListResponse(_ response: SessionListResponseMessage) {
        let filteredSessions = response.sessions.filter { $0.threadType != "private" }
        guard !filteredSessions.isEmpty || (response.hasMore == false && threadListOffset == 0) else {
            // Empty non-first page means nothing more to append.
            isLoadingMoreThreads = false
            hasMoreThreads = response.hasMore ?? false
            return
        }

        hasMoreThreads = response.hasMore ?? false
        isLoadingMoreThreads = false

        var restoredThreads: [IOSThread] = []
        for session in filteredSessions {
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

        // First page: replace the default empty placeholder thread if present.
        if threadListOffset == 0 {
            let defaultIsEmpty = threads.count == 1
                && viewModels[threads[0].id]?.messages.isEmpty ?? true
                && viewModels[threads[0].id]?.sessionId == nil
            if defaultIsEmpty, let defaultThread = threads.first {
                viewModels.removeValue(forKey: defaultThread.id)
                threads = restoredThreads
            } else {
                // Deduplicate: only prepend restored threads whose sessionId
                // doesn't already exist in the current thread list.
                let existingSessionIds: Set<String> = Set(
                    threads.compactMap { thread -> String? in
                        // Check both the thread's own sessionId AND the VM's bound sessionId
                        if let sid = thread.sessionId { return sid }
                        return viewModels[thread.id]?.sessionId
                    }
                )
                var newThreads: [IOSThread] = []
                for restored in restoredThreads {
                    if let sid = restored.sessionId, existingSessionIds.contains(sid) {
                        // Already have a thread for this session — discard the duplicate VM.
                        viewModels.removeValue(forKey: restored.id)
                    } else {
                        newThreads.append(restored)
                    }
                }
                threads = newThreads + threads
            }
        } else {
            // Subsequent pages: append only sessions not already in the list.
            let existingSessionIds: Set<String> = Set(threads.compactMap { thread -> String? in
                if let sid = thread.sessionId { return sid }
                return viewModels[thread.id]?.sessionId
            })
            for restored in restoredThreads {
                if let sid = restored.sessionId, existingSessionIds.contains(sid) {
                    viewModels.removeValue(forKey: restored.id)
                } else {
                    threads.append(restored)
                }
            }
        }
    }

    /// Load the next page of threads from the daemon (Connected mode only).
    func loadMoreThreads() {
        guard isConnectedMode,
              let daemon = daemonClient as? DaemonClient,
              !isLoadingMoreThreads,
              hasMoreThreads else { return }
        isLoadingMoreThreads = true
        threadListOffset += Self.threadPageSize
        try? daemon.sendSessionList(offset: threadListOffset, limit: Self.threadPageSize)
    }

    private func handleHistoryResponse(_ response: HistoryResponseMessage) {
        guard let threadId = pendingHistoryBySessionId.removeValue(forKey: response.sessionId) else { return }
        guard let vm = viewModels[threadId] else { return }
        vm.populateFromHistory(response.messages)
    }

    private func handleSubagentDetailResponse(_ response: IPCSubagentDetailResponse) {
        for (_, vm) in viewModels {
            if vm.activeSubagents.contains(where: { $0.id == response.subagentId }) {
                vm.subagentDetailStore.populateFromDetailResponse(response)
                return
            }
        }
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
            observeForActivityTracking(vm: existing, threadId: threadId)
            return existing
        }
        let vm = ChatViewModel(daemonClient: daemonClient)
        viewModels[threadId] = vm
        observeForTitleGeneration(vm: vm, threadId: threadId)
        observeForActivityTracking(vm: vm, threadId: threadId)
        return vm
    }

    /// Watch for the first completed assistant reply to auto-title the thread.
    private func observeForTitleGeneration(vm: ChatViewModel, threadId: UUID) {
        // Find the thread's default title; skip if already customized.
        guard threads.first(where: { $0.id == threadId })?.title == "New Chat" else { return }

        vm.messageManager.$messages
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

    /// Update lastActivityAt whenever the message count changes (not on every streaming delta).
    /// Skips updates while the VM is loading history so that hydrating old messages
    /// doesn't stamp the thread as recently active.
    private func observeForActivityTracking(vm: ChatViewModel, threadId: UUID) {
        guard !observedActivityThreadIds.contains(threadId) else { return }
        observedActivityThreadIds.insert(threadId)

        vm.messageManager.$messages
            .dropFirst()
            .map(\.count)
            .removeDuplicates()
            .sink { [weak self, weak vm] _ in
                guard let vm, !vm.isLoadingHistory else { return }
                self?.touchLastActivity(for: threadId)
            }
            .store(in: &cancellables)
    }

    /// Private threads are excluded from the session list response filter, so they
    /// won't appear in the normal active thread list.
    var privateThreads: [IOSThread] {
        threads.filter { $0.isPrivate }
    }

    @discardableResult
    func newThread() -> IOSThread {
        let thread = IOSThread()
        threads.append(thread)
        save()
        return thread
    }

    /// Create a new private thread with the given name. The thread is immediately
    /// backed by a daemon session with threadType "private" so it is persisted on
    /// the daemon side and excluded from normal thread restoration.
    @discardableResult
    func newPrivateThread(name: String = "Private Thread") -> IOSThread {
        let thread = IOSThread(title: name, isPrivate: true)
        threads.append(thread)
        // Get or create the view model after appending so activity tracking
        // can find the thread in self.threads.
        let vm = viewModel(for: thread.id)
        vm.createSessionIfNeeded(threadType: "private")
        save()
        return thread
    }

    func deleteThread(_ thread: IOSThread) {
        viewModels.removeValue(forKey: thread.id)
        threads.removeAll { $0.id == thread.id }
        // Always keep at least one active (non-archived) non-private thread.
        // Private threads are managed separately and should not prevent the
        // regular thread list from being empty.
        if threads.filter({ !$0.isArchived && !$0.isPrivate }).isEmpty {
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

    func archiveThread(_ thread: IOSThread) {
        guard let idx = threads.firstIndex(where: { $0.id == thread.id }) else { return }
        threads[idx].isArchived = true
        save()
    }

    func unarchiveThread(_ thread: IOSThread) {
        guard let idx = threads.firstIndex(where: { $0.id == thread.id }) else { return }
        threads[idx].isArchived = false
        save()
    }

    /// Update lastActivityAt to now for the given thread.
    func touchLastActivity(for threadId: UUID) {
        guard let idx = threads.firstIndex(where: { $0.id == threadId }) else { return }
        threads[idx].lastActivityAt = Date()
        save()
    }

    /// Returns the last message text for a thread, if available.
    func lastMessagePreview(for threadId: UUID) -> String? {
        guard let vm = viewModels[threadId],
              let last = vm.messages.last else { return nil }
        let text = last.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return String(text.prefix(80))
    }

    // MARK: - Persistence

    private func save() {
        // Don't persist daemon-synced threads — they're loaded on connect.
        guard !isConnectedMode else { return }
        let persisted = threads.map { PersistedThread(id: $0.id, title: $0.title, createdAt: $0.createdAt, lastActivityAt: $0.lastActivityAt, isArchived: $0.isArchived, isPrivate: $0.isPrivate) }
        if let data = try? JSONEncoder().encode(persisted) {
            UserDefaults.standard.set(data, forKey: Self.persistenceKey)
        }
    }

    private static func load() -> [IOSThread] {
        guard let data = UserDefaults.standard.data(forKey: persistenceKey),
              let persisted = try? JSONDecoder().decode([PersistedThread].self, from: data) else {
            return []
        }
        return persisted.map { IOSThread(id: $0.id, title: $0.title, createdAt: $0.createdAt, lastActivityAt: $0.lastActivityAt, isArchived: $0.isArchived ?? false, isPrivate: $0.isPrivate ?? false) }
    }
}
#endif
