import XCTest
@testable import VellumAssistantShared

final class ChatVisibleMessageFilterTests: XCTestCase {

    // MARK: - visibleMessages

    func testHiddenAutomatedMessagesAreFilteredOut() {
        var hidden = ChatMessage(role: .user, text: "bootstrap")
        hidden.isHidden = true
        let visible = ChatMessage(role: .user, text: "Hello")

        let result = ChatVisibleMessageFilter.visibleMessages(from: [hidden, visible])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].text, "Hello")
    }

    func testSubagentNotificationsAreFilteredOut() {
        var notification = ChatMessage(role: .assistant, text: "Subagent completed")
        notification.isSubagentNotification = true
        let visible = ChatMessage(role: .assistant, text: "Here is the result")

        let result = ChatVisibleMessageFilter.visibleMessages(from: [notification, visible])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].text, "Here is the result")
    }

    func testNormalVisibleMessagesArePreserved() {
        let user = ChatMessage(role: .user, text: "What is the weather?")
        let assistant = ChatMessage(role: .assistant, text: "It is sunny today.")

        let result = ChatVisibleMessageFilter.visibleMessages(from: [user, assistant])

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].text, "What is the weather?")
        XCTAssertEqual(result[1].text, "It is sunny today.")
    }

    func testMixedArrayFiltersCorrectly() {
        var hidden = ChatMessage(role: .user, text: "auto-wake")
        hidden.isHidden = true
        let user = ChatMessage(role: .user, text: "Tell me a joke")
        var notification = ChatMessage(role: .assistant, text: "Subagent done")
        notification.isSubagentNotification = true
        let assistant = ChatMessage(role: .assistant, text: "Why did the chicken cross the road?")
        var bothFlags = ChatMessage(role: .assistant, text: "ghost message")
        bothFlags.isHidden = true
        bothFlags.isSubagentNotification = true

        let result = ChatVisibleMessageFilter.visibleMessages(
            from: [hidden, user, notification, assistant, bothFlags]
        )

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].text, "Tell me a joke")
        XCTAssertEqual(result[1].text, "Why did the chicken cross the road?")
    }

    func testPhantomEmptyMessagesAreFilteredOut() {
        // Phantom messages with no renderable content (empty text, no tool calls,
        // no attachments, no special widgets) should be excluded.
        let phantom = ChatMessage(role: .assistant, text: "")
        let visible = ChatMessage(role: .assistant, text: "Real response")

        let result = ChatVisibleMessageFilter.visibleMessages(from: [phantom, visible])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].text, "Real response")
    }

    func testMessagesWithToolCallsAreNotFilteredOut() {
        var msg = ChatMessage(role: .assistant, text: "", toolCalls: [
            ToolCallData(toolName: "Bash", inputSummary: "ls", inputFull: "", inputRawValue: "")
        ])
        msg.contentOrder = [.toolCall(0)]

        let result = ChatVisibleMessageFilter.visibleMessages(from: [msg])

        XCTAssertEqual(result.count, 1)
    }

    func testEmptyArrayReturnsEmpty() {
        let result = ChatVisibleMessageFilter.visibleMessages(from: [])
        XCTAssertTrue(result.isEmpty)
    }

    // MARK: - paginatedMessages

    func testSuffixWindowReturnsAllWhenDisplayedMessageCountIsMax() {
        let messages = (0..<10).map { i in
            ChatMessage(role: .user, text: "Message \(i)")
        }

        let result = ChatVisibleMessageFilter.paginatedMessages(
            from: messages,
            displayedMessageCount: .max
        )

        XCTAssertEqual(result.count, 10)
    }

    func testSuffixWindowUsesFilteredVisibleSetNotRawCount() {
        // 5 raw messages, but 2 are hidden/notification, so 3 visible.
        var hidden1 = ChatMessage(role: .user, text: "hidden-1")
        hidden1.isHidden = true
        var notif1 = ChatMessage(role: .assistant, text: "notif-1")
        notif1.isSubagentNotification = true
        let visible1 = ChatMessage(role: .user, text: "A")
        let visible2 = ChatMessage(role: .assistant, text: "B")
        let visible3 = ChatMessage(role: .user, text: "C")

        // Request last 2 visible messages — should get B and C, not based on raw array.
        let result = ChatVisibleMessageFilter.paginatedMessages(
            from: [hidden1, visible1, notif1, visible2, visible3],
            displayedMessageCount: 2
        )

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].text, "B")
        XCTAssertEqual(result[1].text, "C")
    }

    func testSuffixWindowReturnsAllWhenCountExceedsVisible() {
        let messages = [
            ChatMessage(role: .user, text: "First"),
            ChatMessage(role: .assistant, text: "Second"),
        ]

        let result = ChatVisibleMessageFilter.paginatedMessages(
            from: messages,
            displayedMessageCount: 100
        )

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].text, "First")
        XCTAssertEqual(result[1].text, "Second")
    }

    func testSuffixWindowReturnsCorrectSlice() {
        let messages = (0..<5).map { i in
            ChatMessage(role: .user, text: "Msg \(i)")
        }

        let result = ChatVisibleMessageFilter.paginatedMessages(
            from: messages,
            displayedMessageCount: 3
        )

        XCTAssertEqual(result.count, 3)
        XCTAssertEqual(result[0].text, "Msg 2")
        XCTAssertEqual(result[1].text, "Msg 3")
        XCTAssertEqual(result[2].text, "Msg 4")
    }
}
