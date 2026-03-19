import XCTest
@testable import VellumAssistantLib

final class MessageListBottomAnchorPolicyTests: XCTestCase {
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
}
