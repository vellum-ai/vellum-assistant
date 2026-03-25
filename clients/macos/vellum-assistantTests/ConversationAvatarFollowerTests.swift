import XCTest
@testable import VellumAssistantLib

final class ConversationAvatarFollowerTests: XCTestCase {
    @MainActor
    func testUpdateIsAtBottomSetsTrue() {
        let coordinator = MessageListScrollCoordinator()
        coordinator.isAtBottom = false

        coordinator.updateIsAtBottom("scroll-bottom-anchor")

        XCTAssertTrue(coordinator.isAtBottom)
    }

    @MainActor
    func testUpdateIsAtBottomSetsFalseForOtherID() {
        let coordinator = MessageListScrollCoordinator()
        coordinator.isAtBottom = true

        coordinator.updateIsAtBottom("some-message-id")

        XCTAssertFalse(coordinator.isAtBottom)
    }

    @MainActor
    func testUpdateIsAtBottomSetsFalseForNil() {
        let coordinator = MessageListScrollCoordinator()
        coordinator.isAtBottom = true

        coordinator.updateIsAtBottom(nil)

        XCTAssertFalse(coordinator.isAtBottom)
    }
}
