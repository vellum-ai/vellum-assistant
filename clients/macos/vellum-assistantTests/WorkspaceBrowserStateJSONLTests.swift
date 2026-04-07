import XCTest
@testable import VellumAssistantLib

@MainActor
final class WorkspaceBrowserStateJSONLTests: XCTestCase {

    // MARK: - JSON / JSONL / NDJSON default to tree

    func testJsonDefaultsToTree() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "json", prefersSource: false),
            .tree
        )
    }

    func testJsonlDefaultsToTree() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "jsonl", prefersSource: false),
            .tree
        )
    }

    func testNdjsonDefaultsToTree() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "ndjson", prefersSource: false),
            .tree
        )
    }

    // MARK: - Markdown defaults to preview

    func testMarkdownDefaultsToPreview() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "md", prefersSource: false),
            .preview
        )
    }

    func testMarkdownLongExtensionDefaultsToPreview() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "markdown", prefersSource: false),
            .preview
        )
    }

    // MARK: - Unknown defaults to source

    func testUnknownDefaultsToSource() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "txt", prefersSource: false),
            .source
        )
    }

    func testEmptyExtensionDefaultsToSource() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "", prefersSource: false),
            .source
        )
    }

    // MARK: - prefersSource overrides everything

    func testPrefersSourceForcesSourceForJsonl() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "jsonl", prefersSource: true),
            .source
        )
    }

    func testPrefersSourceForcesSourceForNdjson() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "ndjson", prefersSource: true),
            .source
        )
    }

    func testPrefersSourceForcesSourceForJson() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "json", prefersSource: true),
            .source
        )
    }

    func testPrefersSourceForcesSourceForMarkdown() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "md", prefersSource: true),
            .source
        )
    }

    func testPrefersSourceForcesSourceForUnknown() {
        XCTAssertEqual(
            WorkspaceBrowserState.defaultViewMode(forExtension: "txt", prefersSource: true),
            .source
        )
    }
}
