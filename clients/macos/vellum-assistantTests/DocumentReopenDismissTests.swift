import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Regression tests for document reopen and dismiss behavior (PRs #5069 / #5072).
///
/// Covers:
/// - `DocumentResultParser.parse` extracting surface_id and title from JSON
/// - `DocumentResultParser.titleFromSummary` colon-based fallback extraction
/// - `openDocumentEditor` notification posting with correct userInfo
/// - Dismiss state: dismissed surface IDs prevent widget rendering
@MainActor
final class DocumentReopenDismissTests: XCTestCase {

    // MARK: - parseDocumentResult: valid JSON

    func testParseValidJsonExtractsSurfaceIdAndTitle() {
        let json = #"{"surface_id": "doc-abc", "title": "My Essay"}"#
        let toolCall = ToolCallData(
            toolName: "document_create",
            inputSummary: "document_create: fallback",
            result: json,
            isComplete: true
        )

        let result = DocumentResultParser.parse(from: toolCall)

        XCTAssertEqual(result.surfaceId, "doc-abc")
        XCTAssertEqual(result.title, "My Essay")
    }

    func testParseValidJsonWithExtraFieldsStillWorks() {
        let json = #"{"surface_id": "doc-xyz", "title": "Report", "extra": 42}"#
        let toolCall = ToolCallData(
            toolName: "document_create",
            inputSummary: "document_create: ignored",
            result: json,
            isComplete: true
        )

        let result = DocumentResultParser.parse(from: toolCall)

        XCTAssertEqual(result.surfaceId, "doc-xyz")
        XCTAssertEqual(result.title, "Report")
    }

    // MARK: - parseDocumentResult: missing surface_id

    func testParseMissingSurfaceIdReturnsNilSurfaceId() {
        let json = #"{"title": "Orphan Doc"}"#
        let toolCall = ToolCallData(
            toolName: "document_create",
            inputSummary: "document_create: fallback title",
            result: json,
            isComplete: true
        )

        let result = DocumentResultParser.parse(from: toolCall)

        XCTAssertNil(result.surfaceId)
        XCTAssertEqual(result.title, "Orphan Doc")
    }

    // MARK: - parseDocumentResult: missing title falls back to summary

    func testParseMissingTitleFallsBackToSummary() {
        let json = #"{"surface_id": "doc-123"}"#
        let toolCall = ToolCallData(
            toolName: "document_create",
            inputSummary: "document_create: Pizza Recipe",
            result: json,
            isComplete: true
        )

        let result = DocumentResultParser.parse(from: toolCall)

        XCTAssertEqual(result.surfaceId, "doc-123")
        XCTAssertEqual(result.title, "Pizza Recipe")
    }

    // MARK: - parseDocumentResult: invalid / nil result

    func testParseNilResultReturnsNilSurfaceId() {
        let toolCall = ToolCallData(
            toolName: "document_create",
            inputSummary: "document_create: My Doc",
            result: nil,
            isComplete: true
        )

        let result = DocumentResultParser.parse(from: toolCall)

        XCTAssertNil(result.surfaceId)
        XCTAssertEqual(result.title, "My Doc")
    }

    func testParseInvalidJsonReturnsNilSurfaceId() {
        let toolCall = ToolCallData(
            toolName: "document_create",
            inputSummary: "document_create: Fallback",
            result: "not valid json {{{",
            isComplete: true
        )

        let result = DocumentResultParser.parse(from: toolCall)

        XCTAssertNil(result.surfaceId)
        XCTAssertEqual(result.title, "Fallback")
    }

    func testParseEmptyStringResultReturnsNilSurfaceId() {
        let toolCall = ToolCallData(
            toolName: "document_create",
            inputSummary: "document_create: Empty",
            result: "",
            isComplete: true
        )

        let result = DocumentResultParser.parse(from: toolCall)

        XCTAssertNil(result.surfaceId)
        XCTAssertEqual(result.title, "Empty")
    }

    // MARK: - titleFromSummary

    func testTitleFromSummaryExtractsAfterColon() {
        XCTAssertEqual(
            DocumentResultParser.titleFromSummary("document_create: A Great Title"),
            "A Great Title"
        )
    }

    func testTitleFromSummaryTrimsWhitespace() {
        XCTAssertEqual(
            DocumentResultParser.titleFromSummary("document_create:   Spaced Out  "),
            "Spaced Out"
        )
    }

    func testTitleFromSummaryWithNoColonReturnsUntitled() {
        XCTAssertEqual(
            DocumentResultParser.titleFromSummary("no colon here"),
            "Untitled Document"
        )
    }

    func testTitleFromSummaryWithEmptyAfterColonReturnsUntitled() {
        XCTAssertEqual(
            DocumentResultParser.titleFromSummary("prefix:   "),
            "Untitled Document"
        )
    }

    func testTitleFromSummaryEmptyStringReturnsUntitled() {
        XCTAssertEqual(
            DocumentResultParser.titleFromSummary(""),
            "Untitled Document"
        )
    }

    // MARK: - openDocumentEditor notification

    func testOpenDocumentEditorNotificationNameIsDefined() {
        let name = Notification.Name.openDocumentEditor
        XCTAssertEqual(name.rawValue, "MainWindow.openDocumentEditor")
    }

    func testOpenDocumentEditorNotificationCarriesSurfaceId() {
        let expectation = expectation(description: "openDocumentEditor received")
        var receivedSurfaceId: String?

        let observer = NotificationCenter.default.addObserver(
            forName: .openDocumentEditor,
            object: nil,
            queue: .main
        ) { notification in
            receivedSurfaceId = notification.userInfo?["documentSurfaceId"] as? String
            expectation.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        NotificationCenter.default.post(
            name: .openDocumentEditor,
            object: nil,
            userInfo: ["documentSurfaceId": "doc-notify-test"]
        )

        wait(for: [expectation], timeout: 1.0)
        XCTAssertEqual(receivedSurfaceId, "doc-notify-test")
    }

    // MARK: - Dismiss state via ChatViewModel's dismissedDocumentSurfaceIds

    /// Simulates the dismiss flow: ChatViewModel tracks dismissed surface IDs in a Set.
    /// After inserting a surface ID, the widget should not render (the guard in
    /// `documentWidget` checks `!dismissedDocumentSurfaceIds.contains(surfaceId)`).
    func testDismissedSetBlocksRendering() {
        var dismissedIds: Set<String> = []

        // Initially the surface is not dismissed
        XCTAssertFalse(dismissedIds.contains("doc-dismiss-1"))

        // Simulate the onDismiss closure
        dismissedIds.insert("doc-dismiss-1")

        XCTAssertTrue(dismissedIds.contains("doc-dismiss-1"),
                      "After dismiss, surface ID should be in the set")
    }

    func testDismissedSetPersistsAcrossMultipleInsertions() {
        var dismissedIds: Set<String> = []

        dismissedIds.insert("doc-a")
        dismissedIds.insert("doc-b")
        dismissedIds.insert("doc-c")

        XCTAssertEqual(dismissedIds.count, 3)
        XCTAssertTrue(dismissedIds.contains("doc-a"))
        XCTAssertTrue(dismissedIds.contains("doc-b"))
        XCTAssertTrue(dismissedIds.contains("doc-c"))
    }

    func testDismissedSetDoesNotAffectOtherSurfaces() {
        var dismissedIds: Set<String> = []

        dismissedIds.insert("doc-dismissed")

        XCTAssertTrue(dismissedIds.contains("doc-dismissed"))
        XCTAssertFalse(dismissedIds.contains("doc-other"),
                       "Non-dismissed surface should not be blocked")
    }

    func testDuplicateDismissIsIdempotent() {
        var dismissedIds: Set<String> = []

        dismissedIds.insert("doc-dup")
        dismissedIds.insert("doc-dup")

        XCTAssertEqual(dismissedIds.count, 1,
                       "Inserting the same ID twice should not create duplicates")
    }

    // MARK: - Integration: parse + dismiss guard logic

    func testDocumentWidgetGuardLogic() {
        let json = #"{"surface_id": "doc-guard", "title": "Guarded"}"#
        let toolCall = ToolCallData(
            toolName: "document_create",
            inputSummary: "document_create: Guarded",
            result: json,
            isComplete: true
        )

        let parsed = DocumentResultParser.parse(from: toolCall)
        var dismissedIds: Set<String> = []

        // Widget should render when not dismissed
        let shouldRender = parsed.surfaceId != nil && !dismissedIds.contains(parsed.surfaceId!)
        XCTAssertTrue(shouldRender, "Widget should render for non-dismissed surface")

        // Dismiss the surface
        dismissedIds.insert(parsed.surfaceId!)

        // Widget should not render after dismiss
        let shouldRenderAfterDismiss = parsed.surfaceId != nil && !dismissedIds.contains(parsed.surfaceId!)
        XCTAssertFalse(shouldRenderAfterDismiss, "Widget should not render after dismiss")
    }

    func testDocumentWidgetGuardWithNilSurfaceId() {
        let toolCall = ToolCallData(
            toolName: "document_create",
            inputSummary: "document_create: No ID",
            result: #"{"title": "No Surface"}"#,
            isComplete: true
        )

        let parsed = DocumentResultParser.parse(from: toolCall)
        let dismissedIds: Set<String> = []

        // nil surfaceId means the widget should not render regardless
        let shouldRender = parsed.surfaceId != nil && !dismissedIds.contains(parsed.surfaceId ?? "")
        XCTAssertFalse(shouldRender, "Widget should not render without a surface ID")
    }
}
