import XCTest
@testable import VellumAssistantLib

final class MessageListPaginationTriggerPolicyTests: XCTestCase {

    // MARK: - Prefetch-zone regression

    /// Regression: LazyVStack materialises the sentinel in its prefetch zone,
    /// which can be hundreds of points above the visible viewport. The sentinel
    /// reports a large negative minY (e.g. -800) in that case. The policy must
    /// NOT trigger pagination for positions well outside the trigger band.
    func testSentinelWellAboveViewportDoesNotTrigger() {
        // Sentinel is 800pt above the top of a 600pt viewport —
        // deep in the prefetch zone, not near the visible top.
        let triggered = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: -800,
            viewportHeight: 600,
            wasInRange: false
        )
        XCTAssertFalse(triggered, "Sentinel deep in the prefetch zone should not trigger pagination")
    }

    /// A sentinel just barely outside the tolerance should not trigger.
    func testSentinelJustOutsideToleranceDoesNotTrigger() {
        let tolerance = MessageListPaginationTriggerPolicy.topTolerance
        let triggered = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: -(tolerance + 1),
            viewportHeight: 600,
            wasInRange: false
        )
        XCTAssertFalse(triggered)
    }

    // MARK: - Trigger band entry

    /// When the sentinel scrolls into the trigger band for the first time,
    /// pagination should fire.
    func testSentinelEnteringTriggerBandTriggersOnce() {
        let triggered = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: 10,
            viewportHeight: 600,
            wasInRange: false
        )
        XCTAssertTrue(triggered, "Sentinel entering the trigger band should fire pagination")
    }

    /// The sentinel sitting right at the top edge (minY = 0) is in-band.
    func testSentinelAtExactTopEdgeTriggersOnce() {
        let triggered = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: 0,
            viewportHeight: 600,
            wasInRange: false
        )
        XCTAssertTrue(triggered)
    }

    /// The sentinel at a small negative minY (within topTolerance) triggers.
    func testSentinelSlightlyAboveViewportTriggersOnce() {
        let triggered = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: -20,
            viewportHeight: 600,
            wasInRange: false
        )
        XCTAssertTrue(triggered)
    }

    // MARK: - One-shot / no repeated triggers

    /// Once the sentinel is in-band and wasInRange is true, subsequent updates
    /// must NOT re-trigger pagination.
    func testSentinelRemainingInBandDoesNotRepeatTrigger() {
        // First entry triggers.
        let first = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: 10,
            viewportHeight: 600,
            wasInRange: false
        )
        XCTAssertTrue(first)

        // Sentinel stays in-band (wasInRange now true) — should not fire again.
        let second = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: 10,
            viewportHeight: 600,
            wasInRange: true
        )
        XCTAssertFalse(second, "Pagination must not repeatedly fire while sentinel stays in-band")

        // Sentinel moves within the band — still no re-trigger.
        let third = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: 30,
            viewportHeight: 600,
            wasInRange: true
        )
        XCTAssertFalse(third)
    }

    // MARK: - Re-arming after exit and re-entry

    /// When the sentinel leaves the trigger band and then re-enters,
    /// pagination should fire again (re-arm).
    func testSentinelLeavingAndReenteringRearmsCorrectly() {
        // 1. Enter band — triggers.
        let entry = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: 10,
            viewportHeight: 600,
            wasInRange: false
        )
        XCTAssertTrue(entry)

        // 2. Leave band (sentinel scrolled back down, out of range).
        let exitIsInBand = MessageListPaginationTriggerPolicy.isInTriggerBand(
            sentinelMinY: 400,
            viewportHeight: 600
        )
        // 400 is above bottomTolerance (200), so it's out of band.
        XCTAssertFalse(exitIsInBand, "Sentinel at minY 400 should be outside the trigger band")

        let duringExit = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: 400,
            viewportHeight: 600,
            wasInRange: true
        )
        XCTAssertFalse(duringExit)

        // 3. Re-enter band — should trigger again.
        let reentry = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: 10,
            viewportHeight: 600,
            wasInRange: false  // was out of band after step 2
        )
        XCTAssertTrue(reentry, "Re-entering the trigger band after leaving should re-arm pagination")
    }

    // MARK: - Edge cases

    /// Non-finite geometry should never trigger.
    func testNonFiniteGeometryDoesNotTrigger() {
        XCTAssertFalse(
            MessageListPaginationTriggerPolicy.shouldTrigger(
                sentinelMinY: .infinity,
                viewportHeight: 600,
                wasInRange: false
            )
        )
        XCTAssertFalse(
            MessageListPaginationTriggerPolicy.shouldTrigger(
                sentinelMinY: 10,
                viewportHeight: .infinity,
                wasInRange: false
            )
        )
        XCTAssertFalse(
            MessageListPaginationTriggerPolicy.shouldTrigger(
                sentinelMinY: .nan,
                viewportHeight: 600,
                wasInRange: false
            )
        )
    }

    // MARK: - isInTriggerBand unit tests

    func testIsInTriggerBandAtBoundaries() {
        let top = MessageListPaginationTriggerPolicy.topTolerance
        let bottom = MessageListPaginationTriggerPolicy.bottomTolerance

        // Exactly at top tolerance boundary — in band.
        XCTAssertTrue(
            MessageListPaginationTriggerPolicy.isInTriggerBand(sentinelMinY: -top, viewportHeight: 600)
        )
        // Just inside top boundary.
        XCTAssertTrue(
            MessageListPaginationTriggerPolicy.isInTriggerBand(sentinelMinY: -(top - 1), viewportHeight: 600)
        )
        // Just outside top boundary.
        XCTAssertFalse(
            MessageListPaginationTriggerPolicy.isInTriggerBand(sentinelMinY: -(top + 1), viewportHeight: 600)
        )

        // Exactly at bottom tolerance boundary — in band.
        XCTAssertTrue(
            MessageListPaginationTriggerPolicy.isInTriggerBand(sentinelMinY: bottom, viewportHeight: 600)
        )
        // Just inside bottom boundary.
        XCTAssertTrue(
            MessageListPaginationTriggerPolicy.isInTriggerBand(sentinelMinY: bottom - 1, viewportHeight: 600)
        )
        // Just outside bottom boundary.
        XCTAssertFalse(
            MessageListPaginationTriggerPolicy.isInTriggerBand(sentinelMinY: bottom + 1, viewportHeight: 600)
        )
    }

    /// The trigger band should work with various viewport heights since it is
    /// anchored to the top of the viewport (minY = 0), not relative to height.
    func testTriggerBandIsViewportHeightIndependent() {
        // Sentinel at minY = 10 should be in-band regardless of viewport size.
        XCTAssertTrue(
            MessageListPaginationTriggerPolicy.isInTriggerBand(sentinelMinY: 10, viewportHeight: 300)
        )
        XCTAssertTrue(
            MessageListPaginationTriggerPolicy.isInTriggerBand(sentinelMinY: 10, viewportHeight: 1200)
        )
    }
}
