import XCTest
@testable import VellumAssistantShared

/// Tests for ChatTranscriptFormatter from the iOS perspective.
/// Verifies that the shared transcript formatting logic works correctly for iOS usage:
/// conversation markdown generation, plain text extraction, and participant name handling.
@MainActor
final class ChatTranscriptFormatterIOSTests: XCTestCase {

    private let names = ChatTranscriptFormatter.ParticipantNames(
        assistantName: "Velly",
        userName: "User"
    )

    // MARK: - conversationMarkdown

    func testConversationMarkdownWithTitleAndMessages() {
        let messages = [
            ChatMessage(role: .user, text: "Hello from iPhone!"),
            ChatMessage(role: .assistant, text: "Hi there, iOS user!")
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: "iOS Conversation",
            participantNames: names
        )

        XCTAssertTrue(result.hasPrefix("# iOS Conversation"))
        XCTAssertTrue(result.contains("### User"))
        XCTAssertTrue(result.contains("Hello from iPhone!"))
        XCTAssertTrue(result.contains("### Velly"))
        XCTAssertTrue(result.contains("Hi there, iOS user!"))
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
        XCTAssertTrue(result.contains("### User"))
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

        XCTAssertFalse(result.contains("### Velly"))
        XCTAssertTrue(result.contains("### User"))
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

    func testConversationMarkdownUsesCustomParticipantNames() {
        let customNames = ChatTranscriptFormatter.ParticipantNames(
            assistantName: "Assistant",
            userName: "iPhone User"
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

        XCTAssertTrue(result.contains("### iPhone User"))
        XCTAssertTrue(result.contains("### Assistant"))
        XCTAssertFalse(result.contains("Velly"))
        XCTAssertFalse(result.contains("### User\n"), "Should not contain default 'User' participant name")
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

    // MARK: - Multi-turn Conversation Transcript

    func testMultiTurnConversationFormat() {
        let messages = [
            ChatMessage(role: .user, text: "What is SwiftUI?"),
            ChatMessage(role: .assistant, text: "SwiftUI is a declarative UI framework."),
            ChatMessage(role: .user, text: "How does it differ from UIKit?"),
            ChatMessage(role: .assistant, text: "SwiftUI uses a declarative approach while UIKit is imperative."),
        ]

        let result = ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: "SwiftUI Discussion",
            participantNames: names
        )

        XCTAssertTrue(result.hasPrefix("# SwiftUI Discussion"))
        let separatorCount = result.components(separatedBy: "\n\n---\n\n").count - 1
        XCTAssertEqual(separatorCount, 3, "Should have 3 separators between 4 messages")
    }
}
