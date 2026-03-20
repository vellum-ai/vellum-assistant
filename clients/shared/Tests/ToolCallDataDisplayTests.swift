import XCTest
@testable import VellumAssistantShared

final class ToolCallDataDisplayTests: XCTestCase {

    // MARK: - friendlyName

    func testSkillExecuteFriendlyName() {
        let tc = ToolCallData(toolName: "skill_execute", inputSummary: "")
        XCTAssertEqual(tc.friendlyName, "Use Skill")
    }

    // MARK: - actionDescription

    func testSkillExecuteActionDescriptionWithActivity() {
        let tc = ToolCallData(toolName: "skill_execute", inputSummary: "Writing the landing page")
        XCTAssertEqual(tc.actionDescription, "Writing the landing page")
    }

    func testSkillExecuteActionDescriptionWithoutActivity() {
        let tc = ToolCallData(toolName: "skill_execute", inputSummary: "")
        XCTAssertEqual(tc.actionDescription, "Used a skill")
    }
}
