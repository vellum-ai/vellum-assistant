import XCTest
@testable import VellumAssistantLib

final class AssistantStatusTests: XCTestCase {

    func testAuthFailedMenuTitleContainsAuthenticationAndAssistantName() {
        let title = AssistantStatus.authFailed.menuTitle(assistantName: "Vellum")
        XCTAssertTrue(title.contains("Authentication"), "menuTitle should mention Authentication: \(title)")
        XCTAssertTrue(title.contains("Vellum"), "menuTitle should include the assistant name: \(title)")
    }

    func testAuthFailedStatusColorIsDistinctFromDisconnected() {
        XCTAssertNotEqual(
            AssistantStatus.authFailed.statusColor,
            AssistantStatus.disconnected.statusColor,
            "authFailed and disconnected should be visually distinct"
        )
    }

    func testAuthFailedDoesNotPulse() {
        XCTAssertFalse(AssistantStatus.authFailed.shouldPulse, "authFailed is a steady state, not animated")
    }
}
