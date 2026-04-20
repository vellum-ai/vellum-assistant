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

    /// Regression: previously `actionDescription` parsed `inputSummary`, which
    /// `summarizeToolInputStatic` truncates to 80 chars + "...". For compound
    /// bash commands long enough to truncate, the trailing "..." landed mid-token
    /// so `interpretBashCommand` saw a final token like `"pkb/N..."` and produced
    /// `"Listed N..."`. Sourcing from `inputRawValue` avoids that.
    func testBashActionDescriptionUsesInputRawValueNotTruncatedSummary() {
        let fullCmd = #"cd ~/.vellum/workspace && ls pkb/alice/ 2>/dev/null && echo "---" && cat pkb/NOW.md 2>/dev/null | head -50"#
        let truncatedSummary = String(fullCmd.prefix(77)) + "..."
        let tc = ToolCallData(
            toolName: "bash",
            inputSummary: truncatedSummary,
            inputRawValue: fullCmd
        )
        XCTAssertFalse(tc.actionDescription.contains("..."), "actionDescription must not leak the truncation marker")
        XCTAssertFalse(tc.actionDescription.contains("…"))
        XCTAssertNotEqual(tc.actionDescription, "Listed N...")
    }
}
