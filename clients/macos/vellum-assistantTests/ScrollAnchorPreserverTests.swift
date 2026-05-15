import XCTest
@testable import VellumAssistantLib

@MainActor
final class ScrollAnchorPreserverTests: XCTestCase {

    private static let epsilon: CGFloat = 8

    // MARK: - Reference-shift compensation

    func testCompensatesByReferenceShift() {
        // A row above the visible region expanded by 50pt while the user is
        // 200pt above the visual bottom. The coordinator observed the
        // anchor reference's `minY` move 50pt; the preserver must shift
        // `clipView.bounds.origin.y` by the same 50pt so the same content
        // stays visible.
        let delta = ScrollAnchorPreserver.offsetDelta(
            compensationDelta: 50,
            contentOffsetY: 200,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        )
        XCTAssertEqual(delta, 50)
    }

    func testCompensatesByExactReferenceShiftForLargeJump() {
        // A multi-batch layout (e.g. paginated history finished resolving
        // height estimates) can move the reference by thousands of points
        // in a single emit. The delta must equal the actual reference
        // shift, not be capped or rounded.
        let delta = ScrollAnchorPreserver.offsetDelta(
            compensationDelta: 4000,
            contentOffsetY: 800,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        )
        XCTAssertEqual(delta, 4000)
    }

    func testCompensatesOnNegativeReferenceShift() {
        // Symmetric case to the growth direction: when a row above the
        // viewport collapses (thinking-block dismissal, height-estimate
        // correction), the reference's `minY` decreases. The preserver
        // must shift by the same negative delta so the viewport doesn't
        // jump downward.
        let delta = ScrollAnchorPreserver.offsetDelta(
            compensationDelta: -100,
            contentOffsetY: 200,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        )
        XCTAssertEqual(delta, -100)
    }

    func testCompensatesOnSmallShrinkFromRecordedRegression() {
        // A per-frame HUD recording captured a 34pt shrink at the tail of
        // a streaming response with no compensation, producing a visible
        // 34pt viewport jump. Translated to the reference-based formulation:
        // the reference's `minY` decreased by 34pt, the preserver must
        // shift by -34 to hold the viewport.
        let delta = ScrollAnchorPreserver.offsetDelta(
            compensationDelta: -34,
            contentOffsetY: 1798.5,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        )
        XCTAssertEqual(delta, -34)
    }

    // MARK: - Skip cases

    func testSkipsWhenReferenceDidNotMove() {
        // The headline regression: streaming response below the viewport
        // grows by 1pt/token, `documentView.frame.height` grows in
        // lockstep, but no row in the materialized subtree changes
        // position. The coordinator passes `compensationDelta=0` and the
        // preserver skips. This is the case the old `contentHDelta`
        // formulation got wrong — applying `+1` per token walked the user
        // away from latest at the token rate.
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            compensationDelta: 0,
            contentOffsetY: 200,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testSkipsOnSubPixelJitter() {
        // Layout passes occasionally produce sub-pt reference shifts from
        // font-metric rounding or off-screen relayouts that don't
        // correspond to a visible shift. Skipping these prevents accumulated
        // drift from oscillating around a stable layout.
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            compensationDelta: 0.3,
            contentOffsetY: 200,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testSkipsShrinkWhenPinnedToVisualBottom() {
        // When the user is pinned to the visual bottom, shrinks don't
        // apply a negative shift either — NSScrollView auto-clamps at
        // offset 0 and pulling "past" that would violate the pinned state
        // the user chose.
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            compensationDelta: -100,
            contentOffsetY: 5,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testSkipsWhenPinnedToVisualBottom() {
        // User is at the visual bottom (offset ≤ epsilon). Inverted scroll
        // already auto-follows new content there — adding a delta would
        // push them off the bottom they intentionally stayed at.
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            compensationDelta: 100,
            contentOffsetY: 5,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testSkipsWhenAtExactlyEpsilon() {
        // Boundary: offset == epsilon counts as pinned (strict > check).
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            compensationDelta: 100,
            contentOffsetY: 8,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testCompensatesJustAboveEpsilon() {
        let delta = ScrollAnchorPreserver.offsetDelta(
            compensationDelta: 100,
            contentOffsetY: 9,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        )
        XCTAssertEqual(delta, 100)
    }

    func testSkipsWhenPreservationDisabled() {
        // Pagination flow opts out: the explicit scroll-to-anchor in
        // `handlePaginationSentinel` is the source of truth and shifting
        // the offset to absorb the older page would race the snap.
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            compensationDelta: 100,
            contentOffsetY: 200,
            shouldPreserveAnchor: false,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    // MARK: - Live-scroll gate

    func testSkipsWhenUserIsLiveScrolling() {
        // The user is actively scrolling (trackpad, wheel, or momentum
        // decay). Any content shift mid-gesture must not trigger a clip
        // origin shift, because `setBoundsOrigin` mid-gesture cancels the
        // user's scroll input and traps them in the current region.
        XCTAssertNil(ScrollAnchorPreserver.offsetDelta(
            compensationDelta: 50,
            contentOffsetY: 200,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: true,
            pinnedToLatestEpsilon: Self.epsilon
        ))
    }

    func testCompensatesOnceLiveScrollEnds() {
        // After `didEndLiveScrollNotification` fires, isUserLiveScrolling
        // flips back to false and subsequent passive shifts (e.g. a
        // thinking block expanding above the viewport) compensate normally.
        let delta = ScrollAnchorPreserver.offsetDelta(
            compensationDelta: 50,
            contentOffsetY: 200,
            shouldPreserveAnchor: true,
            isUserLiveScrolling: false,
            pinnedToLatestEpsilon: Self.epsilon
        )
        XCTAssertEqual(delta, 50)
    }
}
