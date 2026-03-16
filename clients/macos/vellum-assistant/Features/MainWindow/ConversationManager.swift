import SwiftUI
import VellumAssistantShared
import Foundation
import UserNotifications
import os
import Combine

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ConversationManager")
private let archivedSessionsKey = "archivedConversationIds"

// MARK: - Conversation Client Protocol

/// Abstraction for fetching individual conversations, decoupled from DaemonClient.
@MainActor
protocol ConversationClientProtocol {
    func fetchConversationById(_ conversationId: String) async -> ConversationsListResponse.Conversation?
    func deleteConversation(_ conversationId: String) async
}

/// Fetches conversation data via GatewayHTTPClient.
@MainActor
struct ConversationClient: ConversationClientProtocol {
    nonisolated init() {}

    func fetchConversationById(_ conversationId: String) async -> ConversationsListResponse.Conversation? {
        let result: (SingleConversationResponse?, GatewayHTTPClient.Response)? = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/conversations/\(conversationId)", timeout: 10
        )
        return result?.0?.conversation
    }

    func deleteConversation(_ conversationId: String) async {
        let response = try? await GatewayHTTPClient.delete(
            path: "assistants/{assistantId}/conversations/\(conversationId)", timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Delete conversation \(conversationId) failed (HTTP \(statusCode))")
        }
    }
}

