import SwiftUI
import VellumAssistantShared
import Foundation
import UserNotifications
import os
import Combine

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadManager")
private let archivedSessionsKey = "archivedSessionIds"

@MainActor
final class ThreadManager: ObservableObject, ThreadRestorerDelegate {
    @AppStorage("restoreRecentThreads") private(set) var restoreRecentThreads = true
    @AppStorage("lastActiveThreadId") private var lastActiveThreadIdString: String?
    @AppStorage("completedConversationCount") private var completedConversationCount: Int = 0
    @Published var threads: [ThreadModel] = []
    @Published var hasMoreThreads: Bool = false
    @Published var isLoadingMoreThreads: Bool = false
    private struct AssistantActivitySnapshot: Equatable {
        let messageId: UUID
        let textLength: Int
        let toolCallCount: Int
        let completedToolCallCount: Int
        let surfaceCount: Int
        let isStreaming: Bool
    }
    /// Tracks the number of rows already fetched from the daemon so pagination
    /// offsets stay correct even when the client filters out some sessions.
    var serverOffset: Int = 0
    @Published var activeThreadId: UUID? {
        didSet {
            if let activeThreadId {
                let activeViewModel = getOrCreateViewModel(for: activeThreadId)
                activeViewModel?.ensureMessageLoopStarted()
                sessionRestorer.loadHistoryIfNeeded(threadId: activeThreadId)
                // Only persist the active thread ID if we're not in the middle of restoration.
                // During init and session restoration, the didSet fires multiple times and would
                // overwrite the saved value before restoreLastActiveThread() reads it.
                if !isRestoringThreads {
                    lastActiveThreadIdString = activeThreadId.uuidString
                }
                // Notify the daemon so it rebinds the socket to this thread's session.
                // Without this, socketToSession stays stale after thread switches,
                // causing ownership checks (e.g. subagent abort) to fail.
                if let sessionId = activeViewModel?.sessionId {
                    do {
                        try daemonClient.send(IPCSessionSwitchRequest(sessionId: sessionId))
                    } catch {
                        log.error("Failed to send session switch request: \(error)")
                    }
                }
            } else {
                lastActiveThreadIdString = nil
            }
            // Subscribe to the new active view model's changes
            subscribeToActiveViewModel()
        }
    }

    private var chatViewModels: [UUID: ChatViewModel] = [:]
    /// Maximum number of ChatViewModels to keep in memory. When this limit is
    /// exceeded, the least-recently-accessed VM (that isn't the active thread) is
    /// evicted. This prevents unbounded memory growth from accumulated conversations.
    private let maxCachedViewModels = 10
    /// Tracks access order for LRU eviction. Most-recently-accessed ID is at the end.
    private var vmAccessOrder: [UUID] = []
    private let daemonClient: DaemonClient
    private let sessionRestorer: ThreadSessionRestorer
    private let activityNotificationService: ActivityNotificationService?
    /// Flag to suppress lastActiveThreadIdString writes during initialization and session restoration.
    private var isRestoringThreads = false
    /// Subscription to activeViewModel's messages count changes.
    /// Forwards only message count changes to ThreadManager's objectWillChange.
    private var activeViewModelCancellable: AnyCancellable?
    /// Subscriptions to per-thread busy-state changes (isSending, isThinking, pendingQueuedCount).
    private var busyStateCancellables: [UUID: Set<AnyCancellable>] = [:]
    /// Subscription to assistant activity per thread.
    /// Used to mark inactive threads as unseen when assistant output changes.
    private var assistantActivityCancellables: [UUID: AnyCancellable] = [:]
    /// Last observed assistant activity snapshot per thread.
    private var latestAssistantActivitySnapshots: [UUID: AssistantActivitySnapshot] = [:]
    /// Cached set of thread IDs whose ChatViewModel indicates active processing.
    @Published private(set) var busyThreadIds: Set<UUID> = []

    /// Threads that are not archived — used by the UI to populate the sidebar.
    /// Sorted: pinned first (by pinnedOrder ascending), then threads with explicit
    /// displayOrder ascending, then remaining threads by lastInteractedAt descending.
    /// Threads move to the top when messages are sent or received, but NOT when clicked/selected.
    var visibleThreads: [ThreadModel] {
        threads.filter { !$0.isArchived && $0.kind != .private }.sorted { a, b in
            if a.isPinned && b.isPinned {
                return (a.pinnedOrder ?? 0) < (b.pinnedOrder ?? 0)
            }
            if a.isPinned { return true }
            if b.isPinned { return false }
            // Threads with explicit displayOrder come before those without
            if let aOrder = a.displayOrder, let bOrder = b.displayOrder {
                return aOrder < bOrder
            }
            if a.displayOrder != nil { return true }
            if b.displayOrder != nil { return false }
            return a.lastInteractedAt > b.lastInteractedAt
        }
    }

    /// Count of visible (non-archived, non-private) threads with unseen assistant messages.
    /// Used by AppDelegate to drive the dock badge.
    var unseenVisibleConversationCount: Int {
        threads.filter { !$0.isArchived && $0.kind != .private && $0.hasUnseenLatestAssistantMessage }.count
    }

    var archivedThreads: [ThreadModel] {
        threads.filter { $0.isArchived }
    }

