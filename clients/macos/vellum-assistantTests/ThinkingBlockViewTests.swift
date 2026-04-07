import XCTest
@testable import VellumAssistantLib

@MainActor
final class ThinkingBlockViewTests: XCTestCase {
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
