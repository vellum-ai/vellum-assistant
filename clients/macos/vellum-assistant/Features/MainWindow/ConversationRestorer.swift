import Combine
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadConversationRestorer")

/// Delegate protocol so the restorer can read and mutate thread state
/// owned by `ThreadManager`.
@MainActor
protocol ThreadRestorerDelegate: AnyObject {
    var threads: [ThreadModel] { get set }
    var restoreRecentThreads: Bool { get }
    var isLoadingMoreThreads: Bool { get set }
    var hasMoreThreads: Bool { get set }
    var serverOffset: Int { get set }
    /// Returns or lazily creates a ChatViewModel for the given thread.
    func chatViewModel(for threadId: UUID) -> ChatViewModel?
    /// Returns an existing ChatViewModel without creating one (avoids triggering lazy init).
    func existingChatViewModel(for threadId: UUID) -> ChatViewModel?
    func setChatViewModel(_ vm: ChatViewModel, for threadId: UUID)
    func removeChatViewModel(for threadId: UUID)
    func makeViewModel() -> ChatViewModel
    func activateThread(_ id: UUID)
    func createThread()
    func isConversationArchived(_ conversationId: String) -> Bool
    func restoreLastActiveThread()
    func appendThreads(from response: ConversationListResponseMessage)
    /// Returns an existing ChatViewModel matching the given conversation ID, if any.
    func existingChatViewModel(forConversationId conversationId: String) -> ChatViewModel?
    /// Merge daemon attention metadata into an existing thread, allowing the
    /// owner to preserve optimistic local seen/unread state until the daemon
    /// catches up or returns a newer reply.
    func mergeAssistantAttention(
        from item: ConversationListResponseItem,
        intoThreadAt index: Int
    )
}

/// Handles daemon conversation restoration: fetching the conversation list on connect,
/// creating threads for recent conversations, and loading per-thread history on demand.
@MainActor
final class ThreadConversationRestorer {
    /// Maps conversation IDs to thread IDs for in-flight `history_request` messages,
    /// so rapid tab switches don't cause history from one thread to land in another.
    /// Exposed as internal for `@testable` test access.
    var pendingHistoryByConversationId: [String: UUID] = [:]

    private let daemonClient: DaemonClient
    private var connectionCancellable: AnyCancellable?
    private var disconnectCancellable: AnyCancellable?

    weak var delegate: ThreadRestorerDelegate?

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    func startObserving(skipInitialFetch: Bool = false) {
        daemonClient.onConversationListResponse = { [weak self] response in
            self?.handleConversationListResponse(response)
        }
        daemonClient.onHistoryResponse = { [weak self] response in
            self?.handleHistoryResponse(response)
        }
        daemonClient.onConversationTitleUpdated = { [weak self] response in
            self?.handleConversationTitleUpdated(response)
        }
        daemonClient.onSubagentDetailResponse = { [weak self] response in
            self?.handleSubagentDetailResponse(response)
        }
        daemonClient.onMessageContentResponse = { [weak self] response in
            self?.handleMessageContentResponse(response)
        }

        // On first launch after onboarding, skip the initial conversation list fetch
        // so the conversation restorer doesn't override the wake-up conversation thread.
        // The handlers above are still registered for later use (e.g. history loading).
        guard !skipInitialFetch else { return }

        // Reset loading state when the daemon disconnects so the Load More
        // button doesn't stay permanently disabled after a dropped connection.
        disconnectCancellable = daemonClient.$isConnected
            .removeDuplicates()
            .filter { !$0 }
            .sink { [weak self] _ in
                self?.delegate?.isLoadingMoreThreads = false
            }

        connectionCancellable = daemonClient.$isConnected
            .removeDuplicates()
            .filter { $0 }
            .first()
            .sink { [weak self] _ in
                self?.fetchConversationList()
            }
    }

    func loadHistoryIfNeeded(threadId: UUID) {
        guard let delegate else { return }
        guard let thread = delegate.threads.first(where: { $0.id == threadId }) else { return }
        guard let conversationId = thread.conversationId else { return }
        guard let viewModel = delegate.chatViewModel(for: threadId) else { return }
        guard !viewModel.isHistoryLoaded else { return }

        pendingHistoryByConversationId[conversationId] = threadId

        // Wire up the "load more" callback so the view model can request
        // older pages through the same pending-history tracking mechanism.
        viewModel.onLoadMoreHistory = { [weak self] conversationId, beforeTimestamp in
            self?.requestPaginatedHistory(conversationId: conversationId, beforeTimestamp: beforeTimestamp)
        }

        do {
            try daemonClient.sendHistoryRequest(conversationId: conversationId, limit: 50, mode: "light", maxToolResultChars: 1000)
        } catch {
            log.error("Failed to send history_request: \(error.localizedDescription)")
            pendingHistoryByConversationId.removeValue(forKey: conversationId)
        }
    }

