import XCTest
@testable import VellumAssistantLib

final class MessageListBottomAnchorPolicyTests: XCTestCase {

    // MARK: - needsRepin (existing API — behavior preserved)

    /// `anchorMinY` now represents distance-from-bottom (0 = at bottom,
    /// positive = scrolled up). `needsRepin` returns true when the distance
    /// exceeds the tolerance.
    func testNeedsRepinWhenScrolledFarFromBottom() {
        XCTAssertTrue(
            MessageListBottomAnchorPolicy.needsRepin(
                anchorMinY: 40,
                viewportHeight: 500
            )
        )
    }

    func testDoesNotRepinWhenWithinTolerance() {
        XCTAssertFalse(
            MessageListBottomAnchorPolicy.needsRepin(
                anchorMinY: 0.5,
                viewportHeight: 500
            )
        )
        XCTAssertFalse(
            MessageListBottomAnchorPolicy.needsRepin(
                anchorMinY: 2,
                viewportHeight: 500
            )
        )
    }

    func testUnknownGeometryDefaultsToRepin() {
        XCTAssertTrue(
            MessageListBottomAnchorPolicy.needsRepin(
                anchorMinY: .infinity,
                viewportHeight: 500
            )
        )
        XCTAssertTrue(
            MessageListBottomAnchorPolicy.needsRepin(
                anchorMinY: 0,
                viewportHeight: .infinity
            )
        )
    }

    // MARK: - verify (decision API)

    // -- Anchored outcomes --

    func testVerifyAnchoredWhenExactlyAtBottom() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 0,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .anchored)
    }

    func testVerifyAnchoredWhenWithinTolerance() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 1.5,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .anchored)
    }

    func testVerifyAnchoredWhenNegativeDistanceFromBottom() {
        // Negative distance means content is shorter than viewport (overscroll).
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: -5,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .anchored)
    }

    // -- NeedsRepin outcomes --

    func testVerifyNeedsRepinWhenScrolledFarFromBottom() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 40,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .needsRepin)
    }

    func testVerifyNeedsRepinJustOutsideTolerance() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 2.01,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .needsRepin)
    }

    // -- GeometryUnavailable outcomes --

    func testVerifyGeometryUnavailableWhenAnchorIsInfinity() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: .infinity,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .geometryUnavailable)
    }

    func testVerifyGeometryUnavailableWhenViewportIsInfinity() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 0,
            viewportHeight: .infinity
        )
        XCTAssertEqual(outcome, .geometryUnavailable)
    }

    func testVerifyGeometryUnavailableWhenBothAreInfinity() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: .infinity,
            viewportHeight: .infinity
        )
        XCTAssertEqual(outcome, .geometryUnavailable)
    }

    func testVerifyGeometryUnavailableWhenAnchorIsNaN() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: .nan,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .geometryUnavailable)
    }

    func testVerifyGeometryUnavailableWhenViewportIsNaN() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 0,
            viewportHeight: .nan
        )
        XCTAssertEqual(outcome, .geometryUnavailable)
    }

    func testVerifyGeometryUnavailableWhenAnchorIsNegativeInfinity() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: -.infinity,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .geometryUnavailable)
    }

    // MARK: - needsRepin agrees with verify

    func testNeedsRepinAgreesWithVerifyForFiniteInputs() {
        let cases: [(CGFloat, CGFloat)] = [
            (-5, 500),    // negative distance (overscroll) — anchored
            (0, 500),     // at bottom — anchored
            (1, 500),     // within tolerance — anchored
            (2, 500),     // at tolerance boundary — anchored
            (40, 500),    // scrolled up — needsRepin
        ]
        for (anchor, viewport) in cases {
            let outcome = MessageListBottomAnchorPolicy.verify(
                anchorMinY: anchor,
                viewportHeight: viewport
            )
            let legacy = MessageListBottomAnchorPolicy.needsRepin(
                anchorMinY: anchor,
                viewportHeight: viewport
            )
            switch outcome {
            case .anchored:
                XCTAssertFalse(legacy, "needsRepin should be false when verify returns .anchored (anchor=\(anchor), viewport=\(viewport))")
            case .needsRepin:
                XCTAssertTrue(legacy, "needsRepin should be true when verify returns .needsRepin (anchor=\(anchor), viewport=\(viewport))")
            case .geometryUnavailable:
                XCTAssertTrue(legacy, "needsRepin should be true when verify returns .geometryUnavailable (anchor=\(anchor), viewport=\(viewport))")
            }
        }
    }

    func testNeedsRepinReturnsTrueForGeometryUnavailable() {
        // Confirms the existing behavior: non-finite inputs collapse to true
        // in needsRepin, while verify distinguishes them as .geometryUnavailable.
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: .infinity,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .geometryUnavailable)

        let legacy = MessageListBottomAnchorPolicy.needsRepin(
            anchorMinY: .infinity,
            viewportHeight: 500
        )
        XCTAssertTrue(legacy)
    }
}
