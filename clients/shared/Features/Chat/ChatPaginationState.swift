import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChatPaginationState")

/// Owns message-pagination and display-window state: the visible message
/// suffix window and daemon cursor-based history loading.
@MainActor @Observable
public final class ChatPaginationState {

    // MARK: - Constants

    /// Page size for chat message display; older messages are loaded in this increment.
    public static let messagePageSize = 50

    // MARK: - Display window

    /// Number of messages currently revealed at the top of the conversation.
    /// The view slices `messages` to `messages.suffix(displayedMessageCount)`.
    /// Grows by `messagePageSize` each time the user scrolls to the top.
    /// Set to `Int.max` when the user has loaded all history ("show all" mode), so that new
    /// incoming messages don't collapse the window back to `suffix(messagePageSize)`.
    public var displayedMessageCount: Int = messagePageSize

    /// True while a previous-page load is in progress (brief async delay for UX).
    public var isLoadingMoreMessages: Bool = false

    /// The subset of messages visible to the user (excludes subagent notifications,
    /// hidden messages, and messages without renderable content).
    /// Computed from `messageManager.messages` so the Observation framework
    /// tracks the single underlying stored property.
    public var displayedMessages: [ChatMessage] {
        ChatVisibleMessageFilter.visibleMessages(from: messageManager.messages)
    }

    // MARK: - Daemon History Pagination

    /// Timestamp of the oldest loaded message (ms since epoch). Used as the
    /// `beforeTimestamp` cursor when fetching the next older page from the daemon.
    public var historyCursor: Double?

    /// Whether the daemon has indicated that older messages exist beyond the
    /// currently loaded page. Falls back to `false` for older daemons that don't
    /// send `hasMore` in the history response.
    public var hasMoreHistory: Bool = false

    /// Whether there are more messages above the current display window.
    /// True when either:
    ///   1. There are locally loaded messages outside the current display suffix, OR
    ///   2. The daemon has older pages available to fetch.
    /// When `displayedMessageCount == Int.max` (show-all mode), only daemon pages apply.
    public var hasMoreMessages: Bool {
        (displayedMessageCount < displayedMessages.count) || hasMoreHistory
    }

    // MARK: - Timeout

    /// Timeout task that logs a warning at 30s if the daemon is slow, then
    /// clears `isLoadingMoreMessages` at 60s to unblock the user. The 30s
    /// warning preserves the flag to avoid misclassifying late-but-valid
    /// responses (see loadPreviousMessagePage); the 60s hard clear accepts
    /// the risk of a narrow misclassification window to prevent a permanently
    /// stuck loading spinner.
    @ObservationIgnored var loadMoreTimeoutTask: Task<Void, Never>?

    // MARK: - Lifecycle

    deinit {
        loadMoreTimeoutTask?.cancel()
    }

    // MARK: - Dependencies

    /// The message manager whose `messages` property backs the computed `displayedMessages`.
    @ObservationIgnored private let messageManager: ChatMessageManager

    /// Callback invoked when `loadPreviousMessagePage` needs to fetch an older
    /// page from the daemon. The conversation restorer sets this so the daemon
    /// client request is routed through the same pending-history tracking used
    /// for initial loads.
    @ObservationIgnored public var onLoadMoreHistory: ((_ conversationId: String, _ beforeTimestamp: Double) -> Void)?

    /// Closure that supplies the current conversationId from ChatViewModel.
    /// Set after init to avoid capturing `self` before ChatViewModel is fully initialized.
    @ObservationIgnored var conversationIdProvider: () -> String? = { nil }

    // MARK: - Init

    init(
        messageManager: ChatMessageManager
    ) {
        self.messageManager = messageManager
    }

    // MARK: - Public API

    /// Load the previous page of messages by expanding the display window.
    /// When all locally loaded messages are already visible and the daemon has
    /// more history available, requests the next older page from the daemon.
    /// Returns `true` if there were additional messages to reveal or a fetch was started.
    @discardableResult
    public func loadPreviousMessagePage() async -> Bool {
        guard hasMoreMessages, !isLoadingMoreMessages else { return false }

        // If the local display window can still grow, expand it first.
        let locallyHasMore = displayedMessageCount < displayedMessages.count
        if locallyHasMore {
            isLoadingMoreMessages = true
            // Brief delay so the loading indicator is visible before the list shifts.
            try? await Task.sleep(nanoseconds: 150_000_000)
            let next = displayedMessageCount + Self.messagePageSize
            let total = displayedMessages.count
            // When all messages fit within the expanded window, switch to show-all mode
            // (Int.max) so future incoming messages don't shrink the visible history back
            // to a suffix window — the regression described in the parent PR.
            displayedMessageCount = next >= total ? Int.max : next
            isLoadingMoreMessages = false
            return true
        }

        // All local messages are visible — fetch the next page from the daemon.
        let conversationId = conversationIdProvider()
        guard hasMoreHistory, let cursor = historyCursor, let conversationId else { return false }
        isLoadingMoreMessages = true
        // Safety timeout: log a warning if the daemon is slow, but do NOT
        // clear isLoadingMoreMessages here. Callers (ConversationRestorer,
        // IOSConversationStore) use `vm.isLoadingMoreMessages` to decide whether
        // a history response is a pagination load. If the timeout clears the
        // flag before the response arrives, the late-but-valid response is
        // misclassified as an initial load and replaces all messages instead
        // of prepending. The flag is properly cleared by populateFromHistory
        // when the response arrives, or by reconnect/conversation-switch logic if
        // the daemon disconnects.
        // At 60s a hard clear of isLoadingMoreMessages fires to prevent a permanent
        // stuck spinner. This accepts a narrow misclassification window for late
        // responses arriving between 60-65s.
        loadMoreTimeoutTask?.cancel()
        loadMoreTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000) // 30 seconds
            guard let self, !Task.isCancelled, self.isLoadingMoreMessages else { return }
            log.warning("Pagination request still pending after 30s — daemon may be unresponsive")
            try? await Task.sleep(nanoseconds: 30_000_000_000) // +30s = 60s total
            guard !Task.isCancelled, self.isLoadingMoreMessages else { return }
            log.error("Pagination request timed out after 60s — resetting pagination state")
            self.isLoadingMoreMessages = false
            self.loadMoreTimeoutTask = nil
        }
        onLoadMoreHistory?(conversationId, cursor)
        // The loading indicator is cleared by populateFromHistory when the response arrives.
        return true
    }

    /// Reset pagination when the conversation switches or history is reloaded.
    public func resetMessagePagination() {
        displayedMessageCount = Self.messagePageSize
        historyCursor = nil
        hasMoreHistory = false
        loadMoreTimeoutTask?.cancel()
        loadMoreTimeoutTask = nil
        isLoadingMoreMessages = false
    }

}
