import XCTest
@testable import VellumAssistantLib

final class SharedFileViewerComponentsTests: XCTestCase {

    // MARK: availableViewModes

    func testJsonlReturnsTreeAndSource() {
        XCTAssertEqual(availableViewModes(for: "messages.jsonl", mimeType: ""), [.tree, .source])
    }

    func testNdjsonReturnsTreeAndSource() {
        XCTAssertEqual(availableViewModes(for: "events.ndjson", mimeType: ""), [.tree, .source])
    }

    func testJsonStillReturnsTreeAndSource() {
        XCTAssertEqual(availableViewModes(for: "data.json", mimeType: ""), [.tree, .source])
    }

    func testMarkdownStillReturnsPreviewAndSource() {
        XCTAssertEqual(availableViewModes(for: "README.md", mimeType: ""), [.preview, .source])
    }

    func testApplicationJsonlMimeReturnsTreeAndSource() {
        XCTAssertEqual(availableViewModes(for: "weird.txt", mimeType: "application/jsonl"), [.tree, .source])
    }

    func testApplicationXNdjsonMimeReturnsTreeAndSource() {
        XCTAssertEqual(availableViewModes(for: "weird.txt", mimeType: "application/x-ndjson"), [.tree, .source])
    }

    func testTreeIsFirstSoSkillDetailDefaultsToTree() {
        // SkillDetailView uses `autoModes.first` to pick the default mode for
        // newly opened files. JSONL files must default to .tree (matching JSON
        // behavior), now that FileContentView wires parseJSONL via isJSONL.
        let modes = availableViewModes(for: "messages.jsonl", mimeType: "")
        XCTAssertEqual(modes.first, .tree)
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

    // MARK: - Detection contract

    func testJsonlDetectionContractIsConsistent() {
        // FileContentView wires .tree mode to JSONTreeView with
        // isJSONL: isJSONLContent(...). For the wiring to be coherent, every
        // file that gets [.tree, .source] from JSONL detection must also be
        // recognized by isJSONLContent — and vice versa.
        let cases: [(String, String)] = [
            ("messages.jsonl", ""),
            ("events.ndjson", ""),
            ("anything.txt", "application/jsonl"),
            ("anything.txt", "application/x-ndjson"),
            ("anything.txt", "application/x-jsonlines"),
            ("anything.txt", "application/jsonlines"),
        ]
        for (name, mime) in cases {
            XCTAssertTrue(
                isJSONLContent(fileName: name, mimeType: mime),
                "\(name) / \(mime) should be JSONL"
            )
            XCTAssertTrue(
                availableViewModes(for: name, mimeType: mime).contains(.tree),
                "\(name) / \(mime) should expose .tree mode"
            )
        }

        // Inverse: regular JSON must NOT be flagged as JSONL even though it
        // also gets [.tree, .source].
        XCTAssertFalse(isJSONLContent(fileName: "data.json", mimeType: "application/json"))
        XCTAssertTrue(availableViewModes(for: "data.json", mimeType: "application/json").contains(.tree))
    }
}