    var activeThread: ThreadModel? {
        guard let id = activeThreadId else { return nil }
        return threads.first { $0.id == id }
    }

    var activeViewModel: ChatViewModel? {
        guard let activeThreadId else { return nil }
        return getOrCreateViewModel(for: activeThreadId)
    }

    init(daemonClient: DaemonClient, activityNotificationService: ActivityNotificationService? = nil, isFirstLaunch: Bool = false) {
        self.daemonClient = daemonClient
        self.activityNotificationService = activityNotificationService
        self.sessionRestorer = ThreadSessionRestorer(daemonClient: daemonClient)
        // On first launch (post-onboarding), skip session restoration — there are
        // no meaningful prior sessions. Allow activeThreadId writes immediately so
        // the wake-up thread's UUID is persisted.
        // On normal launches, suppress writes during restoration so the saved
        // value isn't overwritten before restoreLastActiveThread() reads it.
        self.isRestoringThreads = !isFirstLaunch
        // Create one default thread so the window is never empty
        createThread()
        sessionRestorer.delegate = self
        sessionRestorer.startObserving(skipInitialFetch: isFirstLaunch)
    }

    func createThread() {
        // If the active thread is still empty, just keep it instead of creating another.
        // Only reuse when the thread is truly fresh: no messages at all, no persisted
        // session, and not a private thread (which have different persistence semantics).
        if let activeId = activeThreadId,
           let vm = chatViewModels[activeId],
           vm.messages.isEmpty {
            let activeThread = threads.first(where: { $0.id == activeId })
            if activeThread?.kind != .private && activeThread?.sessionId == nil {
                return
            }
        }

        let thread = ThreadModel()
        let viewModel = makeViewModel()
        viewModel.isHistoryLoaded = true  // No session yet — nothing to load
        let threadId = thread.id
        viewModel.onFirstUserMessage = { [weak self] _ in
            self?.completedConversationCount += 1
            self?.updateThreadTitle(id: threadId, title: "Untitled")
            self?.updateLastInteracted(threadId: threadId)
        }
        threads.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()
        activeThreadId = thread.id
        log.info("Created thread \(thread.id) with title \"\(thread.title)\"")
    }

    func createPrivateThread() {
        let thread = ThreadModel(kind: .private)
        let viewModel = makeViewModel()
        viewModel.isHistoryLoaded = true  // No session yet — nothing to load
        let threadId = thread.id
        viewModel.onFirstUserMessage = { [weak self] _ in
            self?.completedConversationCount += 1
            self?.updateThreadTitle(id: threadId, title: "Untitled")
            self?.updateLastInteracted(threadId: threadId)
        }
        threads.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()
        activeThreadId = thread.id

        // Immediately create a daemon session so the thread is persisted
        // before the user sends any messages.
        viewModel.createSessionIfNeeded(threadType: "private")

        log.info("Created private thread \(thread.id)")
    }

    /// Create a visible thread bound to an existing task run conversation.
    /// Called when the daemon broadcasts `task_run_thread_created` so the user
    /// can see task execution messages streaming in real-time.
    func createTaskRunThread(conversationId: String, workItemId: String, title: String) {
        // Avoid creating a duplicate thread if one already exists for this conversation
        if threads.contains(where: { $0.sessionId == conversationId }) {
            return
        }

        let thread = ThreadModel(title: title, sessionId: conversationId)
        let viewModel = makeViewModel()
        viewModel.sessionId = conversationId
        // Mark history as loaded since this thread streams live — there is no
        // prior history to fetch. Without this, handleAssistantMessageArrival
        // would drop all live updates (unseen indicators, recency bumps) because
        // the !isHistoryLoaded guard returns early.
        viewModel.isHistoryLoaded = true
        // Start the message loop so the view model receives streamed messages
        viewModel.startMessageLoop()

        threads.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()

        log.info("Created task run thread \(thread.id) for conversation \(conversationId) (work item \(workItemId))")
    }

