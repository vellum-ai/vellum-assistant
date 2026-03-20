import XCTest
@testable import VellumAssistantShared

/// Unit tests for MockDaemonClient — verifies initial state, connect/disconnect lifecycle,
/// send recording, and emit-to-subscriber delivery.
@MainActor
final class MockDaemonClientTests: XCTestCase {

    // MARK: - Initial State

    func testInitialStateIsDisconnected() {
        let client = MockDaemonClient()
        XCTAssertFalse(client.isConnected, "New client should start disconnected")
    }

    func testInitialSentMessagesIsEmpty() {
        let client = MockDaemonClient()
        XCTAssertTrue(client.sentMessages.isEmpty, "No messages should be recorded before any sends")
    }

    // MARK: - Connect / Disconnect

    func testConnectSetsIsConnected() async throws {
        let client = MockDaemonClient()
        try await client.connect()
        XCTAssertTrue(client.isConnected, "connect() should set isConnected to true")
    }

    func testDisconnectClearsIsConnected() async throws {
        let client = MockDaemonClient()
        try await client.connect()
        XCTAssertTrue(client.isConnected)
        client.disconnect()
        XCTAssertFalse(client.isConnected, "disconnect() should set isConnected to false")
    }

    func testDisconnectWithoutConnectIsNoOp() {
        let client = MockDaemonClient()
        // Should not crash or throw
        client.disconnect()
        XCTAssertFalse(client.isConnected, "disconnect() on an already-disconnected client should be a no-op")
    }

    // MARK: - Send Recording

    func testSendRecordsSingleMessage() {
        let client = MockDaemonClient()
        client.sendUserMessage(content: "Hello", conversationId: "conv-1")
        XCTAssertEqual(client.sentMessages.count, 1, "One send should record exactly one message")
        XCTAssertEqual(client.sentMessages[0].content, "Hello")
        XCTAssertEqual(client.sentMessages[0].conversationId, "conv-1")
    }

    func testSendRecordsMultipleMessages() {
        let client = MockDaemonClient()
        client.sendUserMessage(content: "A", conversationId: "conv-1")
        client.sendUserMessage(content: "B", conversationId: "conv-2")
        client.sendUserMessage(content: "C", conversationId: "conv-3")
        XCTAssertEqual(client.sentMessages.count, 3, "Three sends should record three messages")
    }

    func testSendRecordsNilContent() {
        let client = MockDaemonClient()
        client.sendUserMessage(content: nil, conversationId: "conv-1")
        XCTAssertEqual(client.sentMessages.count, 1)
        XCTAssertNil(client.sentMessages[0].content)
        XCTAssertEqual(client.sentMessages[0].conversationId, "conv-1")
    }

    func testSendRecordsConversationId() {
        let client = MockDaemonClient()
        client.sendUserMessage(content: "Test", conversationId: "sess-abc")
        XCTAssertEqual(client.sentMessages.count, 1)
        XCTAssertEqual(client.sentMessages[0].conversationId, "sess-abc")
    }

    // MARK: - Subscribe / Emit

    func testSubscribeReturnsStream() {
        let client = MockDaemonClient()
        let stream = client.subscribe()
        // Simply verify subscribe() returns without crashing; stream is non-nil (value type)
        _ = stream
    }

    func testEmitDeliversToSubscriber() async {
        let client = MockDaemonClient()
        let stream = client.subscribe()

        // Collect one message from the stream
        let expectation = XCTestExpectation(description: "Subscriber receives emitted message")
        var receivedMessage: ServerMessage?

        let task = Task {
            for await message in stream {
                receivedMessage = message
                expectation.fulfill()
                break
            }
        }

        // Give the task a moment to start waiting on the stream
        await Task.yield()

        // Emit a message
        let delta = AssistantTextDeltaMessage(text: "Hello from emit")
        client.emit(.assistantTextDelta(delta))

        await fulfillment(of: [expectation], timeout: 2.0)
        task.cancel()

        if case .assistantTextDelta(let received) = receivedMessage {
            XCTAssertEqual(received.text, "Hello from emit")
        } else {
            XCTFail("Expected .assistantTextDelta, got \(String(describing: receivedMessage))")
        }
    }

    func testEmitDeliversToMultipleSubscribers() async {
        let client = MockDaemonClient()

        let stream1 = client.subscribe()
        let stream2 = client.subscribe()

        let exp1 = XCTestExpectation(description: "Subscriber 1 receives message")
        let exp2 = XCTestExpectation(description: "Subscriber 2 receives message")

        var received1: ServerMessage?
        var received2: ServerMessage?

        let task1 = Task {
            for await msg in stream1 {
                received1 = msg
                exp1.fulfill()
                break
            }
        }

        let task2 = Task {
            for await msg in stream2 {
                received2 = msg
                exp2.fulfill()
                break
            }
        }

        await Task.yield()

        client.emit(.messageComplete(MessageCompleteMessage()))

        await fulfillment(of: [exp1, exp2], timeout: 2.0)
        task1.cancel()
        task2.cancel()

        if case .messageComplete = received1 {} else {
            XCTFail("Subscriber 1 expected .messageComplete, got \(String(describing: received1))")
        }
        if case .messageComplete = received2 {} else {
            XCTFail("Subscriber 2 expected .messageComplete, got \(String(describing: received2))")
        }
    }

    // MARK: - Multiple Connect/Disconnect Cycles

    func testMultipleConnectDisconnectCycles() async throws {
        let client = MockDaemonClient()

        try await client.connect()
        XCTAssertTrue(client.isConnected)

        client.disconnect()
        XCTAssertFalse(client.isConnected)

        try await client.connect()
        XCTAssertTrue(client.isConnected, "Should be able to reconnect after disconnect")

        client.disconnect()
        XCTAssertFalse(client.isConnected)
    }
}
