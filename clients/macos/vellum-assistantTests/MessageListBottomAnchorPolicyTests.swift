import XCTest
@testable import VellumAssistantLib

final class MessageListBottomAnchorPolicyTests: XCTestCase {

    // MARK: - needsRepin (existing API — behavior preserved)

    func testNeedsRepinWhenAnchorFallsBelowViewport() {
        XCTAssertTrue(
            MessageListBottomAnchorPolicy.needsRepin(
                anchorMinY: 540,
                viewportHeight: 500
            )
        )
    }

    func testDoesNotRepinWhenAnchorAlreadyWithinTolerance() {
        XCTAssertFalse(
            MessageListBottomAnchorPolicy.needsRepin(
                anchorMinY: 500.5,
                viewportHeight: 500
            )
        )
        XCTAssertFalse(
            MessageListBottomAnchorPolicy.needsRepin(
                anchorMinY: 502,
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
                anchorMinY: 500,
                viewportHeight: .infinity
            )
        )
    }

    // MARK: - verify (new decision API)

    // -- Anchored outcomes --

    func testVerifyAnchoredWhenExactlyAtViewportBottom() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 500,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .anchored)
    }

    func testVerifyAnchoredWhenWithinTolerance() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 501.5,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .anchored)
    }

    func testVerifyAnchoredWhenAnchorAboveViewportBottom() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 400,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .anchored)
    }

    // -- NeedsRepin outcomes --

    func testVerifyNeedsRepinWhenAnchorBelowViewport() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 540,
            viewportHeight: 500
        )
        XCTAssertEqual(outcome, .needsRepin)
    }

    func testVerifyNeedsRepinJustOutsideTolerance() {
        let outcome = MessageListBottomAnchorPolicy.verify(
            anchorMinY: 502.01,
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
            anchorMinY: 500,
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
            anchorMinY: 500,
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
            (400, 500),
            (500, 500),
            (501, 500),
            (502, 500),
            (540, 500),
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
