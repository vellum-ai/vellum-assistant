import XCTest
@testable import VellumAssistantLib

@MainActor
final class ThinkingBlockViewTests: XCTestCase {
    func testMakeMarkdownViewParsesMarkdownContent() {
        let markdownView = ThinkingBlockView.makeMarkdownView(
            content: "*italic* and **bold**",
            isStreaming: false
        )

        XCTAssertEqual(markdownView.segments, parseMarkdownSegments("*italic* and **bold**"))
        XCTAssertFalse(markdownView.isStreaming)
    }

    func testExpandedThinkingBlockBodyDoesNotCrashWithMarkdown() {
        let view = ThinkingBlockView(
            content: """
            *gasps against the fabric*

            *muffled, breathless*
            """,
            isStreaming: false,
            initiallyExpanded: true
        )

        _ = view.body
    }
}
