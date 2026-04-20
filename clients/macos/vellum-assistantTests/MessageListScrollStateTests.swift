import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MessageListScrollStateTests: XCTestCase {
    private var state: MessageListScrollState!

    override func setUp() {
        super.setUp()
        state = MessageListScrollState()
    }

    override func tearDown() {
        state.cancelAll()
        state = nil
        super.tearDown()
    }

    private func message(
        id: UUID = UUID(),
        role: ChatRole,
        text: String? = nil,
        status: ChatMessageStatus = .sent
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            role: role,
            text: text ?? (role == .user ? "User" : "Assistant"),
            status: status
        )
    }

    private func makeMessageListView(
        messages: [ChatMessage],
        paginatedVisibleMessages: [ChatMessage]? = nil,
        isSending: Bool,
        assistantActivityPhase: String = "",
        conversationId: UUID = UUID()
    ) -> MessageListView {
        var anchorMessageId: UUID?
        var highlightedMessageId: UUID?
        return MessageListView(
            messages: messages,
            messagesRevision: 0,
            isSending: isSending,
            isThinking: false,
            isCompacting: false,
            assistantActivityPhase: assistantActivityPhase,
            assistantActivityAnchor: "",
            assistantActivityReason: nil,
            assistantStatusText: nil,
            selectedModel: "test-model",
            configuredProviders: [],
            providerCatalog: [],
            activeSubagents: [],
            dismissedDocumentSurfaceIds: [],
            onConfirmationAllow: nil,
            onConfirmationDeny: nil,
            onAlwaysAllow: nil,
            onTemporaryAllow: nil,
            onSurfaceAction: nil,
            onGuardianAction: nil,
            onDismissDocumentWidget: nil,
            onForkFromMessage: nil,
            showInspectButton: false,
            isTTSEnabled: false,
            onInspectMessage: nil,
            mediaEmbedSettings: nil,
            onAbortSubagent: nil,
            onSubagentTap: nil,
            onRehydrateMessage: nil,
            onSurfaceRefetch: nil,
            onRetryFailedMessage: nil,
            onRetryConversationError: nil,
            subagentDetailStore: SubagentDetailStore(),
            activePendingRequestId: nil,
            paginatedVisibleMessages: paginatedVisibleMessages ?? messages,
            displayedMessageCount: .max,
            hasMoreMessages: false,
            isLoadingMoreMessages: false,
            loadPreviousMessagePage: nil,
            conversationId: conversationId,
            anchorMessageId: Binding(
                get: { anchorMessageId },
                set: { anchorMessageId = $0 }
            ),
            highlightedMessageId: Binding(
                get: { highlightedMessageId },
                set: { highlightedMessageId = $0 }
            ),
            isInteractionEnabled: true,
            containerWidth: 0
        )
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertFalse(state.showScrollToLatest,
                       "Should not show scroll-to-latest initially")
        XCTAssertFalse(state.scrollIndicatorsHidden,
                       "Scroll indicators should be visible initially")
        XCTAssertNil(state.pinnedLatestTurnAnchorMessageId)
        XCTAssertNil(state.lastMessageId)
        XCTAssertNil(state.currentConversationId)
        XCTAssertEqual(state.scrollContentHeight, 0)
        XCTAssertEqual(state.scrollContainerHeight, 0)
        XCTAssertEqual(state.lastContentOffsetY, 0)
    }

    // MARK: - updateScrollToLatest: Distance Threshold

    func testUpdateScrollToLatestShowsWhenFarFromBottom() {
        // Inverted scroll: lastContentOffsetY IS distanceFromBottom
        state.lastContentOffsetY = 2200  // distanceFromBottom = 2200

        state.updateScrollToLatest()

        XCTAssertTrue(state.showScrollToLatest,
                      "Should show scroll-to-latest when distanceFromBottom > 400")
    }

    func testUpdateScrollToLatestHidesWhenNearBottom() {
        // Inverted scroll: lastContentOffsetY IS distanceFromBottom
        state.lastContentOffsetY = 100  // distanceFromBottom = 100

        state.updateScrollToLatest()

        XCTAssertFalse(state.showScrollToLatest,
                       "Should hide scroll-to-latest when distanceFromBottom <= 400")
    }

    func testUpdateScrollToLatestExactThreshold() {
        // Inverted scroll: lastContentOffsetY IS distanceFromBottom
        state.lastContentOffsetY = 400  // distanceFromBottom = 400

        state.updateScrollToLatest()

        XCTAssertFalse(state.showScrollToLatest,
                       "Should hide scroll-to-latest when distanceFromBottom == 400 (threshold is >400)")
    }

    func testUpdateScrollToLatestJustAboveThreshold() {
        // Inverted scroll: lastContentOffsetY IS distanceFromBottom
        state.lastContentOffsetY = 401  // distanceFromBottom = 401

        state.updateScrollToLatest()

        XCTAssertTrue(state.showScrollToLatest,
                      "Should show scroll-to-latest when distanceFromBottom == 401 (> 400)")
    }

    func testUpdateScrollToLatestAtBottom() {
        // Inverted scroll: 0 = at visual bottom (latest messages)
        state.lastContentOffsetY = 0  // distanceFromBottom = 0

        state.updateScrollToLatest()

        XCTAssertFalse(state.showScrollToLatest,
                       "Should hide scroll-to-latest when at bottom")
    }

    func testUpdateScrollToLatestTogglesCorrectly() {
        // Start far from bottom (inverted scroll: offset = distance)
        state.lastContentOffsetY = 2000
        state.updateScrollToLatest()
        XCTAssertTrue(state.showScrollToLatest)

        // Scroll to bottom (offset 0 = at latest messages)
        state.lastContentOffsetY = 0  // distanceFromBottom = 0
        state.updateScrollToLatest()
        XCTAssertFalse(state.showScrollToLatest,
                       "Should toggle off when scrolled back to bottom")
    }

    // MARK: - updateScrollToLatest: Hysteresis Band

    func testUpdateScrollToLatestStaysVisibleInsideHysteresisBand() {
        // Show the CTA first (inverted scroll: offset = distance).
        state.lastContentOffsetY = 2200  // distanceFromBottom = 2200
        state.updateScrollToLatest()
        XCTAssertTrue(state.showScrollToLatest)

        // Drop distance into the 200..400 band — should stay visible.
        state.lastContentOffsetY = 300  // distanceFromBottom = 300
        state.updateScrollToLatest()
        XCTAssertTrue(state.showScrollToLatest,
                      "Once visible, CTA should stay visible inside the 200..400 hysteresis band")
    }

    func testUpdateScrollToLatestHidesBelowLowThreshold() {
        // Inverted scroll: offset = distance from bottom.
        state.lastContentOffsetY = 2200  // distanceFromBottom = 2200
        state.updateScrollToLatest()
        XCTAssertTrue(state.showScrollToLatest)

        // Drop below the 200pt hide threshold — should hide.
        state.lastContentOffsetY = 199  // distanceFromBottom = 199
        state.updateScrollToLatest()
        XCTAssertFalse(state.showScrollToLatest,
                       "Should hide once distanceFromBottom drops below 200")
    }

    func testUpdateScrollToLatestHiddenStaysHiddenInsideHysteresisBand() {
        // Start hidden.
        XCTAssertFalse(state.showScrollToLatest)

        // Put distance inside the 200..400 band — should remain hidden
        // because the show threshold (>400) was never crossed.
        // Inverted scroll: offset = distance from bottom.
        state.lastContentOffsetY = 399  // distanceFromBottom = 399
        state.updateScrollToLatest()
        XCTAssertFalse(state.showScrollToLatest,
                       "Hidden CTA should not appear until distanceFromBottom exceeds 400")

        state.lastContentOffsetY = 200  // distanceFromBottom = 200
        state.updateScrollToLatest()
        XCTAssertFalse(state.showScrollToLatest,
                       "Hidden CTA should not appear at the low threshold either")
    }

    func testUpdateScrollToLatestHysteresisDoesNotFlickerAroundShowThreshold() {
        // Reproduce the scenario the fix targets: geometry noise that
        // oscillates across the 400pt show threshold should not toggle
        // visibility repeatedly once the CTA is hidden — the low threshold
        // must be crossed first for it to appear.
        // Inverted scroll: lastContentOffsetY = distanceFromBottom.
        state.lastContentOffsetY = 401  // distanceFromBottom = 401
        state.updateScrollToLatest()
        XCTAssertTrue(state.showScrollToLatest, "Crosses show threshold → visible")

        // Bounce to 399 (noise): must stay visible (inside the band).
        state.lastContentOffsetY = 399  // distanceFromBottom = 399
        state.updateScrollToLatest()
        XCTAssertTrue(state.showScrollToLatest,
                      "Noise in the hysteresis band must not toggle visibility")

        // Bounce back to 410: still visible, no flicker.
        state.lastContentOffsetY = 410  // distanceFromBottom = 410
        state.updateScrollToLatest()
        XCTAssertTrue(state.showScrollToLatest)
    }

    // MARK: - reset(for:)

    func testResetClearsAllState() {
        let newId = UUID()

        // Set up non-default state (inverted scroll: offset = distance from bottom)
        state.scrollContentHeight = 5000
        state.scrollContainerHeight = 800
        state.lastContentOffsetY = 2000  // distanceFromBottom = 2000
        state.lastMessageId = UUID()
        state.pinnedLatestTurnAnchorMessageId = UUID()
        state.currentConversationId = UUID()
        state.wasPaginationTriggerInRange = true
        state.lastPaginationCompletedAt = Date()
        state.updateScrollToLatest()
        XCTAssertTrue(state.showScrollToLatest)

        // Reset
        state.reset(for: newId)

        XCTAssertEqual(state.currentConversationId, newId)
        XCTAssertNil(state.pinnedLatestTurnAnchorMessageId)
        XCTAssertNil(state.lastMessageId)
        XCTAssertEqual(state.scrollContentHeight, 0)
        XCTAssertEqual(state.scrollContainerHeight, 0)
        XCTAssertEqual(state.lastContentOffsetY, 0)
        XCTAssertFalse(state.showScrollToLatest)
        XCTAssertFalse(state.wasPaginationTriggerInRange)
        XCTAssertEqual(state.lastPaginationCompletedAt, .distantPast)
    }

    func testResetClearsAnchorState() {
        state.anchorSetTime = Date()
        state.anchorTimeoutTask = Task { try? await Task.sleep(nanoseconds: 1_000_000_000) }

        state.reset(for: UUID())

        XCTAssertNil(state.anchorSetTime)
        XCTAssertNil(state.anchorTimeoutTask)
    }

    func testResetClearsDerivedStateCache() {
        state.derivedStateCache.messageListVersion = 5
        state.derivedStateCache.lastKnownMessagesRevision = 10
        state.derivedStateCache.cachedFirstVisibleMessageId = UUID()

        state.reset(for: UUID())

        XCTAssertEqual(state.derivedStateCache.messageListVersion, 0)
        XCTAssertEqual(state.derivedStateCache.lastKnownMessagesRevision, 0)
        XCTAssertNil(state.derivedStateCache.cachedFirstVisibleMessageId)
        XCTAssertNil(state.derivedStateCache.cachedProjectionKey)
        XCTAssertNil(state.derivedStateCache.cachedProjection)
    }

    func testResetHidesScrollIndicatorsBriefly() {
        state.reset(for: UUID())

        XCTAssertTrue(state.scrollIndicatorsHidden,
                      "Should hide scroll indicators during conversation switch")
    }

    func testResetScrollIndicatorsRestoreAfterDelay() async throws {
        state.reset(for: UUID())
        XCTAssertTrue(state.scrollIndicatorsHidden)

        try await Task.sleep(nanoseconds: 400_000_000)

        XCTAssertFalse(state.scrollIndicatorsHidden,
                       "Scroll indicators should restore after 300ms delay")
    }

    // MARK: - handlePaginationSentinel: Rising-Edge Detection

    func testPaginationSentinelFiresOnRisingEdge() {
        // Start out of range
        state.wasPaginationTriggerInRange = false

        // Enter the trigger band (sentinelMinY > -200)
        let shouldFire = state.handlePaginationSentinel(sentinelMinY: -100)

        XCTAssertTrue(shouldFire,
                      "Should fire on rising edge (out-of-range to in-range)")
    }

    func testPaginationSentinelDoesNotFireWhenAlreadyInRange() {
        // Already in range
        state.wasPaginationTriggerInRange = true

        let shouldFire = state.handlePaginationSentinel(sentinelMinY: -100)

        XCTAssertFalse(shouldFire,
                       "Should not fire when already in range (no rising edge)")
    }

    func testPaginationSentinelDoesNotFireWhenOutOfRange() {
        state.wasPaginationTriggerInRange = false

        let shouldFire = state.handlePaginationSentinel(sentinelMinY: -300)

        XCTAssertFalse(shouldFire,
                       "Should not fire when sentinel is outside trigger band")
    }

    func testPaginationSentinelCooldown() {
        // Fire once
        state.wasPaginationTriggerInRange = false
        let first = state.handlePaginationSentinel(sentinelMinY: -100)
        XCTAssertTrue(first)

        // Record completion
        state.lastPaginationCompletedAt = Date()

        // Move out and back in — should be blocked by cooldown
        state.wasPaginationTriggerInRange = false
        let second = state.handlePaginationSentinel(sentinelMinY: -100)
        XCTAssertFalse(second,
                       "Should be blocked by 500ms cooldown")
    }

    func testPaginationSentinelFiresAfterCooldown() async throws {
        // Fire once and record completion
        state.wasPaginationTriggerInRange = false
        let first = state.handlePaginationSentinel(sentinelMinY: -100)
        XCTAssertTrue(first)
        state.lastPaginationCompletedAt = Date()

        // Wait for cooldown
        try await Task.sleep(nanoseconds: 600_000_000)

        // Move out and back in
        state.wasPaginationTriggerInRange = false
        let second = state.handlePaginationSentinel(sentinelMinY: -100)
        XCTAssertTrue(second,
                      "Should fire after 500ms cooldown expires")
    }

    func testPaginationCooldownResetOnConversationSwitch() {
        state.lastPaginationCompletedAt = Date()
        state.reset(for: UUID())
        XCTAssertEqual(state.lastPaginationCompletedAt, .distantPast,
                       "Cooldown should be reset on conversation switch")
    }

    // MARK: - hideScrollIndicatorsBriefly

    func testHideScrollIndicatorsBriefly() {
        XCTAssertFalse(state.scrollIndicatorsHidden)

        state.hideScrollIndicatorsBriefly()

        XCTAssertTrue(state.scrollIndicatorsHidden,
                      "Should hide scroll indicators immediately")
    }

    func testHideScrollIndicatorsRestoresAfterDelay() async throws {
        state.hideScrollIndicatorsBriefly()
        XCTAssertTrue(state.scrollIndicatorsHidden)

        try await Task.sleep(nanoseconds: 400_000_000)

        XCTAssertFalse(state.scrollIndicatorsHidden,
                       "Should restore scroll indicators after 300ms")
    }

    func testHideScrollIndicatorsResetsTimer() async throws {
        state.hideScrollIndicatorsBriefly()
        XCTAssertTrue(state.scrollIndicatorsHidden)

        // Wait 200ms, then re-hide
        try await Task.sleep(nanoseconds: 200_000_000)
        state.hideScrollIndicatorsBriefly()

        // Wait another 200ms — original timer would have expired
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(state.scrollIndicatorsHidden,
                      "Timer should be reset — still hidden")

        // Wait for new timer to expire
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(state.scrollIndicatorsHidden,
                       "Should restore after reset timer expires")
    }

    // MARK: - distanceFromBottom

    func testDistanceFromBottomCalculation() {
        // Inverted scroll: distanceFromBottom = lastContentOffsetY directly.
        // 0 = at visual bottom (latest messages), increases toward older messages.
        state.lastContentOffsetY = 500

        XCTAssertEqual(state.distanceFromBottom, 500,
                       "distanceFromBottom = lastContentOffsetY (inverted scroll)")
    }

    func testDistanceFromBottomAtBottom() {
        // Inverted scroll: 0 offset = at visual bottom (latest messages).
        state.lastContentOffsetY = 0

        XCTAssertEqual(state.distanceFromBottom, 0,
                       "Should be 0 when scrolled to bottom (offset = 0)")
    }

    // MARK: - cancelAll

    func testCancelAllResetsState() {
        // Inverted scroll: offset = distance from bottom
        state.scrollContentHeight = 5000
        state.scrollContainerHeight = 800
        state.lastContentOffsetY = 2000  // distanceFromBottom = 2000
        state.pinnedLatestTurnAnchorMessageId = UUID()
        state.updateScrollToLatest()
        XCTAssertTrue(state.showScrollToLatest)

        state.cancelAll()

        XCTAssertNil(state.pinnedLatestTurnAnchorMessageId)
        XCTAssertFalse(state.showScrollToLatest)
        XCTAssertFalse(state.scrollIndicatorsHidden)
        XCTAssertEqual(state.scrollContentHeight, 0)
    }

    // MARK: - Latest-turn pinning lifecycle

    func testPinnedLatestTurnAnchorSetOnRealUserSend() {
        let user = message(role: .user)
        let view = makeMessageListView(messages: [user], isSending: true)
        view.scrollState.currentConversationId = view.conversationId

        view.handleSendingChanged()

        XCTAssertEqual(view.scrollState.pinnedLatestTurnAnchorMessageId, user.id)
    }

    func testPinnedLatestTurnAnchorNotSetOnConfirmationResume() {
        let user = message(role: .user)
        let view = makeMessageListView(messages: [user], isSending: true)
        view.scrollState.currentConversationId = view.conversationId
        view.scrollState.lastActivityPhaseWhenIdle = "awaiting_confirmation"

        view.handleSendingChanged()

        XCTAssertNil(view.scrollState.pinnedLatestTurnAnchorMessageId)
    }

    func testPinnedLatestTurnAnchorPreservedWhenSendingEnds() {
        let user = message(role: .user)
        let view = makeMessageListView(messages: [user], isSending: false)
        view.scrollState.currentConversationId = view.conversationId
        view.scrollState.pinnedLatestTurnAnchorMessageId = user.id

        view.handleSendingChanged()

        XCTAssertEqual(view.scrollState.pinnedLatestTurnAnchorMessageId, user.id)
    }

    func testPinnedLatestTurnAnchorReplacedOnNextSend() {
        let firstUser = message(role: .user)
        let assistant = message(role: .assistant)
        let secondUser = message(role: .user)
        let view = makeMessageListView(
            messages: [firstUser, assistant, secondUser],
            isSending: true
        )
        view.scrollState.currentConversationId = view.conversationId
        view.scrollState.pinnedLatestTurnAnchorMessageId = firstUser.id

        view.handleSendingChanged()

        XCTAssertEqual(view.scrollState.pinnedLatestTurnAnchorMessageId, secondUser.id)
    }

    func testPinnedLatestTurnAnchorClearedOnConversationSwitch() {
        let user = message(role: .user)
        let conversationId = UUID()
        let view = makeMessageListView(
            messages: [user],
            isSending: false,
            conversationId: conversationId
        )
        view.scrollState.pinnedLatestTurnAnchorMessageId = user.id
        view.scrollState.currentConversationId = UUID()

        view.handleConversationSwitched()

        XCTAssertNil(view.scrollState.pinnedLatestTurnAnchorMessageId)
        XCTAssertEqual(view.scrollState.currentConversationId, conversationId)
    }

    func testPinnedLatestTurnAnchorIgnoresQueuedFollowUpMessages() {
        let sentUser = message(role: .user)
        let assistant = message(role: .assistant)
        let queuedFollowUp = message(role: .user, status: .queued(position: 1))
        let view = makeMessageListView(
            messages: [sentUser, assistant, queuedFollowUp],
            isSending: true
        )
        view.scrollState.currentConversationId = view.conversationId
        view.scrollState.lastMessageId = assistant.id

        view.handleMessagesCountChanged()

        XCTAssertNil(view.scrollState.pinnedLatestTurnAnchorMessageId)
    }
}