@MainActor
final class ConversationManager: ObservableObject, ConversationRestorerDelegate {
    @AppStorage("restoreRecentThreads") private(set) var restoreRecentConversations = true
    @AppStorage("lastActiveThreadId") private var lastActiveConversationIdString: String?
    @AppStorage("completedConversationCount") private var completedConversationCount: Int = 0
    @Published var conversations: [ConversationModel] = []
    @Published var hasMoreConversations: Bool = false
    @Published var isLoadingMoreConversations: Bool = false
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
    @Published var activeConversationId: UUID? {
        didSet {
            if let activeConversationId {
                // Switching to a real thread discards any draft
                draftViewModel = nil

                let activeViewModel = getOrCreateViewModel(for: activeConversationId)
                activeViewModel?.ensureMessageLoopStarted()
                conversationRestorer.loadHistoryIfNeeded(threadId: activeConversationId)
                // Only persist the active thread ID if we're not in the middle of restoration.
                // During init and session restoration, the didSet fires multiple times and would
                // overwrite the saved value before restoreLastActiveConversation() reads it.
                if !isRestoringConversations {
                    lastActiveConversationIdString = activeConversationId.uuidString
                }
                // Notify the daemon so it rebinds the socket to this thread's session.
                // Without this, socketToSession stays stale after thread switches,
                // causing ownership checks (e.g. subagent abort) to fail.
                if let conversationId = activeViewModel?.conversationId {
                    do {
                        try daemonClient.send(ConversationSwitchRequest(conversationId: conversationId))
                    } catch {
                        log.error("Failed to send session switch request: \(error)")
                    }
                }
            } else {
                // Only clear the persisted thread ID outside of restoration.
                // During init, enterDraftMode() sets activeConversationId = nil before
                // restoreLastActiveConversation() reads the saved value.
                if !isRestoringConversations {
                    lastActiveConversationIdString = nil
                }
            }
            // Clear stale anchor when switching away from the thread that
            // owns it — prevents the anchor from suppressing scroll-to-bottom
            // on unrelated thread switches.
            if let anchorThread = pendingAnchorConversationId, anchorThread != activeConversationId {
                pendingAnchorMessageId = nil
                pendingAnchorConversationId = nil
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
    private let conversationClient: ConversationClientProtocol
    private let conversationRestorer: ConversationRestorer
    private let activityNotificationService: ActivityNotificationService?
    /// Queued renames for conversations that don't yet have a conversationId.
    /// Flushed in backfillConversationId when the daemon assigns a session.
    private var pendingRenames: [UUID: String] = [:]
    /// Flag to suppress lastActiveConversationIdString writes during initialization and session restoration.
    private var isRestoringConversations = false
    /// Subscription to activeViewModel's messages count changes.
    /// Drives activeMessageCount so only message-count-dependent views re-render,
    /// not the entire window tree.
    private var activeViewModelCancellable: AnyCancellable?
    /// Tracks the message count of the active thread's view model.
    /// SwiftUI views that need to react to new messages should observe this
    /// instead of subscribing to ConversationManager.objectWillChange, which fires
    /// for every property change and causes full-tree re-renders.
    @Published public private(set) var activeMessageCount: Int = 0
    /// Subscriptions to per-thread busy-state changes (isSending, isThinking, pendingQueuedCount).
    private var busyStateCancellables: [UUID: Set<AnyCancellable>] = [:]
    /// Subscription to assistant activity per thread.
    /// Used to mark inactive conversations as unseen when assistant output changes.
    private var assistantActivityCancellables: [UUID: AnyCancellable] = [:]
    /// Last observed assistant activity snapshot per thread.
    private var latestAssistantActivitySnapshots: [UUID: AssistantActivitySnapshot] = [:]
    /// Cached set of thread IDs whose ChatViewModel indicates active processing.
    @Published private(set) var busyConversationIds: Set<UUID> = []
    /// Per-thread interaction state derived from ChatViewModel properties.
    /// Priority: error > waitingForInput > processing > idle.
    @Published private(set) var conversationInteractionStates: [UUID: ConversationInteractionState] = [:]
    /// Subscriptions to per-thread interaction-state changes.
    private var interactionStateCancellables: [UUID: Set<AnyCancellable>] = [:]
    /// Pending anchor message ID for scroll-to behavior on notification deep links.
    @Published var pendingAnchorMessageId: UUID?
    /// Message ID to visually highlight after an anchor scroll completes.
    /// Set by MessageListView when it scrolls to the anchor, cleared after the flash animation.
    @Published var highlightedMessageId: UUID?
    /// Tracks which thread the pending anchor belongs to so stale anchors are
    /// cleared automatically when the user switches to a different thread.
    private var pendingAnchorConversationId: UUID?
    /// Session IDs whose seen signals are deferred pending undo expiration.
    private var pendingSeenConversationIds: [String] = []
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
        let conversationId: String?
        let override: PendingAttentionOverride?
    }

    /// Snapshots captured by the most recent `markAllConversationsSeen()` call,
    /// keyed by thread ID. Consumed by `restoreUnseen(threadIds:)`.
    private var markAllSeenPriorStates: [UUID: MarkAllSeenPriorState] = [:]

    /// Threads that are not archived — used by the UI to populate the sidebar.
    /// Sorted: pinned first (by pinnedOrder ascending), then conversations with explicit
    /// displayOrder ascending, then remaining conversations by lastInteractedAt descending.
    /// Threads move to the top when messages are sent or received, but NOT when clicked/selected.
    var visibleConversations: [ConversationModel] {
        conversations.filter { !$0.isArchived && $0.kind != .private }
            .sorted { visibleConversationSortOrder($0, $1) }
    }

    /// Shared sort predicate for visible conversations: pinned first (by pinnedOrder),
    /// then conversations with explicit displayOrder, then remaining by recency.
    private func visibleConversationSortOrder(_ a: ConversationModel, _ b: ConversationModel) -> Bool {
        if a.isPinned && b.isPinned {
            return (a.pinnedOrder ?? 0) < (b.pinnedOrder ?? 0)
        }
        if a.isPinned { return true }
        if b.isPinned { return false }
        // Threads without explicit displayOrder (nil) sort by recency and
        // appear ABOVE explicitly-ordered conversations so new/active conversations are
        // never buried below stale manual ordering.
        if a.displayOrder == nil && b.displayOrder == nil {
            return a.lastInteractedAt > b.lastInteractedAt
        }
        if a.displayOrder == nil { return true }
        if b.displayOrder == nil { return false }
        return a.displayOrder! < b.displayOrder!
    }

    /// Count of visible (non-archived, non-private) conversations with unseen assistant messages.
    /// Used by AppDelegate to drive the dock badge.
    var unseenVisibleConversationCount: Int {
        conversations.filter { !$0.isArchived && $0.kind != .private && $0.hasUnseenLatestAssistantMessage }.count
    }

    var archivedConversations: [ConversationModel] {
        conversations.filter { $0.isArchived }
    }

    var activeConversation: ConversationModel? {
        guard let id = activeConversationId else { return nil }
        return conversations.first { $0.id == id }
    }

    var activeViewModel: ChatViewModel? {
        if activeConversationId == nil, let draftViewModel {
            return draftViewModel
        }
        guard let activeConversationId else { return nil }
        return getOrCreateViewModel(for: activeConversationId)
    }

    init(daemonClient: DaemonClient, conversationClient: ConversationClientProtocol = ConversationClient(), activityNotificationService: ActivityNotificationService? = nil, isFirstLaunch: Bool = false) {
        self.daemonClient = daemonClient
        self.conversationClient = conversationClient
        self.activityNotificationService = activityNotificationService
        self.conversationRestorer = ConversationRestorer(daemonClient: daemonClient)
        // On first launch (post-onboarding), skip session restoration — there are
        // no meaningful prior sessions. Allow activeConversationId writes immediately so
        // the wake-up thread's UUID is persisted.
        // On normal launches, suppress writes during restoration so the saved
        // value isn't overwritten before restoreLastActiveConversation() reads it.
        self.isRestoringConversations = !isFirstLaunch
        // Enter draft mode so the window shows an empty chat without a sidebar entry
        enterDraftMode()
        conversationRestorer.delegate = self
        conversationRestorer.startObserving(skipInitialFetch: isFirstLaunch)
    }

    func createConversation() {
        // If already in draft mode with an empty draft, no-op
        if draftViewModel != nil, activeConversationId == nil {
            return
        }

        // If the active thread is still empty, just keep it instead of creating another.
        // Only reuse when the thread is truly fresh: no messages at all, no persisted
        // session, and not a private thread (which have different persistence semantics).
        if let activeId = activeConversationId,
           let vm = chatViewModels[activeId],
           vm.messages.isEmpty {
            let activeConversation = conversations.first(where: { $0.id == activeId })
            if activeConversation?.kind != .private && activeConversation?.conversationId == nil {
                return
            }
        }

        // Enter draft mode — thread only appears in sidebar when the user sends
        // their first message (via promoteDraft triggered by onUserMessageSent).
        enterDraftMode()
    }

    /// Opens a thread for interaction, optionally creating a new one and/or sending a message.
    ///
    /// - Parameters:
    ///   - message: Text to place in the input field. When nil, the input is left unchanged.
    ///   - forceNew: When true, always creates a fresh thread via `createConversation()`
    ///     even if one is already active. Defaults to false (reuse the active thread).
    ///   - autoSend: When true **and** a message is provided, the message is sent
    ///     immediately. When false the message is only placed in the input field.
    ///     Defaults to true.
    ///   - configure: Optional closure to configure the view model before the message
    ///     is populated/sent (e.g., set skill invocation data or dock state).
    /// - Returns: The active `ChatViewModel`, or nil if thread creation failed.
    @discardableResult
    func openConversation(
        message: String? = nil,
        forceNew: Bool = false,
        autoSend: Bool = true,
        configure: ((ChatViewModel) -> Void)? = nil
    ) -> ChatViewModel? {
        if forceNew || activeViewModel == nil {
            createConversation()
        }
        guard let viewModel = activeViewModel else { return nil }
        configure?(viewModel)
        if let message {
            viewModel.inputText = message
            if autoSend {
                viewModel.sendMessage()
            }
        }
        return viewModel
    }

    /// Ensures an active thread exists, selecting or creating one if needed.
    ///
    /// Selection priority:
    /// 1. If `preferredConversationId` is provided, select a non-archived thread with that session.
    /// 2. Otherwise, select the first visible thread.
    /// 3. If no conversations exist, create a new one.
    ///
    /// Used by `.onAppear` handlers in panel layouts to guarantee a `ChatViewModel`
    /// is available before the chat view renders.
    func ensureActiveConversation(preferredConversationId: String? = nil) {
        guard activeViewModel == nil else { return }
        if let conversationId = preferredConversationId,
           let match = conversations.first(where: { $0.conversationId == conversationId && !$0.isArchived }) {
            selectConversation(id: match.id)
        } else if let first = visibleConversations.first {
            selectConversation(id: first.id)
        } else {
            createConversation()
        }
    }

    /// Enter draft mode: show an empty chat without creating a sidebar thread.
    /// The thread is only created when the user sends their first message.
    func enterDraftMode() {
        // If already in draft mode with an empty draft, no-op (reuse existing draft)
        if let draftVM = draftViewModel, draftVM.messages.isEmpty, activeConversationId == nil {
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
        activeConversationId = nil
        subscribeToActiveViewModel()
        log.info("Entered draft mode")
    }

    /// Promote the draft view model to a real thread.
    /// - Parameter fromUserSend: true when triggered by a user message send,
    ///   false when triggered by `createConversation()` needing a guaranteed `activeConversationId`.
    private func promoteDraft(fromUserSend: Bool) {
        guard let viewModel = draftViewModel else { return }

        let thread = ConversationModel(title: "Untitled")
        let threadId = thread.id
        conversations.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        subscribeToInteractionState(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()
        draftViewModel = nil

        // Increment only on actual user sends, not programmatic createConversation() calls.
        if fromUserSend {
            completedConversationCount += 1
        }

        // Wire up callbacks now that we have a real thread.
        // onFirstUserMessage is already consumed for user-send promotions
        // (it fires before onUserMessageSent in sendMessage), so only set it
        // for createConversation()-triggered promotions where no message was sent yet.
        if !fromUserSend {
            viewModel.onFirstUserMessage = { [weak self] _ in
                self?.completedConversationCount += 1
                // Only set "Untitled" if the user hasn't already renamed this thread.
                if self?.pendingRenames[threadId] == nil {
                    self?.updateConversationTitle(id: threadId, title: "Untitled")
                }
                self?.updateLastInteracted(threadId: threadId)
            }
        }
        viewModel.onUserMessageSent = { [weak self] in
            self?.updateLastInteracted(threadId: threadId)
        }

        activeConversationId = thread.id
        updateLastInteracted(threadId: thread.id)
        log.info("Promoted draft to conversation \(thread.id)")
    }

    func createPrivateConversation() {
        let thread = ConversationModel(kind: .private)
        let viewModel = makeViewModel()
        viewModel.isHistoryLoaded = true  // No session yet — nothing to load
        let threadId = thread.id
        viewModel.onFirstUserMessage = { [weak self] _ in
            self?.completedConversationCount += 1
            // Only set "Untitled" if the user hasn't already renamed this thread.
            if self?.pendingRenames[threadId] == nil {
                self?.updateConversationTitle(id: threadId, title: "Untitled")
            }
            self?.updateLastInteracted(threadId: threadId)
        }
        conversations.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        subscribeToInteractionState(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()
        activeConversationId = thread.id

        // Immediately create a daemon session so the thread is persisted
        // before the user sends any messages.
        viewModel.createConversationIfNeeded(conversationType: "private")

        log.info("Created private conversation \(thread.id)")
    }

    /// Remove a private (temporary) thread and delete its backend conversation.
    /// Stops any active generation before cleanup.
    func removePrivateConversation(id: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == id && $0.kind == .private }) else { return }

        let conversationId = conversations[index].conversationId

        // Stop generation and clean up local state
        chatViewModels[id]?.stopGenerating()
        conversations.remove(at: index)
        chatViewModels.removeValue(forKey: id)
        unsubscribeAllForConversation(id: id)
        vmAccessOrder.removeAll { $0 == id }
        Self.clearRenderCaches()

        // Delete the conversation on the backend (fire-and-forget)
        if let conversationId {
            Task { await conversationClient.deleteConversation(conversationId) }
        }

        log.info("Removed private conversation \(id)")
    }

    /// Shared creation path for conversations spawned by background processes
    /// (schedules, task runs, notifications). All background conversations start
    /// with the unread badge set, ensuring the user sees new activity.
    ///
    /// - Parameters:
    ///   - conversationId: Daemon conversation ID to bind.
    ///   - title: Display title for the sidebar.
    ///   - source: Optional source tag ("schedule", "notification", etc.).
    ///   - scheduleJobId: Optional schedule job ID for schedule grouping.
    ///   - markHistoryLoaded: When true (default), marks history as loaded
    ///     since these conversations stream live. Set to false for notification
    ///     conversations that have a pre-existing seed message requiring fetch.
    /// - Returns: The conversation's local ID if created, nil if a duplicate was skipped.
    @discardableResult
    private func createBackgroundConversation(
        conversationId: String,
        title: String,
        source: String? = nil,
        scheduleJobId: String? = nil,
        markHistoryLoaded: Bool = true
    ) -> UUID? {
        guard !conversations.contains(where: { $0.conversationId == conversationId }) else {
            return nil
        }

        var conversation = ConversationModel(title: title, conversationId: conversationId)
        if let source { conversation.source = source }
        if let scheduleJobId { conversation.scheduleJobId = scheduleJobId }
        conversation.hasUnseenLatestAssistantMessage = true

        let viewModel = makeViewModel()
        viewModel.conversationId = conversationId
        if markHistoryLoaded {
            viewModel.isHistoryLoaded = true
        }
        viewModel.startMessageLoop()

        conversations.insert(conversation, at: 0)
        chatViewModels[conversation.id] = viewModel
        subscribeToBusyState(for: conversation.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: conversation.id, viewModel: viewModel)
        subscribeToInteractionState(for: conversation.id, viewModel: viewModel)
        touchVMAccessOrder(conversation.id)
        evictStaleCachedViewModels()

        return conversation.id
    }

    /// Create a visible thread bound to an existing task run conversation.
    /// Called when the daemon broadcasts `task_run_conversation_created` so the user
    /// can see task execution messages streaming in real-time.
    func createTaskRunConversation(conversationId: String, workItemId: String, title: String) {
        guard let localId = createBackgroundConversation(conversationId: conversationId, title: title) else { return }
        log.info("Created task run conversation \(localId) for conversation \(conversationId) (work item \(workItemId))")
    }

    /// Create a visible thread bound to a schedule-created conversation.
    /// Called when the daemon broadcasts `schedule_conversation_created` so the user
    /// sees scheduled conversations in the sidebar without a full refresh.
    func createScheduleConversation(conversationId: String, scheduleJobId: String, title: String) {
        guard let localId = createBackgroundConversation(
            conversationId: conversationId,
            title: title,
            source: "schedule",
            scheduleJobId: scheduleJobId
        ) else { return }
        log.info("Created schedule conversation \(localId) for conversation \(conversationId) (schedule \(scheduleJobId))")
    }

    /// Create a visible thread bound to a notification-created conversation.
    /// Called when the daemon broadcasts `notification_thread_created` so the user
    /// can see notification conversations and deep-link into them.
    func createNotificationConversation(conversationId: String, title: String, sourceEventName: String) {
        guard let localId = createBackgroundConversation(
            conversationId: conversationId,
            title: title,
            source: "notification",
            markHistoryLoaded: false
        ) else { return }
        log.info("Created notification conversation \(localId) for conversation \(conversationId) (source: \(sourceEventName))")
    }

    func closeConversation(id: UUID) {
        // No-op if only 1 thread remains
        guard conversations.count > 1 else { return }

        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }

        // Cancel any active generation so the daemon doesn't keep processing
        // an orphaned request after the view model is removed.
        chatViewModels[id]?.stopGenerating()

        conversations.remove(at: index)
        chatViewModels.removeValue(forKey: id)
        unsubscribeAllForConversation(id: id)
        vmAccessOrder.removeAll { $0 == id }

        // Reclaim memory held by static caches that may reference
        // messages from the closed thread.
        Self.clearRenderCaches()

        // If the closed thread was active, select an adjacent thread
        if activeConversationId == id {
            // Prefer the thread at the same index (next), otherwise fall back to last
            if index < conversations.count {
                activeConversationId = conversations[index].id
            } else {
                activeConversationId = conversations.last?.id
            }
        }

        log.info("Closed thread \(id)")
    }

    func archiveConversation(id: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }

        // Clear ordering state before archiving so stale is_pinned/display_order
        // values don't affect DB pagination (which sorts by is_pinned DESC).
        // Send the update BEFORE setting isArchived, because sendReorderConversations()
        // only serializes visibleConversations (non-archived).
        let wasPinned = conversations[index].isPinned
        let hadOrder = conversations[index].displayOrder != nil

        // Batch mutations into a single array write to avoid multiple
        // @Published objectWillChange emissions that can cause SwiftUI
        // ForEach re-entrancy crashes.
        var thread = conversations[index]
        thread.isPinned = false
        thread.pinnedOrder = nil
        thread.displayOrder = nil
        thread.isArchived = true
        conversations[index] = thread

        if wasPinned {
            recompactPinnedOrders()
        }
        if wasPinned || hadOrder {
            sendReorderConversations()
        }

        if let conversationId = conversations[index].conversationId {
            chatViewModels[id]?.stopGenerating()
            var archived = archivedConversationIds
            archived.insert(conversationId)
            archivedConversationIds = archived
            // Session ID already known — safe to release the view model.
            chatViewModels.removeValue(forKey: id)
            unsubscribeAllForConversation(id: id)
            vmAccessOrder.removeAll { $0 == id }
        } else if chatViewModels[id]?.messages.contains(where: { $0.role == .user }) != true
                    && chatViewModels[id]?.isBootstrapping != true {
            chatViewModels[id]?.stopGenerating()
            // No session ID, no user messages, and no bootstrap in flight —
            // a session will never be created, so there is nothing to backfill.
            // Clean up immediately.
            chatViewModels.removeValue(forKey: id)
            unsubscribeAllForConversation(id: id)
            vmAccessOrder.removeAll { $0 == id }
        } else {
            // Session ID is nil but a session is expected (user messages exist
            // or bootstrap is in flight, e.g. a workspace refinement that
            // doesn't append a user message). Keep the ChatViewModel alive so
            // the onConversationCreated callback can fire, claim its own session via
            // the correlation ID, persist the archive state via backfillConversationId,
            // and then clean up. Use cancelPendingMessage() instead of
            // stopGenerating() to discard the queued message without clearing the
            // correlation ID — this prevents the VM from claiming an unrelated
            // session_info from another thread.
            chatViewModels[id]?.cancelPendingMessage()
        }

        // If the archived thread was active, select an adjacent visible thread
        // or create a new one if none remain.
        if activeConversationId == id {
            // Find the position of the archived thread among visible conversations
            // (before archiving filtered it out) and pick the neighbor.
            let visible = visibleConversations
            if !visible.isEmpty {
                // The archived thread was at `index` in the full `conversations` array.
                // Find the closest visible thread by scanning neighbors.
                let visibleAfter = conversations[index...].dropFirst().first(where: { !$0.isArchived })
                let visibleBefore = conversations[..<index].last(where: { !$0.isArchived })
                if let next = visibleAfter ?? visibleBefore {
                    activeConversationId = next.id
                } else {
                    activeConversationId = visible.first?.id
                }
            } else {
                createConversation()
            }
        }

        // Reclaim memory held by static caches that may reference
        // messages from the archived thread.
        Self.clearRenderCaches()

        log.info("Archived thread \(id)")
    }

    func unarchiveConversation(id: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }

        conversations[index].isArchived = false

        // Ensure a ChatViewModel exists (lazily created if it was evicted on archive).
        getOrCreateViewModel(for: id)

        if let conversationId = conversations[index].conversationId {
            var archived = archivedConversationIds
            archived.remove(conversationId)
            archivedConversationIds = archived
        }

        log.info("Unarchived thread \(id)")
    }

