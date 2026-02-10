import XCTest
@testable import vellum_assistant

final class ToolDefinitionsTests: XCTestCase {

    func testToolCount() {
        XCTAssertEqual(ToolDefinitions.tools.count, 12, "Should have 12 tools defined")
    }

    func testToolNames() {
        let names = ToolDefinitions.tools.compactMap { $0["name"] as? String }
        XCTAssertTrue(names.contains("click"))
        XCTAssertTrue(names.contains("double_click"))
        XCTAssertTrue(names.contains("right_click"))
        XCTAssertTrue(names.contains("type_text"))
        XCTAssertTrue(names.contains("key"))
        XCTAssertTrue(names.contains("scroll"))
        XCTAssertTrue(names.contains("wait"))
        XCTAssertTrue(names.contains("drag"))
        XCTAssertTrue(names.contains("open_app"))
        XCTAssertTrue(names.contains("run_applescript"))
        XCTAssertTrue(names.contains("done"))
        XCTAssertTrue(names.contains("respond"))
    }

    func testToolsHaveInputSchema() {
        for tool in ToolDefinitions.tools {
            let name = tool["name"] as? String ?? "unknown"
            XCTAssertNotNil(tool["input_schema"], "Tool '\(name)' should have input_schema")
        }
    }

    func testToolsSerialization() {
        // Verify tools can be serialized to JSON (required for API calls)
        do {
            let data = try JSONSerialization.data(withJSONObject: ToolDefinitions.tools)
            XCTAssertTrue(data.count > 0, "Should produce non-empty JSON")
        } catch {
            XCTFail("Tools should be JSON-serializable: \(error)")
        }
    }
}
