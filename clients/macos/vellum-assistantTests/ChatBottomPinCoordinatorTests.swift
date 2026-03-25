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
    }

    // MARK: - Detach on Upward Scroll

    func testScrollUpDetachesFromBottom() {
        coordinator.handleUserAction(.scrollUp)

        XCTAssertFalse(coordinator.isFollowingBottom)
        XCTAssertEqual(followStateChanges, [false])
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

        coordinator.requestPin(reason: .resize, conversationId: convId)

        XCTAssertEqual(pinRequestCount, 0)
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
        coordinator.requestPin(reason: .messageCount, conversationId: convId)
        XCTAssertEqual(pinRequestCount, 0)

        coordinator.handleUserAction(.scrollToBottom)
        coordinator.requestPin(reason: .messageCount, conversationId: convId)

        XCTAssertEqual(pinRequestCount, 1)
    }

    // MARK: - Immediate Pin Execution

    func testSuccessfulPinExecutesImmediately() {
        let convId = UUID()
        pinShouldSucceed = true

        coordinator.requestPin(reason: .initialRestore, conversationId: convId)

        XCTAssertEqual(pinRequestCount, 1)
    }

    func testRequestPinCallsOnPinRequestedExactlyOnce() {
        let convId = UUID()

        coordinator.requestPin(reason: .messageCount, conversationId: convId)
        XCTAssertEqual(pinRequestCount, 1)

        coordinator.requestPin(reason: .expansion, conversationId: convId)
        XCTAssertEqual(pinRequestCount, 2)

        coordinator.requestPin(reason: .resize, conversationId: convId)
        XCTAssertEqual(pinRequestCount, 3)
    }

    // MARK: - User Action Handling

    func testDetachCancelsAndSuppressesFutureRequests() {
        let convId = UUID()

        coordinator.detach(trigger: .userScrollUp)

        XCTAssertFalse(coordinator.isFollowingBottom)

        // Subsequent requests should be suppressed.
        coordinator.requestPin(reason: .messageCount, conversationId: convId)
        XCTAssertEqual(pinRequestCount, 0,
                       "Pin requests should be suppressed while detached")
    }

    // MARK: - Reset

    func testResetClearsAllStateAndReattaches() {
        coordinator.handleUserAction(.scrollUp)
        XCTAssertFalse(coordinator.isFollowingBottom)

        let newConvId = UUID()
        coordinator.reset(newConversationId: newConvId)

        XCTAssertTrue(coordinator.isFollowingBottom)
    }

    func testResetWithoutSubsequentRequestsHasNoSideEffects() {
        coordinator.handleUserAction(.scrollUp)
        XCTAssertFalse(coordinator.isFollowingBottom)

        coordinator.reset()

        XCTAssertTrue(coordinator.isFollowingBottom)
        // No pin calls should have been triggered.
        XCTAssertEqual(pinRequestCount, 0)
    }

}