    func isConversationArchived(_ conversationId: String) -> Bool {
        archivedConversationIds.contains(conversationId)
    }

    /// Load more conversations from the daemon (pagination).
    func loadMoreThreads() {
        guard !isLoadingMoreConversations else { return }
        isLoadingMoreConversations = true
        do {
            try daemonClient.sendConversationList(offset: serverOffset, limit: 50)
        } catch {
            log.error("Failed to request more conversations: \(error.localizedDescription)")
            isLoadingMoreConversations = false
        }
    }

    /// Handle appended conversations from a "load more" response.
    func appendConversations(from response: ConversationListResponseMessage) {
        // Increment offset by the unfiltered count so pagination stays aligned
        // with the daemon's row numbering regardless of client-side filtering.
        serverOffset += response.conversations.count

        let recentSessions = response.conversations.filter {
            $0.conversationType != "private" && $0.channelBinding?.sourceChannel == nil
        }

        // Compute the next pinnedOrder based on existing pinned conversations AND
        // persisted displayOrder values in the incoming batch, so legacy conversations
        // (nil displayOrder) don't collide with explicit or already-loaded ones.
        let existingMax = conversations.compactMap(\.pinnedOrder).max() ?? -1
        let batchMax = recentSessions
            .filter { $0.isPinned ?? false }
            .compactMap { $0.displayOrder.map { Int($0) } }
            .max() ?? -1
        var nextPinnedOrder = max(existingMax, batchMax) + 1

        for session in recentSessions {
            // If a local thread already exists, merge server pin/order metadata.
            if let existingIdx = conversations.firstIndex(where: { $0.conversationId == session.id }) {
                let isPinned = session.isPinned ?? false
                var thread = conversations[existingIdx]
                thread.isPinned = isPinned
                thread.pinnedOrder = isPinned ? (session.displayOrder.map { Int($0) } ?? nextPinnedOrder) : nil
                thread.displayOrder = session.displayOrder.map { Int($0) }
                conversations[existingIdx] = thread
                mergeAssistantAttention(from: session, intoThreadAt: existingIdx)
                if isPinned && session.displayOrder == nil { nextPinnedOrder += 1 }
                continue
            }

            let isPinned = session.isPinned ?? false
            let effectiveCreatedAt = session.createdAt ?? session.updatedAt
            let thread = ConversationModel(
                title: session.title,
                createdAt: Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAt) / 1000.0),
                conversationId: session.id,
                isArchived: isConversationArchived(session.id),
                isPinned: isPinned,
                pinnedOrder: isPinned ? (session.displayOrder.map { Int($0) } ?? nextPinnedOrder) : nil,
                displayOrder: session.displayOrder.map { Int($0) },
                lastInteractedAt: Date(timeIntervalSince1970: TimeInterval(session.updatedAt) / 1000.0),
                kind: session.conversationType == "private" ? .private : .standard,
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
            conversations.append(thread)
        }

