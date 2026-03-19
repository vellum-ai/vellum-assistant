import XCTest
@testable import VellumAssistantLib

@MainActor
final class ChatBottomPinCoordinatorTests: XCTestCase {
    private var coordinator: ChatBottomPinCoordinator!
    private var pinRequestCount: Int = 0
    private var lastPinReason: BottomPinRequestReason?
    private var lastPinAnimated: Bool?
    private var pinShouldSucceed: Bool = true
    private var followStateChanges: [Bool] = []

    override func setUp() {
        super.setUp()
        coordinator = ChatBottomPinCoordinator()
        pinRequestCount = 0
        lastPinReason = nil
        lastPinAnimated = nil
        pinShouldSucceed = true
        followStateChanges = []

        coordinator.onPinRequested = { [weak self] reason, animated in
            self?.pinRequestCount += 1
            self?.lastPinReason = reason
            self?.lastPinAnimated = animated
            return self?.pinShouldSucceed ?? false
        }
        coordinator.onFollowStateChanged = { [weak self] isFollowing in
            self?.followStateChanges.append(isFollowing)
        }
    }

    override func tearDown() {
        coordinator = nil
        super.tearDown()
    }

    // MARK: - Initial State

    func testInitialStateIsFollowingBottom() {
        XCTAssertTrue(coordinator.isFollowingBottom)
        XCTAssertNil(coordinator.activeSession)
    }

    // MARK: - Detach on Upward Scroll

    func testScrollUpDetachesFromBottom() {
        coordinator.handleUserAction(.scrollUp)

        XCTAssertFalse(coordinator.isFollowingBottom)
        XCTAssertEqual(followStateChanges, [false])
    }

    func testScrollUpCancelsActiveSession() {
        let convId = UUID()
        pinShouldSucceed = false
        coordinator.requestPin(reason: .streaming, conversationId: convId)
        XCTAssertNotNil(coordinator.activeSession)

        coordinator.handleUserAction(.scrollUp)

        XCTAssertFalse(coordinator.isFollowingBottom)
        XCTAssertNil(coordinator.activeSession)
    }

    func testRepeatedScrollUpDoesNotDuplicateStateChange() {
        coordinator.handleUserAction(.scrollUp)
        coordinator.handleUserAction(.scrollUp)

        XCTAssertFalse(coordinator.isFollowingBottom)
        // Only one state change callback should fire.
        XCTAssertEqual(followStateChanges, [false])
    }

    // MARK: - Re-arm After Explicit Return to Bottom

    func testScrollToBottomReattaches() {
        coordinator.handleUserAction(.scrollUp)
        XCTAssertFalse(coordinator.isFollowingBottom)

        coordinator.handleUserAction(.scrollToBottom)

        XCTAssertTrue(coordinator.isFollowingBottom)
        XCTAssertEqual(followStateChanges, [false, true])
    }

    func testJumpToLatestReattaches() {
        coordinator.handleUserAction(.scrollUp)
        coordinator.handleUserAction(.jumpToLatest)

        XCTAssertTrue(coordinator.isFollowingBottom)
        XCTAssertEqual(followStateChanges, [false, true])
    }

    func testReattachWhenAlreadyFollowingDoesNotFireCallback() {
        coordinator.handleUserAction(.scrollToBottom)

        // Should not fire since we were already following.
        XCTAssertEqual(followStateChanges, [])
    }

    // MARK: - Suppression While Detached

    func testPinRequestSuppressedWhileDetached() {
        let convId = UUID()
        coordinator.handleUserAction(.scrollUp)

        coordinator.requestPin(reason: .streaming, conversationId: convId)

        XCTAssertEqual(pinRequestCount, 0)
        XCTAssertNil(coordinator.activeSession)
    }

    func testPinRequestSuppressedForMessageCountWhileDetached() {
        let convId = UUID()
        coordinator.handleUserAction(.scrollUp)

        coordinator.requestPin(reason: .messageCount, conversationId: convId)

        XCTAssertEqual(pinRequestCount, 0)
    }

    func testPinRequestSuppressedForExpansionWhileDetached() {
        let convId = UUID()
        coordinator.handleUserAction(.scrollUp)

        coordinator.requestPin(reason: .expansion, conversationId: convId)

        XCTAssertEqual(pinRequestCount, 0)
    }

