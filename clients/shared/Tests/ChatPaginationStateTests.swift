import XCTest
@testable import VellumAssistantShared

/// Tests for the sliding-window pagination state that backs both the macOS
/// and iOS message lists. The core contract:
///
///   - Non-show-all mode: `paginatedVisibleMessages` is a suffix of
///     `displayedMessages` sized by `displayedMessageCount`.
///   - Show-all mode with `displayedMessages.count <= maxPaginatedWindowSize`:
///     `paginatedVisibleMessages == displayedMessages`.
///   - Show-all mode with `displayedMessages.count > maxPaginatedWindowSize`:
///     `paginatedVisibleMessages` is a `maxPaginatedWindowSize`-sized slice
///     anchored at `windowOldestIndex` (or the newest slice when `nil`).
///
///   - `hasMoreMessages` is true whenever messages exist outside the rendered
///     window — locally (non-show-all suffix, show-all sliding window) or
///     remotely (daemon has more history).
///   - `loadPreviousMessagePage` grows the suffix window in non-show-all mode,
///     shifts the sliding window older in show-all mode, and finally fetches
///     from the daemon when no local messages remain above the window.
@MainActor
final class ChatPaginationStateTests: XCTestCase {

    // MARK: - recomputePaginatedSuffix

    func testNonShowAllSuffixWindowMatchesDisplayedMessageCount() {
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: 10)
        let state = ChatPaginationState(messageManager: manager)
        state.displayedMessageCount = 3
        state.recomputePaginatedSuffix()

