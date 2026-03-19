import XCTest
@testable import VellumAssistantShared

final class CommandListBubbleTests: XCTestCase {
    func testParsedEntriesPreserveAssistantCommandRowsWithoutSynthesizingPlatformCommands() {
        let assistantText = """
        COMMANDS
        - /commands — List all available commands
        - /models — List all available models
        - /status — Show conversation status and context usage
        - /btw — Ask a side question while the assistant is working
        """

        let parsed = CommandListBubble.parsedEntries(from: assistantText)

        XCTAssertEqual(parsed?.map(\.id), ["/commands", "/models", "/status", "/btw"])
        XCTAssertEqual(parsed?.map(\.description), [
            "List all available commands",
            "List all available models",
            "Show conversation status and context usage",
            "Ask a side question while the assistant is working",
        ])
    }

    func testParsedEntriesReturnNilForNonCommandListText() {
        let assistantText = """
        I can help with commands, but this message is just prose.
        """

        XCTAssertNil(CommandListBubble.parsedEntries(from: assistantText))
    }
}