    func testPinRequestAllowedAfterReattach() {
        let convId = UUID()
        coordinator.handleUserAction(.scrollUp)
        coordinator.requestPin(reason: .streaming, conversationId: convId)
        XCTAssertEqual(pinRequestCount, 0)

        coordinator.handleUserAction(.scrollToBottom)
        coordinator.requestPin(reason: .streaming, conversationId: convId)

        XCTAssertEqual(pinRequestCount, 1)
    }

    // MARK: - Coalescing Duplicate Requests

    func testDuplicateExpansionRequestsCoalesce() {
        let convId = UUID()
        pinShouldSucceed = false

        coordinator.requestPin(reason: .expansion, conversationId: convId)
        let firstSessionStartTime = coordinator.activeSession?.startTime

        // Second expansion request should coalesce.
        coordinator.requestPin(reason: .expansion, conversationId: convId)

        // Should still be the same session (same start time).
        XCTAssertEqual(coordinator.activeSession?.startTime, firstSessionStartTime)
        // Only one pin call from the initial session start.
        XCTAssertEqual(pinRequestCount, 1)
    }

    func testDuplicateStreamingRequestsCoalesce() {
        let convId = UUID()
        pinShouldSucceed = false

        coordinator.requestPin(reason: .streaming, conversationId: convId)
        let firstStartTime = coordinator.activeSession?.startTime

        coordinator.requestPin(reason: .streaming, conversationId: convId)

        XCTAssertEqual(coordinator.activeSession?.startTime, firstStartTime)
        XCTAssertEqual(pinRequestCount, 1)
    }

    func testDifferentReasonsDoNotCoalesce() {
        let convId = UUID()
        pinShouldSucceed = false

        coordinator.requestPin(reason: .expansion, conversationId: convId)
        let firstStartTime = coordinator.activeSession?.startTime

        coordinator.requestPin(reason: .resize, conversationId: convId)

        // Should be a new session with a new start time.
        XCTAssertNotEqual(coordinator.activeSession?.startTime, firstStartTime)
    }

    func testDifferentConversationsDoNotCoalesce() {
        let conv1 = UUID()
        let conv2 = UUID()
        pinShouldSucceed = false

        coordinator.requestPin(reason: .expansion, conversationId: conv1)
        let firstConvSession = coordinator.activeSession

        coordinator.requestPin(reason: .expansion, conversationId: conv2)

        // New session for the different conversation.
        XCTAssertNotEqual(coordinator.activeSession?.conversationId, firstConvSession?.conversationId)
        XCTAssertEqual(coordinator.activeSession?.conversationId, conv2)
    }

    // MARK: - Bounded Retry Sessions

    func testSessionCapsRetries() {
        var session = BottomPinSession(
            conversationId: UUID(),
            reason: .expansion,
            startTime: CFAbsoluteTimeGetCurrent()
        )

        for _ in 0..<BottomPinSession.maxRetries {
            XCTAssertFalse(session.isExhausted)
            let recorded = session.recordAttempt()
            XCTAssertTrue(recorded)
        }

        XCTAssertTrue(session.isExhausted)
        let overBudget = session.recordAttempt()
        XCTAssertFalse(overBudget)
        XCTAssertEqual(session.attemptCount, BottomPinSession.maxRetries)
    }

    func testExhaustedSessionDoesNotCoalesce() {
        var session = BottomPinSession(
            conversationId: UUID(),
            reason: .expansion,
            startTime: CFAbsoluteTimeGetCurrent()
        )

        for _ in 0..<BottomPinSession.maxRetries {
            session.recordAttempt()
        }

        XCTAssertFalse(session.canCoalesce(reason: .expansion, conversationId: session.conversationId))
    }

    func testSuccessfulPinCompletesSession() {
        let convId = UUID()
        pinShouldSucceed = true

        coordinator.requestPin(reason: .initialRestore, conversationId: convId)

        // Successful pin on first attempt should clear the session.
        XCTAssertEqual(pinRequestCount, 1)
        XCTAssertNil(coordinator.activeSession)
    }

    // MARK: - Cancellation Triggers

