import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatTranscriptFormatterTests: XCTestCase {

    private let names = ChatTranscriptFormatter.ParticipantNames(
        assistantName: "Aria",
        userName: "Noa"
    )

    // MARK: - conversationMarkdown

    func testConversationMarkdownWithTitleAndMessages() {
        let messages = [
            ChatMessage(role: .user, text: "Hello!"),
            ChatMessage(role: .assistant, text: "Hi there!")
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: "Test Conversation",
            participantNames: names
        )

        XCTAssertTrue(result.hasPrefix("# Test Conversation"))
        XCTAssertTrue(result.contains("### Noa"))
        XCTAssertTrue(result.contains("Hello!"))
        XCTAssertTrue(result.contains("### Aria"))
        XCTAssertTrue(result.contains("Hi there!"))
        XCTAssertTrue(result.contains("---"))
    }

    func testConversationMarkdownWithoutTitle() {
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

    func testConversationMarkdownSkipsEmptyTextMessages() {
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

    func testConversationMarkdownEmptyInputReturnsEmptyString() {
        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: [],
            conversationTitle: "Empty Conversation",
            participantNames: names
        )

        XCTAssertEqual(result, "")
    }

    func testConversationMarkdownAllEmptyTextReturnsEmptyString() {
        let messages = [
            ChatMessage(role: .assistant, text: ""),
            ChatMessage(role: .user, text: "  \n  "),
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: "Conversation",
            participantNames: names
        )

        XCTAssertEqual(result, "")
    }

    func testConversationMarkdownSeparatorsBetweenMessages() {
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

    func testConversationMarkdownUsesParticipantNames() {
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

    // MARK: - Queued message filtering

    func testConversationMarkdownExcludesQueuedUserMessages() {
        let messages = [
            ChatMessage(role: .user, text: "Sent question", status: .sent),
            ChatMessage(role: .assistant, text: "Answer"),
            ChatMessage(role: .user, text: "Queued follow-up", status: .queued(position: 0)),
            ChatMessage(role: .user, text: "Another queued", status: .queued(position: 1)),
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: nil,
            participantNames: names
        )

        XCTAssertTrue(result.contains("Sent question"))
        XCTAssertTrue(result.contains("Answer"))
        XCTAssertFalse(result.contains("Queued follow-up"))
        XCTAssertFalse(result.contains("Another queued"))
        // Two surviving messages → exactly one separator.
        let separatorCount = result.components(separatedBy: "\n\n---\n\n").count - 1
        XCTAssertEqual(separatorCount, 1)
    }

    func testConversationMarkdownPreservesSentAndAssistantMessagesWhenNoneQueued() {
        let messages = [
            ChatMessage(role: .user, text: "Hello", status: .sent),
            ChatMessage(role: .assistant, text: "Hi"),
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: nil,
            participantNames: names
        )

        XCTAssertTrue(result.contains("Hello"))
        XCTAssertTrue(result.contains("Hi"))
    }

    func testConversationMarkdownReturnsEmptyWhenAllUserMessagesQueued() {
        let messages = [
            ChatMessage(role: .user, text: "Pending one", status: .queued(position: 0)),
            ChatMessage(role: .user, text: "Pending two", status: .queued(position: 1)),
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: "Drafts",
            participantNames: names
        )

        XCTAssertEqual(result, "")
    }

    func testConversationMarkdownKeepsAssistantMessageWithQueuedStatus() {
        // Defensive: filter is scoped to user role, so an assistant message with
        // an unusual status should still come through unchanged.
        let messages = [
            ChatMessage(role: .assistant, text: "Streaming reply", status: .queued(position: 0)),
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: nil,
            participantNames: names
        )

        XCTAssertTrue(result.contains("Streaming reply"))
        XCTAssertTrue(result.contains("### Aria"))
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
