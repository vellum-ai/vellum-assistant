import XCTest
@testable import VellumAssistantShared

final class TranscriptItemsTests: XCTestCase {

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
        // The plan specifies ordering [assistant-sent, user-sent, user-queued, user-queued, assistant-sent].
        // In real traffic, the latter assistant couldn't actually arrive after queued messages,
        // but the helper is pure data — verify the ordering rules hold for arbitrary input.
        let messages = [assistantSent, userSent, userQueued1, userQueued2, assistantSent2]

        let result = TranscriptItems.build(from: messages)

        XCTAssertEqual(result.count, 4)
        XCTAssertEqual(result[0], .message(assistantSent))
        XCTAssertEqual(result[1], .message(userSent))
        XCTAssertEqual(result[2], .queuedMarker(count: 2))
        XCTAssertEqual(result[3], .message(assistantSent2))
        // The marker uses the stable sentinel id, not any message id, so
        // SwiftUI keeps the same view across queue mutations (e.g. when the
        // head dequeues and the "first queued message" changes).
        XCTAssertEqual(result[2].id, TranscriptItems.queueMarkerId)
        XCTAssertNotEqual(result[2].id, userQueued1.id)
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
        XCTAssertEqual(result.last, .queuedMarker(count: 3))
        XCTAssertEqual(result.last?.id, TranscriptItems.queueMarkerId)
    }

    // MARK: - Identity

    func test_transcriptItem_id_marker_usesStableSentinel() {
        // The marker's identity must be a constant sentinel — not a message
        // id — so SwiftUI `ForEach` / animation diffing treats it as the same
        // view across queue mutations (e.g. when the head of the queue
        // dequeues, the "first queued message" id would otherwise change).
        XCTAssertEqual(TranscriptItem.queuedMarker(count: 2).id, TranscriptItems.queueMarkerId)
        XCTAssertEqual(TranscriptItem.queuedMarker(count: 7).id, TranscriptItems.queueMarkerId)
    }

    func test_transcriptItem_id_message_usesMessageId() {
        let message = userMessage(text: "hi")
        XCTAssertEqual(TranscriptItem.message(message).id, message.id)
    }

    // MARK: - Edge cases

    func test_transcriptItems_singleQueuedMessage_yieldsMarkerWithCountOne() {
        let assistantSent = assistantMessage(text: "hi")
        let queued = userMessage(text: "queued", status: .queued(position: 1))
        let messages = [assistantSent, queued]

        let result = TranscriptItems.build(from: messages)

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0], .message(assistantSent))
        XCTAssertEqual(result[1], .queuedMarker(count: 1))
        XCTAssertEqual(result[1].id, TranscriptItems.queueMarkerId)
    }

    func test_transcriptItems_queuedAssistantMessage_isNotCollapsed() {
        // Assistant messages never carry .queued in practice, but the helper
        // should only collapse when role == .user AND status is .queued.
        // This guards against accidentally hiding non-user queued statuses
        // if the model ever permits them.
        let queuedAssistant = ChatMessage(role: .assistant, text: "q", status: .queued(position: 1))
        let messages = [queuedAssistant]

        let result = TranscriptItems.build(from: messages)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0], .message(queuedAssistant))
    }

    func test_transcriptItems_emptyInput_yieldsEmptyOutput() {
        XCTAssertEqual(TranscriptItems.build(from: []).count, 0)
    }
}
