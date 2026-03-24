import Combine
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ConversationRestorer")

/// Delegate protocol so the restorer can read and mutate conversation state
/// owned by `ConversationManager`.
@MainActor
protocol ConversationRestorerDelegate: AnyObject {
    var conversations: [ConversationModel] { get set }
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
    private var connectionCancellable: AnyCancellable?
    private var disconnectCancellable: AnyCancellable?

    weak var delegate: ConversationRestorerDelegate?

    init(connectionManager: GatewayConnectionManager, eventStreamClient: EventStreamClient, conversationHistoryClient: any ConversationHistoryClientProtocol = ConversationHistoryClient()) {
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.conversationHistoryClient = conversationHistoryClient
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
                default:
                    break
                }
            }
        }
        // On first launch after onboarding, skip the initial conversation list fetch
        // so the conversation restorer doesn't override the wake-up conversation.
        // The handlers above are still registered for later use (e.g. history loading).
        guard !skipInitialFetch else { return }

        // Reset loading state when the daemon disconnects so the Load More
        // button doesn't stay permanently disabled after a dropped connection.
        disconnectCancellable = connectionManager.$isConnected
            .removeDuplicates()
            .filter { !$0 }
            .sink { [weak self] _ in
                self?.delegate?.isLoadingMoreConversations = false
            }

        connectionCancellable = connectionManager.$isConnected
            .removeDuplicates()
            .filter { $0 }
            .first()
            .sink { [weak self] _ in
                self?.fetchConversationList()
            }
    }

    func loadHistoryIfNeeded(conversationId localId: UUID) {
        guard let delegate else { return }
        guard let conversation = delegate.conversations.first(where: { $0.id == localId }) else { return }
        guard let conversationId = conversation.conversationId else { return }
        guard let viewModel = delegate.chatViewModel(for: localId) else { return }
        guard !viewModel.isHistoryLoaded else { return }

        pendingHistoryByConversationId[conversationId] = localId

        // Wire up the "load more" callback so the view model can request
        // older pages through the same pending-history tracking mechanism.
        viewModel.onLoadMoreHistory = { [weak self] conversationId, beforeTimestamp in
            self?.requestPaginatedHistory(conversationId: conversationId, beforeTimestamp: beforeTimestamp)
        }

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

        guard delegate.restoreRecentConversations else {
            delegate.restoreLastActiveConversation()
            return
        }
        guard !response.conversations.isEmpty else {
            delegate.restoreLastActiveConversation()
            return
        }

        // Filter out private conversations and conversations bound to external channels
        // (e.g. Telegram). External channel-bound conversations belong to their own
        // lane and should not appear in the desktop conversation list.
        let recentConversations = response.conversations.filter {
            $0.conversationType != "private" && $0.channelBinding?.sourceChannel == nil
        }

        let defaultConversationIsEmpty = delegate.conversations.count == 1
            && delegate.chatViewModel(for: delegate.conversations[0].id)?.messages.isEmpty ?? true
            && delegate.chatViewModel(for: delegate.conversations[0].id)?.conversationId == nil

        var restoredConversations: [ConversationModel] = []
        // Seed the fallback counter past the highest persisted pinned order
        // so legacy conversations (nil displayOrder) don't collide with explicit ones.
        let maxPersistedPinnedOrder = recentConversations
            .filter { $0.isPinned ?? false }
            .compactMap { $0.displayOrder.map { Int($0) } }
            .max() ?? -1
        var pinnedCount = maxPersistedPinnedOrder + 1
        for session in recentConversations {
            // If a local conversation already exists (e.g. created by
            // createNotificationConversation before the session list response arrived),
            // merge server pin/order metadata into it instead of creating a duplicate.
            if let existingIdx = delegate.conversations.firstIndex(where: { $0.conversationId == session.id }) {
                let isPinned = session.isPinned ?? false
                delegate.conversations[existingIdx].isPinned = isPinned
                delegate.conversations[existingIdx].pinnedOrder = isPinned ? (session.displayOrder.map { Int($0) } ?? pinnedCount) : nil
                delegate.conversations[existingIdx].displayOrder = session.displayOrder.map { Int($0) }
                delegate.conversations[existingIdx].forkParent = session.forkParent
                delegate.mergeAssistantAttention(from: session, intoConversationAt: existingIdx)
                if isPinned && session.displayOrder == nil { pinnedCount += 1 }
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

            let isPinned = session.isPinned ?? false
            let effectiveCreatedAt = session.createdAt ?? session.updatedAt
            let conversation = ConversationModel(
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
                },
                forkParent: session.forkParent
            )
            if isPinned && session.displayOrder == nil { pinnedCount += 1 }
            // VM creation is lazy — only the active conversation will get a VM via
            // getOrCreateViewModel() when it's first accessed.
            restoredConversations.append(conversation)
        }

        if defaultConversationIsEmpty {
            if let defaultConversation = delegate.conversations.first {
                delegate.removeChatViewModel(for: defaultConversation.id)
            }
            delegate.conversations = restoredConversations
        } else {
            delegate.conversations = restoredConversations + delegate.conversations
        }

        if let firstVisible = restoredConversations.first(where: { !$0.isArchived }) {
            delegate.activateConversation(firstVisible.id)
        } else if defaultConversationIsEmpty {
            // All restored conversations are archived and the default conversation was removed,
            // so create a new empty conversation to avoid a blank window.
            delegate.createConversation()
        }

        if let hasMore = response.hasMore {
            delegate.hasMoreConversations = hasMore
        }
        delegate.serverOffset = response.conversations.count
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

    // MARK: - Private

    private func fetchConversationList() {
        Task { [weak self] in
            guard let self else { return }
            let maxAttempts = 3
            for attempt in 1...maxAttempts {
                if let response = await conversationListClient.fetchConversationList(offset: 0, limit: 50) {
                    self.handleConversationListResponse(response)
                    return
                }
                if attempt < maxAttempts {
                    log.warning("Conversation list fetch attempt \(attempt) of \(maxAttempts) failed, retrying in 2 seconds...")
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
            log.warning("All \(maxAttempts) conversation list fetch attempts failed, falling back to last active conversation")
            self.delegate?.restoreLastActiveConversation()
        }
    }
}
