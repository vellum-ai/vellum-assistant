import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatTranscriptFormatterTests: XCTestCase {

    private let names = ChatTranscriptFormatter.ParticipantNames(
        assistantName: "Aria",
        userName: "Noa"
    )

    // MARK: - conversationMarkdown

    func testThreadMarkdownWithTitleAndMessages() {
        let messages = [
            ChatMessage(role: .user, text: "Hello!"),
            ChatMessage(role: .assistant, text: "Hi there!")
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: "Test Thread",
            participantNames: names
        )

        XCTAssertTrue(result.hasPrefix("# Test Thread"))
        XCTAssertTrue(result.contains("### Noa"))
        XCTAssertTrue(result.contains("Hello!"))
        XCTAssertTrue(result.contains("### Aria"))
        XCTAssertTrue(result.contains("Hi there!"))
        XCTAssertTrue(result.contains("---"))
    }

    func testThreadMarkdownWithoutTitle() {
        let messages = [
            ChatMessage(role: .user, text: "Hello!")
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: nil,
            participantNames: names
        )

        XCTAssertFalse(result.hasPrefix("# "))
        XCTAssertTrue(result.contains("### Noa"))
        XCTAssertTrue(result.contains("Hello!"))
    }

    func testThreadMarkdownSkipsEmptyTextMessages() {
        let messages = [
            ChatMessage(role: .assistant, text: ""),
            ChatMessage(role: .user, text: "Real message"),
            ChatMessage(role: .assistant, text: "   "),
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: nil,
            participantNames: names
        )

        XCTAssertFalse(result.contains("### Aria"))
        XCTAssertTrue(result.contains("### Noa"))
        XCTAssertTrue(result.contains("Real message"))
        XCTAssertFalse(result.contains("---"))
    }

    func testThreadMarkdownEmptyInputReturnsEmptyString() {
        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: [],
            conversationTitle: "Empty Thread",
            participantNames: names
        )

        XCTAssertEqual(result, "")
    }

    func testThreadMarkdownAllEmptyTextReturnsEmptyString() {
        let messages = [
            ChatMessage(role: .assistant, text: ""),
            ChatMessage(role: .user, text: "  \n  "),
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: "Thread",
            participantNames: names
        )

        XCTAssertEqual(result, "")
    }

    func testThreadMarkdownSeparatorsBetweenMessages() {
        let messages = [
            ChatMessage(role: .user, text: "First"),
            ChatMessage(role: .assistant, text: "Second"),
            ChatMessage(role: .user, text: "Third"),
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: nil,
            participantNames: names
        )

        let separatorCount = result.components(separatedBy: "\n\n---\n\n").count - 1
        XCTAssertEqual(separatorCount, 2)
    }

    func testThreadMarkdownUsesParticipantNames() {
        let customNames = ChatTranscriptFormatter.ParticipantNames(
            assistantName: "Bot",
            userName: "Human"
        )
        let messages = [
            ChatMessage(role: .user, text: "Hi"),
            ChatMessage(role: .assistant, text: "Hello")
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: nil,
            participantNames: customNames
        )

        XCTAssertTrue(result.contains("### Human"))
        XCTAssertTrue(result.contains("### Bot"))
        XCTAssertFalse(result.contains("Aria"))
        XCTAssertFalse(result.contains("Noa"))
    }

    // MARK: - messagePlainText

    func testMessagePlainTextReturnsTrimmedText() {
        let message = ChatMessage(role: .assistant, text: "  Hello world  ")
        XCTAssertEqual(ChatTranscriptFormatter.messagePlainText(message), "Hello world")
    }

    func testMessagePlainTextReturnsEmptyForBlankMessage() {
        let message = ChatMessage(role: .user, text: "   ")
        XCTAssertEqual(ChatTranscriptFormatter.messagePlainText(message), "")
    }

    func testMessagePlainTextReturnsEmptyForEmptyMessage() {
        let message = ChatMessage(role: .user, text: "")
        XCTAssertEqual(ChatTranscriptFormatter.messagePlainText(message), "")
    }
}
