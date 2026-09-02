import XCTest
import UserNotifications

final class NotificationCategoriesTests: XCTestCase {
    func testIntentCategoryExposesTheGoToConversationAction() {
        let category = NotificationCategories.intentCategory()
        XCTAssertEqual(category.identifier, "notificationIntent")
        XCTAssertEqual(category.actions.count, 1)
        XCTAssertEqual(category.actions[0].identifier, "view")
        XCTAssertEqual(category.actions[0].title, "Go to Conversation")
        XCTAssertTrue(category.actions[0].options.contains(.foreground))
    }
}