        XCTAssertEqual(state.paginatedVisibleMessages.count, 3)
        XCTAssertEqual(state.paginatedVisibleMessages.map(\.text), ["m-7", "m-8", "m-9"])
    }

    func testShowAllShorterThanCapRendersEveryMessage() {
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: 20)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.recomputePaginatedSuffix()

        XCTAssertEqual(state.paginatedVisibleMessages.count, 20)
        XCTAssertNil(state.windowOldestIndex, "Short conversations never anchor the window.")
    }

    func testShowAllLongerThanCapDefaultsToNewestSlice() {
        let total = ChatPaginationState.maxPaginatedWindowSize + 50
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: total)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.recomputePaginatedSuffix()

        XCTAssertEqual(state.paginatedVisibleMessages.count, ChatPaginationState.maxPaginatedWindowSize)
        XCTAssertEqual(state.paginatedVisibleMessages.first?.text, "m-50")
        XCTAssertEqual(state.paginatedVisibleMessages.last?.text, "m-\(total - 1)")
        XCTAssertNil(state.windowOldestIndex, "Passive recompute must not promote nil to a concrete anchor.")
    }

    func testShowAllWithConcreteAnchorRendersSlidingWindow() {
        let total = ChatPaginationState.maxPaginatedWindowSize + 50
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: total)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.windowOldestIndex = 10
        state.recomputePaginatedSuffix()

        XCTAssertEqual(state.paginatedVisibleMessages.count, ChatPaginationState.maxPaginatedWindowSize)
        XCTAssertEqual(state.paginatedVisibleMessages.first?.text, "m-10")
        XCTAssertEqual(
            state.paginatedVisibleMessages.last?.text,
            "m-\(10 + ChatPaginationState.maxPaginatedWindowSize - 1)"
        )
        XCTAssertEqual(state.windowOldestIndex, 10)
    }

    func testShowAllAnchorPastDefaultStartClampsToNewestSlice() {
        let total = ChatPaginationState.maxPaginatedWindowSize + 10
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: total)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.windowOldestIndex = 999 // way past the valid range
        state.recomputePaginatedSuffix()

        let defaultStart = total - ChatPaginationState.maxPaginatedWindowSize
        XCTAssertEqual(state.paginatedVisibleMessages.first?.text, "m-\(defaultStart)")
        XCTAssertEqual(state.windowOldestIndex, defaultStart, "Out-of-range anchor clamps to newest slice.")
    }

    func testShowAllNegativeAnchorClampsToZero() {
        let total = ChatPaginationState.maxPaginatedWindowSize + 10
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: total)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.windowOldestIndex = -5
        state.recomputePaginatedSuffix()

        XCTAssertEqual(state.paginatedVisibleMessages.first?.text, "m-0")
        XCTAssertEqual(state.windowOldestIndex, 0)
    }

    func testShowAllConversationShrinksBelowCapClearsAnchor() {
        // Start long enough to anchor the window, then trim to below the cap.
        let total = ChatPaginationState.maxPaginatedWindowSize + 20
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: total)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.windowOldestIndex = 5
        state.recomputePaginatedSuffix()
        XCTAssertEqual(state.windowOldestIndex, 5)

        manager.messages = makeMessages(count: ChatPaginationState.maxPaginatedWindowSize - 5)
        state.recomputeVisibleMessages(from: manager.messages)

        XCTAssertNil(state.windowOldestIndex, "Below-cap conversations must auto-clear the anchor.")
        XCTAssertEqual(state.paginatedVisibleMessages.count, ChatPaginationState.maxPaginatedWindowSize - 5)
    }

    // MARK: - hasMoreMessages

    func testHasMoreMessagesTrueWhenSuffixHidesLocalMessages() {
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: 10)
        let state = ChatPaginationState(messageManager: manager)
        state.displayedMessageCount = 3
        state.recomputePaginatedSuffix()

        XCTAssertTrue(state.hasMoreMessages)
    }

    func testHasMoreMessagesTrueWhenCapHidesLocalMessagesInShowAll() {
        let total = ChatPaginationState.maxPaginatedWindowSize + 50
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: total)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.recomputePaginatedSuffix()

        XCTAssertTrue(
            state.hasMoreMessages,
            "Regression guard for LUM-952: show-all with cap-hidden local messages must be reachable."
        )
    }

    func testHasMoreMessagesFalseWhenEverythingVisibleAndDaemonExhausted() {
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: 10)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.hasMoreHistory = false
        state.recomputePaginatedSuffix()

        XCTAssertFalse(state.hasMoreMessages)
    }

    func testHasMoreMessagesTrueWhenDaemonHasMoreHistory() {
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: 10)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.hasMoreHistory = true
        state.recomputePaginatedSuffix()

        XCTAssertTrue(state.hasMoreMessages)
    }

    // MARK: - loadPreviousMessagePage

    func testLoadPreviousGrowsSuffixWindowInNonShowAllMode() async {
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: 200)
        let state = ChatPaginationState(messageManager: manager)
        state.displayedMessageCount = ChatPaginationState.messagePageSize
        state.recomputePaginatedSuffix()

        let loaded = await state.loadPreviousMessagePage()

        XCTAssertTrue(loaded)
        XCTAssertEqual(
            state.displayedMessageCount,
            ChatPaginationState.messagePageSize * 2
        )
        XCTAssertFalse(state.isLoadingMoreMessages)
    }

    func testLoadPreviousEntersShowAllWhenAllLocalMessagesFitInGrownSuffix() async {
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: ChatPaginationState.messagePageSize + 10)
        let state = ChatPaginationState(messageManager: manager)
        state.displayedMessageCount = ChatPaginationState.messagePageSize
        state.recomputePaginatedSuffix()

        let loaded = await state.loadPreviousMessagePage()

        XCTAssertTrue(loaded)
        XCTAssertTrue(state.isShowAllMode, "Switch to show-all prevents the suffix-shrink regression.")
        XCTAssertEqual(state.displayedMessageCount, ChatPaginationState.messagePageSize + 10)
    }

    func testLoadPreviousShiftsSlidingWindowInShowAll() async {
        let total = ChatPaginationState.maxPaginatedWindowSize + ChatPaginationState.messagePageSize
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: total)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.recomputePaginatedSuffix()
        XCTAssertNil(state.windowOldestIndex)

        let loaded = await state.loadPreviousMessagePage()

        XCTAssertTrue(loaded)
        let defaultStart = total - ChatPaginationState.maxPaginatedWindowSize
        XCTAssertEqual(
            state.windowOldestIndex,
            max(0, defaultStart - ChatPaginationState.messagePageSize)
        )
    }

    func testLoadPreviousShiftsWindowToZeroWithoutClippingBelow() async {
        // Total puts the default start below a full page shift from zero.
        let total = ChatPaginationState.maxPaginatedWindowSize + ChatPaginationState.messagePageSize / 2
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: total)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.recomputePaginatedSuffix()

        let loaded = await state.loadPreviousMessagePage()

        XCTAssertTrue(loaded)
        XCTAssertEqual(state.windowOldestIndex, 0)
        XCTAssertEqual(state.paginatedVisibleMessages.first?.text, "m-0")
    }

    func testLoadPreviousFallsThroughToDaemonFetchWhenAllLocalReachable() async {
        let total = ChatPaginationState.maxPaginatedWindowSize + ChatPaginationState.messagePageSize
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: total)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.hasMoreHistory = true
        state.historyCursor = 1_700_000_000_000.0
        state.conversationIdProvider = { "conv-1" }
        // Simulate the user already having paged to the oldest local message.
        state.windowOldestIndex = 0
        state.recomputePaginatedSuffix()

        var fetches: [(String, Double)] = []
        state.onLoadMoreHistory = { id, ts in fetches.append((id, ts)) }

        let started = await state.loadPreviousMessagePage()

        XCTAssertTrue(started)
        XCTAssertEqual(fetches.count, 1)
        XCTAssertEqual(fetches.first?.0, "conv-1")
        state.loadMoreTimeoutTask?.cancel()
    }

    func testLoadPreviousReturnsFalseWhenExhausted() async {
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: 10)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.hasMoreHistory = false
        state.recomputePaginatedSuffix()

        let loaded = await state.loadPreviousMessagePage()
        XCTAssertFalse(loaded)
    }

    // MARK: - snapWindowToLatest

    func testSnapWindowToLatestClearsAnchorAndRerendersNewestSlice() {
        let total = ChatPaginationState.maxPaginatedWindowSize + 30
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: total)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.windowOldestIndex = 5
        state.recomputePaginatedSuffix()
        XCTAssertEqual(state.paginatedVisibleMessages.first?.text, "m-5")

        state.snapWindowToLatest()

        XCTAssertNil(state.windowOldestIndex)
        let defaultStart = total - ChatPaginationState.maxPaginatedWindowSize
        XCTAssertEqual(state.paginatedVisibleMessages.first?.text, "m-\(defaultStart)")
    }

    func testSnapWindowToLatestNoOpWhenAlreadyPinned() {
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: 10)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true

        state.snapWindowToLatest()

        XCTAssertNil(state.windowOldestIndex)
    }

    // MARK: - resetMessagePagination

    func testResetMessagePaginationClearsWindowAnchor() {
        let manager = ChatMessageManager()
        manager.messages = makeMessages(count: ChatPaginationState.maxPaginatedWindowSize + 20)
        let state = ChatPaginationState(messageManager: manager)
        state.isShowAllMode = true
        state.windowOldestIndex = 5
        state.historyCursor = 1_700_000_000_000.0
        state.hasMoreHistory = true

        state.resetMessagePagination()

        XCTAssertFalse(state.isShowAllMode)
        XCTAssertNil(state.windowOldestIndex)
        XCTAssertNil(state.historyCursor)
        XCTAssertFalse(state.hasMoreHistory)
        XCTAssertEqual(state.displayedMessageCount, ChatPaginationState.messagePageSize)
    }

    // MARK: - Helpers

    private func makeMessages(count: Int) -> [ChatMessage] {
        (0..<count).map { ChatMessage(role: .user, text: "m-\($0)") }
    }
}