    /// Request history re-fetch for a reconnect catch-up. Registers the conversationId
    /// so the response is properly routed back via handleHistoryResponse.
    func requestReconnectHistory(conversationId: String) {
        guard let delegate else { return }
        // Find the thread that owns this conversationId.
        guard let thread = delegate.threads.first(where: { $0.conversationId == conversationId }) else { return }
        pendingHistoryByConversationId[conversationId] = thread.id
        do {
            try daemonClient.sendHistoryRequest(conversationId: conversationId, limit: 50, mode: "light", maxToolResultChars: 1000)
        } catch {
            log.error("Failed to send reconnect history_request: \(error.localizedDescription)")
            pendingHistoryByConversationId.removeValue(forKey: conversationId)
        }
    }

    /// Request an older page of history for a session. Used by the "Load more"
    /// trigger in the message list when all locally loaded messages are visible.
    func requestPaginatedHistory(conversationId: String, beforeTimestamp: Double) {
        guard let delegate else { return }
        guard let thread = delegate.threads.first(where: { $0.conversationId == conversationId }) else {
            // Thread removed from the list during a concurrent reconnect/refresh.
            // Reset loading state so the user isn't stuck with a permanent spinner.
            delegate.existingChatViewModel(forConversationId: conversationId)?.isLoadingMoreMessages = false
            return
        }
        pendingHistoryByConversationId[conversationId] = thread.id
        do {
            try daemonClient.sendHistoryRequest(conversationId: conversationId, limit: 50, beforeTimestamp: beforeTimestamp, mode: "light", maxToolResultChars: 1000)
        } catch {
            log.error("Failed to send paginated history_request: \(error.localizedDescription)")
            pendingHistoryByConversationId.removeValue(forKey: conversationId)
            // Clear the loading indicator on the view model since the request failed.
            if let vm = delegate.existingChatViewModel(for: thread.id) {
                vm.isLoadingMoreMessages = false
            }
        }
    }

    // MARK: - Response Handlers (internal for testability)

    func handleConversationListResponse(_ response: ConversationListResponseMessage) {
        guard let delegate else { return }

        // If ThreadManager is waiting for a "load more" response, route there.
        if delegate.isLoadingMoreThreads {
            delegate.appendThreads(from: response)
            return
        }

        guard delegate.restoreRecentThreads else {
            delegate.restoreLastActiveThread()
            return
        }
        guard !response.conversations.isEmpty else {
            delegate.restoreLastActiveThread()
            return
        }

        // Filter out private threads and conversations bound to external channels
        // (e.g. Telegram). External channel-bound conversations belong to their own
        // lane and should not appear in the desktop conversation list.
        let recentSessions = response.conversations.filter {
            $0.conversationType != "private" && $0.channelBinding?.sourceChannel == nil
        }

        let defaultThreadIsEmpty = delegate.threads.count == 1
            && delegate.chatViewModel(for: delegate.threads[0].id)?.messages.isEmpty ?? true
            && delegate.chatViewModel(for: delegate.threads[0].id)?.conversationId == nil

        var restoredThreads: [ThreadModel] = []
        // Seed the fallback counter past the highest persisted pinned order
        // so legacy threads (nil displayOrder) don't collide with explicit ones.
        let maxPersistedPinnedOrder = recentSessions
            .filter { $0.isPinned ?? false }
            .compactMap { $0.displayOrder.map { Int($0) } }
            .max() ?? -1
        var pinnedCount = maxPersistedPinnedOrder + 1
        for session in recentSessions {
            // If a local thread already exists (e.g. created by
            // createNotificationThread before the session list response arrived),
            // merge server pin/order metadata into it instead of creating a duplicate.
            if let existingIdx = delegate.threads.firstIndex(where: { $0.conversationId == session.id }) {
                let isPinned = session.isPinned ?? false
                delegate.threads[existingIdx].isPinned = isPinned
                delegate.threads[existingIdx].pinnedOrder = isPinned ? (session.displayOrder.map { Int($0) } ?? pinnedCount) : nil
                delegate.threads[existingIdx].displayOrder = session.displayOrder.map { Int($0) }
                delegate.mergeAssistantAttention(from: session, intoThreadAt: existingIdx)
                if isPinned && session.displayOrder == nil { pinnedCount += 1 }
                continue
            }

            let kind: ThreadKind = session.conversationType == "private" ? .private : .standard

            // Preserve user-set titles: if a thread with this session already
            // exists locally and has a non-default title, keep it instead of
            // overwriting with the daemon's auto-generated title.
            let existingTitle = delegate.threads
                .first(where: { $0.conversationId == session.id && $0.title != "New Conversation" })?
                .title
            let title = existingTitle ?? session.title

            let isPinned = session.isPinned ?? false
            let effectiveCreatedAt = session.createdAt ?? session.updatedAt
            let thread = ThreadModel(
                title: title,
                createdAt: Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAt) / 1000.0),
                conversationId: session.id,
                isArchived: delegate.isConversationArchived(session.id),
                isPinned: isPinned,
                pinnedOrder: isPinned ? (session.displayOrder.map { Int($0) } ?? pinnedCount) : nil,
                displayOrder: session.displayOrder.map { Int($0) },
                lastInteractedAt: Date(timeIntervalSince1970: TimeInterval(session.updatedAt) / 1000.0),
                kind: kind,
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
            if isPinned && session.displayOrder == nil { pinnedCount += 1 }
            // VM creation is lazy — only the active thread will get a VM via
            // getOrCreateViewModel() when it's first accessed.
            restoredThreads.append(thread)
        }

