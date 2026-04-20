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
    /// Returns an existing ChatViewModel matching the given conversation ID, if any.
    func existingChatViewModel(forConversationId conversationId: String) -> ChatViewModel?
    /// Merge daemon attention metadata into an existing conversation, allowing the
    /// owner to preserve optimistic local seen/unread state until the daemon
    /// catches up or returns a newer reply.
    func mergeAssistantAttention(
        from item: ConversationListResponseItem,
        intoConversationAt index: Int
    )
}

/// Handles daemon conversation restoration: fetching the conversation list on connect,
/// creating conversations for recent conversations, and loading per-conversation history on demand.
@MainActor
final class ConversationRestorer {
    /// Maps conversation IDs to local IDs for in-flight `history_request` messages,
    /// so rapid tab switches don't cause history from one conversation to land in another.
    /// Exposed as internal for `@testable` test access.
    var pendingHistoryByConversationId: [String: UUID] = [:]

    private let connectionManager: GatewayConnectionManager
    private let eventStreamClient: EventStreamClient
    private let conversationListClient: any ConversationListClientProtocol = ConversationListClient()
    private let conversationHistoryClient: any ConversationHistoryClientProtocol
    private var disconnectObservationTask: Task<Void, Never>?
    private var fetchConversationListTask: Task<Void, Never>?
    /// Debounce task for `conversation_list_invalidated` refetch.
    private var invalidationRefetchTask: Task<Void, Never>?
    /// NotificationCenter observer token for `.daemonDidReconnect`. One-shot —
    /// removed after the first post fires the initial conversation list fetch.
    private var daemonReconnectObserver: NSObjectProtocol?
    /// NotificationCenter observer token for `NSApplication.didBecomeActiveNotification`.
    /// Kept for the lifetime of the restorer to catch every activation.
    private var appDidBecomeActiveObserver: NSObjectProtocol?

    weak var delegate: ConversationRestorerDelegate?

    init(connectionManager: GatewayConnectionManager, eventStreamClient: EventStreamClient, conversationHistoryClient: any ConversationHistoryClientProtocol = ConversationHistoryClient()) {
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.conversationHistoryClient = conversationHistoryClient
    }

