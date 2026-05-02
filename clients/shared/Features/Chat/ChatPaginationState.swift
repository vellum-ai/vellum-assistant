import Combine
import Foundation
import Observation
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

    /// Upper bound on the number of items passed to the ForEach. When the
    /// conversation has more messages than this, the view renders a sliding
    /// window of this size which shifts older as the user paginates back and
    /// resets to the newest slice when the user returns to latest via the
    /// scroll-to-latest CTA. Matches the pattern used by iMessage, Slack,
    /// Discord, and other chat clients — a bounded ForEach keeps layout and
    /// identity-diff costs flat regardless of conversation length.
    public static let maxPaginatedWindowSize = 100

    /// Number of messages currently revealed at the top of the conversation.
    /// The view slices `messages` to `messages.suffix(displayedMessageCount)`.
    /// Grows by `messagePageSize` each time the user scrolls to the top.
    /// When `isShowAllMode` is true the window tracks the full message count
    /// so new incoming messages are included automatically.
    public var displayedMessageCount: Int = messagePageSize

    /// When true, the display window auto-tracks the full message count so
    /// new incoming messages don't collapse visible history back to a suffix.
    /// Separate from `displayedMessageCount` to avoid using `Int.max` as a
    /// sentinel — which conflated "don't shrink" (behavioral) with "how many
    /// items" (sizing) and made the ForEach item count unbounded.
    public var isShowAllMode: Bool = false

    /// Starting index within `displayedMessages` of the current paginated
    /// window when in show-all mode. `nil` means "pin to the latest slice"
    /// (window = `suffix(maxPaginatedWindowSize)`) so streaming and new
    /// messages stay visible. A concrete value means the user has paginated
    /// back; the window is anchored at that offset and does not auto-track
    /// the newest messages until the user invokes the scroll-to-latest CTA.
    ///
    /// Only consulted when `isShowAllMode` is true and
    /// `displayedMessages.count > maxPaginatedWindowSize`. Cleared by
    /// `resetMessagePagination()`, `snapWindowToLatest()`, and the
    /// `isShowAllMode` setter when transitioning to `false`.
    public var windowOldestIndex: Int?

    /// True while a previous-page load is in progress (brief async delay for UX).
    public var isLoadingMoreMessages: Bool = false

    /// All visible messages (excludes subagent notifications, hidden messages,
    /// and messages without renderable content). Cached as a stored property
    /// and updated reactively via a Combine subscription to
    /// `messageManager.messagesPublisher`, so views read an O(1) cached value
    /// instead of recomputing the O(n) filter on every body evaluation.
    ///
    /// - SeeAlso: [WWDC23 — Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
    public private(set) var displayedMessages: [ChatMessage] = []

    /// Paginated suffix of visible messages for the current display window.
    /// Cached as a stored property so `MessageListView.body` reads it in O(1)
    /// instead of running the O(n) visibility filter on every body evaluation.
    /// Updated when either the message list or `displayedMessageCount` changes.
    public private(set) var paginatedVisibleMessages: [ChatMessage] = []

    /// Whether `paginatedVisibleMessages` is empty. Cached O(1) boolean so
    /// views needing only emptiness (skeleton/empty-state routing) observe this
    /// instead of the full array — avoiding invalidation on every message mutation.
    public private(set) var isPaginatedEmpty: Bool = true

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
    ///   1. There are locally loaded messages outside the current display suffix
    ///      (non-show-all mode) or above the current sliding window (show-all
    ///      mode with a conversation longer than `maxPaginatedWindowSize`), OR
    ///   2. The daemon has older pages available to fetch.
    public var hasMoreMessages: Bool {
        let visibleCount = displayedMessages.count
        let capHidesLocal: Bool
        if isShowAllMode && visibleCount > Self.maxPaginatedWindowSize {
            let defaultStart = visibleCount - Self.maxPaginatedWindowSize
            let start = min(windowOldestIndex ?? defaultStart, defaultStart)
            capHidesLocal = start > 0
        } else {
            capHidesLocal = false
        }
        return (!isShowAllMode && displayedMessageCount < visibleCount)
            || capHidesLocal
            || hasMoreHistory
    }

    // MARK: - Visible Messages Cache

    // MARK: - Timeout

    /// Timeout task that logs a warning at 30s if the daemon is slow, then
    /// clears `isLoadingMoreMessages` at 60s to unblock the user. The 30s
    /// warning preserves the flag to avoid misclassifying late-but-valid
    /// responses (see loadPreviousMessagePage); the 60s hard clear accepts
    /// the risk of a narrow misclassification window to prevent a permanently
    /// stuck loading spinner.
    @ObservationIgnored var loadMoreTimeoutTask: Task<Void, Never>?

    // MARK: - Lifecycle

    @ObservationIgnored private var messagesSub: AnyCancellable?

    deinit {
        loadMoreTimeoutTask?.cancel()
        messagesSub?.cancel()
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

        // Seed the cache synchronously so the first view read sees correct data.
        recomputeVisibleMessages(from: messageManager.messages)

        messagesSub = messageManager.messagesPublisher
            .dropFirst() // skip the seed value already handled above
            .sink { [weak self] messages in
                self?.recomputeVisibleMessages(from: messages)
            }
    }

    // MARK: - Cache Recomputation

    /// Recomputes `displayedMessages` and `paginatedVisibleMessages` from a
    /// snapshot of the raw message array. Called by the Combine subscription
    /// when messages change, and by mutation sites that alter both `messages`
    /// and `displayedMessageCount` in the same synchronous block.
    func recomputeVisibleMessages(from messages: [ChatMessage]) {
        displayedMessages = ChatVisibleMessageFilter.visibleMessages(from: messages)
        recomputePaginatedSuffix()
    }

    /// Recomputes the paginated slice from the already-cached
    /// `displayedMessages`. In show-all mode with a conversation longer than
    /// `maxPaginatedWindowSize`, the slice is a sliding window anchored at
    /// `windowOldestIndex` (or the newest slice when that is `nil`); all
    /// other cases fall back to a grow-only suffix.
    func recomputePaginatedSuffix() {
        defer {
            let newEmpty = paginatedVisibleMessages.isEmpty
            if newEmpty != isPaginatedEmpty { isPaginatedEmpty = newEmpty }
        }
        let visible = displayedMessages
        if isShowAllMode {
            let cap = Self.maxPaginatedWindowSize
            if visible.count <= cap {
                paginatedVisibleMessages = visible
                windowOldestIndex = nil
                return
            }
            let defaultStart = visible.count - cap
            let requested = windowOldestIndex ?? defaultStart
            // Clamp to a valid window range. A negative `requested` (e.g. from
            // a prior clamp against a shorter array) snaps to 0; a value past
            // `defaultStart` snaps to the newest slice.
            let start = max(0, min(requested, defaultStart))
            // Only persist the clamped value when the user has explicitly
            // anchored the window, so passive resizes (trim, new message
            // append) don't promote `nil` (auto-pin) to a concrete index.
            if windowOldestIndex != nil { windowOldestIndex = start }
            paginatedVisibleMessages = Array(visible[start..<(start + cap)])
            return
        }
        if displayedMessageCount < visible.count {
            paginatedVisibleMessages = Array(visible.suffix(displayedMessageCount))
        } else {
            paginatedVisibleMessages = visible
        }
    }

    // MARK: - Public API

    /// Load the previous page of messages by expanding or shifting the display
    /// window. Priority:
    ///   1. Non-show-all: grow `displayedMessageCount` by one page.
    ///   2. Show-all with cap-hidden local messages: shift `windowOldestIndex`
    ///      older by one page so the locally loaded messages above the window
    ///      become reachable.
    ///   3. Daemon fetch when no local messages remain above the window.
    /// Returns `true` if there were additional messages to reveal or a fetch was started.
    @discardableResult
    public func loadPreviousMessagePage() async -> Bool {
        guard hasMoreMessages, !isLoadingMoreMessages else { return false }

        // If the local display window can still grow, expand it first.
        let locallyHasMore = !isShowAllMode && displayedMessageCount < displayedMessages.count
        if locallyHasMore {
            isLoadingMoreMessages = true
            // Brief delay so the loading indicator is visible before the list shifts.
            try? await Task.sleep(nanoseconds: 150_000_000)
            let next = displayedMessageCount + Self.messagePageSize
            let total = displayedMessages.count
            // When all messages fit within the expanded window, switch to show-all
            // mode so future incoming messages don't shrink the visible history back
            // to a suffix window — the regression described in the parent PR.
            if next >= total {
                isShowAllMode = true
                displayedMessageCount = total
            } else {
                displayedMessageCount = next
            }
            recomputePaginatedSuffix()
            isLoadingMoreMessages = false
            return true
        }

        // Show-all mode: shift the sliding window older if local messages are
        // still hidden above it, before falling through to the daemon fetch.
        if isShowAllMode && displayedMessages.count > Self.maxPaginatedWindowSize {
            let defaultStart = displayedMessages.count - Self.maxPaginatedWindowSize
            let current = min(windowOldestIndex ?? defaultStart, defaultStart)
            if current > 0 {
                isLoadingMoreMessages = true
                try? await Task.sleep(nanoseconds: 150_000_000)
                windowOldestIndex = max(0, current - Self.messagePageSize)
                recomputePaginatedSuffix()
                isLoadingMoreMessages = false
                return true
            }
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
        isShowAllMode = false
        displayedMessageCount = Self.messagePageSize
        windowOldestIndex = nil
        historyCursor = nil
        hasMoreHistory = false
        loadMoreTimeoutTask?.cancel()
        loadMoreTimeoutTask = nil
        isLoadingMoreMessages = false
        recomputeVisibleMessages(from: messageManager.messages)
    }

    /// Reset the sliding window to the newest slice. Invoked from the
    /// "Scroll to latest" CTA so tapping that control takes the user to the
    /// actual newest messages, not just the newest message that happened to
    /// be in the previously-anchored window.
    public func snapWindowToLatest() {
        guard windowOldestIndex != nil else { return }
        windowOldestIndex = nil
        recomputeVisibleMessages(from: messageManager.messages)
    }

}