    /// Create a visible thread bound to a notification-created conversation.
    /// Called when the daemon broadcasts `notification_thread_created` so the user
    /// can see notification threads and deep-link into them.
    func createNotificationThread(conversationId: String, title: String, sourceEventName: String) {
        // Avoid creating a duplicate thread if one already exists for this conversation
        if threads.contains(where: { $0.sessionId == conversationId }) {
            return
        }

        var thread = ThreadModel(title: title, sessionId: conversationId)
        thread.source = "notification"
        thread.hasUnseenLatestAssistantMessage = true
        let viewModel = makeViewModel()
        viewModel.sessionId = conversationId
        // Do NOT set isHistoryLoaded here — notification threads have a
        // pre-existing seed message persisted by conversation-pairing before
        // the notification_thread_created event is emitted. Leaving
        // isHistoryLoaded false allows ThreadSessionRestorer.loadHistoryIfNeeded
        // to fetch that seed message when the thread is first selected.
        // The handleAssistantMessageArrival guard dropping updates is correct
        // for notification threads because their content arrives via history
        // load, not live streaming. Unread state is already set explicitly
        // above (hasUnseenLatestAssistantMessage = true).

        // Start the message loop so the view model receives streamed messages
        viewModel.startMessageLoop()

        threads.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()

        log.info("Created notification thread \(thread.id) for conversation \(conversationId) (source: \(sourceEventName))")
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
        unsubscribeFromBusyState(for: id)
        vmAccessOrder.removeAll { $0 == id }

        // Reclaim memory held by static caches that may reference
        // messages from the closed thread.
        Self.clearRenderCaches()

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

    func archiveThread(id: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }

        threads[index].isArchived = true

        if let sessionId = threads[index].sessionId {
            chatViewModels[id]?.stopGenerating()
            var archived = archivedSessionIds
            archived.insert(sessionId)
            archivedSessionIds = archived
            // Session ID already known — safe to release the view model.
            chatViewModels.removeValue(forKey: id)
            unsubscribeFromBusyState(for: id)
            vmAccessOrder.removeAll { $0 == id }
        } else if chatViewModels[id]?.messages.contains(where: { $0.role == .user }) != true
                    && chatViewModels[id]?.isBootstrapping != true {
            chatViewModels[id]?.stopGenerating()
            // No session ID, no user messages, and no bootstrap in flight —
            // a session will never be created, so there is nothing to backfill.
            // Clean up immediately.
            chatViewModels.removeValue(forKey: id)
            unsubscribeFromBusyState(for: id)
            vmAccessOrder.removeAll { $0 == id }
        } else {
            // Session ID is nil but a session is expected (user messages exist
            // or bootstrap is in flight, e.g. a workspace refinement that
            // doesn't append a user message). Keep the ChatViewModel alive so
            // the onSessionCreated callback can fire, claim its own session via
            // the correlation ID, persist the archive state via backfillSessionId,
            // and then clean up. Use cancelPendingMessage() instead of
            // stopGenerating() to discard the queued message without clearing the
            // correlation ID — this prevents the VM from claiming an unrelated
            // session_info from another thread.
            chatViewModels[id]?.cancelPendingMessage()
        }

        // If the archived thread was active, select an adjacent visible thread
        // or create a new one if none remain.
        if activeThreadId == id {
            // Find the position of the archived thread among visible threads
            // (before archiving filtered it out) and pick the neighbor.
            let visible = visibleThreads
            if !visible.isEmpty {
                // The archived thread was at `index` in the full `threads` array.
                // Find the closest visible thread by scanning neighbors.
                let visibleAfter = threads[index...].dropFirst().first(where: { !$0.isArchived })
                let visibleBefore = threads[..<index].last(where: { !$0.isArchived })
                if let next = visibleAfter ?? visibleBefore {
                    activeThreadId = next.id
                } else {
                    activeThreadId = visible.first?.id
                }
            } else {
                createThread()
            }
        }

        // Reclaim memory held by static caches that may reference
        // messages from the archived thread.
        Self.clearRenderCaches()

        log.info("Archived thread \(id)")
    }

    func unarchiveThread(id: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }

        threads[index].isArchived = false

        // Ensure a ChatViewModel exists (lazily created if it was evicted on archive).
        getOrCreateViewModel(for: id)

        if let sessionId = threads[index].sessionId {
            var archived = archivedSessionIds
            archived.remove(sessionId)
            archivedSessionIds = archived
        }

