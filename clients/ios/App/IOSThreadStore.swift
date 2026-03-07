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
    var isPinned: Bool
    var displayOrder: Int?
    /// Private threads are excluded from the normal thread list and persist only
    /// for the current session. They match the macOS "temporary chat" behavior.
    var isPrivate: Bool
    /// The schedule job ID that created this thread, if any.
    /// Threads sharing the same scheduleJobId belong to the same schedule group.
    var scheduleJobId: String?
    var hasUnseenLatestAssistantMessage: Bool
    var latestAssistantMessageAt: Date?
    var lastSeenAssistantMessageAt: Date?

    /// Whether this thread was created by a schedule or reminder trigger.
    var isScheduleThread: Bool {
        if scheduleJobId != nil { return true }
        return title.hasPrefix("Schedule: ") || title.hasPrefix("Schedule (manual): ") || title.hasPrefix("Reminder: ")
    }

    init(id: UUID = UUID(), title: String = "New Chat", createdAt: Date = Date(), lastActivityAt: Date? = nil, sessionId: String? = nil, isArchived: Bool = false, isPinned: Bool = false, displayOrder: Int? = nil, isPrivate: Bool = false, scheduleJobId: String? = nil, hasUnseenLatestAssistantMessage: Bool = false, latestAssistantMessageAt: Date? = nil, lastSeenAssistantMessageAt: Date? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.lastActivityAt = lastActivityAt ?? createdAt
        self.sessionId = sessionId
        self.isArchived = isArchived
        self.isPinned = isPinned
        self.displayOrder = displayOrder
        self.isPrivate = isPrivate
        self.scheduleJobId = scheduleJobId
        self.hasUnseenLatestAssistantMessage = hasUnseenLatestAssistantMessage
        self.latestAssistantMessageAt = latestAssistantMessageAt
        self.lastSeenAssistantMessageAt = lastSeenAssistantMessageAt
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
    var isPinned: Bool?
    var displayOrder: Int?
    var isPrivate: Bool?
    var sessionId: String?
    var scheduleJobId: String?
    var hasUnseenLatestAssistantMessage: Bool?
    var latestAssistantMessageAt: Date?
    var lastSeenAssistantMessageAt: Date?
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
    /// True while the first page of threads is being fetched from the daemon.
    /// Used by the UI to show a loading indicator instead of a placeholder thread.
    @Published var isLoadingInitialThreads: Bool = false

    /// ViewModels keyed by thread ID, created lazily on first access.
    private var viewModels: [UUID: ChatViewModel] = [:]
    private var daemonClient: any DaemonClientProtocol
    private static let persistenceKey = "ios_threads_v1"
    private static let connectedCacheKey = "ios_connected_threads_cache_v1"
    private var cancellables: Set<AnyCancellable> = []
    /// Maps daemon session IDs to thread IDs for history loading.
    private var pendingHistoryBySessionId: [String: UUID] = [:]
    /// Tracks thread IDs that already have an activity-tracking observer to avoid duplicates.
    private var observedActivityThreadIds: Set<UUID> = []
    /// Number of threads per page when listing sessions from the daemon.
    private static let threadPageSize = 50
    /// Current offset used for the next page fetch; advances by `threadPageSize` on each load.
    private var threadListOffset: Int = 0
    /// Reconnect-generation counter. Incremented only when pagination is reset due to a
    /// reconnect (or a `rebindDaemonClient` call). Never incremented on ordinary
    /// `loadMoreThreads` calls.
    ///
    /// Because the daemon does not echo a request ID back in session-list responses, we
    /// cannot correlate individual responses to individual requests within the same
    /// connection.  What we *can* do is reject any response that arrived from the *old*
    /// connection after a reconnect has already started a fresh page-1 sequence.  This is
    /// exactly what the generation counter provides: every page-1 send captures the current
    /// generation in `expectedSessionListGeneration`; the response handler discards any
    /// response whose expected generation no longer matches the live counter.
    private var sessionListGeneration: UInt64 = 0
    /// Generation captured at the time the most-recent page-1 session-list request was sent.
    /// The response handler compares this against `sessionListGeneration` to detect and
    /// discard stale responses from the previous connection.
    private var expectedSessionListGeneration: UInt64 = 0
    /// SessionIds that the user has locally edited (renamed/archived/unarchived)
    /// since the cache was loaded. Only these threads preserve local overrides
    /// when the daemon response arrives; all others accept daemon data.
    private var locallyEditedSessionIds: Set<String> = []

    private func assistantTimestamp(_ timestampMs: Int?) -> Date? {
        guard let timestampMs else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(timestampMs) / 1000.0)
    }

    private func applySessionMetadata(
        _ session: IPCSessionListResponseSession,
        to thread: inout IOSThread
    ) {
        thread.isPinned = session.isPinned ?? false
        thread.displayOrder = session.displayOrder.map { Int($0) }
        thread.hasUnseenLatestAssistantMessage =
            session.assistantAttention?.hasUnseenLatestAssistantMessage ?? false
        thread.latestAssistantMessageAt = assistantTimestamp(
            session.assistantAttention?.latestAssistantMessageAt
        )
        thread.lastSeenAssistantMessageAt = assistantTimestamp(
            session.assistantAttention?.lastSeenAssistantMessageAt
        )
    }

    init(daemonClient: any DaemonClientProtocol) {
        self.daemonClient = daemonClient

        if let daemon = daemonClient as? DaemonClient {
            // Connected mode — show cached threads instantly or spinner on first launch
            isConnectedMode = true
            let cached = Self.loadConnectedCache()
            if cached.isEmpty {
                isLoadingInitialThreads = true
                threads = [IOSThread()]
            } else {
                isLoadingInitialThreads = false
                threads = cached
            }
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
        daemon.onSubagentDetailResponse = { [weak self] response in
            self?.handleSubagentDetailResponse(response)
        }
        daemon.onMessageContentResponse = { [weak self] response in
            self?.handleMessageContentResponse(response)
        }
        daemon.onScheduleThreadCreated = { [weak self] msg in
            guard let self else { return }
            // Avoid duplicates
            guard !self.threads.contains(where: { $0.sessionId == msg.conversationId }) else { return }
            let thread = IOSThread(
                title: msg.title,
                sessionId: msg.conversationId,
                scheduleJobId: msg.scheduleJobId
            )
            // Remove the empty placeholder thread if it's still present (race:
            // schedule_thread_created can arrive before the first session_list_response).
            if self.threads.count == 1,
               self.threads[0].sessionId == nil,
               self.viewModels[self.threads[0].id]?.messages.isEmpty ?? true,
               self.viewModels[self.threads[0].id]?.sessionId == nil {
                self.viewModels.removeValue(forKey: self.threads[0].id)
                self.threads = [thread]
            } else {
                self.threads.insert(thread, at: 0)
            }
            self.isLoadingInitialThreads = false
            self.saveConnectedCache()
        }

        // Fetch session list once connected. Try immediately if already connected,
        // otherwise wait for the daemonDidReconnect notification.
        if daemon.isConnected {
            threadListOffset = 0
            sessionListGeneration += 1
            sendPageOneSessionList(daemon: daemon)
        }

        NotificationCenter.default.publisher(for: .daemonDidReconnect)
            .sink { [weak self, weak daemon] _ in
                guard let self, let daemon else { return }
                // Reset pagination state so the list refreshes from page 1.
                self.threadListOffset = 0
                self.hasMoreThreads = false
                // Bump the generation counter WITHOUT touching expectedSessionListGeneration.
                // There is now a gap where sessionListGeneration = N but
                // expectedSessionListGeneration = N-1.  Any in-flight response from the
                // old connection that arrives in this window fails the
                // expectedSessionListGeneration == sessionListGeneration guard in
                // handleSessionListResponse and is correctly discarded.
                //
                // expectedSessionListGeneration is updated to N only when the new page-1
                // request is actually sent (inside sendPageOneSessionList), so if the send
                // throws the guard stays closed.
                //
                // Limitation: responses that arrive after the new page-1 has been sent
                // cannot be distinguished from the new page-1 response because the daemon
                // does not echo a request ID. Only reconnect-era staleness is detectable.
                self.sessionListGeneration += 1
                self.sendPageOneSessionList(daemon: daemon)
            }
            .store(in: &cancellables)
    }

    /// Capture the current generation as expected and send a page-1 session-list request.
    ///
    /// `expectedSessionListGeneration` is updated here — not in the reconnect handler — so
    /// the guard window (sessionListGeneration != expectedSessionListGeneration) remains open
    /// for any response that arrives between the generation bump and this send.  If the send
    /// throws, the expected generation is not advanced and the guard stays closed.
    private func sendPageOneSessionList(daemon: DaemonClient) {
        do {
            try daemon.sendSessionList(offset: 0, limit: Self.threadPageSize)
            expectedSessionListGeneration = sessionListGeneration
        } catch {
            // Send failed — leave expectedSessionListGeneration unchanged so the
            // guard stays closed and stale responses are rejected.
        }
    }

    /// Re-point the store at a freshly constructed DaemonClient after `rebuildClient()`.
    ///
    /// `@StateObject` is initialised once by SwiftUI and never replaced when `ContentView`
    /// re-initialises, so when the connection is rebuilt (QR pairing, settings change) the
    /// store would otherwise keep sending messages to the old, disconnected client.  This
    /// method swaps the client reference, cancels Combine subscriptions that captured the old
    /// client, drops stale ChatViewModels (they reference the old client via `ChatViewModel`'s
    /// own stored reference), resets pagination, and re-registers daemon callbacks on the new
    /// client so the thread list is refreshed from the new connection.
    func rebindDaemonClient(_ newClient: any DaemonClientProtocol) {
        // Drop Combine subscriptions tied to the old DaemonClient so the reconnect
        // publisher from setupDaemonCallbacks doesn't fire against the wrong daemon.
        cancellables.removeAll()

        // Nil out callbacks on the old daemon before replacing the reference.
        // In-flight HTTP responses (session-list, history, subagent-detail) are launched
        // in fire-and-forget Tasks and are not cancelled by disconnect.  Without this,
        // a response arriving after the rebind would invoke the closures registered by
        // the previous setupDaemonCallbacks call, which capture [weak self] and would
        // still call back into this store — potentially corrupting the thread list with
        // stale sessions from the old connection.
        if let oldDaemon = daemonClient as? DaemonClient {
            oldDaemon.onSessionListResponse = nil
            oldDaemon.onHistoryResponse = nil
            oldDaemon.onSubagentDetailResponse = nil
            oldDaemon.onMessageContentResponse = nil
            oldDaemon.onScheduleThreadCreated = nil
        }

        daemonClient = newClient

        // Existing ViewModels hold a reference to the old, disconnected client inside
        // ChatViewModel.  Discard them so new ones are created with the new client.
        viewModels.removeAll()
        observedActivityThreadIds.removeAll()
        pendingHistoryBySessionId.removeAll()

        if let daemon = newClient as? DaemonClient {
            // Connected mode — show cached threads instantly or spinner on first launch.
            isConnectedMode = true
            locallyEditedSessionIds.removeAll()
            let cached = Self.loadConnectedCache()
            if cached.isEmpty {
                isLoadingInitialThreads = true
                threads = [IOSThread()]
            } else {
                isLoadingInitialThreads = false
                threads = cached
            }
            threadListOffset = 0
            sessionListGeneration += 1
            hasMoreThreads = false
            isLoadingMoreThreads = false
            setupDaemonCallbacks(daemon)
        } else {
            // Switched back to standalone mode — reload persisted threads.
            isConnectedMode = false
            isLoadingInitialThreads = false
            locallyEditedSessionIds.removeAll()
            clearConnectedCache()
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

    private func handleSessionListResponse(_ response: SessionListResponseMessage) {
        // Discard responses from a previous connection.  The daemon does not echo a
        // request ID, so within a single connection all responses are accepted in order.
        // Reconnect-era staleness is detected via the generation counter: when the
        // connection is reset, sessionListGeneration is bumped and
        // expectedSessionListGeneration is updated to match only for the new page-1
        // send.  Any response still arriving from the old connection carries the stale
        // expected generation and is dropped here.
        guard expectedSessionListGeneration == sessionListGeneration else {
            return
        }

        let filteredSessions = response.sessions.filter { $0.threadType != "private" }

        // Handle confirmed-empty first-page response: clear stale cached sessions.
        // Only clear when hasMore is explicitly false (authoritative empty result).
        // Transient failures (HTTP errors, decode errors) emit hasMore: nil and must
        // not wipe the cache — the user should keep seeing cached threads.
        if filteredSessions.isEmpty && threadListOffset == 0 && response.hasMore == false {
            let keepThreads = threads.filter { $0.sessionId == nil || $0.isPrivate }
            for thread in threads where thread.sessionId != nil && !thread.isPrivate {
                viewModels.removeValue(forKey: thread.id)
            }
            threads = keepThreads.isEmpty ? [IOSThread()] : keepThreads
            isLoadingInitialThreads = false
            isLoadingMoreThreads = false
            hasMoreThreads = response.hasMore ?? false
            clearConnectedCache()
            locallyEditedSessionIds.removeAll()
            return
        }

        guard !filteredSessions.isEmpty else {
            // Empty non-first page means nothing more to append.
            isLoadingMoreThreads = false
            isLoadingInitialThreads = false
            hasMoreThreads = response.hasMore ?? false
            return
        }

        hasMoreThreads = response.hasMore ?? false
        isLoadingMoreThreads = false
        isLoadingInitialThreads = false

        var restoredThreads: [IOSThread] = []
        for session in filteredSessions {
            let effectiveCreatedAt = session.createdAt ?? session.updatedAt
            var thread = IOSThread(
                title: session.title,
                createdAt: Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAt) / 1000.0),
                lastActivityAt: Date(timeIntervalSince1970: TimeInterval(session.updatedAt) / 1000.0),
                sessionId: session.id,
                scheduleJobId: session.scheduleJobId
            )
            applySessionMetadata(session, to: &thread)
            let vm = ChatViewModel(daemonClient: daemonClient)
            vm.sessionId = session.id
            viewModels[thread.id] = vm
            restoredThreads.append(thread)
        }

        // First page: three-case merge logic.
        if threadListOffset == 0 {
            let isSinglePlaceholder = threads.count == 1
                && threads[0].sessionId == nil
                && viewModels[threads[0].id]?.messages.isEmpty ?? true
                && viewModels[threads[0].id]?.sessionId == nil

            // All non-private threads are cached (have sessionId, no VM created yet).
            let allAreCached = !threads.isEmpty
                && threads.filter({ !$0.isPrivate }).allSatisfy {
                    $0.sessionId != nil && viewModels[$0.id] == nil
                }

            if isSinglePlaceholder, let defaultThread = threads.first {
                // Case 1: Single empty placeholder — replace entirely.
                viewModels.removeValue(forKey: defaultThread.id)
                threads = restoredThreads
            } else if allAreCached {
                // Case 2: All threads are from cache (no VMs, no user interaction).
                // Replace with daemon data, preserving local overrides and private threads.
                let privateThreads = threads.filter { $0.isPrivate }

                var localOverrides: [String: IOSThread] = [:]
                for thread in threads {
                    if let sid = thread.sessionId, locallyEditedSessionIds.contains(sid) {
                        localOverrides[sid] = thread
                    }
                }

                var merged: [IOSThread] = []
                for var restored in restoredThreads {
                    if let local = localOverrides[restored.sessionId ?? ""] {
                        restored = IOSThread(
                            id: restored.id,
                            title: local.title,
                            createdAt: restored.createdAt,
                            lastActivityAt: restored.lastActivityAt,
                            sessionId: restored.sessionId,
                            isArchived: local.isArchived,
                            isPinned: restored.isPinned,
                            displayOrder: restored.displayOrder,
                            scheduleJobId: restored.scheduleJobId,
                            hasUnseenLatestAssistantMessage: restored.hasUnseenLatestAssistantMessage,
                            latestAssistantMessageAt: restored.latestAssistantMessageAt,
                            lastSeenAssistantMessageAt: restored.lastSeenAssistantMessageAt
                        )
                    }
                    merged.append(restored)
                }

                threads = merged + privateThreads
                locallyEditedSessionIds.removeAll()
            } else {
                // Case 3: User is active (VMs exist or local threads present).
                // Deduplicate: only prepend restored threads whose sessionId
                // doesn't already exist in the current thread list.
                let existingSessionIds: Set<String> = Set(
                    threads.compactMap { thread -> String? in
                        if let sid = thread.sessionId { return sid }
                        return viewModels[thread.id]?.sessionId
                    }
                )
                var newThreads: [IOSThread] = []
                for restored in restoredThreads {
                    if let sid = restored.sessionId, existingSessionIds.contains(sid) {
                        if let existingIndex = threads.firstIndex(where: { $0.sessionId == sid }) {
                            threads[existingIndex].isPinned = restored.isPinned
                            threads[existingIndex].displayOrder = restored.displayOrder
                            threads[existingIndex].hasUnseenLatestAssistantMessage = restored.hasUnseenLatestAssistantMessage
                            threads[existingIndex].latestAssistantMessageAt = restored.latestAssistantMessageAt
                            threads[existingIndex].lastSeenAssistantMessageAt = restored.lastSeenAssistantMessageAt
                        }
                        viewModels.removeValue(forKey: restored.id)
                    } else {
                        newThreads.append(restored)
                    }
                }
                threads = newThreads + threads
            }
            saveConnectedCache()
        } else {
            // Subsequent pages: append only sessions not already in the list.
            let existingSessionIds: Set<String> = Set(threads.compactMap { thread -> String? in
                if let sid = thread.sessionId { return sid }
                return viewModels[thread.id]?.sessionId
            })
            for restored in restoredThreads {
                if let sid = restored.sessionId, existingSessionIds.contains(sid) {
                    if let existingIndex = threads.firstIndex(where: { $0.sessionId == sid }) {
                        threads[existingIndex].isPinned = restored.isPinned
                        threads[existingIndex].displayOrder = restored.displayOrder
                        threads[existingIndex].hasUnseenLatestAssistantMessage = restored.hasUnseenLatestAssistantMessage
                        threads[existingIndex].latestAssistantMessageAt = restored.latestAssistantMessageAt
                        threads[existingIndex].lastSeenAssistantMessageAt = restored.lastSeenAssistantMessageAt
                    }
                    viewModels.removeValue(forKey: restored.id)
                } else {
                    threads.append(restored)
                }
            }
            saveConnectedCache()
        }
    }

    /// Load the next page of threads from the daemon (Connected mode only).
    func loadMoreThreads() {
        guard isConnectedMode,
              let daemon = daemonClient as? DaemonClient,
              !isLoadingMoreThreads,
              hasMoreThreads else { return }
        isLoadingMoreThreads = true
        let nextOffset = threadListOffset + Self.threadPageSize
        threadListOffset = nextOffset
        // Do not touch sessionListGeneration or expectedSessionListGeneration here.
        // The generation counter tracks reconnect boundaries only; within a single
        // connection all responses are accepted (the daemon doesn't echo request IDs).
        do {
            try daemon.sendSessionList(offset: nextOffset, limit: Self.threadPageSize)
        } catch {
            // Request failed before being sent — roll back pagination state.
            isLoadingMoreThreads = false
            threadListOffset -= Self.threadPageSize
        }
    }

    private func handleHistoryResponse(_ response: HistoryResponseMessage) {
        guard let threadId = pendingHistoryBySessionId.removeValue(forKey: response.sessionId) else { return }
        guard let vm = viewModels[threadId] else { return }

        let isPaginationLoad = vm.isHistoryLoaded && vm.isLoadingMoreMessages

        vm.populateFromHistory(
            response.messages,
            hasMore: response.hasMore,
            oldestTimestamp: response.oldestTimestamp,
            isPaginationLoad: isPaginationLoad
        )

        // Wire up the onLoadMoreHistory callback if not already set.
        if vm.onLoadMoreHistory == nil {
            vm.onLoadMoreHistory = { [weak self] sessionId, beforeTimestamp in
                self?.requestPaginatedHistory(sessionId: sessionId, beforeTimestamp: beforeTimestamp)
            }
        }
    }

    private func handleSubagentDetailResponse(_ response: IPCSubagentDetailResponse) {
        for (_, vm) in viewModels {
            if vm.activeSubagents.contains(where: { $0.id == response.subagentId }) {
                vm.subagentDetailStore.populateFromDetailResponse(response)
                return
            }
        }
    }

    private func handleMessageContentResponse(_ response: IPCMessageContentResponse) {
        for (_, vm) in viewModels {
            if vm.messages.contains(where: { $0.daemonMessageId == response.messageId }) {
                vm.handleMessageContentResponse(response)
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

        // Wire up the "load more" callback for pagination.
        vm.onLoadMoreHistory = { [weak self] sessionId, beforeTimestamp in
            self?.requestPaginatedHistory(sessionId: sessionId, beforeTimestamp: beforeTimestamp)
        }

        try? daemon.sendHistoryRequest(sessionId: sessionId, limit: 50, mode: "light", maxToolResultChars: 1000)
    }

    /// Mark a connected conversation as seen when the user explicitly opens it.
    func markConversationSeenIfNeeded(threadId: UUID) {
        guard isConnectedMode,
              let idx = threads.firstIndex(where: { $0.id == threadId }),
              let sessionId = threads[idx].sessionId,
              threads[idx].hasUnseenLatestAssistantMessage else { return }

        threads[idx].hasUnseenLatestAssistantMessage = false
        saveConnectedCache()

        let signal = IPCConversationSeenSignal(
            conversationId: sessionId,
            sourceChannel: "vellum",
            signalType: "macos_conversation_opened",
            confidence: "explicit",
            source: "ui-navigation",
            evidenceText: "User opened conversation in app"
        )
        try? daemonClient.send(signal)
    }

    /// Request an older page of history for pagination.
    private func requestPaginatedHistory(sessionId: String, beforeTimestamp: Double) {
        guard let daemon = daemonClient as? DaemonClient,
              let thread = threads.first(where: { $0.sessionId == sessionId }) else {
            // Clear loading state so the user isn't stuck with a permanent spinner.
            // The daemon cast may fail (e.g. HTTP transport) while the thread is still findable.
            if let thread = threads.first(where: { $0.sessionId == sessionId }),
               let vm = viewModels[thread.id] {
                vm.isLoadingMoreMessages = false
            }
            return
        }
        pendingHistoryBySessionId[sessionId] = thread.id
        do {
            try daemon.sendHistoryRequest(sessionId: sessionId, limit: 50, beforeTimestamp: beforeTimestamp, mode: "light", maxToolResultChars: 1000)
        } catch {
            pendingHistoryBySessionId.removeValue(forKey: sessionId)
            if let vm = viewModels[thread.id] {
                vm.isLoadingMoreMessages = false
            }
        }
    }

    /// Return the ChatViewModel for the given thread, creating it if necessary.
    func viewModel(for threadId: UUID) -> ChatViewModel {
        if let existing = viewModels[threadId] {
            wireReconnectCallback(vm: existing, threadId: threadId)
            observeForActivityTracking(vm: existing, threadId: threadId)
            return existing
        }
        let vm = ChatViewModel(daemonClient: daemonClient)
        viewModels[threadId] = vm

        // Copy sessionId from the thread so the VM joins the existing
        // daemon session instead of bootstrapping a new one.
        if let thread = threads.first(where: { $0.id == threadId }) {
            vm.sessionId = thread.sessionId
        }

        wireReconnectCallback(vm: vm, threadId: threadId)

        // Only auto-title threads without a daemon session (new local threads).
        // Daemon threads already have titles from the session list.
        if threads.first(where: { $0.id == threadId })?.sessionId == nil {
            observeForTitleGeneration(vm: vm, threadId: threadId)
        }
        observeForActivityTracking(vm: vm, threadId: threadId)
        return vm
    }

    /// Wire the reconnect history callback so the store registers in
    /// pendingHistoryBySessionId and the response is properly routed back.
    private func wireReconnectCallback(vm: ChatViewModel, threadId: UUID) {
        guard vm.onReconnectHistoryNeeded == nil else { return }
        vm.onReconnectHistoryNeeded = { [weak self, weak vm] sessionId in
            guard let self, let _ = vm, let daemon = self.daemonClient as? DaemonClient else { return }
            self.pendingHistoryBySessionId[sessionId] = threadId
            try? daemon.sendHistoryRequest(sessionId: sessionId, limit: 50, mode: "light", maxToolResultChars: 1000)
        }
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
        if let sid = thread.sessionId { locallyEditedSessionIds.remove(sid) }
        threads.removeAll { $0.id == thread.id }
        // Always keep at least one active (non-archived) non-private thread.
        // Private threads are managed separately and should not prevent the
        // regular thread list from being empty.
        if threads.filter({ !$0.isArchived && !$0.isPrivate }).isEmpty {
            newThread()
        } else {
            save()
        }
        saveConnectedCache()
    }

    func updateTitle(_ title: String, for threadId: UUID) {
        guard let idx = threads.firstIndex(where: { $0.id == threadId }) else { return }
        threads[idx].title = title
        if let sid = threads[idx].sessionId { locallyEditedSessionIds.insert(sid) }
        save()
        saveConnectedCache()
    }

    func archiveThread(_ thread: IOSThread) {
        guard let idx = threads.firstIndex(where: { $0.id == thread.id }) else { return }
        threads[idx].isArchived = true
        if let sid = threads[idx].sessionId { locallyEditedSessionIds.insert(sid) }
        save()
        saveConnectedCache()
    }

    func unarchiveThread(_ thread: IOSThread) {
        guard let idx = threads.firstIndex(where: { $0.id == thread.id }) else { return }
        threads[idx].isArchived = false
        if let sid = threads[idx].sessionId { locallyEditedSessionIds.insert(sid) }
        save()
        saveConnectedCache()
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

    // MARK: Connected-mode cache

    private func saveConnectedCache() {
        guard isConnectedMode else { return }
        let cacheable = threads.filter { $0.sessionId != nil && !$0.isPrivate }
        guard !cacheable.isEmpty else {
            UserDefaults.standard.removeObject(forKey: Self.connectedCacheKey)
            return
        }
        let persisted = cacheable.map {
            PersistedThread(
                id: $0.id,
                title: $0.title,
                createdAt: $0.createdAt,
                lastActivityAt: $0.lastActivityAt,
                isArchived: $0.isArchived,
                isPinned: $0.isPinned,
                displayOrder: $0.displayOrder,
                isPrivate: false,
                sessionId: $0.sessionId,
                scheduleJobId: $0.scheduleJobId,
                hasUnseenLatestAssistantMessage: $0.hasUnseenLatestAssistantMessage,
                latestAssistantMessageAt: $0.latestAssistantMessageAt,
                lastSeenAssistantMessageAt: $0.lastSeenAssistantMessageAt
            )
        }
        if let data = try? JSONEncoder().encode(persisted) {
            UserDefaults.standard.set(data, forKey: Self.connectedCacheKey)
        }
    }

    private static func loadConnectedCache() -> [IOSThread] {
        guard let data = UserDefaults.standard.data(forKey: connectedCacheKey),
              let persisted = try? JSONDecoder().decode([PersistedThread].self, from: data) else {
            return []
        }
        return persisted.compactMap { p in
            guard p.sessionId != nil, !(p.isPrivate ?? false) else { return nil }
            return IOSThread(
                id: p.id,
                title: p.title,
                createdAt: p.createdAt,
                lastActivityAt: p.lastActivityAt,
                sessionId: p.sessionId,
                isArchived: p.isArchived ?? false,
                isPinned: p.isPinned ?? false,
                displayOrder: p.displayOrder,
                isPrivate: false,
                scheduleJobId: p.scheduleJobId,
                hasUnseenLatestAssistantMessage: p.hasUnseenLatestAssistantMessage ?? false,
                latestAssistantMessageAt: p.latestAssistantMessageAt,
                lastSeenAssistantMessageAt: p.lastSeenAssistantMessageAt
            )
        }
    }

    private func clearConnectedCache() {
        UserDefaults.standard.removeObject(forKey: Self.connectedCacheKey)
    }

    private func save() {
        // Don't persist daemon-synced threads — they're loaded on connect.
        guard !isConnectedMode else { return }
        let persisted = threads.map { PersistedThread(id: $0.id, title: $0.title, createdAt: $0.createdAt, lastActivityAt: $0.lastActivityAt, isArchived: $0.isArchived, isPrivate: $0.isPrivate, sessionId: $0.sessionId, scheduleJobId: $0.scheduleJobId) }
        if let data = try? JSONEncoder().encode(persisted) {
            UserDefaults.standard.set(data, forKey: Self.persistenceKey)
        }
    }

    private static func load() -> [IOSThread] {
        guard let data = UserDefaults.standard.data(forKey: persistenceKey),
              let persisted = try? JSONDecoder().decode([PersistedThread].self, from: data) else {
            return []
        }
        return persisted.map { IOSThread(id: $0.id, title: $0.title, createdAt: $0.createdAt, lastActivityAt: $0.lastActivityAt, sessionId: $0.sessionId, isArchived: $0.isArchived ?? false, isPrivate: $0.isPrivate ?? false, scheduleJobId: $0.scheduleJobId) }
    }
}
#endif