    deinit {
        disconnectObservationTask?.cancel()
        fetchConversationListTask?.cancel()
        invalidationRefetchTask?.cancel()
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
                    self.handleConversationListResponse(response)
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
        // — the shared, main-actor-synchronous signal posted by
        // `GatewayConnectionManager.setConnected(true)`.
        //
        // An `observationStream` on `isConnected` is inappropriate here:
        // `withObservationTracking` installation and `setConnected(true)`
        // are enqueued on the main actor in an unordered pair, so when the
        // transition lands before tracking is installed the `onChange`
        // callback never fires and the first-connect branch is silently
        // skipped. `.daemonDidReconnect` is delivered synchronously from
        // the write site, so it cannot be missed for this reason.
        //
        // The synchronous `isConnected` guard covers the case where the
        // daemon is already connected at observer-registration time; it is
        // idempotent because `fetchConversationList` cancels any in-flight
        // fetch before starting a new one.
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

    /// Request history re-fetch for a reconnect catch-up. Registers the conversationId
    /// so the response is properly routed back via handleHistoryResponse.
    func requestReconnectHistory(conversationId: String) {
        guard let delegate else { return }
        // Find the conversation that owns this conversationId.
        guard let conversation = delegate.conversations.first(where: { $0.conversationId == conversationId }) else { return }
        pendingHistoryByConversationId[conversationId] = conversation.id
        Task { [weak self] in
            guard let self else { return }
            let response = await self.conversationHistoryClient.fetchHistory(conversationId: conversationId, limit: 50, beforeTimestamp: nil, mode: "light", maxTextChars: nil, maxToolResultChars: 1000)
            if let response {
                self.handleHistoryResponse(response)
            } else {
                self.pendingHistoryByConversationId.removeValue(forKey: conversationId)
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

    func handleConversationListResponse(_ response: ConversationListResponseMessage) {
        guard let delegate else { return }

        // If ConversationManager is waiting for a "load more" response, route there.
        if delegate.isLoadingMoreConversations {
            delegate.appendConversations(from: response)
            return
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

        // Filter out private conversations.
        let recentConversations = response.conversations.filter {
            $0.conversationType != "private"
        }

        let defaultConversationIsEmpty = delegate.conversations.count == 1
            && delegate.chatViewModel(for: delegate.conversations[0].id)?.messages.isEmpty ?? true
            && delegate.chatViewModel(for: delegate.conversations[0].id)?.conversationId == nil

        var restoredConversations: [ConversationModel] = []
        for session in recentConversations {
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
            if let existingIdx = delegate.conversations.firstIndex(where: { $0.conversationId == session.id }) {
                // Copy-modify-writeback for non-attention fields: write back once
                // so conversations.didSet fires once instead of per-field.
                var existing = delegate.conversations[existingIdx]
                existing.groupId = groupId
                existing.displayOrder = session.displayOrder.map { Int($0) }
                existing.hostAccess = session.hostAccess ?? false
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
                delegate.conversations[existingIdx] = existing
                // Attention merge must go through mergeAssistantAttention so that
                // pendingAttentionOverrides are reconciled (e.g. a notification
                // conversation the user already opened before the list arrived).
                delegate.mergeAssistantAttention(from: session, intoConversationAt: existingIdx)
                continue
            }

            let kind: ConversationKind = session.conversationType == "private" ? .private : .standard

            // Preserve user-set titles: if a conversation with this session already
            // exists locally and has a non-default title, keep it instead of
            // overwriting with the daemon's auto-generated title.
            let existingTitle = delegate.conversations
                .first(where: { $0.conversationId == session.id && $0.title != "New Conversation" })?
                .title
            let title = existingTitle ?? session.title

            let effectiveCreatedAt = session.createdAt ?? session.updatedAt
            let conversation = ConversationModel(
                title: title,
                createdAt: Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAt) / 1000.0),
                conversationId: session.id,
                isArchived: delegate.isConversationArchived(session.id),
                groupId: groupId,
                displayOrder: session.displayOrder.map { Int($0) },
                lastInteractedAt: Date(timeIntervalSince1970: TimeInterval(session.lastMessageAt ?? session.updatedAt) / 1000.0),
                kind: kind,
                source: session.source,
                conversationType: session.conversationType,
                hostAccess: session.hostAccess ?? false,
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
                // VM creation is lazy — only the active conversation will get a VM via
                // getOrCreateViewModel() when it's first accessed.
                restoredConversations.append(conversation)
            }
        }

        // Suppress animations during bulk list assignment. Without this,
        // SwiftUI computes before/after diffing and animation interpolation
        // for every row — expensive when restoring ~50 conversations at once.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            if defaultConversationIsEmpty {
                if let defaultConversation = delegate.conversations.first {
                    delegate.removeChatViewModel(for: defaultConversation.id)
                }
                delegate.conversations = restoredConversations
            } else {
                delegate.conversations = restoredConversations + delegate.conversations
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
        // background, so it reflects foreground-only count for correct pagination.
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

        viewModel.populateFromHistory(
            response.messages,
            hasMore: response.hasMore,
            oldestTimestamp: response.oldestTimestamp,
            isPaginationLoad: isPaginationLoad
        )

        // Wire up the onLoadMoreHistory callback if not already set (e.g. for
        // reconnect-restored conversations that didn't go through loadHistoryIfNeeded).
        if viewModel.onLoadMoreHistory == nil {
            viewModel.onLoadMoreHistory = { [weak self] conversationId, beforeTimestamp in
                self?.requestPaginatedHistory(conversationId: conversationId, beforeTimestamp: beforeTimestamp)
            }
        }

        log.info("Loaded \(response.messages.count) history messages for conversation \(localId) (hasMore: \(response.hasMore), isPagination: \(isPaginationLoad))")
    }

    func handleConversationTitleUpdated(_ response: ConversationTitleUpdatedMessage) {
        guard let delegate else { return }
        guard let index = delegate.conversations.firstIndex(where: { $0.conversationId == response.conversationId }) else { return }
        delegate.conversations[index].title = response.title
    }

    // MARK: - Invalidation Debounce

    /// Trailing-edge debounce for `conversation_list_invalidated` events.
    /// Cancels any pending refetch and schedules a new one after 250 ms,
    /// reusing the existing page-1 fetch + merge path so that selection,
    /// scroll position, and per-conversation history are preserved.
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
            self.fetchConversationList()
        }
    }

    // MARK: - Private

    private func fetchConversationList() {
        fetchConversationListTask = Task { [weak self] in
            guard let self else { return }
            // Cap at 2 attempts to limit worst-case restore delay (~32s with 15s
            // per-request timeout) while still covering the daemon restart race.
            let maxAttempts = 2
            for attempt in 1...maxAttempts {
                // Fetch foreground and background conversations in parallel so
                // background conversations don't consume pagination slots from
                // the main list.
                async let foregroundResult = conversationListClient.fetchConversationList(offset: 0, limit: 50, conversationType: nil)
                async let backgroundResult = conversationListClient.fetchConversationList(offset: 0, limit: 50, conversationType: "background")
                let foreground = await foregroundResult
                let background = await backgroundResult

                if let foreground {
                    // Deduplicate by conversation ID so that daemons that don't
                    // yet support the conversationType query param (which return
                    // the same conversations for both requests) don't produce
                    // duplicate sidebar entries.
                    var seenIds = Set(foreground.conversations.map(\.id))
                    let uniqueBackground = (background?.conversations ?? []).filter {
                        seenIds.insert($0.id).inserted
                    }
                    // Set serverOffset from foreground count BEFORE merging.
                    // loadMoreConversations pages the foreground endpoint only,
                    // so the offset must not include merged background rows.
                    self.delegate?.serverOffset = foreground.nextOffset ?? foreground.conversations.count
                    let merged = ConversationListResponse(
                        type: foreground.type,
                        conversations: foreground.conversations + uniqueBackground,
                        hasMore: foreground.hasMore,
                        groups: foreground.groups
                    )
                    self.handleConversationListResponse(merged)
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
}