        log.info("Unarchived thread \(id)")
    }

    func isSessionArchived(_ sessionId: String) -> Bool {
        archivedSessionIds.contains(sessionId)
    }

    /// Load more threads from the daemon (pagination).
    func loadMoreThreads() {
        guard !isLoadingMoreThreads else { return }
        isLoadingMoreThreads = true
        do {
            try daemonClient.sendSessionList(offset: serverOffset, limit: 50)
        } catch {
            log.error("Failed to request more threads: \(error.localizedDescription)")
            isLoadingMoreThreads = false
        }
    }

    /// Handle appended threads from a "load more" response.
    func appendThreads(from response: SessionListResponseMessage) {
        // Increment offset by the unfiltered count so pagination stays aligned
        // with the daemon's row numbering regardless of client-side filtering.
        serverOffset += response.sessions.count

        let recentSessions = response.sessions.filter {
            $0.threadType != "private" && $0.channelBinding?.sourceChannel == nil
        }

        // Compute the next pinnedOrder based on existing pinned threads so
        // appended pinned threads don't collide with already-loaded ones.
        var nextPinnedOrder = (threads.compactMap(\.pinnedOrder).max() ?? -1) + 1

        for session in recentSessions {
            // Skip sessions that already have a thread
            guard !threads.contains(where: { $0.sessionId == session.id }) else { continue }

            let isPinned = session.isPinned ?? false
            let effectiveCreatedAt = session.createdAt ?? session.updatedAt
            let thread = ThreadModel(
                title: session.title,
                createdAt: Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAt) / 1000.0),
                sessionId: session.id,
                isArchived: isSessionArchived(session.id),
                isPinned: isPinned,
                pinnedOrder: isPinned ? nextPinnedOrder : nil,
                displayOrder: session.displayOrder.map { Int($0) },
                lastInteractedAt: Date(timeIntervalSince1970: TimeInterval(session.updatedAt) / 1000.0),
                kind: session.threadType == "private" ? .private : .standard,
                source: session.source,
                hasUnseenLatestAssistantMessage: session.assistantAttention?.hasUnseenLatestAssistantMessage ?? false
            )
            if isPinned { nextPinnedOrder += 1 }
            // VM creation is lazy — getOrCreateViewModel() will instantiate
            // when the thread is first accessed (e.g. selected by the user).
            threads.append(thread)
        }

        if let hasMore = response.hasMore {
            hasMoreThreads = hasMore
        }
        evictStaleCachedViewModels()
        isLoadingMoreThreads = false
    }

    /// Clear the `activeSurfaceId` on a specific thread's ChatViewModel.
    /// Used when switching threads to prevent stale surface context injection.
    func clearActiveSurface(threadId: UUID) {
        chatViewModels[threadId]?.activeSurfaceId = nil
    }

    func selectThread(id: UUID) {
        guard let thread = threads.first(where: { $0.id == id }) else { return }

        let previousActiveId = activeThreadId
        trimPreviousThreadIfNeeded(nextThreadId: id)

        // Re-create the ViewModel if it was LRU-evicted.
        if chatViewModels[id] == nil {
            let viewModel = makeViewModel()
            viewModel.sessionId = thread.sessionId
            chatViewModels[id] = viewModel
            subscribeToBusyState(for: id, viewModel: viewModel)
            subscribeToAssistantActivity(for: id, viewModel: viewModel)
            evictStaleCachedViewModels()
        }

        touchVMAccessOrder(id)
        activeThreadId = id
        // Switching threads is a natural point to shed cached render
        // artefacts from the previous conversation.
        Self.clearRenderCaches()

        // Emit explicit seen signal for user-initiated thread selection.
        // Skip if this thread was already active to avoid duplicate signals
        // (e.g. when openConversationThread sets activeThreadId directly and
        // SwiftUI's onChange cycle calls selectThread with the same id).
        if id != previousActiveId, let sessionId = thread.sessionId {
            emitConversationSeenSignal(conversationId: sessionId)
            if let idx = threads.firstIndex(where: { $0.id == id }) {
                threads[idx].hasUnseenLatestAssistantMessage = false
            }
        }
    }

    // MARK: - Render Cache Management

    /// Clears static render caches used by chat bubble and markdown views.
    /// Called on thread close, archive, and switch to prevent unbounded
    /// growth of cached `AttributedString` / segment data across conversations.
    private static func clearRenderCaches() {
        ChatBubble.segmentCache.removeAll()
        ChatBubble.markdownCache.removeAll()
        ChatBubble.inlineMarkdownCache.removeAll()
        ChatBubble.estimatedCacheBytes = 0
        ChatBubble.lastStreamingSegments = nil
        ChatBubble.lastStreamingInlineMarkdown = nil
        ChatBubble.lastStreamingMarkdown = nil
        MarkdownSegmentView.clearAttributedStringCache()
    }

    /// Returns true if the thread has at least one user message.
    func threadHasMessages(_ id: UUID) -> Bool {
        chatViewModels[id]?.messages.contains(where: { $0.role == .user }) ?? false
    }

    /// Update confirmation state across all *existing* chat view models, not just
    /// the active one. Only iterates VMs that are already instantiated — does not
    /// trigger lazy creation for threads that have never been accessed.
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

    // MARK: - Pinning & Ordering

    func pinThread(id: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }
        let nextOrder = (threads.compactMap(\.pinnedOrder).max() ?? -1) + 1
        threads[index].isPinned = true
        threads[index].pinnedOrder = nextOrder
        sendReorderThreads()
    }

    func unpinThread(id: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }
        threads[index].isPinned = false
        threads[index].pinnedOrder = nil
        threads[index].displayOrder = nil
        recompactPinnedOrders()
        sendReorderThreads()
    }

    func reorderPinnedThreads(from source: IndexSet, to destination: Int) {
        var pinned = visibleThreads.filter(\.isPinned)
        pinned.move(fromOffsets: source, toOffset: destination)
        for (order, item) in pinned.enumerated() {
            if let idx = threads.firstIndex(where: { $0.id == item.id }) {
                threads[idx].pinnedOrder = order
            }
        }
    }

    func updateLastInteracted(threadId: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == threadId }) else { return }
        threads[index].lastInteractedAt = Date()
    }

    /// Move a thread to a new position in the visible list (for drag-and-drop reorder).
    /// Works for any thread: pinned-to-pinned reorders among pinned items,
    /// unpinned-to-pinned pins the source, and unpinned-to-unpinned reorders
    /// using displayOrder. When the target is a schedule thread, the source is
    /// inserted at the end of the unpinned regular threads list (the boundary
    /// between regular and scheduled threads).
    @discardableResult
    func moveThread(sourceId: UUID, beforeId: UUID) -> Bool {
        guard let sourceIdx = threads.firstIndex(where: { $0.id == sourceId }),
              let targetIdx = threads.firstIndex(where: { $0.id == beforeId }) else { return false }
        let targetThread = threads[targetIdx]

        if targetThread.isPinned {
            // Dropping onto a pinned thread — pin the source if needed and reorder
            if !threads[sourceIdx].isPinned {
                threads[sourceIdx].isPinned = true
            }
            let targetOrder = targetThread.pinnedOrder ?? 0
            threads[sourceIdx].pinnedOrder = targetOrder
            for i in threads.indices where threads[i].isPinned && threads[i].id != sourceId {
                if let order = threads[i].pinnedOrder, order >= targetOrder {
                    threads[i].pinnedOrder = order + 1
                }
            }
            recompactPinnedOrders()
        } else {
            // Dropping onto an unpinned thread — reorder using displayOrder.
            // If the source was pinned, unpin it first.
            if threads[sourceIdx].isPinned {
                threads[sourceIdx].isPinned = false
                threads[sourceIdx].pinnedOrder = nil
                recompactPinnedOrders()
            }

            // Build the current visible unpinned order and insert the source before the target.
            // Include schedule threads so that dropping on a schedule thread places the source
            // at the boundary (end of regular threads, just before the first schedule thread).
            let unpinned = visibleThreads.filter { !$0.isPinned }
            var reordered = unpinned.filter { $0.id != sourceId }
            let targetPos = reordered.firstIndex(where: { $0.id == beforeId }) ?? reordered.endIndex
            if let movedThread = unpinned.first(where: { $0.id == sourceId }) ?? [threads[sourceIdx]].first {
                reordered.insert(movedThread, at: targetPos)
            }
            // Assign sequential displayOrder to all reordered unpinned threads
            for (order, item) in reordered.enumerated() {
                if let idx = threads.firstIndex(where: { $0.id == item.id }) {
                    threads[idx].displayOrder = order
                }
            }
        }

        sendReorderThreads()
        return true
    }

    private func recompactPinnedOrders() {
        let pinned = threads.enumerated()
            .filter { $0.element.isPinned }
            .sorted { ($0.element.pinnedOrder ?? 0) < ($1.element.pinnedOrder ?? 0) }
        for (order, item) in pinned.enumerated() {
            threads[item.offset].pinnedOrder = order
        }
    }

    /// Send the current thread ordering to the daemon so it persists across restarts.
    /// For pinned threads, derives a deterministic displayOrder from pinnedOrder so
    /// the pinned ordering survives restarts. For unpinned threads that have been
    /// explicitly reordered (non-nil displayOrder), sends their displayOrder. For
    /// unpinned threads without explicit ordering, sends nil so they sort by recency.
    private func sendReorderThreads() {
        let visible = visibleThreads
        var updates: [IPCReorderThreadsRequestUpdate] = []
        for thread in visible {
            guard let sessionId = thread.sessionId else { continue }
            let order: Double?
            if thread.isPinned {
                // Pinned threads always need a persisted displayOrder derived from
                // their pinnedOrder so their user-defined order survives restarts.
                order = Double(thread.pinnedOrder ?? 0)
            } else {
                order = thread.displayOrder.map { Double($0) }
            }
            updates.append(IPCReorderThreadsRequestUpdate(
                sessionId: sessionId,
                displayOrder: order,
                isPinned: thread.isPinned
            ))
        }
        guard !updates.isEmpty else { return }
        do {
            try daemonClient.send(IPCReorderThreadsRequest(
                type: "reorder_threads",
                updates: updates
            ))
        } catch {
            log.error("Failed to send reorder_threads: \(error.localizedDescription)")
        }
    }

    // MARK: - ThreadRestorerDelegate

    func chatViewModel(for threadId: UUID) -> ChatViewModel? {
        return getOrCreateViewModel(for: threadId)
    }

    func existingChatViewModel(for threadId: UUID) -> ChatViewModel? {
        guard let vm = chatViewModels[threadId] else { return nil }
        touchVMAccessOrder(threadId)
        return vm
    }

    func existingChatViewModel(forSessionId sessionId: String) -> ChatViewModel? {
        for (threadId, vm) in chatViewModels where vm.sessionId == sessionId {
            touchVMAccessOrder(threadId)
            return vm
        }
        return nil
    }

    func setChatViewModel(_ vm: ChatViewModel, for threadId: UUID) {
        chatViewModels[threadId] = vm
        subscribeToBusyState(for: threadId, viewModel: vm)
        subscribeToAssistantActivity(for: threadId, viewModel: vm)
        touchVMAccessOrder(threadId)
        evictStaleCachedViewModels()
        // Re-subscribe if this is the active view model
        if threadId == activeThreadId {
            subscribeToActiveViewModel()
        }
    }

    func removeChatViewModel(for threadId: UUID) {
        chatViewModels.removeValue(forKey: threadId)
        unsubscribeFromBusyState(for: threadId)
        vmAccessOrder.removeAll { $0 == threadId }
    }

    /// Called when the user responds to a confirmation via the inline chat UI.
    /// The app layer uses this to dismiss the native notification and resume
    /// the notification service continuation. Receives (requestId, decision).
    var onInlineConfirmationResponse: ((String, String) -> Void)?

    /// The ambient agent instance, set by the app layer so watch session callbacks
    /// can create and manage WatchSession objects.
    weak var ambientAgent: AmbientAgent?

    func updateThreadTitle(id: UUID, title: String) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }
        threads[index].title = title
    }

    func makeViewModel() -> ChatViewModel {
        let viewModel = ChatViewModel(daemonClient: daemonClient)
        viewModel.onToolCallsComplete = { [weak self, weak viewModel] toolCalls in
            guard let self, let service = self.activityNotificationService else { return }
            let sessionId = viewModel?.sessionId ?? ""
            Task { @MainActor in
                await service.notifySessionComplete(
                    summary: "Tool execution completed",
                    steps: toolCalls.count,
                    toolCalls: toolCalls,
                    sessionId: sessionId
                )
            }
        }
        viewModel.shouldAcceptConfirmation = { [weak self, weak viewModel] in
            guard let self, let viewModel else { return false }
            return self.isLatestToolUseRecipient(viewModel)
        }
        viewModel.onInlineConfirmationResponse = { [weak self] requestId, decision in
            // The decision was already sent to the daemon by ChatViewModel.
            // Forward to the app layer so it can dismiss the native notification
            // and resume the notification service continuation.
            self?.onInlineConfirmationResponse?(requestId, decision)
        }
        viewModel.onWatchStarted = { [weak self] msg, client in
            guard let self else { return }
            let session = WatchSession(
                watchId: msg.watchId,
                sessionId: msg.sessionId,
                durationSeconds: Int(msg.durationSeconds),
                intervalSeconds: Int(msg.intervalSeconds)
            )
            self.ambientAgent?.activeWatchSession = session
            session.start(daemonClient: client)
        }
        viewModel.onWatchCompleteRequest = { [weak self] _ in
            self?.ambientAgent?.activeWatchSession?.stop()
            self?.ambientAgent?.activeWatchSession = nil
        }
        viewModel.onStopWatch = { [weak self] in
            self?.ambientAgent?.activeWatchSession?.stop()
            self?.ambientAgent?.activeWatchSession = nil
        }
        viewModel.onSessionCreated = { [weak self, weak viewModel] sessionId in
            guard let self, let viewModel else { return }
            self.backfillSessionId(sessionId, for: viewModel)
        }
        viewModel.onVoiceResponseComplete = { responseText in
            guard !NSApp.isActive else { return }
            let content = UNMutableNotificationContent()
            content.title = "Response Ready"
            content.body = String(responseText.prefix(200))
            content.sound = .default
            content.categoryIdentifier = "VOICE_RESPONSE_COMPLETE"

            let request = UNNotificationRequest(
                identifier: "voice-response-\(UUID().uuidString)",
                content: content,
                trigger: nil
            )
            UNUserNotificationCenter.current().add(request) { error in
                if let error {
                    log.error("Failed to post voice response notification: \(error.localizedDescription)")
                }
            }
        }
        viewModel.onUserMessageSent = { [weak self, weak viewModel] in
            guard let self, let viewModel else { return }
            if let threadId = self.chatViewModels.first(where: { $0.value === viewModel })?.key {
                self.updateLastInteracted(threadId: threadId)
            }
        }
        viewModel.onReconnectHistoryNeeded = { [weak self] sessionId in
            guard let self else { return }
            self.sessionRestorer.requestReconnectHistory(sessionId: sessionId)
        }
        return viewModel
    }

    func activateThread(_ id: UUID) {
        let previousActiveId = activeThreadId
        trimPreviousThreadIfNeeded(nextThreadId: id)
        activeThreadId = id

        // Emit explicit seen signal for user-initiated thread activation.
        // Skip during session restoration to avoid false "seen" signals on bootstrap.
        if !isRestoringThreads,
           id != previousActiveId,
           let thread = threads.first(where: { $0.id == id }),
           let sessionId = thread.sessionId {
            emitConversationSeenSignal(conversationId: sessionId)
            if let idx = threads.firstIndex(where: { $0.id == id }) {
                threads[idx].hasUnseenLatestAssistantMessage = false
            }
        }
    }

    /// Clear the local unseen flag and notify the daemon that the conversation
    /// has been seen. Use this from call-sites that bypass `selectThread` (e.g.
    /// deep-link navigation in `openConversationThread`) where the `id != previousActiveId`
    /// guard would skip the signal.
    internal func markConversationSeen(threadId: UUID) {
        guard let idx = threads.firstIndex(where: { $0.id == threadId }) else { return }
        threads[idx].hasUnseenLatestAssistantMessage = false
        if let sessionId = threads[idx].sessionId {
            emitConversationSeenSignal(conversationId: sessionId)
        }
    }

    // MARK: - Private

    /// Send a `conversation_seen_signal` IPC message to the daemon.
    private func emitConversationSeenSignal(conversationId: String) {
        let signal = IPCConversationSeenSignal(
            conversationId: conversationId,
            sourceChannel: "vellum",
            signalType: "macos_conversation_opened",
            confidence: "explicit",
            source: "ui-navigation",
            evidenceText: "User opened conversation in app"
        )
        do {
            try daemonClient.send(signal)
        } catch {
            log.warning("Failed to send conversation_seen_signal for \(conversationId): \(error.localizedDescription)")
        }
    }

    /// Trim the previously active thread's view model to shed memory before
    /// switching to a different thread. Skipped when the VM hasn't loaded
    /// history yet or when it has an active generation in progress.
    private func trimPreviousThreadIfNeeded(nextThreadId: UUID) {
        guard let previousId = activeThreadId, previousId != nextThreadId,
              let vm = chatViewModels[previousId],
              vm.isHistoryLoaded,
              !vm.isSending, !vm.isThinking, !vm.isLoadingMoreMessages else { return }
        vm.trimForBackground()
    }

    /// Backfill ThreadModel.sessionId when the daemon assigns a session to a new thread.
    private func backfillSessionId(_ sessionId: String, for viewModel: ChatViewModel) {
        guard let threadId = chatViewModels.first(where: { $0.value === viewModel })?.key,
              let index = threads.firstIndex(where: { $0.id == threadId }),
              threads[index].sessionId == nil else { return }
        threads[index].sessionId = sessionId
        // If the thread was archived before the session ID arrived,
        // persist the archive state now that we have a session ID and
        // release the view model that was kept alive for this callback.
        if threads[index].isArchived {
            var archived = archivedSessionIds
            archived.insert(sessionId)
            archivedSessionIds = archived
            chatViewModels.removeValue(forKey: threadId)
            unsubscribeFromBusyState(for: threadId)
            vmAccessOrder.removeAll { $0 == threadId }
        }
    }

    // MARK: - Lazy VM Creation

    /// Returns an existing ChatViewModel or lazily creates one for the given thread.
    /// This is the single entry point for VM access — `appendThreads` and session
    /// restoration no longer eagerly create VMs for every loaded session.
    @discardableResult
    private func getOrCreateViewModel(for threadId: UUID) -> ChatViewModel? {
        if let vm = chatViewModels[threadId] {
            touchVMAccessOrder(threadId)
            return vm
        }
        // Only create if the thread exists
        guard let thread = threads.first(where: { $0.id == threadId }) else { return nil }
        let viewModel = makeViewModel()
        viewModel.sessionId = thread.sessionId
        if thread.sessionId == nil {
            viewModel.isHistoryLoaded = true
        }
        chatViewModels[threadId] = viewModel
        subscribeToBusyState(for: threadId, viewModel: viewModel)
        subscribeToAssistantActivity(for: threadId, viewModel: viewModel)
        touchVMAccessOrder(threadId)
        evictStaleCachedViewModels()
        return viewModel
    }

    // MARK: - VM LRU Cache Management

    /// Move `threadId` to the end of `vmAccessOrder` (most-recently-used position).
    private func touchVMAccessOrder(_ threadId: UUID) {
        vmAccessOrder.removeAll { $0 == threadId }
        vmAccessOrder.append(threadId)
    }

    /// Evict the oldest cached ChatViewModel that is not the active thread,
    /// keeping at most `maxCachedViewModels` entries in the dictionary.
    private func evictStaleCachedViewModels() {
        while chatViewModels.count > maxCachedViewModels {
            // Find the oldest non-active, non-busy VM so we never cancel an in-flight response
            // just because the user switched threads.
            guard let victim = vmAccessOrder.first(where: {
                guard $0 != activeThreadId, let vm = chatViewModels[$0] else { return false }
                return !vm.isSending && !vm.isThinking && vm.pendingQueuedCount == 0
            }) else {
                break
            }
            chatViewModels.removeValue(forKey: victim)
            unsubscribeFromBusyState(for: victim)
            vmAccessOrder.removeAll { $0 == victim }
            log.info("LRU evicted VM for thread \(victim)")
        }
    }

    private var archivedSessionIds: Set<String> {
        get {
            Set(UserDefaults.standard.stringArray(forKey: archivedSessionsKey) ?? [])
        }
        set {
            UserDefaults.standard.set(Array(newValue), forKey: archivedSessionsKey)
        }
    }


    /// Restore the last active thread from UserDefaults after session restoration completes
    func restoreLastActiveThread() {
        guard restoreRecentThreads else {
            // Clear the flag even if restoration is disabled
            isRestoringThreads = false
            return
        }
        guard let savedUUIDString = lastActiveThreadIdString,
              let savedUUID = UUID(uuidString: savedUUIDString) else {
            // Clear the flag and allow future activeThreadId changes to persist
            isRestoringThreads = false
            return
        }

        // Only restore if thread exists and is visible (not archived)
        if threads.contains(where: { $0.id == savedUUID && !$0.isArchived }) {
            activeThreadId = savedUUID
            log.info("Restored last active thread: \(savedUUID)")
        } else {
            // Thread no longer exists, clear saved state
            lastActiveThreadIdString = nil
            log.info("Saved thread not found, falling back to default")
        }

        // Clear the flag so future activeThreadId changes persist normally
        isRestoringThreads = false
    }

    // MARK: - Busy State

    /// Whether the given thread's ChatViewModel indicates active processing.
    func isThreadBusy(_ threadId: UUID) -> Bool {
        busyThreadIds.contains(threadId)
    }

    /// Subscribe to busy-state publishers on a ChatViewModel so `busyThreadIds` stays current.
    func subscribeToBusyState(for threadId: UUID, viewModel: ChatViewModel) {
        // Tear down any previous subscriptions for this thread.
        busyStateCancellables.removeValue(forKey: threadId)
        var subs = Set<AnyCancellable>()

        let mgr = viewModel.messageManager
        // Combine the three relevant publishers into a single derived boolean.
        Publishers.CombineLatest3(
            mgr.$isSending,
            mgr.$isThinking,
            mgr.$pendingQueuedCount
        )
        .map { isSending, isThinking, pendingQueuedCount in
            isSending || isThinking || pendingQueuedCount > 0
        }
        .removeDuplicates()
        .sink { [weak self] isBusy in
            guard let self else { return }
            if isBusy {
                self.busyThreadIds.insert(threadId)
            } else {
                self.busyThreadIds.remove(threadId)
            }
        }
        .store(in: &subs)

        busyStateCancellables[threadId] = subs
    }

    /// Subscribe to assistant activity for a thread.
    /// Any change to the latest assistant message's rendered content marks
    /// inactive threads unseen, including mid-stream continuation updates.
    private func subscribeToAssistantActivity(for threadId: UUID, viewModel: ChatViewModel) {
        assistantActivityCancellables[threadId]?.cancel()
        if let snapshot = latestAssistantActivitySnapshot(in: viewModel.messages) {
            latestAssistantActivitySnapshots[threadId] = snapshot
        } else {
            latestAssistantActivitySnapshots.removeValue(forKey: threadId)
        }

        assistantActivityCancellables[threadId] = viewModel.messageManager.$messages
            .map { [weak self] messages in
                self?.latestAssistantActivitySnapshot(in: messages)
            }
            .removeDuplicates()
            .sink { [weak self] latestSnapshot in
                guard let self else { return }
                let previousSnapshot = self.latestAssistantActivitySnapshots[threadId]
                if let latestSnapshot {
                    self.latestAssistantActivitySnapshots[threadId] = latestSnapshot
                } else {
                    self.latestAssistantActivitySnapshots.removeValue(forKey: threadId)
                }
                guard previousSnapshot != latestSnapshot,
                      let latestSnapshot else { return }
                self.handleAssistantMessageArrival(threadId: threadId, previousSnapshot: previousSnapshot, currentSnapshot: latestSnapshot)
            }
    }

    private func latestAssistantActivitySnapshot(in messages: [ChatMessage]) -> AssistantActivitySnapshot? {
        guard let message = messages.reversed().first(where: { $0.role == .assistant }) else { return nil }
        return AssistantActivitySnapshot(
            messageId: message.id,
            textLength: message.text.count,
            toolCallCount: message.toolCalls.count,
            completedToolCallCount: message.toolCalls.filter(\.isComplete).count,
            surfaceCount: message.inlineSurfaces.count,
            isStreaming: message.isStreaming
        )
    }

    /// Remove busy-state subscriptions for a thread (e.g. on archive/close).
    private func unsubscribeFromBusyState(for threadId: UUID) {
        busyStateCancellables.removeValue(forKey: threadId)
        assistantActivityCancellables[threadId]?.cancel()
        assistantActivityCancellables.removeValue(forKey: threadId)
        latestAssistantActivitySnapshots.removeValue(forKey: threadId)
        busyThreadIds.remove(threadId)
    }

    /// Subscribe to the active ChatViewModel's messages publisher.
    /// Only forwards changes when the message count changes, preserving the
    /// wrapper-view isolation pattern that prevents high-frequency ChatViewModel
    /// updates (like keystroke events, streaming deltas) from invalidating MainWindowView.
    private func subscribeToActiveViewModel() {
        // Cancel previous subscription
        activeViewModelCancellable?.cancel()
        activeViewModelCancellable = nil

        // Subscribe to the new active view model if one exists
        guard let viewModel = activeViewModel else { return }

        // Observe message count changes to drive the sidebar unread indicator.
        activeViewModelCancellable = viewModel.messageManager.$messages
            .map { $0.count }
            .removeDuplicates()
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
    }

    /// Mark assistant activity on a thread as seen/unseen depending on whether
    /// that thread is currently active.
    ///
    /// For the active thread, the seen signal is only emitted on meaningful
    /// transitions — when a new assistant message first appears (new messageId)
    /// or when streaming completes (isStreaming goes from true to false). This
    /// avoids O(n) IPC calls per streaming response (one per text delta) while
    /// still advancing the server-side seen cursor.
    private func handleAssistantMessageArrival(threadId: UUID, previousSnapshot: AssistantActivitySnapshot?, currentSnapshot: AssistantActivitySnapshot) {
        // Skip during thread restoration or history re-hydration —
        // loadHistoryIfNeeded populates messages which triggers the Combine
        // publisher, but those are historical messages, not fresh assistant
        // replies. Without this guard the handler would clear real unread
        // state on app launch, or bump threads to the top when clicking on
        // them causes an evicted ViewModel to reload its history.
        guard !isRestoringThreads else { return }
        if let vm = chatViewModels[threadId], vm.isLoadingHistory || !vm.isHistoryLoaded {
            return
        }
        guard let index = threads.firstIndex(where: { $0.id == threadId }) else { return }
        updateLastInteracted(threadId: threadId)
        if threadId == activeThreadId {
            threads[index].hasUnseenLatestAssistantMessage = false
            // Only emit the IPC seen signal on meaningful transitions:
            // 1. A new assistant message appeared (different messageId)
            // 2. Streaming just completed (isStreaming went true -> false)
            let isNewMessage = previousSnapshot?.messageId != currentSnapshot.messageId
            let streamingJustCompleted = previousSnapshot?.isStreaming == true && !currentSnapshot.isStreaming
            if isNewMessage || streamingJustCompleted {
                if let sessionId = threads[index].sessionId {
                    emitConversationSeenSignal(conversationId: sessionId)
                }
            }
        } else {
            threads[index].hasUnseenLatestAssistantMessage = true
        }
    }
}
