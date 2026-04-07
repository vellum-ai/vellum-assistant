import XCTest
@testable import VellumAssistantLib

final class SharedFileViewerComponentsTests: XCTestCase {

    // MARK: availableViewModes

    func testJsonlReturnsTreeAndSource() {
        XCTAssertEqual(availableViewModes(for: "messages.jsonl", mimeType: ""), [.source, .tree])
    }

    func testNdjsonReturnsTreeAndSource() {
        XCTAssertEqual(availableViewModes(for: "events.ndjson", mimeType: ""), [.source, .tree])
    }

    func testJsonStillReturnsTreeAndSource() {
        XCTAssertEqual(availableViewModes(for: "data.json", mimeType: ""), [.tree, .source])
    }

    func testMarkdownStillReturnsPreviewAndSource() {
        XCTAssertEqual(availableViewModes(for: "README.md", mimeType: ""), [.preview, .source])
    }

    func testApplicationJsonlMimeReturnsTreeAndSource() {
        XCTAssertEqual(availableViewModes(for: "weird.txt", mimeType: "application/jsonl"), [.source, .tree])
    }

    func testApplicationXNdjsonMimeReturnsTreeAndSource() {
        XCTAssertEqual(availableViewModes(for: "weird.txt", mimeType: "application/x-ndjson"), [.source, .tree])
    }

    func testSourceIsFirstUntilJsonlParserIsWired() {
        // SkillDetailView uses `autoModes.first` to pick the default mode for
        // newly opened files. JSONL files default to .source until the
        // follow-up PR wires the JSONL parser into FileContentView, at which
        // point the order will flip so JSONL files default to .tree.
        let modes = availableViewModes(for: "messages.jsonl", mimeType: "")
        XCTAssertEqual(modes.first, .source)
        XCTAssertTrue(modes.contains(.tree), "Tree mode must still be reachable so users can toggle to it")
    }

    func testUnknownExtensionFallsBackToSourceOnly() {
        XCTAssertEqual(availableViewModes(for: "thing.txt", mimeType: ""), [.source])
    }

    // MARK: fileIcon

    func testJsonlFileNameReturnsCodeIcon() {
        XCTAssertEqual(fileIcon(for: "application/octet-stream", fileName: "messages.jsonl"), .fileCode)
    }

    func testNdjsonFileNameReturnsCodeIcon() {
        XCTAssertEqual(fileIcon(for: "application/octet-stream", fileName: "events.ndjson"), .fileCode)
    }

    func testJsonlMimeReturnsCodeIcon() {
        XCTAssertEqual(fileIcon(for: "application/jsonl", fileName: nil), .fileCode)
    }

    func testJsonStillReturnsCodeIcon() {
        XCTAssertEqual(fileIcon(for: "application/json", fileName: nil), .fileCode)
    }

    func testTextStillReturnsTextIcon() {
        XCTAssertEqual(fileIcon(for: "text/plain", fileName: nil), .fileText)
    }

    // MARK: isJSONLContent

    func testIsJSONLContentForJsonlExtension() {
        XCTAssertTrue(isJSONLContent(fileName: "messages.jsonl", mimeType: ""))
    }

    func testIsJSONLContentForNdjsonExtension() {
        XCTAssertTrue(isJSONLContent(fileName: "events.ndjson", mimeType: ""))
    }

    func testIsJSONLContentFalseForJson() {
        XCTAssertFalse(isJSONLContent(fileName: "data.json", mimeType: "application/json"))
    }

    func testIsJSONLContentForApplicationJsonlMime() {
        XCTAssertTrue(isJSONLContent(fileName: "anything.txt", mimeType: "application/jsonl"))
    }

    func testIsJSONLContentForUppercaseExtension() {
        XCTAssertTrue(isJSONLContent(fileName: "DATA.JSONL", mimeType: ""))
    }

    func testIsJSONLContentFalseForPlainText() {
        XCTAssertFalse(isJSONLContent(fileName: "notes.txt", mimeType: "text/plain"))
    }
}
