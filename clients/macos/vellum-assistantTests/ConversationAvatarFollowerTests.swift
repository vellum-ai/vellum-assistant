import XCTest
@testable import VellumAssistantLib

final class ConversationAvatarFollowerTests: XCTestCase {
    @MainActor
    func testViewportChangeRecomputesVisibility() {
        let coordinator = MessageListScrollCoordinator()
        // Distance-from-bottom of 15 is within the 20pt visibility threshold.
        coordinator.anchorLastMinY = 15
        coordinator.anchorIsVisible = false
        var storedViewportHeight: CGFloat = 500

        let changed = coordinator.updateAnchorViewport(
            height: 540,
            storedViewportHeight: &storedViewportHeight
        )

        XCTAssertTrue(changed)
        XCTAssertEqual(storedViewportHeight, 540)
        XCTAssertTrue(coordinator.anchorIsVisible)
    }

    @MainActor
    func testViewportChangeNoOpsWhenHeightIsUnchanged() {
        let coordinator = MessageListScrollCoordinator()
        // Distance-from-bottom of 50 is outside the 20pt threshold — not visible.
        coordinator.anchorLastMinY = 50
        coordinator.anchorIsVisible = false
        var storedViewportHeight: CGFloat = 540

        let changed = coordinator.updateAnchorViewport(
            height: 540,
            storedViewportHeight: &storedViewportHeight
        )

        XCTAssertFalse(changed)
        XCTAssertEqual(storedViewportHeight, 540)
        XCTAssertFalse(coordinator.anchorIsVisible)
    }
}
