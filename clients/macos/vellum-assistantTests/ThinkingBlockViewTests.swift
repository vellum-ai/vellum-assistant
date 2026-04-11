import XCTest
@testable import VellumAssistantLib

@MainActor
final class ThinkingBlockViewTests: XCTestCase {
    /// Regression test for a crash where `parseMarkdownSegments` applied to
    /// thinking-block content with italics separated by blank lines tripped
    /// an NSRange assertion during expanded-card seeding.
    /// (See commit `adaf6e796`.)
    func testParseMarkdownSegmentsDoesNotCrashOnItalicsAcrossBlankLines() {
        _ = parseMarkdownSegments("""
        *gasps against the fabric*

        *muffled, breathless*
        """)
    }

    /// Smoke test that `ThinkingBlockView.body` can be evaluated against
    /// the store-backed expansion without crashing.
    func testThinkingBlockBodyEvaluatesWithStoreInjection() {
        let store = ThinkingBlockExpansionStore()
        store.toggle("test-key")

        let view = ThinkingBlockView(
            content: "thinking content",
            isStreaming: false,
            expansionKey: "test-key"
        )

        _ = view.body
    }
}
