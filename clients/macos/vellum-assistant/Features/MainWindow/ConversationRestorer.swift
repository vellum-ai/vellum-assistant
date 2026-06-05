import AppKit
import Foundation
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConversationRestorer")

/// Delegate protocol so the restorer can read and mutate conversation state
/// owned by `ConversationManager`.
@MainActor
protocol ConversationRestorerDelegate: AnyObject {
    var conversations: [ConversationModel] { get set }
    var groups: [ConversationGroup] { get set }
    var daemonSupportsGroups: Bool { get set }
    var restoreRecentConversations: Bool { get }
    var isLoadingMoreConversations: Bool { get set }
    var hasMoreConversations: Bool { get set }
    var serverOffset: Int { get set }
    /// Returns or lazily creates a ChatViewModel for the given conversation.
    func chatViewModel(for conversationId: UUID) -> ChatViewModel?
    /// Returns an existing ChatViewModel without creating one (avoids triggering lazy init).
    func existingChatViewModel(for conversationId: UUID) -> ChatViewModel?
    func setChatViewModel(_ vm: ChatViewModel, for conversationId: UUID)
    func removeChatViewModel(for conversationId: UUID)
    func makeViewModel() -> ChatViewModel
    func activateConversation(_ id: UUID)
    func createConversation()
    func isConversationArchived(_ conversationId: String) -> Bool
    func restoreLastActiveConversation()
    func appendConversations(from response: ConversationListResponseMessage)
    /// Queue a latest-history reconciliation for an already-loaded conversation.
    /// Used when a conversation-list refresh shows that another client advanced
    /// the conversation while this client may have missed the live SSE event.
    func reconcileLoadedConversationHistory(localId: UUID, daemonConversationId: String)
    /// Returns an existing ChatViewModel matching the given conversation ID, if any.
    func existingChatViewModel(forConversationId conversationId: String) -> ChatViewModel?
    /// Merge daemon attention metadata into an existing conversation, allowing the
    /// owner to preserve optimistic local seen/unread state until the daemon
    /// catches up or returns a newer reply.
    func mergeAssistantAttention(
        from item: ConversationListResponseItem,
        intoConversationAt index: Int
    )
    /// Value-level attention merge for batch operations. Applies attention
    /// fields and reconciles pending overrides without writing to
    /// `conversations`, so the caller can coalesce N mutations into one
    /// `conversations` writeback.
    func applyAssistantAttention(
        from item: ConversationListResponseItem,
        into conversation: inout ConversationModel
    )
    /// Patch a single already-loaded conversation row from a server item,
    /// used for narrow per-conversation metadata sync tags so the client
    /// avoids refetching the entire paginated list.
    func mergeConversationRow(from item: ConversationListResponseItem)
}

/// Handles daemon conversation restoration: fetching the conversation list on connect,
/// creating conversations for recent conversations, and loading per-conversation history on demand.
@MainActor
final class ConversationRestorer {
    /// Maps conversation IDs to local IDs for in-flight `history_request` messages,
    /// so rapid tab switches don't cause history from one conversation to land in another.
    /// Exposed as internal for `@testable` test access.
    var pendingHistoryByConversationId: [String: UUID] = [:]

    /// In-flight history reconstruction tasks spawned by `handleHistoryResponse`.
    /// Each task offloads message reconstruction to a background thread, then
    /// applies the result on the main actor. Exposed as internal so tests can
    /// `await` pending work before asserting on view-model state. Each task
    /// removes itself from this list after completing, keyed by `id`, so the
    /// list does not grow unboundedly in production.
    struct InFlightHistoryReconstructionTask {
        let id: UUID
        let task: Task<Void, Never>
    }
    var inFlightHistoryReconstructionTasks: [InFlightHistoryReconstructionTask] = []

    private let connectionManager: GatewayConnectionManager
    private let eventStreamClient: EventStreamClient
    private let conversationListClient: any ConversationListClientProtocol
    private let conversationHistoryClient: any ConversationHistoryClientProtocol
    private let conversationDetailClient: any ConversationDetailClientProtocol
    private var disconnectObservationTask: Task<Void, Never>?
    private var fetchConversationListTask: Task<Void, Never>?
    /// Debounce task for `conversation_list_invalidated` refetch.
    private var invalidationRefetchTask: Task<Void, Never>?
    /// Serial queue of conversation IDs awaiting reconnect history reload.
    /// Processed one at a time by `reconnectHistoryDrainTask` to prevent N
    /// simultaneous history reconstructions from saturating the main actor.
    private var reconnectHistoryQueue: [String] = []
    private var reconnectHistoryDrainTask: Task<Void, Never>?
    /// NotificationCenter observer token for `.daemonDidReconnect`. One-shot —
    /// removed after the first post fires the initial conversation list fetch.
    private var daemonReconnectObserver: NSObjectProtocol?
    /// NotificationCenter observer token for `NSApplication.didBecomeActiveNotification`.
    /// Kept for the lifetime of the restorer to catch every activation.
    private var appDidBecomeActiveObserver: NSObjectProtocol?
    /// Last `lastMessageAt` observed in a list response for loaded conversations.
    /// This prevents app activation/list invalidation refreshes from repeatedly
    /// fetching the same latest history page when the server-side latest message
    /// has not changed.
    private var observedListLastMessageAtByConversationId: [String: Int] = [:]

