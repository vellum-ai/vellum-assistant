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

    /// Regression test for expanded thinking blocks going blank at the end of
    /// an active turn. When `MessageListContentView` tears down and rebuilds
    /// the wrapped subtree as `isActiveTurn` flips true → false, a freshly
    /// constructed `ThinkingBlockView` reads `isExpanded == true` from the
    /// store (preserved by commit `54e20c80b`) but its `@State` segment cache
    /// is empty. Neither `onChange(of: content)` nor `onChange(of: isExpanded)`
    /// fires on initial values, so the block rendered blank until the user
    /// manually toggled it. `.onAppear` now seeds the cache in that case.
    /// This test evaluates the body of an already-expanded view with
    /// non-trivial markdown content to exercise the seeding path.
    func testThinkingBlockExpandedOnAppearSeedsSegmentCache() {
        let store = ThinkingBlockExpansionStore()
        store.toggle("turn-end-key")

        let view = ThinkingBlockView(
            content: """
            # Reasoning

            Step one: consider the input.

            *pauses*

            Step two: produce the output.
            """,
            isStreaming: false,
            expansionKey: "turn-end-key"
        )

        _ = view.body
    }
}
