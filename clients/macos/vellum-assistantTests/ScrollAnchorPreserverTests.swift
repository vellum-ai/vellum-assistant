import XCTest
@testable import VellumAssistantLib

@MainActor
final class ScrollAnchorPreserverTests: XCTestCase {

    private static let epsilon: CGFloat = 8

    // MARK: - The streaming bug case

    func testStreamingGrowthShiftsOffsetByDelta() {
        // User is reading older content 200pt above the visual bottom while
        // a streaming assistant response (lives at doc Y=0 in the inverted
        // scroll) grows by 50pt. Without compensation, the user's visible
        // content scrolls upward off the viewport. Compensation must add
        // 50pt to the offset so the same content stays in view.
        let delta = ScrollAnchorPreserver.offsetDelta(
            currentContentHeight: 1050,
            lastContentHeight: 1000,
            contentOffsetY: 200,
            shouldPreserveAnchor: true,
            pinnedToLatestEpsilon: Self.epsilon
        )
        XCTAssertEqual(delta, 50)
    }

    func testStreamingGrowthCompensatesByExactDeltaForLargeJump() {
        // A multi-token batch can land in a single layout pass. The delta
        // must equal the actual height growth, not be capped or rounded.
        let delta = ScrollAnchorPreserver.offsetDelta(
            currentContentHeight: 5000,
            lastContentHeight: 1000,
            contentOffsetY: 800,
            shouldPreserveAnchor: true,
            pinnedToLatestEpsilon: Self.epsilon
        )
        XCTAssertEqual(delta, 4000)
    }

    // MARK: - Skip cases

    func testSkipsOnFirstMeasurement() {
        // Initial attach has lastContentHeight == 0. Compensating against
        // 0 would treat the entire first emit as a delta and shove the
        // user far off the visual bottom on first paint.
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            currentContentHeight: 1000,
            lastContentHeight: 0,
            contentOffsetY: 200,
            shouldPreserveAnchor: true,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testSkipsWhenContentDidNotGrow() {
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            currentContentHeight: 1000,
            lastContentHeight: 1000,
            contentOffsetY: 200,
            shouldPreserveAnchor: true,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testSkipsWhenContentShrunk() {
        // A collapse (e.g., thinking-block dismissal) reduces height. We
        // do not pull the user toward the streaming edge in that case.
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            currentContentHeight: 900,
            lastContentHeight: 1000,
            contentOffsetY: 200,
            shouldPreserveAnchor: true,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testSkipsWhenPinnedToVisualBottom() {
        // User is at the visual bottom (offset ≤ epsilon). Inverted scroll
        // already auto-follows new content there — adding a delta would
        // push them off the bottom they intentionally stayed at.
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            currentContentHeight: 1100,
            lastContentHeight: 1000,
            contentOffsetY: 5,
            shouldPreserveAnchor: true,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testSkipsWhenAtExactlyEpsilon() {
        // Boundary: offset == epsilon counts as pinned (strict > check).
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            currentContentHeight: 1100,
            lastContentHeight: 1000,
            contentOffsetY: 8,
            shouldPreserveAnchor: true,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testCompensatesJustAboveEpsilon() {
        let delta = ScrollAnchorPreserver.offsetDelta(
            currentContentHeight: 1100,
            lastContentHeight: 1000,
            contentOffsetY: 9,
            shouldPreserveAnchor: true,
            pinnedToLatestEpsilon: Self.epsilon
        )
        XCTAssertEqual(delta, 100)
    }

    func testSkipsWhenPreservationDisabled() {
        // Pagination flow opts out: the explicit scroll-to-anchor in
        // `handlePaginationSentinel` is the source of truth and shifting
        // the offset to absorb the older page would race the snap.
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            currentContentHeight: 1100,
            lastContentHeight: 1000,
            contentOffsetY: 200,
            shouldPreserveAnchor: false,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }
}
