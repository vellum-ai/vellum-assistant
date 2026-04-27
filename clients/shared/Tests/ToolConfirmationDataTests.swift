import XCTest
@testable import VellumAssistantShared

final class ToolConfirmationDataTests: XCTestCase {
    func testFullInputPreviewDoesNotTruncateLongStrings() {
        let oldString = String(repeating: "old-", count: 80)
        let newString = String(repeating: "new-", count: 80)
        let confirmation = ToolConfirmationData(
            requestId: "req-1",
            toolName: "file_edit",
            input: [
                "path": AnyCodable("/tmp/sample.txt"),
                "old_string": AnyCodable(oldString),
                "new_string": AnyCodable(newString),
            ],
            riskLevel: "medium"
        )

        let preview = confirmation.fullInputPreview
        XCTAssertTrue(preview.contains("old_string: \(oldString)"))
        XCTAssertTrue(preview.contains("new_string: \(newString)"))
        XCTAssertFalse(preview.contains("old_string: \(String(oldString.prefix(117)))..."))
        XCTAssertFalse(preview.contains("new_string: \(String(newString.prefix(117)))..."))
    }

    func testUnifiedDiffPreviewShowsReplacedLines() {
        let diff = ConfirmationRequestDiff(
            filePath: "/tmp/test.txt",
            oldContent: "line1\nline2\nline3",
            newContent: "line1\nline2-updated\nline3",
            isNewFile: false
        )
        let confirmation = ToolConfirmationData(
            requestId: "req-2",
            toolName: "file_edit",
            input: [:],
            riskLevel: "medium",
            diff: diff
        )

        let rendered = confirmation.unifiedDiffPreview ?? ""
        XCTAssertTrue(rendered.contains("--- a//tmp/test.txt"))
        XCTAssertTrue(rendered.contains("+++ b//tmp/test.txt"))
        XCTAssertTrue(rendered.contains("-line2"))
        XCTAssertTrue(rendered.contains("+line2-updated"))
    }

    func testUnifiedDiffPreviewSupportsMultipleHunks() {
        let oldLines = (1...20).map { "line\($0)" }
        var newLines = oldLines
        newLines[2] = "CHANGED_A"
        newLines[17] = "CHANGED_B"

        let diff = ConfirmationRequestDiff(
            filePath: "/tmp/multi.txt",
            oldContent: oldLines.joined(separator: "\n"),
            newContent: newLines.joined(separator: "\n"),
            isNewFile: false
        )
        let confirmation = ToolConfirmationData(
            requestId: "req-3",
            toolName: "file_edit",
            input: [:],
            riskLevel: "medium",
            diff: diff
        )

        let rendered = confirmation.unifiedDiffPreview ?? ""
        XCTAssertTrue(rendered.contains("-line3"))
        XCTAssertTrue(rendered.contains("+CHANGED_A"))
        XCTAssertTrue(rendered.contains("-line18"))
        XCTAssertTrue(rendered.contains("+CHANGED_B"))
        let hunkHeaderCount = rendered.components(separatedBy: "@@ -").count - 1
        XCTAssertGreaterThanOrEqual(hunkHeaderCount, 2)
    }

    func testUnifiedDiffPreviewLargeFallbackIsNotTruncated() {
        let oldLines = (1...1005).map { "line\($0)" }
        var newLines = oldLines
        newLines[500] = "line501-updated"

        let diff = ConfirmationRequestDiff(
            filePath: "/tmp/large.txt",
            oldContent: oldLines.joined(separator: "\n"),
            newContent: newLines.joined(separator: "\n"),
            isNewFile: false
        )
        let confirmation = ToolConfirmationData(
            requestId: "req-4",
            toolName: "file_edit",
            input: [:],
            riskLevel: "high",
            diff: diff
        )

        let rendered = confirmation.unifiedDiffPreview ?? ""
        XCTAssertFalse(rendered.contains("Diff too large"))
        XCTAssertTrue(rendered.contains("-line501"))
        XCTAssertTrue(rendered.contains("+line501-updated"))
        XCTAssertTrue(rendered.contains("-line1005"))
        XCTAssertTrue(rendered.contains("+line1005"))
    }
}
