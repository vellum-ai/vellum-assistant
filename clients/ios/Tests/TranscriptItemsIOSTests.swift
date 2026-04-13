import XCTest
@testable import VellumAssistantShared

/// iOS-side verification of the shared `TranscriptItems.build(from:)` helper
/// used by `ChatContentView` to collapse inline queued user bubbles into a
/// single marker. The shared helper is already tested on macOS
/// (`clients/macos/vellum-assistantTests/TranscriptItemsTests.swift`) — these
/// cases ensure the import resolves and guard against platform-specific
/// regressions (e.g. a future refactor that accidentally diverges the iOS
/// transcript projection).
final class TranscriptItemsIOSTests: XCTestCase {

    // MARK: - Helpers

    private func userMessage(text: String, status: ChatMessageStatus = .sent) -> ChatMessage {
        ChatMessage(role: .user, text: text, status: status)
    }

    private func assistantMessage(text: String) -> ChatMessage {
        ChatMessage(role: .assistant, text: text)
    }

    // MARK: - Tests

    func test_transcriptItems_collapsesQueuedUserBubblesIntoSingleMarker() {
        let assistantSent = assistantMessage(text: "hello")
        let userSent = userMessage(text: "hi", status: .sent)
        let userQueued1 = userMessage(text: "follow-up 1", status: .queued(position: 1))
        let userQueued2 = userMessage(text: "follow-up 2", status: .queued(position: 2))
        let assistantSent2 = assistantMessage(text: "ack")
        let messages = [assistantSent, userSent, userQueued1, userQueued2, assistantSent2]

        let result = TranscriptItems.build(from: messages)

        XCTAssertEqual(result.count, 4)
        XCTAssertEqual(result[0], .message(assistantSent))
        XCTAssertEqual(result[1], .message(userSent))
        XCTAssertEqual(result[2], .queuedMarker(count: 2, anchorId: userQueued1.id))
        XCTAssertEqual(result[3], .message(assistantSent2))
    }

    func test_transcriptItems_noQueuedMessagesYieldsOriginalList() {
        let messages = [
            assistantMessage(text: "a"),
            userMessage(text: "b"),
            assistantMessage(text: "c"),
            userMessage(text: "d"),
        ]

        let result = TranscriptItems.build(from: messages)

        XCTAssertEqual(result.count, messages.count)
        for (index, message) in messages.enumerated() {
            XCTAssertEqual(result[index], .message(message))
        }
    }

    func test_transcriptItems_queuedMessagesAtEnd_markerAtEnd() {
        let assistantSent = assistantMessage(text: "hi")
        let userSent = userMessage(text: "hello", status: .sent)
        let queued1 = userMessage(text: "q1", status: .queued(position: 1))
        let queued2 = userMessage(text: "q2", status: .queued(position: 2))
        let queued3 = userMessage(text: "q3", status: .queued(position: 3))
        let messages = [assistantSent, userSent, queued1, queued2, queued3]

        let result = TranscriptItems.build(from: messages)

        XCTAssertEqual(result.count, 3)
        XCTAssertEqual(result[0], .message(assistantSent))
        XCTAssertEqual(result[1], .message(userSent))
        XCTAssertEqual(result.last, .queuedMarker(count: 3, anchorId: queued1.id))
    }
}
