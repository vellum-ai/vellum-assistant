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
                // Switching to a real thread discards any draft
                draftViewModel = nil

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
                        try daemonClient.send(SessionSwitchRequest(sessionId: sessionId))
                    } catch {
                        log.error("Failed to send session switch request: \(error)")
                    }
                }
            } else {
                // Only clear the persisted thread ID outside of restoration.
                // During init, enterDraftMode() sets activeThreadId = nil before
                // restoreLastActiveThread() reads the saved value.
                if !isRestoringThreads {
                    lastActiveThreadIdString = nil
                }
            }
            // Clear stale anchor when switching away from the thread that
            // owns it — prevents the anchor from suppressing scroll-to-bottom
            // on unrelated thread switches.
            if let anchorThread = pendingAnchorThreadId, anchorThread != activeThreadId {
                pendingAnchorMessageId = nil
                pendingAnchorThreadId = nil
            }
            // Subscribe to the new active view model's changes
            subscribeToActiveViewModel()
        }
    }

    @Published private(set) var draftViewModel: ChatViewModel?
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
    /// Queued renames for threads that don't yet have a sessionId.
    /// Flushed in backfillSessionId when the daemon assigns a session.
    private var pendingRenames: [UUID: String] = [:]
    /// Flag to suppress lastActiveThreadIdString writes during initialization and session restoration.
    private var isRestoringThreads = false
    /// Subscription to activeViewModel's messages count changes.
    /// Drives activeMessageCount so only message-count-dependent views re-render,
    /// not the entire window tree.
    private var activeViewModelCancellable: AnyCancellable?
    /// Tracks the message count of the active thread's view model.
    /// SwiftUI views that need to react to new messages should observe this
    /// instead of subscribing to ThreadManager.objectWillChange, which fires
    /// for every property change and causes full-tree re-renders.
    @Published public private(set) var activeMessageCount: Int = 0
    /// Subscriptions to per-thread busy-state changes (isSending, isThinking, pendingQueuedCount).
    private var busyStateCancellables: [UUID: Set<AnyCancellable>] = [:]
    /// Subscription to assistant activity per thread.
    /// Used to mark inactive threads as unseen when assistant output changes.
    private var assistantActivityCancellables: [UUID: AnyCancellable] = [:]
    /// Last observed assistant activity snapshot per thread.
    private var latestAssistantActivitySnapshots: [UUID: AssistantActivitySnapshot] = [:]
    /// Cached set of thread IDs whose ChatViewModel indicates active processing.
    @Published private(set) var busyThreadIds: Set<UUID> = []
    /// Per-thread interaction state derived from ChatViewModel properties.
    /// Priority: error > waitingForInput > processing > idle.
    @Published private(set) var threadInteractionStates: [UUID: ThreadInteractionState] = [:]
    /// Subscriptions to per-thread interaction-state changes.
    private var interactionStateCancellables: [UUID: Set<AnyCancellable>] = [:]
    /// Pending anchor message ID for scroll-to behavior on notification deep links.
    @Published var pendingAnchorMessageId: UUID?
    /// Tracks which thread the pending anchor belongs to so stale anchors are
    /// cleared automatically when the user switches to a different thread.
    private var pendingAnchorThreadId: UUID?
    /// Session IDs whose seen signals are deferred pending undo expiration.
    private var pendingSeenSessionIds: [String] = []
    /// Task that auto-commits deferred seen signals after the undo window.
    private var pendingSeenSignalTask: Task<Void, Never>?
    /// Local seen/unread toggles should survive a stale daemon session-list
    /// replay until the daemon either acknowledges them or reports a newer reply.
    private var pendingAttentionOverrides: [String: PendingAttentionOverride] = [:]

    private enum PendingAttentionOverride {
        case seen(latestAssistantMessageAt: Date?)
        case unread(latestAssistantMessageAt: Date?)
    }

    /// Per-thread attention state captured before mark-all-seen,
    /// so the undo path can restore exact prior values.
    private struct MarkAllSeenPriorState {
        let lastSeenAssistantMessageAt: Date?
        let sessionId: String?
        let override: PendingAttentionOverride?
    }

    /// Snapshots captured by the most recent `markAllThreadsSeen()` call,
    /// keyed by thread ID. Consumed by `restoreUnseen(threadIds:)`.
    private var markAllSeenPriorStates: [UUID: MarkAllSeenPriorState] = [:]

    /// Threads that are not archived — used by the UI to populate the sidebar.
    /// Sorted: pinned first (by pinnedOrder ascending), then threads with explicit
    /// displayOrder ascending, then remaining threads by lastInteractedAt descending.
    /// Threads move to the top when messages are sent or received, but NOT when clicked/selected.
    var visibleThreads: [ThreadModel] {
        threads.filter { !$0.isArchived && $0.kind != .private }
            .sorted { visibleThreadSortOrder($0, $1) }
    }

    /// Shared sort predicate for visible threads: pinned first (by pinnedOrder),
    /// then threads with explicit displayOrder, then remaining by recency.
    private func visibleThreadSortOrder(_ a: ThreadModel, _ b: ThreadModel) -> Bool {
        if a.isPinned && b.isPinned {
            return (a.pinnedOrder ?? 0) < (b.pinnedOrder ?? 0)
        }
        if a.isPinned { return true }
        if b.isPinned { return false }
        // Threads without explicit displayOrder (nil) sort by recency and
        // appear ABOVE explicitly-ordered threads so new/active threads are
        // never buried below stale manual ordering.
        if a.displayOrder == nil && b.displayOrder == nil {
            return a.lastInteractedAt > b.lastInteractedAt
        }
        if a.displayOrder == nil { return true }
        if b.displayOrder == nil { return false }
        return a.displayOrder! < b.displayOrder!
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
        if activeThreadId == nil, let draftViewModel {
            return draftViewModel
        }
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
        // Enter draft mode so the window shows an empty chat without a sidebar entry
        enterDraftMode()
        sessionRestorer.delegate = self
        sessionRestorer.startObserving(skipInitialFetch: isFirstLaunch)
    }

    func createThread() {
        // If already in draft mode with an empty draft, no-op
        if draftViewModel != nil, activeThreadId == nil {
            return
        }

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

        // Enter draft mode — thread only appears in sidebar when the user sends
        // their first message (via promoteDraft triggered by onUserMessageSent).
        enterDraftMode()
    }

    /// Ensures an active thread exists, selecting or creating one if needed.
    ///
    /// Selection priority:
    /// 1. If `preferredSessionId` is provided, select a non-archived thread with that session.
    /// 2. Otherwise, select the first visible thread.
    /// 3. If no threads exist, create a new one.
    ///
    /// Used by `.onAppear` handlers in panel layouts to guarantee a `ChatViewModel`
    /// is available before the chat view renders.
    func ensureActiveThread(preferredSessionId: String? = nil) {
        guard activeViewModel == nil else { return }
        if let sessionId = preferredSessionId,
           let match = threads.first(where: { $0.sessionId == sessionId && !$0.isArchived }) {
            selectThread(id: match.id)
        } else if let first = visibleThreads.first {
            selectThread(id: first.id)
        } else {
            createThread()
        }
    }

    /// Enter draft mode: show an empty chat without creating a sidebar thread.
    /// The thread is only created when the user sends their first message.
    func enterDraftMode() {
        // If already in draft mode with an empty draft, no-op (reuse existing draft)
        if let draftVM = draftViewModel, draftVM.messages.isEmpty, activeThreadId == nil {
            return
        }

        let viewModel = makeViewModel()
        viewModel.isHistoryLoaded = true  // No session yet — nothing to load
        // Promote on any first send (text, attachment, slash command).
        // onUserMessageSent fires for all send types unlike onFirstUserMessage
        // which skips empty text and slash commands.
        viewModel.onUserMessageSent = { [weak self] in
            self?.promoteDraft(fromUserSend: true)
        }
        draftViewModel = viewModel
        activeThreadId = nil
        subscribeToActiveViewModel()
        log.info("Entered draft mode")
    }

    /// Promote the draft view model to a real thread.
    /// - Parameter fromUserSend: true when triggered by a user message send,
    ///   false when triggered by `createThread()` needing a guaranteed `activeThreadId`.
    private func promoteDraft(fromUserSend: Bool) {
        guard let viewModel = draftViewModel else { return }

        let thread = ThreadModel(title: "Untitled")
        let threadId = thread.id
        threads.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        subscribeToInteractionState(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()
        draftViewModel = nil

        // Increment only on actual user sends, not programmatic createThread() calls.
        if fromUserSend {
            completedConversationCount += 1
        }

        // Wire up callbacks now that we have a real thread.
        // onFirstUserMessage is already consumed for user-send promotions
        // (it fires before onUserMessageSent in sendMessage), so only set it
        // for createThread()-triggered promotions where no message was sent yet.
        if !fromUserSend {
            viewModel.onFirstUserMessage = { [weak self] _ in
                self?.completedConversationCount += 1
                // Only set "Untitled" if the user hasn't already renamed this thread.
                if self?.pendingRenames[threadId] == nil {
                    self?.updateThreadTitle(id: threadId, title: "Untitled")
                }
                self?.updateLastInteracted(threadId: threadId)
            }
        }
        viewModel.onUserMessageSent = { [weak self] in
            self?.updateLastInteracted(threadId: threadId)
        }

        activeThreadId = thread.id
        updateLastInteracted(threadId: thread.id)
        log.info("Promoted draft to thread \(thread.id)")
    }

    func createPrivateThread() {
        let thread = ThreadModel(kind: .private)
        let viewModel = makeViewModel()
        viewModel.isHistoryLoaded = true  // No session yet — nothing to load
        let threadId = thread.id
        viewModel.onFirstUserMessage = { [weak self] _ in
            self?.completedConversationCount += 1
            // Only set "Untitled" if the user hasn't already renamed this thread.
            if self?.pendingRenames[threadId] == nil {
                self?.updateThreadTitle(id: threadId, title: "Untitled")
            }
            self?.updateLastInteracted(threadId: threadId)
        }
        threads.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        subscribeToInteractionState(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()
        activeThreadId = thread.id

        // Immediately create a daemon session so the thread is persisted
        // before the user sends any messages.
        viewModel.createSessionIfNeeded(threadType: "private")

        log.info("Created private thread \(thread.id)")
    }

    /// Remove a private (temporary) thread and delete its backend conversation.
    /// Stops any active generation before cleanup.
    func removePrivateThread(id: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == id && $0.kind == .private }) else { return }

        let sessionId = threads[index].sessionId

        // Stop generation and clean up local state
        chatViewModels[id]?.stopGenerating()
        threads.remove(at: index)
        chatViewModels.removeValue(forKey: id)
        unsubscribeAllForThread(id: id)
        vmAccessOrder.removeAll { $0 == id }
        Self.clearRenderCaches()

        // Delete the conversation on the backend (fire-and-forget)
        if let sessionId {
            daemonClient.deleteConversation(sessionId)
        }

        log.info("Removed private thread \(id)")
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
        subscribeToInteractionState(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()

        log.info("Created task run thread \(thread.id) for conversation \(conversationId) (work item \(workItemId))")
    }

    /// Create a visible thread bound to a schedule-created conversation.
    /// Called when the daemon broadcasts `schedule_thread_created` so the user
    /// sees scheduled threads in the sidebar without a full refresh.
    func createScheduleThread(conversationId: String, scheduleJobId: String, title: String) {
        // Avoid creating a duplicate thread if one already exists for this conversation
        if threads.contains(where: { $0.sessionId == conversationId }) {
            return
        }

        var thread = ThreadModel(title: title, sessionId: conversationId)
        thread.scheduleJobId = scheduleJobId
        thread.source = "schedule"
        let viewModel = makeViewModel()
        viewModel.sessionId = conversationId
        viewModel.isHistoryLoaded = true
        viewModel.startMessageLoop()

        threads.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        subscribeToInteractionState(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()

        log.info("Created schedule thread \(thread.id) for conversation \(conversationId) (schedule \(scheduleJobId))")
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
        subscribeToInteractionState(for: thread.id, viewModel: viewModel)
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
        unsubscribeAllForThread(id: id)
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

        // Clear ordering state before archiving so stale is_pinned/display_order
        // values don't affect DB pagination (which sorts by is_pinned DESC).
        // Send the update BEFORE setting isArchived, because sendReorderThreads()
        // only serializes visibleThreads (non-archived).
        let wasPinned = threads[index].isPinned
        let hadOrder = threads[index].displayOrder != nil

        // Batch mutations into a single array write to avoid multiple
        // @Published objectWillChange emissions that can cause SwiftUI
        // ForEach re-entrancy crashes.
        var thread = threads[index]
        thread.isPinned = false
        thread.pinnedOrder = nil
        thread.displayOrder = nil
        thread.isArchived = true
        threads[index] = thread

        if wasPinned {
            recompactPinnedOrders()
        }
        if wasPinned || hadOrder {
            sendReorderThreads()
        }

        if let sessionId = threads[index].sessionId {
            chatViewModels[id]?.stopGenerating()
            var archived = archivedSessionIds
            archived.insert(sessionId)
            archivedSessionIds = archived
            // Session ID already known — safe to release the view model.
            chatViewModels.removeValue(forKey: id)
            unsubscribeAllForThread(id: id)
            vmAccessOrder.removeAll { $0 == id }
        } else if chatViewModels[id]?.messages.contains(where: { $0.role == .user }) != true
                    && chatViewModels[id]?.isBootstrapping != true {
            chatViewModels[id]?.stopGenerating()
            // No session ID, no user messages, and no bootstrap in flight —
            // a session will never be created, so there is nothing to backfill.
            // Clean up immediately.
            chatViewModels.removeValue(forKey: id)
            unsubscribeAllForThread(id: id)
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

        // Compute the next pinnedOrder based on existing pinned threads AND
        // persisted displayOrder values in the incoming batch, so legacy threads
        // (nil displayOrder) don't collide with explicit or already-loaded ones.
        let existingMax = threads.compactMap(\.pinnedOrder).max() ?? -1
        let batchMax = recentSessions
            .filter { $0.isPinned ?? false }
            .compactMap { $0.displayOrder.map { Int($0) } }
            .max() ?? -1
        var nextPinnedOrder = max(existingMax, batchMax) + 1

        for session in recentSessions {
            // If a local thread already exists, merge server pin/order metadata.
            if let existingIdx = threads.firstIndex(where: { $0.sessionId == session.id }) {
                let isPinned = session.isPinned ?? false
                var thread = threads[existingIdx]
                thread.isPinned = isPinned
                thread.pinnedOrder = isPinned ? (session.displayOrder.map { Int($0) } ?? nextPinnedOrder) : nil
                thread.displayOrder = session.displayOrder.map { Int($0) }
                threads[existingIdx] = thread
                mergeAssistantAttention(from: session, intoThreadAt: existingIdx)
                if isPinned && session.displayOrder == nil { nextPinnedOrder += 1 }
                continue
            }

            let isPinned = session.isPinned ?? false
            let effectiveCreatedAt = session.createdAt ?? session.updatedAt
            let thread = ThreadModel(
                title: session.title,
                createdAt: Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAt) / 1000.0),
                sessionId: session.id,
                isArchived: isSessionArchived(session.id),
                isPinned: isPinned,
                pinnedOrder: isPinned ? (session.displayOrder.map { Int($0) } ?? nextPinnedOrder) : nil,
                displayOrder: session.displayOrder.map { Int($0) },
                lastInteractedAt: Date(timeIntervalSince1970: TimeInterval(session.updatedAt) / 1000.0),
                kind: session.threadType == "private" ? .private : .standard,
                source: session.source,
                scheduleJobId: session.scheduleJobId,
                hasUnseenLatestAssistantMessage: session.assistantAttention?.hasUnseenLatestAssistantMessage ?? false,
                latestAssistantMessageAt: session.assistantAttention?.latestAssistantMessageAt.map {
                    Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
                },
                lastSeenAssistantMessageAt: session.assistantAttention?.lastSeenAssistantMessageAt.map {
                    Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
                }
            )
            if isPinned && session.displayOrder == nil { nextPinnedOrder += 1 }
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

        removeAbandonedEmptyThread(switching: id)

        let previousActiveId = activeThreadId
        trimPreviousThreadIfNeeded(nextThreadId: id)

        // Re-create the ViewModel if it was LRU-evicted.
        if chatViewModels[id] == nil {
            let viewModel = makeViewModel()
            viewModel.sessionId = thread.sessionId
            chatViewModels[id] = viewModel
            subscribeToBusyState(for: id, viewModel: viewModel)
            subscribeToAssistantActivity(for: id, viewModel: viewModel)
            subscribeToInteractionState(for: id, viewModel: viewModel)
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
        if id != previousActiveId {
            markConversationSeen(threadId: id)
        }
    }

    /// Select a thread by its daemon conversation ID (sessionId).
    /// Returns `true` if a matching thread was found and selected, `false` otherwise.
    @discardableResult
    func selectThreadBySessionId(_ sessionId: String) -> Bool {
        guard let thread = threads.first(where: { $0.sessionId == sessionId }) else { return false }
        selectThread(id: thread.id)
        return true
    }

    /// Select a thread by session ID, fetching it on-demand from the server if not locally available.
    /// Returns `true` if the thread was found (or fetched) and selected, `false` on failure.
    func selectThreadBySessionIdAsync(_ sessionId: String) async -> Bool {
        // Fast path: already loaded locally
        if selectThreadBySessionId(sessionId) {
            return true
        }

        // Slow path: fetch the conversation from the daemon and insert it locally
        guard let session = await daemonClient.fetchConversationById(sessionId) else {
            return false
        }

        // Re-check after await — another code path (e.g. SSE session-list response)
        // may have inserted this thread while we were waiting on the network.
        if selectThreadBySessionId(sessionId) {
            return true
        }

        // Don't insert external-channel or private threads into the main sidebar
        if session.threadType == "private" || session.channelBinding?.sourceChannel != nil {
            return false
        }

        let effectiveCreatedAt = session.createdAt ?? session.updatedAt
        let thread = ThreadModel(
            title: session.title,
            createdAt: Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAt) / 1000.0),
            sessionId: session.id,
            isPinned: session.isPinned ?? false,
            pinnedOrder: (session.isPinned ?? false) ? session.displayOrder.map { Int($0) } : nil,
            displayOrder: session.displayOrder.map { Int($0) },
            lastInteractedAt: Date(timeIntervalSince1970: TimeInterval(session.updatedAt) / 1000.0),
            kind: .standard,
            source: session.source,
            scheduleJobId: session.scheduleJobId,
            hasUnseenLatestAssistantMessage: session.assistantAttention?.hasUnseenLatestAssistantMessage ?? false,
            latestAssistantMessageAt: session.assistantAttention?.latestAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            },
            lastSeenAssistantMessageAt: session.assistantAttention?.lastSeenAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
        )

        let viewModel = makeViewModel()
        viewModel.sessionId = session.id
        // Leave isHistoryLoaded false so history is fetched when the thread activates
        viewModel.startMessageLoop()

        threads.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        subscribeToInteractionState(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()

        selectThread(id: thread.id)
        return true
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
        var thread = threads[index]
        thread.isPinned = true
        thread.pinnedOrder = nextOrder
        threads[index] = thread
        sendReorderThreads()
    }

    func unpinThread(id: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }
        var thread = threads[index]
        thread.isPinned = false
        thread.pinnedOrder = nil
        thread.displayOrder = nil
        threads[index] = thread
        recompactPinnedOrders()
        sendReorderThreads()
    }

    func reorderPinnedThreads(from source: IndexSet, to destination: Int) {
        var pinned = visibleThreads.filter(\.isPinned)
        pinned.move(fromOffsets: source, toOffset: destination)
        var draft = threads
        for (order, item) in pinned.enumerated() {
            if let idx = draft.firstIndex(where: { $0.id == item.id }) {
                draft[idx].pinnedOrder = order
            }
        }
        threads = draft
        sendReorderThreads()
    }

    func updateLastInteracted(threadId: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == threadId }) else { return }
        var thread = threads[index]
        thread.lastInteractedAt = Date()
        // Clear explicit displayOrder so the thread reverts to recency-based sorting.
        // This ensures actively-used threads float to the top naturally and new threads
        // aren't permanently stuck below explicitly-ordered threads.
        let hadOrder = thread.displayOrder != nil
        if hadOrder {
            thread.displayOrder = nil
        }
        threads[index] = thread
        if hadOrder {
            sendReorderThreads()
        }
    }

    /// Move a thread to a new position in the visible list (for drag-and-drop reorder).
    /// Works for any thread: pinned-to-pinned reorders among pinned items,
    /// unpinned-to-pinned pins the source, and unpinned-to-unpinned reorders
    /// using displayOrder. When the target is a schedule thread, the source is
    /// inserted at the end of the unpinned regular threads list (the boundary
    /// between regular and scheduled threads).
    ///
    /// Only assigns displayOrder to the dragged thread and threads that already
    /// had an explicit displayOrder. Threads without explicit ordering (sorted
    /// by recency) keep nil displayOrder so new threads continue to appear at top.
    @discardableResult
    func moveThread(sourceId: UUID, targetId: UUID) -> Bool {
        guard let sourceIdx = threads.firstIndex(where: { $0.id == sourceId }),
              let targetIdx = threads.firstIndex(where: { $0.id == targetId }) else { return false }
        let targetThread = threads[targetIdx]

        // Work on a local copy to batch all mutations into a single
        // @Published write, preventing SwiftUI ForEach re-entrancy crashes.
        var draft = threads

        if targetThread.isPinned {
            // Dropping onto a pinned thread — pin the source if needed and reorder
            let sourceWasPinned = draft[sourceIdx].isPinned
            if !sourceWasPinned {
                draft[sourceIdx].isPinned = true
            }
            let targetOrder = targetThread.pinnedOrder ?? 0
            let sourceOrder = sourceWasPinned ? (draft[sourceIdx].pinnedOrder ?? Int.max) : Int.max

            // Direction-aware: if source is above target (lower order), insert after target
            let insertOrder = sourceOrder < targetOrder ? targetOrder + 1 : targetOrder

            draft[sourceIdx].pinnedOrder = insertOrder
            for i in draft.indices where draft[i].isPinned && draft[i].id != sourceId {
                if let order = draft[i].pinnedOrder, order >= insertOrder {
                    draft[i].pinnedOrder = order + 1
                }
            }
            recompactPinnedOrders(in: &draft)
        } else {
            // Dropping onto an unpinned thread — reorder using displayOrder.
            // Capture pinned state BEFORE modifications so direction detection
            // isn't affected by the unpin changing the source's list position.
            let sourceWasPinned = draft[sourceIdx].isPinned

            if sourceWasPinned {
                draft[sourceIdx].isPinned = false
                draft[sourceIdx].pinnedOrder = nil
                draft[sourceIdx].displayOrder = nil
                recompactPinnedOrders(in: &draft)
            }

            // Build the unpinned list in sidebar display order: regular threads first,
            // then schedule threads. This matches the UI sections and prevents dropping
            // onto a schedule thread from inserting the source among regular threads
            // at the wrong position.
            let visible = draft.filter { !$0.isArchived && $0.kind != .private }
                .sorted { visibleThreadSortOrder($0, $1) }
            let allUnpinned = visible.filter { !$0.isPinned }
            let regularUnpinned = allUnpinned.filter { !$0.isScheduleThread }
            let scheduleUnpinned = allUnpinned.filter { $0.isScheduleThread }
            let unpinned = regularUnpinned + scheduleUnpinned

            var reordered = unpinned.filter { $0.id != sourceId }

            let insertPos: Int
            let sourceThread = draft[sourceIdx]
            if targetThread.isScheduleThread && !sourceThread.isScheduleThread {
                // Cross-section drag: insert at section boundary
                insertPos = reordered.firstIndex(where: { $0.isScheduleThread }) ?? reordered.endIndex
            } else {
                // Direction-aware: if source was visually above target (dragging down),
                // insert AFTER target; if below (dragging up), insert BEFORE target.
                // Pinned threads are always visually above unpinned ones, so a
                // pinned→unpinned drag is always "dragging down".
                let draggingDown: Bool
                if sourceWasPinned {
                    draggingDown = true
                } else {
                    let sourceVisualIdx = unpinned.firstIndex(where: { $0.id == sourceId })
                    let targetVisualIdx = unpinned.firstIndex(where: { $0.id == targetId })
                    draggingDown = (sourceVisualIdx ?? 0) < (targetVisualIdx ?? 0)
                }

                if draggingDown {
                    let targetInFiltered = reordered.firstIndex(where: { $0.id == targetId }) ?? reordered.endIndex
                    insertPos = min(targetInFiltered + 1, reordered.endIndex)
                } else {
                    insertPos = reordered.firstIndex(where: { $0.id == targetId }) ?? reordered.endIndex
                }
            }

            if let movedThread = unpinned.first(where: { $0.id == sourceId }) ?? [draft[sourceIdx]].first {
                reordered.insert(movedThread, at: insertPos)
            }

            // Assign displayOrder to ALL threads in the reordered list. When a
            // user drags a thread they are explicitly defining an ordering, so every
            // thread in the affected section needs a concrete displayOrder. Without
            // this, dragging between recency-sorted threads (nil displayOrder) would
            // only assign an order to the source, causing it to jump to the top of
            // the list since visibleThreads sorts non-nil displayOrder above nil.
            for (order, item) in reordered.enumerated() {
                if let idx = draft.firstIndex(where: { $0.id == item.id }) {
                    draft[idx].displayOrder = order
                }
            }
        }

        // Single write — triggers objectWillChange exactly once.
        threads = draft
        sendReorderThreads()
        return true
    }

    /// Recompact pinned orders in the given draft array (no @Published writes).
    private func recompactPinnedOrders(in draft: inout [ThreadModel]) {
        let pinned = draft.enumerated()
            .filter { $0.element.isPinned }
            .sorted { ($0.element.pinnedOrder ?? 0) < ($1.element.pinnedOrder ?? 0) }
        for (order, item) in pinned.enumerated() {
            draft[item.offset].pinnedOrder = order
        }
    }

    private func recompactPinnedOrders() {
        var draft = threads
        recompactPinnedOrders(in: &draft)
        threads = draft
    }

    /// Send the current thread ordering to the daemon so it persists across restarts.
    /// For pinned threads, derives a deterministic displayOrder from pinnedOrder so
    /// the pinned ordering survives restarts. For unpinned threads that have been
    /// explicitly reordered (non-nil displayOrder), sends their displayOrder. For
    /// unpinned threads without explicit ordering, sends nil so they sort by recency.
    private func sendReorderThreads() {
        let visible = visibleThreads
        var updates: [ReorderThreadsRequestUpdate] = []
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
            updates.append(ReorderThreadsRequestUpdate(
                sessionId: sessionId,
                displayOrder: order,
                isPinned: thread.isPinned
            ))
        }
        guard !updates.isEmpty else { return }
        do {
            try daemonClient.send(ReorderThreadsRequest(
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
        subscribeToInteractionState(for: threadId, viewModel: vm)
        touchVMAccessOrder(threadId)
        evictStaleCachedViewModels()
        // Re-subscribe if this is the active view model
        if threadId == activeThreadId {
            subscribeToActiveViewModel()
        }
    }

    func removeChatViewModel(for threadId: UUID) {
        chatViewModels.removeValue(forKey: threadId)
        unsubscribeAllForThread(id: threadId)
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

    /// Rename a thread and send the rename to the daemon.
    /// If the thread doesn't have a sessionId yet, the rename is queued
    /// and flushed when backfillSessionId is called.
    func renameThread(id: UUID, title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }
        threads[index].title = trimmed
        if let sessionId = threads[index].sessionId {
            try? daemonClient.send(SessionRenameRequest(
                type: "session_rename",
                sessionId: sessionId,
                title: trimmed
            ))
        } else {
            pendingRenames[id] = trimmed
        }
    }

    func makeViewModel() -> ChatViewModel {
        let viewModel = ChatViewModel(daemonClient: daemonClient)
        viewModel.onToolCallsComplete = { [weak self, weak viewModel] toolCalls in
            guard let self, let service = self.activityNotificationService else { return }
            let sessionId = viewModel?.sessionId ?? ""
            // Pass empty summary so ActivityNotificationService derives the title
            // from the tool calls themselves (friendly name + target for single tool,
            // count-based for multiple tools)
            let summary = ""
            Task { @MainActor in
                await service.notifySessionComplete(
                    summary: summary,
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
        if !isRestoringThreads, id != previousActiveId {
            markConversationSeen(threadId: id)
        }
    }

    /// If the active thread has an unseen assistant message, mark it as seen.
    /// Called when the app becomes active (e.g. user clicks the menu bar icon
    /// or switches back to the app) so that a pre-selected unread thread is
    /// marked seen without requiring a thread switch.
    func markActiveThreadSeenIfNeeded() {
        guard NSApp.isActive,
              !isRestoringThreads,
              let activeId = activeThreadId,
              let idx = threads.firstIndex(where: { $0.id == activeId }),
              threads[idx].hasUnseenLatestAssistantMessage else { return }
        markConversationSeen(threadId: activeId)
    }

    /// Clear the local unseen flag and notify the daemon that the conversation
    /// has been seen. Use this from call-sites that bypass `selectThread` (e.g.
    /// deep-link navigation in `openConversationThread`) where the `id != previousActiveId`
    /// guard would skip the signal.
    internal func markConversationSeen(threadId: UUID) {
        guard let idx = threads.firstIndex(where: { $0.id == threadId }) else { return }
        // If the thread has a pending .unread override, opening the thread clears it
        // so the normal seen flow proceeds rather than leaving the thread stuck as unread.
        if let sessionId = threads[idx].sessionId,
           case .unread = pendingAttentionOverrides[sessionId] {
            pendingAttentionOverrides.removeValue(forKey: sessionId)
        }
        var thread = threads[idx]
        thread.hasUnseenLatestAssistantMessage = false
        if let sessionId = thread.sessionId {
            pendingAttentionOverrides[sessionId] = .seen(
                latestAssistantMessageAt: thread.latestAssistantMessageAt
            )
            thread.lastSeenAssistantMessageAt = thread.latestAssistantMessageAt
            threads[idx] = thread
            emitConversationSeenSignal(conversationId: sessionId)
        } else {
            threads[idx] = thread
        }
    }

    internal func markConversationUnread(threadId: UUID) {
        guard let idx = threads.firstIndex(where: { $0.id == threadId }),
              let sessionId = threads[idx].sessionId,
              canMarkConversationUnread(threadId: threadId, at: idx) else { return }

        let latestAssistantMessageAt = threads[idx].latestAssistantMessageAt

        let previousLastSeenAssistantMessageAt = threads[idx].lastSeenAssistantMessageAt
        let previousOverride = pendingAttentionOverrides[sessionId]
        let wasPendingSeen = pendingSeenSessionIds.contains(sessionId)

        pendingSeenSessionIds.removeAll { $0 == sessionId }
        pendingAttentionOverrides[sessionId] = .unread(
            latestAssistantMessageAt: latestAssistantMessageAt
        )
        var thread = threads[idx]
        thread.hasUnseenLatestAssistantMessage = true
        thread.lastSeenAssistantMessageAt = nil
        threads[idx] = thread
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.emitConversationUnreadSignal(conversationId: sessionId)
            } catch {
                self.rollbackUnreadMutationIfNeeded(
                    threadId: threadId,
                    sessionId: sessionId,
                    latestAssistantMessageAt: latestAssistantMessageAt,
                    previousLastSeenAssistantMessageAt: previousLastSeenAssistantMessageAt,
                    previousOverride: previousOverride,
                    wasPendingSeen: wasPendingSeen
                )
                log.warning("Failed to send conversation_unread_signal for \(sessionId): \(error.localizedDescription)")
            }
        }
    }

    /// Set a pending anchor message for scroll-to behavior on notification deep links.
    /// Only takes effect when the specified thread is currently active.
    func setPendingAnchorMessage(threadId: UUID, messageId: UUID) {
        guard activeThreadId == threadId else { return }
        pendingAnchorMessageId = messageId
        pendingAnchorThreadId = threadId
    }

    /// Mark all visible (non-archived, non-private) threads as seen locally.
    /// Seen signals are NOT sent immediately — call `commitPendingSeenSignals()`
    /// after the undo window expires, or `cancelPendingSeenSignals()` if the
    /// user clicks Undo. Returns the IDs of threads that were actually marked.
    @discardableResult
    internal func markAllThreadsSeen() -> [UUID] {
        // Commit (not cancel) any already-pending signals so a second
        // mark-all invocation doesn't silently drop the first batch.
        commitPendingSeenSignals()
        var markedIds: [UUID] = []
        var sessionIds: [String] = []
        var priorStates: [UUID: MarkAllSeenPriorState] = [:]
        for idx in threads.indices {
            guard !threads[idx].isArchived,
                  threads[idx].kind != .private,
                  threads[idx].hasUnseenLatestAssistantMessage else { continue }
            let threadId = threads[idx].id
            let sessionId = threads[idx].sessionId
            // Capture prior state before overwriting
            priorStates[threadId] = MarkAllSeenPriorState(
                lastSeenAssistantMessageAt: threads[idx].lastSeenAssistantMessageAt,
                sessionId: sessionId,
                override: sessionId.flatMap { pendingAttentionOverrides[$0] }
            )
            threads[idx].hasUnseenLatestAssistantMessage = false
            markedIds.append(threadId)
            if let sessionId {
                sessionIds.append(sessionId)
                pendingAttentionOverrides[sessionId] = .seen(
                    latestAssistantMessageAt: threads[idx].latestAssistantMessageAt
                )
                threads[idx].lastSeenAssistantMessageAt = threads[idx].latestAssistantMessageAt
            }
        }
        markAllSeenPriorStates = priorStates
        if !sessionIds.isEmpty {
            pendingSeenSessionIds = sessionIds
        }
        return markedIds
    }

    /// Send the deferred seen signals that were collected by
    /// `markAllThreadsSeen()`. Called when the undo window expires
    /// (toast dismissed or auto-dismiss timer fires).
    internal func commitPendingSeenSignals() {
        let sessionIds = pendingSeenSessionIds
        pendingSeenSessionIds = []
        markAllSeenPriorStates = [:]
        pendingSeenSignalTask?.cancel()
        pendingSeenSignalTask = nil
        for sessionId in sessionIds {
            emitConversationSeenSignal(conversationId: sessionId)
        }
    }

    /// Cancel any pending seen signals (user clicked Undo).
    internal func cancelPendingSeenSignals() {
        pendingSeenSessionIds = []
        pendingSeenSignalTask?.cancel()
        pendingSeenSignalTask = nil
    }

    /// Schedule deferred seen signals to fire after a delay.
    /// If the user clicks Undo before the delay, call
    /// `cancelPendingSeenSignals()` to prevent them from sending.
    /// The optional `onCommit` closure is called after the signals are sent,
    /// allowing callers to dismiss the undo toast when the window expires.
    internal func schedulePendingSeenSignals(delay: TimeInterval = 5.0, onCommit: (() -> Void)? = nil) {
        pendingSeenSignalTask?.cancel()
        pendingSeenSignalTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.commitPendingSeenSignals()
            onCommit?()
        }
    }

    /// Restore the unseen flag for the given thread IDs and cancel any
    /// pending seen signals (used by undo). Restores prior
    /// `lastSeenAssistantMessageAt` and `pendingAttentionOverrides`
    /// values captured by `markAllThreadsSeen()` instead of blindly
    /// clearing them.
    internal func restoreUnseen(threadIds: [UUID]) {
        cancelPendingSeenSignals()
        let priorStates = markAllSeenPriorStates
        markAllSeenPriorStates = [:]
        for id in threadIds {
            if let idx = threads.firstIndex(where: { $0.id == id }) {
                threads[idx].hasUnseenLatestAssistantMessage = true
                if let prior = priorStates[id] {
                    threads[idx].lastSeenAssistantMessageAt = prior.lastSeenAssistantMessageAt
                    if let sessionId = prior.sessionId {
                        // Only restore the override if the current override is
                        // still the .seen that markAllThreadsSeen() installed.
                        // If the user changed it (e.g. marked unread during
                        // the undo window), keep the newer override.
                        if let currentOverride = pendingAttentionOverrides[sessionId],
                           case .seen = currentOverride {
                            if let previousOverride = prior.override {
                                pendingAttentionOverrides[sessionId] = previousOverride
                            } else {
                                pendingAttentionOverrides.removeValue(forKey: sessionId)
                            }
                        }
                    }
                } else {
                    // Fallback: no prior state captured (shouldn't happen in
                    // normal flow), clear conservatively.
                    threads[idx].lastSeenAssistantMessageAt = nil
                    if let sessionId = threads[idx].sessionId {
                        pendingAttentionOverrides.removeValue(forKey: sessionId)
                    }
                }
            }
        }
    }

    // MARK: - Private

    /// Send a `conversation_seen_signal` message to the daemon.
    private func emitConversationSeenSignal(conversationId: String) {
        let signal = ConversationSeenSignal(
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

    private func emitConversationUnreadSignal(conversationId: String) async throws {
        let signal = ConversationUnreadSignal(
            conversationId: conversationId,
            sourceChannel: "vellum",
            signalType: "macos_conversation_opened",
            confidence: "explicit",
            source: "ui-navigation",
            evidenceText: "User selected Mark as unread"
        )
        try await daemonClient.sendConversationUnread(signal)
    }

    private func rollbackUnreadMutationIfNeeded(
        threadId: UUID,
        sessionId: String,
        latestAssistantMessageAt: Date?,
        previousLastSeenAssistantMessageAt: Date?,
        previousOverride: PendingAttentionOverride?,
        wasPendingSeen: Bool = false
    ) {
        guard let idx = threads.firstIndex(where: { $0.id == threadId }),
              threads[idx].sessionId == sessionId,
              case .unread(let pendingLatestAssistantMessageAt) = pendingAttentionOverrides[sessionId],
              pendingLatestAssistantMessageAt == latestAssistantMessageAt else { return }

        if let previousOverride {
            pendingAttentionOverrides[sessionId] = previousOverride
        } else {
            pendingAttentionOverrides.removeValue(forKey: sessionId)
        }
        threads[idx].hasUnseenLatestAssistantMessage = false
        threads[idx].lastSeenAssistantMessageAt = previousLastSeenAssistantMessageAt

        if wasPendingSeen && !pendingSeenSessionIds.contains(sessionId) {
            pendingSeenSessionIds.append(sessionId)
            if pendingSeenSignalTask == nil {
                schedulePendingSeenSignals()
            }
        }
    }

    /// Remove the currently active thread if it was never used (no messages,
    /// no persisted session, not private). Prevents abandoned empty threads
    /// from accumulating in the sidebar.
    /// - Parameter switching: The thread ID being switched to. Pass `nil`
    ///   when called from `createThread()` (the active thread is checked
    ///   separately by the reuse guard above).
    private func removeAbandonedEmptyThread(switching nextId: UUID? = nil) {
        guard let previousId = activeThreadId,
              previousId != nextId,
              let vm = chatViewModels[previousId],
              vm.messages.isEmpty else { return }
        let thread = threads.first(where: { $0.id == previousId })
        guard thread?.kind != .private, thread?.sessionId == nil else { return }
        threads.removeAll { $0.id == previousId }
        chatViewModels.removeValue(forKey: previousId)
        unsubscribeAllForThread(id: previousId)
        vmAccessOrder.removeAll { $0 == previousId }
        log.info("Removed abandoned empty thread \(previousId)")
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
            unsubscribeAllForThread(id: threadId)
            vmAccessOrder.removeAll { $0 == threadId }
        }
        // Re-send ordering now that this thread has a session ID.
        // Any drag/pin actions performed before the daemon assigned
        // a session would have been skipped by sendReorderThreads()
        // because it filters out threads without a sessionId.
        sendReorderThreads()
        // Flush any rename that was queued before the session ID was assigned.
        if let pendingTitle = pendingRenames.removeValue(forKey: threadId) {
            try? daemonClient.send(SessionRenameRequest(
                type: "session_rename",
                sessionId: sessionId,
                title: pendingTitle
            ))
        }
    }

    func mergeAssistantAttention(
        from session: SessionListResponseSession,
        intoThreadAt index: Int
    ) {
        threads[index].hasUnseenLatestAssistantMessage =
            session.assistantAttention?.hasUnseenLatestAssistantMessage ?? false
        threads[index].latestAssistantMessageAt =
            session.assistantAttention?.latestAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
        threads[index].lastSeenAssistantMessageAt =
            session.assistantAttention?.lastSeenAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }

        guard let sessionId = threads[index].sessionId,
              let override = pendingAttentionOverrides[sessionId] else { return }

        switch override {
        case .seen(let targetLatestAssistantMessageAt):
            if !threads[index].hasUnseenLatestAssistantMessage {
                pendingAttentionOverrides.removeValue(forKey: sessionId)
                return
            }
            // When target is nil (e.g. notification-created thread before history loads),
            // drop the override if the server reports unseen — the server has newer info.
            if targetLatestAssistantMessageAt == nil {
                pendingAttentionOverrides.removeValue(forKey: sessionId)
                return
            }
            if let targetLatestAssistantMessageAt,
               let serverLatestAssistantMessageAt = threads[index].latestAssistantMessageAt,
               serverLatestAssistantMessageAt > targetLatestAssistantMessageAt {
                pendingAttentionOverrides.removeValue(forKey: sessionId)
                return
            }

            if let targetLatestAssistantMessageAt,
               threads[index].latestAssistantMessageAt == nil {
                threads[index].latestAssistantMessageAt = targetLatestAssistantMessageAt
            }
            threads[index].hasUnseenLatestAssistantMessage = false
            threads[index].lastSeenAssistantMessageAt =
                threads[index].latestAssistantMessageAt

        case .unread(let targetLatestAssistantMessageAt):
            if threads[index].hasUnseenLatestAssistantMessage {
                pendingAttentionOverrides.removeValue(forKey: sessionId)
                return
            }
            if let targetLatestAssistantMessageAt,
               let serverLatestAssistantMessageAt = threads[index].latestAssistantMessageAt,
               serverLatestAssistantMessageAt > targetLatestAssistantMessageAt {
                pendingAttentionOverrides.removeValue(forKey: sessionId)
                return
            }

            if let targetLatestAssistantMessageAt,
               threads[index].latestAssistantMessageAt == nil {
                threads[index].latestAssistantMessageAt = targetLatestAssistantMessageAt
            }
            threads[index].hasUnseenLatestAssistantMessage = true
            threads[index].lastSeenAssistantMessageAt = nil
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
        subscribeToInteractionState(for: threadId, viewModel: viewModel)
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
        // After restoration finishes, re-run the active-thread seen check.
        // The didBecomeActive notification may have fired while isRestoringThreads
        // was true, causing markActiveThreadSeenIfNeeded() to no-op. Deferring
        // ensures the check runs once restoration is complete.
        defer { markActiveThreadSeenIfNeeded() }

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

    /// Remove busy-state and interaction-state subscriptions for a thread.
    ///
    /// Does NOT clear `threadInteractionStates` — the last known interaction
    /// state is preserved so that evicted (but still visible) threads continue
    /// showing the correct sidebar cue.  Callers that permanently remove a
    /// thread (close / archive) should use `unsubscribeAllForThread(id:)` instead.
    private func unsubscribeFromBusyState(for threadId: UUID) {
        busyStateCancellables.removeValue(forKey: threadId)
        assistantActivityCancellables[threadId]?.cancel()
        assistantActivityCancellables.removeValue(forKey: threadId)
        latestAssistantActivitySnapshots.removeValue(forKey: threadId)
        busyThreadIds.remove(threadId)
        interactionStateCancellables.removeValue(forKey: threadId)
    }

    /// Atomically cancel all per-thread subscriptions and remove cached state
    /// for a thread that is being permanently removed (closed, archived, or
    /// session-backfilled-then-discarded). Unlike `unsubscribeFromBusyState`,
    /// this also clears `threadInteractionStates` so stale sidebar cues don't linger.
    private func unsubscribeAllForThread(id: UUID) {
        busyStateCancellables[id] = nil
        assistantActivityCancellables[id]?.cancel()
        assistantActivityCancellables[id] = nil
        latestAssistantActivitySnapshots.removeValue(forKey: id)
        busyThreadIds.remove(id)
        interactionStateCancellables[id] = nil
        threadInteractionStates.removeValue(forKey: id)
    }

    // MARK: - Interaction State

    /// Returns the derived interaction state for a thread, defaulting to `.idle`.
    func interactionState(for threadId: UUID) -> ThreadInteractionState {
        threadInteractionStates[threadId] ?? .idle
    }

    /// Subscribe to interaction-state–relevant publishers on a ChatViewModel so
    /// `threadInteractionStates` stays current.
    ///
    /// Derives state with priority: error > waitingForInput > processing > idle.
    func subscribeToInteractionState(for threadId: UUID, viewModel: ChatViewModel) {
        interactionStateCancellables.removeValue(forKey: threadId)
        var subs = Set<AnyCancellable>()

        let msgMgr = viewModel.messageManager
        let errMgr = viewModel.errorManager

        // Combine busy-state publishers with error and message publishers.
        // Error state: errorText or sessionError non-nil.
        // WaitingForInput: hasPendingConfirmation (derived from messages).
        // Processing: isSending || isThinking || pendingQueuedCount > 0.
        Publishers.CombineLatest4(
            msgMgr.$isSending,
            msgMgr.$isThinking,
            msgMgr.$pendingQueuedCount,
            msgMgr.$messages
        )
        .combineLatest(
            errMgr.$errorText,
            errMgr.$sessionError
        )
        .map { busyTuple, errorText, sessionError in
            let (isSending, isThinking, pendingQueuedCount, messages) = busyTuple
            let hasError = errorText != nil || sessionError != nil
            let hasPendingConfirmation = messages.contains(where: { $0.confirmation?.state == .pending })
            let isBusy = isSending || isThinking || pendingQueuedCount > 0

            if hasError {
                return ThreadInteractionState.error
            } else if hasPendingConfirmation {
                return ThreadInteractionState.waitingForInput
            } else if isBusy {
                return ThreadInteractionState.processing
            } else {
                return ThreadInteractionState.idle
            }
        }
        .removeDuplicates()
        .sink { [weak self] state in
            guard let self else { return }
            if state == .idle {
                self.threadInteractionStates.removeValue(forKey: threadId)
            } else {
                self.threadInteractionStates[threadId] = state
            }
        }
        .store(in: &subs)

        interactionStateCancellables[threadId] = subs
    }

    /// Subscribe to the active ChatViewModel's messages publisher.
    /// Updates activeMessageCount so only views that depend on the message count
    /// re-render, preventing full-tree invalidation on every streaming token.
    private func subscribeToActiveViewModel() {
        // Cancel previous subscription
        activeViewModelCancellable?.cancel()
        activeViewModelCancellable = nil
        // Reset so views don't show a stale count while the new thread loads.
        activeMessageCount = 0

        // Subscribe to the new active view model if one exists
        guard let viewModel = activeViewModel else { return }

        activeViewModelCancellable = viewModel.messageManager.$messages
            .map { $0.count }
            .removeDuplicates()
            .sink { [weak self] count in
                self?.activeMessageCount = count
            }
    }

    /// Mark assistant activity on a thread as seen/unseen depending on whether
    /// that thread is currently active.
    ///
    /// For the active thread, the seen signal is only emitted on meaningful
    /// transitions — when a new assistant message first appears (new messageId)
    /// or when streaming completes (isStreaming goes from true to false). This
    /// avoids O(n) HTTP calls per streaming response (one per text delta) while
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
        let isNewMessage = previousSnapshot?.messageId != currentSnapshot.messageId
        // Keep the local attention timestamp current for live assistant replies
        // so unread eligibility survives until the next session-list refresh.
        if threads[index].latestAssistantMessageAt == nil || isNewMessage {
            threads[index].latestAssistantMessageAt = Date()
        }
        if threadId == activeThreadId {
            threads[index].hasUnseenLatestAssistantMessage = false
            // Only emit the seen signal on meaningful transitions:
            // 1. A new assistant message appeared (different messageId)
            // 2. Streaming just completed (isStreaming went true -> false)
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

    private func canMarkConversationUnread(threadId: UUID, at threadIndex: Int) -> Bool {
        guard threads[threadIndex].sessionId != nil,
              !threads[threadIndex].hasUnseenLatestAssistantMessage else { return false }
        // Live assistant replies update the in-memory activity snapshot before
        // session-list hydration backfills latestAssistantMessageAt.
        return threads[threadIndex].latestAssistantMessageAt != nil
            || latestAssistantActivitySnapshots[threadId] != nil
    }
}