    weak var delegate: ConversationRestorerDelegate?

    init(
        connectionManager: GatewayConnectionManager,
        eventStreamClient: EventStreamClient,
        conversationHistoryClient: any ConversationHistoryClientProtocol = ConversationHistoryClient(),
        conversationListClient: any ConversationListClientProtocol = ConversationListClient(),
        conversationDetailClient: any ConversationDetailClientProtocol = ConversationDetailClient()
    ) {
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.conversationHistoryClient = conversationHistoryClient
        self.conversationListClient = conversationListClient
        self.conversationDetailClient = conversationDetailClient
    }

    deinit {
        disconnectObservationTask?.cancel()
        fetchConversationListTask?.cancel()
        invalidationRefetchTask?.cancel()
        reconnectHistoryDrainTask?.cancel()
        for entry in inFlightHistoryReconstructionTasks {
            entry.task.cancel()
        }
        if let daemonReconnectObserver {
            NotificationCenter.default.removeObserver(daemonReconnectObserver)
        }
        if let appDidBecomeActiveObserver {
            NotificationCenter.default.removeObserver(appDidBecomeActiveObserver)
        }
    }

    func startObserving(skipInitialFetch: Bool = false) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            for await message in self.eventStreamClient.subscribe() {
                switch message {
                case .conversationListResponse(let response):
                    // SSE-pushed responses don't have the foreground/background
                    // separation that fetchConversationList enforces, so they
                    // must not touch serverOffset (which paginates the
                    // foreground endpoint only).
                    self.handleConversationListResponse(response, updateServerOffset: false)
                case .historyResponse(let response):
                    self.handleHistoryResponse(response)
                case .conversationTitleUpdated(let response):
                    self.handleConversationTitleUpdated(response)
                case .conversationListInvalidated:
                    self.scheduleInvalidationRefetch()
                default:
                    break
                }
            }
        }
        // On first launch after onboarding, skip the initial conversation list fetch
        // so the conversation restorer doesn't override the wake-up conversation.
        // The handlers above are still registered for later use (e.g. history loading).
        guard !skipInitialFetch else { return }

        // Refetch the conversation list whenever the macOS app becomes active
        // (user returns from another app, e.g. the iOS Simulator). This covers
        // the case where a mutation on another device (pin/rename/archive) did
        // not produce a `conversation_list_invalidated` SSE event — either
        // because the server didn't broadcast it or because our SSE stream was
        // between reconnects when it fired. `scheduleInvalidationRefetch`
        // debounces, so rapid activations coalesce into a single fetch.
        if let existing = appDidBecomeActiveObserver {
            NotificationCenter.default.removeObserver(existing)
            appDidBecomeActiveObserver = nil
        }
        appDidBecomeActiveObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.connectionManager.isConnected else { return }
                self.scheduleInvalidationRefetch()
            }
        }

        // Reset loading state when the daemon disconnects so the Load More
        // button doesn't stay permanently disabled after a dropped connection.
        // The transition to `false` is only read for its edge effect, so this
        // path tolerates the Observation framework's racy "first read" semantics.
        disconnectObservationTask?.cancel()
        disconnectObservationTask = Task { @MainActor [weak self] in
            for await connected in observationStream({ [weak self] in self?.connectionManager.isConnected ?? false }) {
                guard let self, !Task.isCancelled else { break }
                if !connected {
                    self.delegate?.isLoadingMoreConversations = false
                }
            }
        }

        // Fetch conversation list on first connect using `.daemonDidReconnect`
        // — the shared signal posted by `GatewayConnectionManager.setConnected(true)`.
        //
        // An `observationStream` on `isConnected` is inappropriate here:
        // `withObservationTracking` installation and `setConnected(true)`
        // are enqueued on the main actor in an unordered pair, so when the
        // transition lands before tracking is installed the `onChange`
        // callback never fires and the first-connect branch is silently
        // skipped.
        //
        // The notification is deferred to a separate main-actor turn to
        // avoid a synchronous NotificationCenter cascade during property
        // mutation. The synchronous `isConnected` guard below is the
        // primary safety net — it covers the case where the daemon is
        // already connected at observer-registration time. The deferred
        // notification handles the case where connection completes after
        // this code runs. Both paths are idempotent because
        // `fetchConversationList` cancels any in-flight fetch before
        // starting a new one.
        if connectionManager.isConnected {
            fetchConversationList()
        } else {
            if let existing = daemonReconnectObserver {
                NotificationCenter.default.removeObserver(existing)
                daemonReconnectObserver = nil
            }
            daemonReconnectObserver = NotificationCenter.default.addObserver(
                forName: .daemonDidReconnect,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if let observer = self.daemonReconnectObserver {
                        NotificationCenter.default.removeObserver(observer)
                        self.daemonReconnectObserver = nil
                    }
                    self.fetchConversationList()
                }
            }
        }
    }

    func loadHistoryIfNeeded(conversationId localId: UUID) {
        guard let delegate else { return }
        guard let conversation = delegate.conversations.first(where: { $0.id == localId }) else { return }
        guard let conversationId = conversation.conversationId else { return }
        guard let viewModel = delegate.chatViewModel(for: localId) else { return }
        guard !viewModel.isHistoryLoaded else { return }

        // Skip if a fetch is already in flight for this conversation.
        guard pendingHistoryByConversationId[conversationId] == nil else { return }
        pendingHistoryByConversationId[conversationId] = localId

        // Wire up the "load more" callback so the view model can request
        // older pages through the same pending-history tracking mechanism.
        viewModel.onLoadMoreHistory = { [weak self] conversationId, beforeTimestamp in
            self?.requestPaginatedHistory(conversationId: conversationId, beforeTimestamp: beforeTimestamp)
        }

        let retryDelays: [UInt64] = [500_000_000, 2_000_000_000] // 0.5s, then 2s
        Task { [weak self] in
            guard let self else { return }
            let maxAttempts = retryDelays.count + 1
            for attempt in 1...maxAttempts {
                let response = await self.conversationHistoryClient.fetchHistory(conversationId: conversationId, limit: 50, beforeTimestamp: nil, mode: "light", maxTextChars: nil, maxToolResultChars: 1000)
                if let response {
                    self.handleHistoryResponse(response)
                    return
                }
                if attempt < maxAttempts {
                    let delay = retryDelays[attempt - 1]
                    log.warning("History fetch attempt \(attempt) of \(maxAttempts) for conversation \(conversationId) failed, retrying in \(Double(delay) / 1_000_000_000)s...")
                    try? await Task.sleep(nanoseconds: delay)
                    guard !Task.isCancelled else {
                        self.pendingHistoryByConversationId.removeValue(forKey: conversationId)
                        return
                    }
                }
            }
            log.error("All \(maxAttempts) history fetch attempts failed for conversation \(conversationId)")
            self.pendingHistoryByConversationId.removeValue(forKey: conversationId)
        }
    }

    /// Queue a reconnect history re-fetch. Requests are processed serially by
    /// `drainReconnectHistoryQueue` to prevent N simultaneous history
    /// reconstructions from saturating the main actor after a reconnect.
    func requestReconnectHistory(conversationId: String) {
        guard let delegate else { return }
        guard let conversation = delegate.conversations.first(where: { $0.conversationId == conversationId }) else { return }
        pendingHistoryByConversationId[conversationId] = conversation.id
        guard !reconnectHistoryQueue.contains(conversationId) else { return }
        reconnectHistoryQueue.append(conversationId)
        drainReconnectHistoryQueue()
    }

    func handleSyncRoutes(_ routes: [SyncTagRoute], activeConversationId: String?) {
        var shouldRefetchConversationList = false

        for route in routes {
            switch route {
            case .conversationList:
                // Shape change (created / deleted / reordered): the *set* of
                // rows changed, so the paginated list must be refetched.
                shouldRefetchConversationList = true
            case .conversationMetadata(let conversationId):
                // Content-only change to one existing row (seen / rename /
                // attention). Patch just that row via a single
                // `GET /v1/conversations/:id` instead of draining the full
                // paginated list (3 parallel streams over every conversation),
                // which is what otherwise exhausts the daemon's per-client
                // request budget and 429s the app. Mirrors web's single-row
                // GET-and-patch.
                refreshConversationRow(conversationId: conversationId)
            case .conversationMessages(let conversationId):
                // A messages-only change doesn't alter the list shape, so it
                // must not trigger a full list refetch — only the active
                // conversation needs its history reconciled.
                guard activeConversationId == conversationId else { continue }
                requestReconnectHistory(conversationId: conversationId)
            case .assistantAvatar, .assistantIdentity, .assistantConfig, .assistantSounds, .assistantSchedules:
                continue
            }
        }

        if shouldRefetchConversationList {
            scheduleInvalidationRefetch()
        }
    }

    /// Fetch a single conversation and patch its sidebar row in place. Used for
    /// narrow `conversation:<id>:metadata` sync tags so a content-only change
    /// to one row costs one request instead of a full paginated list drain.
    /// No-ops silently when the fetch fails or the row isn't loaded locally —
    /// a subsequent shape-changing `conversations:list` tag or cold restore
    /// reconciles anything missed.
    private func refreshConversationRow(conversationId: String) {
        Task { [weak self] in
            guard let self else { return }
            guard let item = await self.conversationDetailClient.fetchConversation(conversationId: conversationId) else { return }
            self.delegate?.mergeConversationRow(from: item)
        }
    }

    func handleBroadSyncRefresh(activeConversationId: String?) {
        handleSyncRoutes(
            SyncTagRouter.broadRefreshRoutes(activeConversationId: activeConversationId),
            activeConversationId: activeConversationId
        )
    }

    /// Process queued reconnect history requests one at a time. Yields between
    /// each request so user-input events can interleave with heavy history loads.
    private func drainReconnectHistoryQueue() {
        guard reconnectHistoryDrainTask == nil else { return }
        reconnectHistoryDrainTask = Task { [weak self] in
            defer { self?.reconnectHistoryDrainTask = nil }
            while let self, !Task.isCancelled, !self.reconnectHistoryQueue.isEmpty {
                let conversationId = self.reconnectHistoryQueue.removeFirst()
                // Restart the VM's latch timeout now that the fetch is actually
                // beginning (may have waited in the queue behind other conversations).
                if let localId = self.pendingHistoryByConversationId[conversationId] {
                    self.delegate?.existingChatViewModel(for: localId)?.restartReconnectLatchTimeout()
                }
                let response = await self.conversationHistoryClient.fetchHistory(
                    conversationId: conversationId,
                    limit: 50,
                    beforeTimestamp: nil,
                    mode: "light",
                    maxTextChars: nil,
                    maxToolResultChars: 1000
                )
                if let response {
                    self.handleHistoryResponse(response)
                } else {
                    self.pendingHistoryByConversationId.removeValue(forKey: conversationId)
                }
                await Task.yield()
            }
        }
    }

    /// Request an older page of history for a session. Used by the "Load more"
    /// trigger in the message list when all locally loaded messages are visible.
    func requestPaginatedHistory(conversationId: String, beforeTimestamp: Double) {
        guard let delegate else { return }
        guard let conversation = delegate.conversations.first(where: { $0.conversationId == conversationId }) else {
            // Conversation removed from the list during a concurrent reconnect/refresh.
            // Reset loading state so the user isn't stuck with a permanent spinner.
            delegate.existingChatViewModel(forConversationId: conversationId)?.isLoadingMoreMessages = false
            return
        }
        pendingHistoryByConversationId[conversationId] = conversation.id
        Task { [weak self] in
            guard let self else { return }
            let response = await self.conversationHistoryClient.fetchHistory(conversationId: conversationId, limit: 50, beforeTimestamp: beforeTimestamp, mode: "light", maxTextChars: nil, maxToolResultChars: 1000)
            if let response {
                self.handleHistoryResponse(response)
            } else {
                self.pendingHistoryByConversationId.removeValue(forKey: conversationId)
                if let vm = self.delegate?.existingChatViewModel(for: conversation.id) {
                    vm.isLoadingMoreMessages = false
                }
            }
        }
    }

    // MARK: - Response Handlers (internal for testability)

    func handleConversationListResponse(_ response: ConversationListResponseMessage, updateServerOffset: Bool = true) {
        guard let delegate else { return }

        // If ConversationManager is waiting for a "load more" response, route there.
        if delegate.isLoadingMoreConversations {
            delegate.appendConversations(from: response)
            return
        }

        if updateServerOffset {
            delegate.serverOffset = response.nextOffset ?? response.conversations.count
        }

        // Seed groups from the response if available, otherwise fall back to system defaults.
        // This must run before the restoreRecentConversations guard so that users who
        // disable restore still get groups initialized for the session.
        // Wrapped in an animation-suppressing transaction so SwiftUI doesn't
        // compute diffing/animation for the groups-only update.
        var groupTransaction = Transaction()
        groupTransaction.disablesAnimations = true
        let daemonSupportsGroups: Bool
        if let responseGroups = response.groups, !responseGroups.isEmpty {
            withTransaction(groupTransaction) {
                delegate.groups = responseGroups.map { ConversationGroup(from: $0) }
            }
            delegate.daemonSupportsGroups = true
            daemonSupportsGroups = true
        } else {
            if delegate.groups.isEmpty {
                withTransaction(groupTransaction) {
                    delegate.groups = [ConversationGroup.pinned, ConversationGroup.scheduled, ConversationGroup.background, ConversationGroup.all]
                }
            }
            delegate.daemonSupportsGroups = false
            daemonSupportsGroups = false
        }

        guard delegate.restoreRecentConversations else {
            delegate.restoreLastActiveConversation()
            return
        }

        guard !response.conversations.isEmpty else {
            delegate.restoreLastActiveConversation()
            return
        }

        let defaultConversationIsEmpty = delegate.conversations.count == 1
            && delegate.chatViewModel(for: delegate.conversations[0].id)?.messages.isEmpty ?? true
            && delegate.chatViewModel(for: delegate.conversations[0].id)?.conversationId == nil

        // Snapshot existing conversations so that per-row merges accumulate
        // in-memory instead of triggering N × conversations.didSet.
        var snapshot = delegate.conversations

        // Index by daemon conversation ID for O(1) lookup per server row.
        // With ~1800 conversations, this eliminates ~3.24M string comparisons
        // (O(n²) linear scan) in favor of ~3600 hash lookups (O(n)).
        var snapshotIndexByDaemonId: [String: Int] = Dictionary(minimumCapacity: snapshot.count)
        for (idx, conv) in snapshot.enumerated() {
            if let cid = conv.conversationId {
                snapshotIndexByDaemonId[cid] = idx
            }
        }

        var restoredConversations: [ConversationModel] = []
        for session in response.conversations {
            let isPinned = session.isPinned ?? false
            let groupId: String? = daemonSupportsGroups
                ? (session.groupId ?? (isPinned ? ConversationGroup.pinned.id : ConversationGroup.all.id))
                : ConversationModel.deriveGroupId(
                    serverGroupId: session.groupId,
                    isPinned: isPinned,
                    source: session.source,
                    title: session.title
                )

            // If a local conversation already exists (e.g. created by
            // createNotificationConversation before the session list response arrived),
            // merge server pin/order metadata into it instead of creating a duplicate.
            if let existingIdx = snapshotIndexByDaemonId[session.id] {
                var existing = snapshot[existingIdx]
                existing.groupId = groupId
                existing.displayOrder = session.displayOrder.map { Int($0) }
                existing.forkParent = session.forkParent
                // Refresh mutable fields from the server so invalidation refetches
                // pick up renames, source changes, and interaction timestamps.
                if existing.title == "New Conversation" {
                    existing.title = session.title
                }
                existing.lastInteractedAt = Date(timeIntervalSince1970: TimeInterval(session.lastMessageAt ?? session.updatedAt) / 1000.0)
                existing.source = session.source
                existing.conversationType = session.conversationType
                existing.originChannel = session.channelBinding?.sourceChannel ?? session.conversationOriginChannel
                existing.inferenceProfile = session.inferenceProfile
                existing.scheduleJobId = session.scheduleJobId
                // Attention merge reconciles pendingAttentionOverrides (e.g. a
                // notification conversation the user already opened before the list
                // arrived).
                delegate.applyAssistantAttention(from: session, into: &existing)
                snapshot[existingIdx] = existing
                requestLoadedHistoryReconciliationIfNeeded(
                    localId: existing.id,
                    daemonConversationId: session.id,
                    serverLastMessageAtMillis: session.lastMessageAt
                )
                continue
            }

            let effectiveCreatedAt = session.createdAt ?? session.updatedAt
            let conversation = ConversationModel(
                title: session.title,
                createdAt: Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAt) / 1000.0),
                conversationId: session.id,
                isArchived: delegate.isConversationArchived(session.id),
                groupId: groupId,
                displayOrder: session.displayOrder.map { Int($0) },
                lastInteractedAt: Date(timeIntervalSince1970: TimeInterval(session.lastMessageAt ?? session.updatedAt) / 1000.0),
                source: session.source,
                conversationType: session.conversationType,
                inferenceProfile: session.inferenceProfile,
                scheduleJobId: session.scheduleJobId,
                hasUnseenLatestAssistantMessage: session.assistantAttention?.hasUnseenLatestAssistantMessage ?? false,
                latestAssistantMessageAt: session.assistantAttention?.latestAssistantMessageAt.map {
                    Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
                },
                lastSeenAssistantMessageAt: session.assistantAttention?.lastSeenAssistantMessageAt.map {
                    Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
                },
                forkParent: session.forkParent,
                originChannel: session.channelBinding?.sourceChannel ?? session.conversationOriginChannel
            )
            // Suppress unread indicators for automated conversations on initial load.
            // The server tracks attention for all conversations, but automated threads
            // (heartbeat, schedule, background/task) should never show unread state.
            if conversation.shouldSuppressUnreadIndicator {
                var suppressed = conversation
                suppressed.hasUnseenLatestAssistantMessage = false
                restoredConversations.append(suppressed)
            } else {
                restoredConversations.append(conversation)
            }
        }

        // Single conversations writeback: suppress animations during bulk list
        // assignment so SwiftUI doesn't compute diffing/animation for every row.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            if defaultConversationIsEmpty {
                if let defaultConversation = snapshot.first {
                    delegate.removeChatViewModel(for: defaultConversation.id)
                }
                delegate.conversations = restoredConversations
            } else {
                delegate.conversations = restoredConversations + snapshot
            }
        }

        if let hasMore = response.hasMore {
            delegate.hasMoreConversations = hasMore
        }

        // Cold launch lands on the draft VM created by ConversationManager.init —
        // do not auto-activate a restored conversation. The sidebar above is still
        // populated so the user can click into a recent conversation if desired.
        if defaultConversationIsEmpty && restoredConversations.first(where: { !$0.isArchived }) == nil {
            // All restored conversations are archived and the default was removed:
            // fall back to an explicit draft so the window isn't blank.
            delegate.createConversation()
        }

        // serverOffset is set by fetchConversationList before merging foreground +
        // background, so it reflects the foreground-only DB cursor for correct pagination.
        log.info("Restored \(restoredConversations.count) conversations from daemon (hasMore: \(response.hasMore ?? false))")
        delegate.restoreLastActiveConversation()
    }

    func handleHistoryResponse(_ response: HistoryResponse) {
        guard let localId = pendingHistoryByConversationId.removeValue(forKey: response.conversationId) else { return }
        guard let viewModel = delegate?.chatViewModel(for: localId) else { return }

        // Determine whether this is a pagination load (older page) vs an initial
        // or reconnect load. If the view model already has history loaded and
        // isLoadingMoreMessages is true, the response is for a "Load more" request.
        let isPaginationLoad = viewModel.isHistoryLoaded && viewModel.isLoadingMoreMessages

        // Wire up the onLoadMoreHistory callback eagerly (independent of reconstruction).
        if viewModel.onLoadMoreHistory == nil {
            viewModel.onLoadMoreHistory = { [weak self] conversationId, beforeTimestamp in
                self?.requestPaginatedHistory(conversationId: conversationId, beforeTimestamp: beforeTimestamp)
            }
        }

        // Offload the heavy reconstruction work (JSON size estimation, tool input
        // formatting, image decoding) to a background thread. The nonisolated
        // static method accesses no @MainActor state, so this is safe.
        // Gate the VM before the detached task so streaming handlers suppress
        // SSE deltas that arrive during reconstruction. Skip the gate for
        // pagination loads — the pagination branch returns early without
        // resetting the flag, which would permanently suppress all deltas.
        if !isPaginationLoad {
            viewModel.isLoadingHistory = true
        }
        let convId = viewModel.conversationId
        let messages = response.messages
        let hasMore = response.hasMore
        let oldestTimestamp = response.oldestTimestamp
        let taskId = UUID()
        let task = Task { @MainActor [weak viewModel, weak self] in
            let result = await Task.detached(priority: .userInitiated) {
                HistoryReconstructionService.reconstructMessages(from: messages, conversationId: convId)
            }.value
            viewModel?.applyReconstructedHistory(
                result,
                hasMore: hasMore,
                oldestTimestamp: oldestTimestamp,
                isPaginationLoad: isPaginationLoad
            )
            self?.inFlightHistoryReconstructionTasks.removeAll(where: { $0.id == taskId })
        }
        inFlightHistoryReconstructionTasks.append(InFlightHistoryReconstructionTask(id: taskId, task: task))

        log.info("Loaded \(response.messages.count) history messages for conversation \(localId) (hasMore: \(hasMore), isPagination: \(isPaginationLoad))")
    }

    /// Waits for every history-reconstruction task currently in flight to
    /// finish. Internal helper used by tests that need to assert on
    /// view-model state mutated by the reconstruction task.
    func awaitPendingHistoryReconstructions() async {
        // Snapshot the in-flight list so concurrently-appended tasks (e.g. from
        // chained handleHistoryResponse calls in the test) are picked up on the
        // next iteration rather than leaving the loop racing against itself.
        while !inFlightHistoryReconstructionTasks.isEmpty {
            let snapshot = inFlightHistoryReconstructionTasks
            for entry in snapshot {
                _ = await entry.task.value
            }
        }
    }

    func handleConversationTitleUpdated(_ response: ConversationTitleUpdatedMessage) {
        guard let delegate else { return }
        guard let index = delegate.conversations.firstIndex(where: { $0.conversationId == response.conversationId }) else { return }
        guard delegate.conversations[index].title != response.title else { return }
        delegate.conversations[index].title = response.title
    }

    private func requestLoadedHistoryReconciliationIfNeeded(
        localId: UUID,
        daemonConversationId: String,
        serverLastMessageAtMillis: Int?
    ) {
        guard let serverLastMessageAtMillis else { return }
        guard observedListLastMessageAtByConversationId[daemonConversationId] != serverLastMessageAtMillis else {
            return
        }
        observedListLastMessageAtByConversationId[daemonConversationId] = serverLastMessageAtMillis
        delegate?.reconcileLoadedConversationHistory(
            localId: localId,
            daemonConversationId: daemonConversationId
        )
    }

    // MARK: - Invalidation Debounce

    /// Trailing-edge debounce for `conversation_list_invalidated` events.
    /// Cancels any pending refetch and schedules a new one after 250 ms,
    /// then does a cheap page-1-only refetch (`refetchRecentConversations`)
    /// that merges into the loaded list, preserving selection, scroll
    /// position, and per-conversation history. This deliberately does NOT
    /// re-drain the full paginated list — see `refetchRecentConversations`.
    /// If pagination is in flight, defers the refetch until pagination settles
    /// to avoid misrouting the page-1 response through the append path.
    func scheduleInvalidationRefetch() {
        invalidationRefetchTask?.cancel()
        invalidationRefetchTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard let self, !Task.isCancelled else { return }
            // Wait for any in-flight "Load More" pagination to finish so the
            // page-1 response isn't misrouted through appendConversations.
            // Poll every 250ms, giving up after ~5s to avoid stalling forever.
            var paginationWaitAttempts = 0
            while self.delegate?.isLoadingMoreConversations == true, paginationWaitAttempts < 20 {
                paginationWaitAttempts += 1
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard !Task.isCancelled else { return }
            }
            self.fetchConversationListTask?.cancel()
            self.refetchRecentConversations()
        }
    }

    // MARK: - Private

    /// Full cold-start drain: fetches **every** conversation across the three
    /// streams (foreground/background/archived), each paginated to exhaustion.
    /// Used only on first connect and reconnect (see `startObserving`). The
    /// frequent invalidation path uses `refetchRecentConversations` instead —
    /// this drain is ~`pages × 3` requests and must not run on every
    /// `conversation_list_invalidated` event.
    func fetchConversationList() {
        fetchConversationListTask = Task { [weak self] in
            guard let self else { return }
            // Cap at 2 attempts to limit worst-case restore delay (~32s with 15s
            // per-request timeout) while still covering the daemon restart race.
            let maxAttempts = 2
            for attempt in 1...maxAttempts {
                // Fetch foreground, background, and archived conversations in
                // parallel so they don't consume each other's pagination slots.
                // Each side paginates until the daemon reports
                // `hasMore == false`; without this the sidebar truncates at the
                // first 50 rows (LUM-1618 on web, fixed for macOS here).
                //
                // Archived rows are fetched separately so the active streams
                // stay lean (the daemon now filters archived by default —
                // `archiveStatus: "active"`), while the merged list still
                // contains every row that the Settings → Archive tab needs to
                // render. The archived fetch is best-effort: if it fails the
                // sidebar still restores; the Archive tab repopulates on the
                // next refresh.
                async let foregroundResult = self.fetchAllConversationPages(conversationType: nil)
                async let backgroundResult = self.fetchAllConversationPages(conversationType: "background")
                async let archivedResult = self.fetchAllConversationPages(conversationType: nil, archiveStatus: "archived")
                let foreground = await foregroundResult
                let background = await backgroundResult
                let archived = await archivedResult

                if let foreground {
                    // Deduplicate by conversation ID so that daemons that don't
                    // yet support the conversationType / archiveStatus query
                    // params (which would return overlapping conversations
                    // across requests) don't produce duplicate sidebar entries.
                    var seenIds = Set(foreground.conversations.map(\.id))
                    let uniqueBackground = (background?.conversations ?? []).filter {
                        seenIds.insert($0.id).inserted
                    }
                    let uniqueArchived = (archived?.conversations ?? []).filter {
                        seenIds.insert($0.id).inserted
                    }
                    // Set serverOffset to the foreground DB cursor BEFORE
                    // merging. loadMoreConversations pages the foreground
                    // endpoint only, so the offset must not include merged
                    // background or archived rows; nextOffset is the DB cursor
                    // (see fetchAllConversationPages), not the inflated row
                    // count.
                    self.delegate?.serverOffset = foreground.nextOffset ?? foreground.conversations.count
                    let merged = ConversationListResponse(
                        type: foreground.type,
                        conversations: foreground.conversations + uniqueBackground + uniqueArchived,
                        hasMore: false,
                        groups: foreground.groups
                    )
                    self.handleConversationListResponse(merged, updateServerOffset: false)
                    return
                }
                if attempt < maxAttempts {
                    log.warning("Conversation list fetch attempt \(attempt) of \(maxAttempts) failed, retrying in 2 seconds...")
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard !Task.isCancelled else { return }
                }
            }
            log.warning("All \(maxAttempts) conversation list fetch attempts failed, falling back to last active conversation")
            self.delegate?.restoreLastActiveConversation()
        }
    }

    /// Cheap refetch for `conversation_list_invalidated` events: fetches only
    /// **page 1** of each stream (foreground/background/archived) — three
    /// requests, no pagination loop — and merges into the loaded list.
    ///
    /// This relies on `handleConversationListResponse` being a merge (not a
    /// replace) for an established user: it updates matched rows in place by
    /// daemon id, prepends only brand-new rows, and keeps every already-loaded
    /// row that isn't in the response. New conversations (the dominant shape
    /// change) are most-recent and therefore on page 1, so they're picked up;
    /// reorders/renames within the recent window are refreshed too.
    ///
    /// Pagination state is deliberately preserved: the merged response carries
    /// `hasMore: nil` (so `hasMoreConversations` is not clobbered) and
    /// `updateServerOffset: false` (so the "load more" cursor is untouched).
    ///
    /// Accepted tradeoff: a conversation deleted or reordered on another device
    /// that sits OUTSIDE page 1 of all three streams won't be reflected until
    /// the next cold-start/reconnect full drain (`fetchConversationList`).
    /// That's fine — creation lands on page 1, single deletes are usually
    /// optimistic-local on the deleting client, and reconnect re-drains fully.
    private func refetchRecentConversations() {
        fetchConversationListTask = Task { [weak self] in
            guard let self else { return }
            let pageSize = Self.conversationListPageSize
            async let foregroundResult = self.conversationListClient.fetchConversationList(
                offset: 0, limit: pageSize, conversationType: nil, archiveStatus: nil
            )
            async let backgroundResult = self.conversationListClient.fetchConversationList(
                offset: 0, limit: pageSize, conversationType: "background", archiveStatus: nil
            )
            async let archivedResult = self.conversationListClient.fetchConversationList(
                offset: 0, limit: pageSize, conversationType: nil, archiveStatus: "archived"
            )
            let foreground = await foregroundResult
            let background = await backgroundResult
            let archived = await archivedResult

            // Best-effort: if the foreground page fails, leave the loaded list
            // untouched. A subsequent invalidation or reconnect will retry.
            guard let foreground else { return }

            // Same dedup as the full drain: foreground ids win, then filter
            // background/archived against them so overlapping rows from daemons
            // that ignore the query params don't duplicate.
            var seenIds = Set(foreground.conversations.map(\.id))
            let uniqueBackground = (background?.conversations ?? []).filter {
                seenIds.insert($0.id).inserted
            }
            let uniqueArchived = (archived?.conversations ?? []).filter {
                seenIds.insert($0.id).inserted
            }
            let merged = ConversationListResponse(
                type: foreground.type,
                conversations: foreground.conversations + uniqueBackground + uniqueArchived,
                hasMore: nil,
                groups: foreground.groups
            )
            self.handleConversationListResponse(merged, updateServerOffset: false)
        }
    }

    /// Matches `ConversationListStore.loadAllRemainingConversations` so cold
    /// restore and "load all" share a tested page size. Larger than the web
    /// client's 50 because macOS talks to the daemon over loopback — the
    /// per-request overhead dominates, so fewer round-trips win.
    private static let conversationListPageSize = 200

    /// Safety cap on the pagination loop — `50 * 200 = 10,000` conversations
    /// per type. Bounded so a malformed `hasMore` from the server can't spin
    /// forever.
    private static let conversationListMaxPages = 50

    /// Page through every conversation of the given type, accumulating until
    /// the daemon reports `hasMore == false` or the safety cap is hit. Returns
    /// `nil` if any page request fails so the caller's retry/fallback logic
    /// can drive recovery from a single-shot failure.
    ///
    /// - Parameter archiveStatus: forwarded to the daemon — `nil` defers to
    ///   the daemon's `"active"` default; pass `"archived"` to drain only
    ///   archived rows.
    private func fetchAllConversationPages(conversationType: String?, archiveStatus: String? = nil) async -> ConversationListResponse? {
        let pageSize = Self.conversationListPageSize
        var accumulated: [ConversationListResponseItem] = []
        var firstPage: ConversationListResponse?
        var nextOffset = 0

        for page in 0..<Self.conversationListMaxPages {
            let offset = page * pageSize
            guard let response = await conversationListClient.fetchConversationList(
                offset: offset, limit: pageSize, conversationType: conversationType, archiveStatus: archiveStatus
            ) else {
                return nil
            }
            if firstPage == nil { firstPage = response }
            accumulated.append(contentsOf: response.conversations)
            // Track the DB cursor the server actually reached. On page 1
            // (offset 0) the endpoint appends injected pinned rows, so the
            // accumulated count overshoots the DB offset; prefer the
            // server-provided nextOffset so incremental "load more" resumes at
            // the right cursor instead of skipping rows. Fall back to advancing
            // by one full page when the daemon omits nextOffset.
            nextOffset = response.nextOffset ?? (offset + pageSize)
            let hasMore = response.hasMore ?? false
            if !hasMore || response.conversations.isEmpty { break }
        }

        guard let first = firstPage else { return nil }
        // Groups are sent with the first page only; preserve them on the
        // synthesized response. `hasMore` is forced to false because we've
        // already exhausted the server (or hit the safety cap). `nextOffset`
        // carries the DB cursor reached (tracked above).
        return ConversationListResponse(
            type: first.type,
            conversations: accumulated,
            hasMore: false,
            nextOffset: nextOffset,
            groups: first.groups
        )
    }
}