    func testDeepLinkAnchorCancelsSession() {
        let convId = UUID()
        pinShouldSucceed = false

        coordinator.requestPin(reason: .streaming, conversationId: convId)
        XCTAssertNotNil(coordinator.activeSession)

        coordinator.cancelActiveSession(reason: .deepLinkAnchorHandoff)

        XCTAssertNil(coordinator.activeSession)
    }

    func testPaginationRestoreCancelsSession() {
        let convId = UUID()
        pinShouldSucceed = false

        coordinator.requestPin(reason: .messageCount, conversationId: convId)
        XCTAssertNotNil(coordinator.activeSession)

        coordinator.cancelActiveSession(reason: .paginationRestore)

        XCTAssertNil(coordinator.activeSession)
    }

    func testConversationSwitchCancelsSession() {
        let convId = UUID()
        pinShouldSucceed = false

        coordinator.requestPin(reason: .streaming, conversationId: convId)
        XCTAssertNotNil(coordinator.activeSession)

        coordinator.cancelActiveSession(reason: .conversationSwitch)

        XCTAssertNil(coordinator.activeSession)
    }

    // MARK: - Reset

    func testResetClearsAllStateAndReattaches() {
        let convId = UUID()
        pinShouldSucceed = false

        coordinator.handleUserAction(.scrollUp)
        coordinator.requestPin(reason: .expansion, conversationId: convId)
        XCTAssertFalse(coordinator.isFollowingBottom)

        let newConvId = UUID()
        coordinator.reset(newConversationId: newConvId)

        XCTAssertTrue(coordinator.isFollowingBottom)
        XCTAssertNil(coordinator.activeSession)
    }

    // MARK: - Pin Session Struct

    func testSessionCoalesceRequiresSameConversation() {
        let convA = UUID()
        let convB = UUID()
        let session = BottomPinSession(
            conversationId: convA,
            reason: .expansion,
            startTime: CFAbsoluteTimeGetCurrent()
        )

        XCTAssertTrue(session.canCoalesce(reason: .expansion, conversationId: convA))
        XCTAssertFalse(session.canCoalesce(reason: .expansion, conversationId: convB))
    }

    func testSessionCoalesceRequiresSameReason() {
        let convId = UUID()
        let session = BottomPinSession(
            conversationId: convId,
            reason: .streaming,
            startTime: CFAbsoluteTimeGetCurrent()
        )

        XCTAssertTrue(session.canCoalesce(reason: .streaming, conversationId: convId))
        XCTAssertFalse(session.canCoalesce(reason: .expansion, conversationId: convId))
        XCTAssertFalse(session.canCoalesce(reason: .resize, conversationId: convId))
        XCTAssertFalse(session.canCoalesce(reason: .messageCount, conversationId: convId))
        XCTAssertFalse(session.canCoalesce(reason: .initialRestore, conversationId: convId))
    }

    // MARK: - Async Retry Behavior

    func testRetryLoopStopsOnSuccess() async throws {
        let convId = UUID()
        var callCount = 0
        pinShouldSucceed = false

        coordinator.onPinRequested = { [weak self] reason, animated in
            callCount += 1
            self?.pinRequestCount = callCount
            // Succeed on the third attempt.
            if callCount >= 3 {
                return true
            }
            return false
        }

        coordinator.requestPin(reason: .initialRestore, conversationId: convId)

        // Allow the retry loop to run.
        try await Task.sleep(nanoseconds: 300_000_000)

        // Should have stopped after success (3 attempts), not continued to maxRetries.
        XCTAssertGreaterThanOrEqual(callCount, 3)
        XCTAssertLessThanOrEqual(callCount, BottomPinSession.maxRetries)
        XCTAssertNil(coordinator.activeSession)
    }

    func testRetryLoopAbortsOnDetach() async throws {
        let convId = UUID()
        var callCount = 0
        pinShouldSucceed = false

        coordinator.onPinRequested = { reason, animated in
            callCount += 1
            return false
        }

        coordinator.requestPin(reason: .initialRestore, conversationId: convId)

        // Let one retry fire.
        try await Task.sleep(nanoseconds: 80_000_000)

        // User scrolls up mid-session.
        coordinator.handleUserAction(.scrollUp)

        let countAfterDetach = callCount
        try await Task.sleep(nanoseconds: 200_000_000)

        // No more attempts after detach.
        XCTAssertEqual(callCount, countAfterDetach)
        XCTAssertNil(coordinator.activeSession)
    }
}