        if let hasMore = response.hasMore {
            hasMoreConversations = hasMore
        }
        evictStaleCachedViewModels()
        isLoadingMoreConversations = false
    }

    /// Clear the `activeSurfaceId` on a specific thread's ChatViewModel.
    /// Used when switching conversations to prevent stale surface context injection.
    func clearActiveSurface(threadId: UUID) {
        chatViewModels[threadId]?.activeSurfaceId = nil
    }

    func selectConversation(id: UUID) {
        guard let thread = conversations.first(where: { $0.id == id }) else { return }

        removeAbandonedEmptyThread(switching: id)

        let previousActiveId = activeConversationId
        trimPreviousThreadIfNeeded(nextThreadId: id)

        // Re-create the ViewModel if it was LRU-evicted.
        if chatViewModels[id] == nil {
            let viewModel = makeViewModel()
            viewModel.conversationId = thread.conversationId
            chatViewModels[id] = viewModel
            subscribeToBusyState(for: id, viewModel: viewModel)
            subscribeToAssistantActivity(for: id, viewModel: viewModel)
            subscribeToInteractionState(for: id, viewModel: viewModel)
            evictStaleCachedViewModels()
        }

        touchVMAccessOrder(id)
        activeConversationId = id
        // Switching conversations is a natural point to shed cached render
        // artefacts from the previous conversation.
        Self.clearRenderCaches()

        // Emit explicit seen signal for user-initiated thread selection.
        // Skip if this thread was already active to avoid duplicate signals
        // (e.g. when openConversationThread sets activeConversationId directly and
        // SwiftUI's onChange cycle calls selectConversation with the same id).
        if id != previousActiveId {
            markConversationSeen(threadId: id)
        }
    }

    /// Select a thread by its daemon conversation ID (conversationId).
    /// Returns `true` if a matching thread was found and selected, `false` otherwise.
    @discardableResult
    func selectThreadByConversationId(_ conversationId: String) -> Bool {
        guard let thread = conversations.first(where: { $0.conversationId == conversationId }) else { return false }
        selectConversation(id: thread.id)
        return true
    }

    /// Select a thread by session ID, fetching it on-demand from the server if not locally available.
    /// Returns `true` if the thread was found (or fetched) and selected, `false` on failure.
    func selectThreadByConversationIdAsync(_ conversationId: String) async -> Bool {
        // Fast path: already loaded locally
        if selectThreadByConversationId(conversationId) {
            return true
        }

        // Slow path: fetch the conversation via the gateway and insert it locally
        guard let session = await conversationClient.fetchConversationById(conversationId) else {
            return false
        }

        // Re-check after await — another code path (e.g. SSE session-list response)
        // may have inserted this thread while we were waiting on the network.
        if selectThreadByConversationId(conversationId) {
            return true
        }

        // Don't insert external-channel or private conversations into the main sidebar
        if session.conversationType == "private" || session.channelBinding?.sourceChannel != nil {
            return false
        }

        let effectiveCreatedAt = session.createdAt ?? session.updatedAt
        let thread = ConversationModel(
            title: session.title,
            createdAt: Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAt) / 1000.0),
            conversationId: session.id,
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
        viewModel.conversationId = session.id
        // Leave isHistoryLoaded false so history is fetched when the thread activates
        viewModel.startMessageLoop()

        conversations.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        subscribeToBusyState(for: thread.id, viewModel: viewModel)
        subscribeToAssistantActivity(for: thread.id, viewModel: viewModel)
        subscribeToInteractionState(for: thread.id, viewModel: viewModel)
        touchVMAccessOrder(thread.id)
        evictStaleCachedViewModels()

        selectConversation(id: thread.id)
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
    /// trigger lazy creation for conversations that have never been accessed.
    func updateConfirmationStateAcrossThreads(requestId: String, decision: String) {
        for viewModel in chatViewModels.values {
            viewModel.updateConfirmationState(requestId: requestId, decision: decision)
        }
    }

    /// Returns true if the given ChatViewModel is the one that most recently
    /// received a `toolUseStart` event across all conversations. Used to route
    /// `confirmationRequest` messages (which lack a conversationId) to exactly
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
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        let nextOrder = (conversations.compactMap(\.pinnedOrder).max() ?? -1) + 1
        var thread = conversations[index]
        thread.isPinned = true
        thread.pinnedOrder = nextOrder
        conversations[index] = thread
        sendReorderConversations()
    }

    func unpinThread(id: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        var thread = conversations[index]
        thread.isPinned = false
        thread.pinnedOrder = nil
        thread.displayOrder = nil
        conversations[index] = thread
        recompactPinnedOrders()
        sendReorderConversations()
    }

    func reorderPinnedThreads(from source: IndexSet, to destination: Int) {
        var pinned = visibleConversations.filter(\.isPinned)
        pinned.move(fromOffsets: source, toOffset: destination)
        var draft = conversations
        for (order, item) in pinned.enumerated() {
            if let idx = draft.firstIndex(where: { $0.id == item.id }) {
                draft[idx].pinnedOrder = order
            }
        }
        conversations = draft
        sendReorderConversations()
    }

    func updateLastInteracted(threadId: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == threadId }) else { return }
        var thread = conversations[index]
        thread.lastInteractedAt = Date()
        // Clear explicit displayOrder so the thread reverts to recency-based sorting.
        // This ensures actively-used conversations float to the top naturally and new conversations
        // aren't permanently stuck below explicitly-ordered conversations.
        let hadOrder = thread.displayOrder != nil
        if hadOrder {
            thread.displayOrder = nil
        }
        conversations[index] = thread
        if hadOrder {
            sendReorderConversations()
        }
    }

    /// Move a thread to a new position in the visible list (for drag-and-drop reorder).
    /// Works for any thread: pinned-to-pinned reorders among pinned items,
    /// unpinned-to-pinned pins the source, and unpinned-to-unpinned reorders
    /// using displayOrder. When the target is a schedule thread, the source is
    /// inserted at the end of the unpinned regular conversations list (the boundary
    /// between regular and scheduled conversations).
    ///
    /// Only assigns displayOrder to the dragged thread and conversations that already
    /// had an explicit displayOrder. Threads without explicit ordering (sorted
    /// by recency) keep nil displayOrder so new conversations continue to appear at top.
    @discardableResult
    func moveThread(sourceId: UUID, targetId: UUID) -> Bool {
        guard let sourceIdx = conversations.firstIndex(where: { $0.id == sourceId }),
              let targetIdx = conversations.firstIndex(where: { $0.id == targetId }) else { return false }
        let targetThread = conversations[targetIdx]

        // Work on a local copy to batch all mutations into a single
        // @Published write, preventing SwiftUI ForEach re-entrancy crashes.
        var draft = conversations

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

            // Build the unpinned list in sidebar display order: regular conversations first,
            // then schedule conversations. This matches the UI sections and prevents dropping
            // onto a schedule thread from inserting the source among regular conversations
            // at the wrong position.
            let visible = draft.filter { !$0.isArchived && $0.kind != .private }
                .sorted { visibleConversationSortOrder($0, $1) }
            let allUnpinned = visible.filter { !$0.isPinned }
            let regularUnpinned = allUnpinned.filter { !$0.isScheduleConversation }
            let scheduleUnpinned = allUnpinned.filter { $0.isScheduleConversation }
            let unpinned = regularUnpinned + scheduleUnpinned

            var reordered = unpinned.filter { $0.id != sourceId }

            let insertPos: Int
            let sourceThread = draft[sourceIdx]
            if targetThread.isScheduleConversation && !sourceThread.isScheduleConversation {
                // Cross-section drag: insert at section boundary
                insertPos = reordered.firstIndex(where: { $0.isScheduleConversation }) ?? reordered.endIndex
            } else {
                // Direction-aware: if source was visually above target (dragging down),
                // insert AFTER target; if below (dragging up), insert BEFORE target.
                // Pinned conversations are always visually above unpinned ones, so a
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

            // Assign displayOrder to ALL conversations in the reordered list. When a
            // user drags a thread they are explicitly defining an ordering, so every
            // thread in the affected section needs a concrete displayOrder. Without
            // this, dragging between recency-sorted conversations (nil displayOrder) would
            // only assign an order to the source, causing it to jump to the top of
            // the list since visibleConversations sorts non-nil displayOrder above nil.
            for (order, item) in reordered.enumerated() {
                if let idx = draft.firstIndex(where: { $0.id == item.id }) {
                    draft[idx].displayOrder = order
                }
            }
        }

        // Single write — triggers objectWillChange exactly once.
        conversations = draft
        sendReorderConversations()
        return true
    }

    /// Recompact pinned orders in the given draft array (no @Published writes).
    private func recompactPinnedOrders(in draft: inout [ConversationModel]) {
        let pinned = draft.enumerated()
            .filter { $0.element.isPinned }
            .sorted { ($0.element.pinnedOrder ?? 0) < ($1.element.pinnedOrder ?? 0) }
        for (order, item) in pinned.enumerated() {
            draft[item.offset].pinnedOrder = order
        }
    }

    private func recompactPinnedOrders() {
        var draft = conversations
        recompactPinnedOrders(in: &draft)
        conversations = draft
    }

    /// Send the current thread ordering to the daemon so it persists across restarts.
    /// For pinned conversations, derives a deterministic displayOrder from pinnedOrder so
    /// the pinned ordering survives restarts. For unpinned conversations that have been
    /// explicitly reordered (non-nil displayOrder), sends their displayOrder. For
    /// unpinned conversations without explicit ordering, sends nil so they sort by recency.
    private func sendReorderConversations() {
        let visible = visibleConversations
        var updates: [ReorderConversationsRequestUpdate] = []
        for thread in visible {
            guard let conversationId = thread.conversationId else { continue }
            let order: Double?
            if thread.isPinned {
                // Pinned conversations always need a persisted displayOrder derived from
                // their pinnedOrder so their user-defined order survives restarts.
                order = Double(thread.pinnedOrder ?? 0)
            } else {
                order = thread.displayOrder.map { Double($0) }
            }
            updates.append(ReorderConversationsRequestUpdate(
                conversationId: conversationId,
                displayOrder: order,
                isPinned: thread.isPinned
            ))
        }
        guard !updates.isEmpty else { return }
        do {
            try daemonClient.send(ReorderConversationsRequest(
                type: "reorder_conversations",
                updates: updates
            ))
        } catch {
            log.error("Failed to send reorder_conversations: \(error.localizedDescription)")
        }
    }

    // MARK: - ConversationRestorerDelegate

    func chatViewModel(for threadId: UUID) -> ChatViewModel? {
        return getOrCreateViewModel(for: threadId)
    }

    func existingChatViewModel(for threadId: UUID) -> ChatViewModel? {
        guard let vm = chatViewModels[threadId] else { return nil }
        touchVMAccessOrder(threadId)
        return vm
    }

    func existingChatViewModel(forConversationId conversationId: String) -> ChatViewModel? {
        for (threadId, vm) in chatViewModels where vm.conversationId == conversationId {
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
        if threadId == activeConversationId {
            subscribeToActiveViewModel()
        }
    }

    func removeChatViewModel(for threadId: UUID) {
        chatViewModels.removeValue(forKey: threadId)
        unsubscribeAllForConversation(id: threadId)
        vmAccessOrder.removeAll { $0 == threadId }
    }

    /// Called when the user responds to a confirmation via the inline chat UI.
    /// The app layer uses this to dismiss the native notification and resume
    /// the notification service continuation. Receives (requestId, decision).
    var onInlineConfirmationResponse: ((String, String) -> Void)?

    /// The ambient agent instance, set by the app layer so watch session callbacks
    /// can create and manage WatchSession objects.
    weak var ambientAgent: AmbientAgent?

    func updateConversationTitle(id: UUID, title: String) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].title = title
    }

    /// Rename a thread and send the rename to the daemon.
    /// If the thread doesn't have a conversationId yet, the rename is queued
    /// and flushed when backfillConversationId is called.
    func renameConversation(id: UUID, title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].title = trimmed
        if let conversationId = conversations[index].conversationId {
            try? daemonClient.send(ConversationRenameRequest(
                type: "conversation_rename",
                conversationId: conversationId,
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
            let conversationId = viewModel?.conversationId ?? ""
            // Pass empty summary so ActivityNotificationService derives the title
            // from the tool calls themselves (friendly name + target for single tool,
            // count-based for multiple tools)
            let summary = ""
            Task { @MainActor in
                await service.notifyConversationComplete(
                    summary: summary,
                    steps: toolCalls.count,
                    toolCalls: toolCalls,
                    conversationId: conversationId
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
                conversationId: msg.conversationId,
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
        viewModel.onConversationCreated = { [weak self, weak viewModel] conversationId in
            guard let self, let viewModel else { return }
            self.backfillConversationId(conversationId, for: viewModel)
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
        viewModel.onReconnectHistoryNeeded = { [weak self] conversationId in
            guard let self else { return }
            self.conversationRestorer.requestReconnectHistory(conversationId: conversationId)
        }
        return viewModel
    }

    func activateConversation(_ id: UUID) {
        let previousActiveId = activeConversationId
        trimPreviousThreadIfNeeded(nextThreadId: id)
        activeConversationId = id

        // Emit explicit seen signal for user-initiated thread activation.
        // Skip during session restoration to avoid false "seen" signals on bootstrap.
        if !isRestoringConversations, id != previousActiveId {
            markConversationSeen(threadId: id)
        }
    }

    /// If the active thread has an unseen assistant message, mark it as seen.
    /// Called when the app becomes active (e.g. user clicks the menu bar icon
    /// or switches back to the app) so that a pre-selected unread thread is
    /// marked seen without requiring a thread switch.
    func markActiveThreadSeenIfNeeded() {
        guard NSApp.isActive,
              !isRestoringConversations,
              let activeId = activeConversationId,
              let idx = conversations.firstIndex(where: { $0.id == activeId }),
              conversations[idx].hasUnseenLatestAssistantMessage else { return }
        markConversationSeen(threadId: activeId)
    }

    /// Clear the local unseen flag and notify the daemon that the conversation
    /// has been seen. Use this from call-sites that bypass `selectConversation` (e.g.
    /// deep-link navigation in `openConversationThread`) where the `id != previousActiveId`
    /// guard would skip the signal.
    internal func markConversationSeen(threadId: UUID) {
        guard let idx = conversations.firstIndex(where: { $0.id == threadId }) else { return }
        // If the thread has a pending .unread override, opening the thread clears it
        // so the normal seen flow proceeds rather than leaving the thread stuck as unread.
        if let conversationId = conversations[idx].conversationId,
           case .unread = pendingAttentionOverrides[conversationId] {
            pendingAttentionOverrides.removeValue(forKey: conversationId)
        }
        var thread = conversations[idx]
        thread.hasUnseenLatestAssistantMessage = false
        if let conversationId = thread.conversationId {
            pendingAttentionOverrides[conversationId] = .seen(
                latestAssistantMessageAt: thread.latestAssistantMessageAt
            )
            thread.lastSeenAssistantMessageAt = thread.latestAssistantMessageAt
            conversations[idx] = thread
            emitConversationSeenSignal(conversationId: conversationId)
        } else {
            conversations[idx] = thread
        }
    }

    internal func markConversationUnread(threadId: UUID) {
        guard let idx = conversations.firstIndex(where: { $0.id == threadId }),
              let conversationId = conversations[idx].conversationId,
              canMarkConversationUnread(threadId: threadId, at: idx) else { return }

        let latestAssistantMessageAt = conversations[idx].latestAssistantMessageAt

        let previousLastSeenAssistantMessageAt = conversations[idx].lastSeenAssistantMessageAt
        let previousOverride = pendingAttentionOverrides[conversationId]
        let wasPendingSeen = pendingSeenConversationIds.contains(conversationId)

        pendingSeenConversationIds.removeAll { $0 == conversationId }
        pendingAttentionOverrides[conversationId] = .unread(
            latestAssistantMessageAt: latestAssistantMessageAt
        )
        var thread = conversations[idx]
        thread.hasUnseenLatestAssistantMessage = true
        thread.lastSeenAssistantMessageAt = nil
        conversations[idx] = thread
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.emitConversationUnreadSignal(conversationId: conversationId)
            } catch {
                self.rollbackUnreadMutationIfNeeded(
                    threadId: threadId,
                    conversationId: conversationId,
                    latestAssistantMessageAt: latestAssistantMessageAt,
                    previousLastSeenAssistantMessageAt: previousLastSeenAssistantMessageAt,
                    previousOverride: previousOverride,
                    wasPendingSeen: wasPendingSeen
                )
                log.warning("Failed to send conversation_unread_signal for \(conversationId): \(error.localizedDescription)")
            }
        }
    }

    /// Set a pending anchor message for scroll-to behavior on notification deep links.
    /// Only takes effect when the specified thread is currently active.
    func setPendingAnchorMessage(threadId: UUID, messageId: UUID) {
        guard activeConversationId == threadId else { return }
        pendingAnchorMessageId = messageId
        pendingAnchorConversationId = threadId
    }

    /// Mark all visible (non-archived, non-private) conversations as seen locally.
    /// Seen signals are NOT sent immediately — call `commitPendingSeenSignals()`
    /// after the undo window expires, or `cancelPendingSeenSignals()` if the
    /// user clicks Undo. Returns the IDs of conversations that were actually marked.
    @discardableResult
    internal func markAllConversationsSeen() -> [UUID] {
        // Commit (not cancel) any already-pending signals so a second
        // mark-all invocation doesn't silently drop the first batch.
        commitPendingSeenSignals()
        var markedIds: [UUID] = []
        var conversationIds: [String] = []
        var priorStates: [UUID: MarkAllSeenPriorState] = [:]
        for idx in conversations.indices {
            guard !conversations[idx].isArchived,
                  conversations[idx].kind != .private,
                  conversations[idx].hasUnseenLatestAssistantMessage else { continue }
            let threadId = conversations[idx].id
            let conversationId = conversations[idx].conversationId
            // Capture prior state before overwriting
            priorStates[threadId] = MarkAllSeenPriorState(
                lastSeenAssistantMessageAt: conversations[idx].lastSeenAssistantMessageAt,
                conversationId: conversationId,
                override: conversationId.flatMap { pendingAttentionOverrides[$0] }
            )
            conversations[idx].hasUnseenLatestAssistantMessage = false
            markedIds.append(threadId)
            if let conversationId {
                conversationIds.append(conversationId)
                pendingAttentionOverrides[conversationId] = .seen(
                    latestAssistantMessageAt: conversations[idx].latestAssistantMessageAt
                )
                conversations[idx].lastSeenAssistantMessageAt = conversations[idx].latestAssistantMessageAt
            }
        }
        markAllSeenPriorStates = priorStates
        if !conversationIds.isEmpty {
            pendingSeenConversationIds = conversationIds
        }
        return markedIds
    }

    /// Send the deferred seen signals that were collected by
    /// `markAllConversationsSeen()`. Called when the undo window expires
    /// (toast dismissed or auto-dismiss timer fires).
    internal func commitPendingSeenSignals() {
        let conversationIds = pendingSeenConversationIds
        pendingSeenConversationIds = []
        markAllSeenPriorStates = [:]
        pendingSeenSignalTask?.cancel()
        pendingSeenSignalTask = nil
        for conversationId in conversationIds {
            emitConversationSeenSignal(conversationId: conversationId)
        }
    }

    /// Cancel any pending seen signals (user clicked Undo).
    internal func cancelPendingSeenSignals() {
        pendingSeenConversationIds = []
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
    /// values captured by `markAllConversationsSeen()` instead of blindly
    /// clearing them.
    internal func restoreUnseen(threadIds: [UUID]) {
        cancelPendingSeenSignals()
        let priorStates = markAllSeenPriorStates
        markAllSeenPriorStates = [:]
        for id in threadIds {
            if let idx = conversations.firstIndex(where: { $0.id == id }) {
                conversations[idx].hasUnseenLatestAssistantMessage = true
                if let prior = priorStates[id] {
                    conversations[idx].lastSeenAssistantMessageAt = prior.lastSeenAssistantMessageAt
                    if let conversationId = prior.conversationId {
                        // Only restore the override if the current override is
                        // still the .seen that markAllConversationsSeen() installed.
                        // If the user changed it (e.g. marked unread during
                        // the undo window), keep the newer override.
                        if let currentOverride = pendingAttentionOverrides[conversationId],
                           case .seen = currentOverride {
                            if let previousOverride = prior.override {
                                pendingAttentionOverrides[conversationId] = previousOverride
                            } else {
                                pendingAttentionOverrides.removeValue(forKey: conversationId)
                            }
                        }
                    }
                } else {
                    // Fallback: no prior state captured (shouldn't happen in
                    // normal flow), clear conservatively.
                    conversations[idx].lastSeenAssistantMessageAt = nil
                    if let conversationId = conversations[idx].conversationId {
                        pendingAttentionOverrides.removeValue(forKey: conversationId)
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
        conversationId: String,
        latestAssistantMessageAt: Date?,
        previousLastSeenAssistantMessageAt: Date?,
        previousOverride: PendingAttentionOverride?,
        wasPendingSeen: Bool = false
    ) {
        guard let idx = conversations.firstIndex(where: { $0.id == threadId }),
              conversations[idx].conversationId == conversationId,
              case .unread(let pendingLatestAssistantMessageAt) = pendingAttentionOverrides[conversationId],
              pendingLatestAssistantMessageAt == latestAssistantMessageAt else { return }

        if let previousOverride {
            pendingAttentionOverrides[conversationId] = previousOverride
        } else {
            pendingAttentionOverrides.removeValue(forKey: conversationId)
        }
        conversations[idx].hasUnseenLatestAssistantMessage = false
        conversations[idx].lastSeenAssistantMessageAt = previousLastSeenAssistantMessageAt

        if wasPendingSeen && !pendingSeenConversationIds.contains(conversationId) {
            pendingSeenConversationIds.append(conversationId)
            if pendingSeenSignalTask == nil {
                schedulePendingSeenSignals()
            }
        }
    }

    /// Remove the currently active thread if it was never used (no messages,
    /// no persisted session, not private). Prevents abandoned empty conversations
    /// from accumulating in the sidebar.
    /// - Parameter switching: The thread ID being switched to. Pass `nil`
    ///   when called from `createConversation()` (the active thread is checked
    ///   separately by the reuse guard above).
    private func removeAbandonedEmptyThread(switching nextId: UUID? = nil) {
        guard let previousId = activeConversationId,
              previousId != nextId,
              let vm = chatViewModels[previousId],
              vm.messages.isEmpty else { return }
        let thread = conversations.first(where: { $0.id == previousId })
        guard thread?.kind != .private, thread?.conversationId == nil else { return }
        conversations.removeAll { $0.id == previousId }
        chatViewModels.removeValue(forKey: previousId)
        unsubscribeAllForConversation(id: previousId)
        vmAccessOrder.removeAll { $0 == previousId }
        log.info("Removed abandoned empty thread \(previousId)")
    }

    /// Trim the previously active thread's view model to shed memory before
    /// switching to a different thread. Skipped when the VM hasn't loaded
    /// history yet or when it has an active generation in progress.
    private func trimPreviousThreadIfNeeded(nextThreadId: UUID) {
        guard let previousId = activeConversationId, previousId != nextThreadId,
              let vm = chatViewModels[previousId],
              vm.isHistoryLoaded,
              !vm.isSending, !vm.isThinking, !vm.isLoadingMoreMessages else { return }
        vm.trimForBackground()
    }

    /// Backfill ConversationModel.conversationId when the daemon assigns a session to a new thread.
    private func backfillConversationId(_ conversationId: String, for viewModel: ChatViewModel) {
        guard let threadId = chatViewModels.first(where: { $0.value === viewModel })?.key,
              let index = conversations.firstIndex(where: { $0.id == threadId }),
              conversations[index].conversationId == nil else { return }
        conversations[index].conversationId = conversationId
        // If the thread was archived before the conversation ID arrived,
        // persist the archive state now that we have a session ID and
        // release the view model that was kept alive for this callback.
        if conversations[index].isArchived {
            var archived = archivedConversationIds
            archived.insert(conversationId)
            archivedConversationIds = archived
            chatViewModels.removeValue(forKey: threadId)
            unsubscribeAllForConversation(id: threadId)
            vmAccessOrder.removeAll { $0 == threadId }
        }
        // Re-send ordering now that this thread has a session ID.
        // Any drag/pin actions performed before the daemon assigned
        // a session would have been skipped by sendReorderConversations()
        // because it filters out conversations without a conversationId.
        sendReorderConversations()
        // Flush any rename that was queued before the session ID was assigned.
        if let pendingTitle = pendingRenames.removeValue(forKey: threadId) {
            try? daemonClient.send(ConversationRenameRequest(
                type: "conversation_rename",
                conversationId: conversationId,
                title: pendingTitle
            ))
        }
    }

    func mergeAssistantAttention(
        from item: ConversationListResponseItem,
        intoThreadAt index: Int
    ) {
        conversations[index].hasUnseenLatestAssistantMessage =
            item.assistantAttention?.hasUnseenLatestAssistantMessage ?? false
        conversations[index].latestAssistantMessageAt =
            item.assistantAttention?.latestAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
        conversations[index].lastSeenAssistantMessageAt =
            item.assistantAttention?.lastSeenAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }

        guard let conversationId = conversations[index].conversationId,
              let override = pendingAttentionOverrides[conversationId] else { return }

        switch override {
        case .seen(let targetLatestAssistantMessageAt):
            if !conversations[index].hasUnseenLatestAssistantMessage {
                pendingAttentionOverrides.removeValue(forKey: conversationId)
                return
            }
            // When target is nil (e.g. notification-created thread before history loads),
            // drop the override if the server reports unseen — the server has newer info.
            if targetLatestAssistantMessageAt == nil {
                pendingAttentionOverrides.removeValue(forKey: conversationId)
                return
            }
            if let targetLatestAssistantMessageAt,
               let serverLatestAssistantMessageAt = conversations[index].latestAssistantMessageAt,
               serverLatestAssistantMessageAt > targetLatestAssistantMessageAt {
                pendingAttentionOverrides.removeValue(forKey: conversationId)
                return
            }

            if let targetLatestAssistantMessageAt,
               conversations[index].latestAssistantMessageAt == nil {
                conversations[index].latestAssistantMessageAt = targetLatestAssistantMessageAt
            }
            conversations[index].hasUnseenLatestAssistantMessage = false
            conversations[index].lastSeenAssistantMessageAt =
                conversations[index].latestAssistantMessageAt

        case .unread(let targetLatestAssistantMessageAt):
            if conversations[index].hasUnseenLatestAssistantMessage {
                pendingAttentionOverrides.removeValue(forKey: conversationId)
                return
            }
            if let targetLatestAssistantMessageAt,
               let serverLatestAssistantMessageAt = conversations[index].latestAssistantMessageAt,
               serverLatestAssistantMessageAt > targetLatestAssistantMessageAt {
                pendingAttentionOverrides.removeValue(forKey: conversationId)
                return
            }

            if let targetLatestAssistantMessageAt,
               conversations[index].latestAssistantMessageAt == nil {
                conversations[index].latestAssistantMessageAt = targetLatestAssistantMessageAt
            }
            conversations[index].hasUnseenLatestAssistantMessage = true
            conversations[index].lastSeenAssistantMessageAt = nil
        }
    }

    // MARK: - Lazy VM Creation

    /// Returns an existing ChatViewModel or lazily creates one for the given thread.
    /// This is the single entry point for VM access — `appendConversations` and session
    /// restoration no longer eagerly create VMs for every loaded session.
    @discardableResult
    private func getOrCreateViewModel(for threadId: UUID) -> ChatViewModel? {
        if let vm = chatViewModels[threadId] {
            touchVMAccessOrder(threadId)
            return vm
        }
        // Only create if the thread exists
        guard let thread = conversations.first(where: { $0.id == threadId }) else { return nil }
        let viewModel = makeViewModel()
        viewModel.conversationId = thread.conversationId
        if thread.conversationId == nil {
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
            // just because the user switched conversations.
            guard let victim = vmAccessOrder.first(where: {
                guard $0 != activeConversationId, let vm = chatViewModels[$0] else { return false }
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

    private var archivedConversationIds: Set<String> {
        get {
            Set(UserDefaults.standard.stringArray(forKey: archivedSessionsKey) ?? [])
        }
        set {
            UserDefaults.standard.set(Array(newValue), forKey: archivedSessionsKey)
        }
    }


    /// Restore the last active thread from UserDefaults after session restoration completes
    func restoreLastActiveConversation() {
        // After restoration finishes, re-run the active-thread seen check.
        // The didBecomeActive notification may have fired while isRestoringConversations
        // was true, causing markActiveThreadSeenIfNeeded() to no-op. Deferring
        // ensures the check runs once restoration is complete.
        defer { markActiveThreadSeenIfNeeded() }

        guard restoreRecentConversations else {
            // Clear the flag even if restoration is disabled
            isRestoringConversations = false
            return
        }
        guard let savedUUIDString = lastActiveConversationIdString,
              let savedUUID = UUID(uuidString: savedUUIDString) else {
            // Clear the flag and allow future activeConversationId changes to persist
            isRestoringConversations = false
            return
        }

        // Only restore if thread exists and is visible (not archived)
        if conversations.contains(where: { $0.id == savedUUID && !$0.isArchived }) {
            activeConversationId = savedUUID
            log.info("Restored last active conversation: \(savedUUID)")
        } else {
            // Conversation no longer exists, clear saved state
            lastActiveConversationIdString = nil
            log.info("Saved conversation not found, falling back to default")
        }

        // Clear the flag so future activeConversationId changes persist normally
        isRestoringConversations = false
    }

    // MARK: - Busy State

    /// Whether the given thread's ChatViewModel indicates active processing.
    func isConversationBusy(_ threadId: UUID) -> Bool {
        busyConversationIds.contains(threadId)
    }

    /// Subscribe to busy-state publishers on a ChatViewModel so `busyConversationIds` stays current.
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
                self.busyConversationIds.insert(threadId)
            } else {
                self.busyConversationIds.remove(threadId)
            }
        }
        .store(in: &subs)

        busyStateCancellables[threadId] = subs
    }

    /// Subscribe to assistant activity for a thread.
    /// Any change to the latest assistant message's rendered content marks
    /// inactive conversations unseen, including mid-stream continuation updates.
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
    /// Does NOT clear `conversationInteractionStates` — the last known interaction
    /// state is preserved so that evicted (but still visible) conversations continue
    /// showing the correct sidebar cue.  Callers that permanently remove a
    /// thread (close / archive) should use `unsubscribeAllForConversation(id:)` instead.
    private func unsubscribeFromBusyState(for threadId: UUID) {
        busyStateCancellables.removeValue(forKey: threadId)
        assistantActivityCancellables[threadId]?.cancel()
        assistantActivityCancellables.removeValue(forKey: threadId)
        latestAssistantActivitySnapshots.removeValue(forKey: threadId)
        busyConversationIds.remove(threadId)
        interactionStateCancellables.removeValue(forKey: threadId)
    }

    /// Atomically cancel all per-thread subscriptions and remove cached state
    /// for a thread that is being permanently removed (closed, archived, or
    /// session-backfilled-then-discarded). Unlike `unsubscribeFromBusyState`,
    /// this also clears `conversationInteractionStates` so stale sidebar cues don't linger.
    private func unsubscribeAllForConversation(id: UUID) {
        busyStateCancellables[id] = nil
        assistantActivityCancellables[id]?.cancel()
        assistantActivityCancellables[id] = nil
        latestAssistantActivitySnapshots.removeValue(forKey: id)
        busyConversationIds.remove(id)
        interactionStateCancellables[id] = nil
        conversationInteractionStates.removeValue(forKey: id)
    }

    // MARK: - Interaction State

    /// Returns the derived interaction state for a thread, defaulting to `.idle`.
    func interactionState(for threadId: UUID) -> ConversationInteractionState {
        conversationInteractionStates[threadId] ?? .idle
    }

    /// Subscribe to interaction-state–relevant publishers on a ChatViewModel so
    /// `conversationInteractionStates` stays current.
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
            errMgr.$conversationError
        )
        .map { busyTuple, errorText, conversationError in
            let (isSending, isThinking, pendingQueuedCount, messages) = busyTuple
            let hasError = errorText != nil || conversationError != nil
            let hasPendingConfirmation = messages.contains(where: { $0.confirmation?.state == .pending })
            let isBusy = isSending || isThinking || pendingQueuedCount > 0

            if hasError {
                return ConversationInteractionState.error
            } else if hasPendingConfirmation {
                return ConversationInteractionState.waitingForInput
            } else if isBusy {
                return ConversationInteractionState.processing
            } else {
                return ConversationInteractionState.idle
            }
        }
        .removeDuplicates()
        .sink { [weak self] state in
            guard let self else { return }
            if state == .idle {
                self.conversationInteractionStates.removeValue(forKey: threadId)
            } else {
                self.conversationInteractionStates[threadId] = state
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
        // state on app launch, or bump conversations to the top when clicking on
        // them causes an evicted ViewModel to reload its history.
        guard !isRestoringConversations else { return }
        if let vm = chatViewModels[threadId], vm.isLoadingHistory || !vm.isHistoryLoaded {
            return
        }
        guard let index = conversations.firstIndex(where: { $0.id == threadId }) else { return }
        updateLastInteracted(threadId: threadId)
        let isNewMessage = previousSnapshot?.messageId != currentSnapshot.messageId
        // Keep the local attention timestamp current for live assistant replies
        // so unread eligibility survives until the next session-list refresh.
        if conversations[index].latestAssistantMessageAt == nil || isNewMessage {
            conversations[index].latestAssistantMessageAt = Date()
        }
        if threadId == activeConversationId {
            conversations[index].hasUnseenLatestAssistantMessage = false
            // Only emit the seen signal on meaningful transitions:
            // 1. A new assistant message appeared (different messageId)
            // 2. Streaming just completed (isStreaming went true -> false)
            let streamingJustCompleted = previousSnapshot?.isStreaming == true && !currentSnapshot.isStreaming
            if isNewMessage || streamingJustCompleted {
                if let conversationId = conversations[index].conversationId {
                    emitConversationSeenSignal(conversationId: conversationId)
                }
            }
        } else {
            conversations[index].hasUnseenLatestAssistantMessage = true
        }
    }

    private func canMarkConversationUnread(threadId: UUID, at threadIndex: Int) -> Bool {
        guard conversations[threadIndex].conversationId != nil,
              !conversations[threadIndex].hasUnseenLatestAssistantMessage else { return false }
        // Live assistant replies update the in-memory activity snapshot before
        // session-list hydration backfills latestAssistantMessageAt.
        return conversations[threadIndex].latestAssistantMessageAt != nil
            || latestAssistantActivitySnapshots[threadId] != nil
    }
}
