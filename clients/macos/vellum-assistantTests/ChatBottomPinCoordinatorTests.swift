import XCTest
@testable import VellumAssistantLib

@MainActor
final class ChatBottomPinCoordinatorTests: XCTestCase {
    private var coordinator: ChatBottomPinCoordinator!
    private var pinRequestCount: Int = 0
    private var pinShouldSucceed: Bool = true
    private var followStateChanges: [Bool] = []

    override func setUp() {
        super.setUp()
        coordinator = ChatBottomPinCoordinator()
        pinRequestCount = 0
        pinShouldSucceed = true
        followStateChanges = []

        coordinator.onPinRequested = { [weak self] in
            self?.pinRequestCount += 1
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

    func testScrollToBottomSuppressedWhileDetached() {
        coordinator.handleUserAction(.scrollUp)

        let result = coordinator.scrollToBottom()

        XCTAssertFalse(result)
        XCTAssertEqual(pinRequestCount, 0)
    }

    func testScrollToBottomAllowedAfterReattach() {
        coordinator.handleUserAction(.scrollUp)
        let suppressedResult = coordinator.scrollToBottom()
        XCTAssertFalse(suppressedResult)
        XCTAssertEqual(pinRequestCount, 0)

        coordinator.handleUserAction(.scrollToBottom)
        let result = coordinator.scrollToBottom()

        XCTAssertTrue(result)
        XCTAssertEqual(pinRequestCount, 1)
    }

    // MARK: - scrollToBottom

    func testScrollToBottomCallsOnPinRequested() {
        pinShouldSucceed = true

        let result = coordinator.scrollToBottom()

        XCTAssertTrue(result)
        XCTAssertEqual(pinRequestCount, 1)
    }

    func testScrollToBottomReturnsFalseWhenPinFails() {
        pinShouldSucceed = false

        let result = coordinator.scrollToBottom()

        XCTAssertFalse(result)
        XCTAssertEqual(pinRequestCount, 1)
    }

    func testScrollToBottomReturnsFalseWhenNoCallback() {
        coordinator.onPinRequested = nil

        let result = coordinator.scrollToBottom()

        XCTAssertFalse(result)
    }

    // MARK: - Detach / Reattach

    func testDetachSuppressesFutureScrollToBottom() {
        coordinator.detach()

        XCTAssertFalse(coordinator.isFollowingBottom)

        let result = coordinator.scrollToBottom()
        XCTAssertFalse(result)
        XCTAssertEqual(pinRequestCount, 0)
    }

    func testDetachFiresFollowStateChanged() {
        coordinator.detach()

        XCTAssertEqual(followStateChanges, [false])
    }

    func testDetachWhenAlreadyDetachedDoesNotFireCallback() {
        coordinator.detach()
        coordinator.detach()

        // Only one state change callback should fire.
        XCTAssertEqual(followStateChanges, [false])
    }

    func testReattachAllowsScrollToBottom() {
        coordinator.detach()
        coordinator.reattach()

        let result = coordinator.scrollToBottom()
        XCTAssertTrue(result)
        XCTAssertEqual(pinRequestCount, 1)
    }

    func testReattachFiresFollowStateChanged() {
        coordinator.detach()
        coordinator.reattach()

        XCTAssertEqual(followStateChanges, [false, true])
    }

    func testReattachWhenAlreadyFollowingDoesNotFireCallback() {
        coordinator.reattach()

        XCTAssertEqual(followStateChanges, [])
    }

    // MARK: - Reset

    func testResetResetsFollowState() {
        coordinator.handleUserAction(.scrollUp)
        XCTAssertFalse(coordinator.isFollowingBottom)

        coordinator.reset()

        XCTAssertTrue(coordinator.isFollowingBottom)
    }

    func testResetFiresFollowStateChanged() {
        coordinator.handleUserAction(.scrollUp)
        followStateChanges = []

        coordinator.reset()

        XCTAssertEqual(followStateChanges, [true])
    }

    func testResetWithoutPriorDetachStillFiresCallback() {
        coordinator.reset()

        // reset() always fires onFollowStateChanged(true).
        XCTAssertEqual(followStateChanges, [true])
    }

    func testResetDoesNotTriggerPinRequest() {
        coordinator.reset()

        XCTAssertEqual(pinRequestCount, 0)
    }

    // MARK: - VerificationOutcome Policy

    /// Verifies that the anchor policy correctly distinguishes between
    /// genuinely off-screen anchors and unavailable geometry.
    func testVerificationOutcomeDistinguishesGeometryStates() {
        // Finite, in-bounds anchor
        let anchored = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 500, viewportHeight: 600
        )
        XCTAssertEqual(anchored, .anchored)

        // Finite, genuinely off-screen
        let offScreen = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 700, viewportHeight: 600
        )
        XCTAssertEqual(offScreen, .needsRepin)

        // Non-finite anchor (geometry not yet measured)
        let infiniteAnchor = MessageListBottomAnchorPolicy.verify(
            anchorMinY: .infinity, viewportHeight: 600
        )
        XCTAssertEqual(infiniteAnchor, .geometryUnavailable)

        // Non-finite viewport (geometry not yet measured)
        let infiniteViewport = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 500, viewportHeight: .infinity
        )
        XCTAssertEqual(infiniteViewport, .geometryUnavailable)

        // Both non-finite
        let bothInfinite = MessageListBottomAnchorPolicy.verify(
            anchorMinY: .infinity, viewportHeight: .infinity
        )
        XCTAssertEqual(bothInfinite, .geometryUnavailable)

        // NaN anchor
        let nanAnchor = MessageListBottomAnchorPolicy.verify(
            anchorMinY: .nan, viewportHeight: 600
        )
        XCTAssertEqual(nanAnchor, .geometryUnavailable)
    }

    /// Verifies that the legacy `needsRepin` helper still collapses
    /// `geometryUnavailable` into `true` for backwards compatibility.
    func testLegacyNeedsRepinCollapsesGeometryUnavailable() {
        // geometryUnavailable -> true (backwards-compatible behavior)
        XCTAssertTrue(MessageListBottomAnchorPolicy.needsRepin(
            anchorMinY: .infinity, viewportHeight: 600
        ))

        // anchored -> false
        XCTAssertFalse(MessageListBottomAnchorPolicy.needsRepin(
            anchorMinY: 500, viewportHeight: 600
        ))

        // needsRepin -> true
        XCTAssertTrue(MessageListBottomAnchorPolicy.needsRepin(
            anchorMinY: 700, viewportHeight: 600
        ))
    }
}