        if defaultThreadIsEmpty {
            if let defaultThread = delegate.threads.first {
                delegate.removeChatViewModel(for: defaultThread.id)
            }
            delegate.threads = restoredThreads
        } else {
            delegate.threads = restoredThreads + delegate.threads
        }

        if let firstVisible = restoredThreads.first(where: { !$0.isArchived }) {
            delegate.activateThread(firstVisible.id)
        } else if defaultThreadIsEmpty {
            // All restored threads are archived and the default thread was removed,
            // so create a new empty thread to avoid a blank window.
            delegate.createThread()
        }

        if let hasMore = response.hasMore {
            delegate.hasMoreThreads = hasMore
        }
        delegate.serverOffset = response.conversations.count
        log.info("Restored \(restoredThreads.count) threads from daemon (hasMore: \(response.hasMore ?? false))")
        delegate.restoreLastActiveThread()
    }

    func handleHistoryResponse(_ response: HistoryResponse) {
        guard let threadId = pendingHistoryByConversationId.removeValue(forKey: response.sessionId) else { return }
        guard let viewModel = delegate?.chatViewModel(for: threadId) else { return }

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
        // reconnect-restored threads that didn't go through loadHistoryIfNeeded).
        if viewModel.onLoadMoreHistory == nil {
            viewModel.onLoadMoreHistory = { [weak self] conversationId, beforeTimestamp in
                self?.requestPaginatedHistory(conversationId: conversationId, beforeTimestamp: beforeTimestamp)
            }
        }

        log.info("Loaded \(response.messages.count) history messages for thread \(threadId) (hasMore: \(response.hasMore), isPagination: \(isPaginationLoad))")
    }

    func handleConversationTitleUpdated(_ response: ConversationTitleUpdatedMessage) {
        guard let delegate else { return }
        guard let index = delegate.threads.firstIndex(where: { $0.conversationId == response.conversationId }) else { return }
        delegate.threads[index].title = response.title
    }

    func handleMessageContentResponse(_ response: MessageContentResponse) {
        guard let delegate else { return }
        // Route the full content back to the ChatViewModel that owns this message.
        // We check all threads with existing VMs for a matching daemonMessageId.
        for thread in delegate.threads {
            guard let viewModel = delegate.existingChatViewModel(for: thread.id) else { continue }
            if viewModel.messages.contains(where: { $0.daemonMessageId == response.messageId }) {
                viewModel.handleMessageContentResponse(response)
                return
            }
        }
    }

    func handleSubagentDetailResponse(_ response: SubagentDetailResponse) {
        guard let delegate else { return }
        // Only check threads that already have a VM — subagent events are only
        // relevant to active conversations, so we must not trigger lazy VM
        // creation for every thread in the list.
        for thread in delegate.threads {
            guard let viewModel = delegate.existingChatViewModel(for: thread.id) else { continue }
            if viewModel.activeSubagents.contains(where: { $0.id == response.subagentId }) {
                viewModel.subagentDetailStore.populateFromDetailResponse(response)
                return
            }
        }
    }

    // MARK: - Private

    private func fetchConversationList() {
        do {
            try daemonClient.sendConversationList()
        } catch {
            log.error("Failed to send conversation_list: \(error.localizedDescription)")
        }
    }
}
