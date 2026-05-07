import XCTest
@testable import VellumAssistantShared

/// Unit tests for GatewayConnectionManager — verifies initial state, connect/disconnect lifecycle,
/// send recording, and emit-to-subscriber delivery.
@MainActor
final class GatewayConnectionManagerTests: XCTestCase {

    // MARK: - Initial State

    func testInitialStateIsDisconnected() {
        let client = GatewayConnectionManager()
        XCTAssertFalse(client.isConnected, "New client should start disconnected")
    }

    // MARK: - Connect / Disconnect

    func testConnectSetsIsConnected() async throws {
        let client = GatewayConnectionManager()
        try await client.connect()
        XCTAssertTrue(client.isConnected, "connect() should set isConnected to true")
    }

    func testDisconnectClearsIsConnected() async throws {
        let client = GatewayConnectionManager()
        try await client.connect()
        XCTAssertTrue(client.isConnected)
        client.disconnect()
        XCTAssertFalse(client.isConnected, "disconnect() should set isConnected to false")
    }

    func testDisconnectWithoutConnectIsNoOp() {
        let client = GatewayConnectionManager()
        // Should not crash or throw
        client.disconnect()
        XCTAssertFalse(client.isConnected, "disconnect() on an already-disconnected client should be a no-op")
    }

    // MARK: - Subscribe / Emit

    func testSubscribeReturnsStream() {
        let client = GatewayConnectionManager()
        let stream = client.eventStreamClient.subscribe()
        // Simply verify subscribe() returns without crashing; stream is non-nil (value type)
        _ = stream
    }

    func testEmitDeliversToSubscriber() async {
        let client = GatewayConnectionManager()
        let stream = client.eventStreamClient.subscribe()

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
        client.eventStreamClient.broadcastMessage(.assistantTextDelta(delta))

        await fulfillment(of: [expectation], timeout: 2.0)
        task.cancel()

        if case .assistantTextDelta(let received) = receivedMessage {
            XCTAssertEqual(received.text, "Hello from emit")
        } else {
            XCTFail("Expected .assistantTextDelta, got \(String(describing: receivedMessage))")
        }
    }

    func testEmitDeliversToMultipleSubscribers() async {
        let client = GatewayConnectionManager()

        let stream1 = client.eventStreamClient.subscribe()
        let stream2 = client.eventStreamClient.subscribe()

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

        client.eventStreamClient.broadcastMessage(.messageComplete(MessageCompleteMessage()))

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
        let client = GatewayConnectionManager()

        try await client.connect()
        XCTAssertTrue(client.isConnected)

        client.disconnect()
        XCTAssertFalse(client.isConnected)

        try await client.connect()
        XCTAssertTrue(client.isConnected, "Should be able to reconnect after disconnect")

        client.disconnect()
        XCTAssertFalse(client.isConnected)
    }

    // MARK: - setConnected Coalescing

    /// Back-to-back calls within a single `@MainActor` turn collapse to
    /// the most-recent target; the public property is unchanged until
    /// the in-flight task drains.
    func testSetConnectedDefersWritesAndCoalescesToFinalTarget() async {
        let client = GatewayConnectionManager()
        XCTAssertFalse(client.isConnected)

        client._testSetConnected(true)
        client._testSetConnected(false)
        client._testSetConnected(true)
        client._testSetConnected(false)
        client._testSetConnected(true)

        XCTAssertFalse(client.isConnected, "Coalesced writes must not apply within the same actor turn")

        await client._testAwaitPendingConnectedTransitions()

        XCTAssertTrue(client.isConnected, "Final coalesced target should be the last setConnected call")
    }

    /// A transient flap (true → false) that returns to the original
    /// value drains as a no-op.
    func testSetConnectedCoalescesBackToOriginalValueAsNoOp() async {
        let client = GatewayConnectionManager()

        client._testSetConnected(true)
        client._testSetConnected(false)
        await client._testAwaitPendingConnectedTransitions()

        XCTAssertFalse(client.isConnected, "Coalesced apply with final target equal to prior value is a no-op")
    }
}
