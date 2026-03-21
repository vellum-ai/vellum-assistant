#if DEBUG
import Foundation

/// Lightweight in-memory mock for `DaemonStatusProtocol`, used in tests and SwiftUI previews.
@MainActor
public final class MockDaemonClient: DaemonStatusProtocol, ObservableObject {
    public var isConnected: Bool = false

    /// Mock EventStreamClient for tests that need subscribe/send.
    public let eventStreamClient = EventStreamClient()

    /// Continuations to feed messages into active `subscribe()` streams.
    private var continuations: [AsyncStream<ServerMessage>.Continuation] = []

    public init() {}

    public func connect() async throws {
        isConnected = true
    }

    public func disconnect() {
        isConnected = false
    }

    /// Subscribe to the mock event stream.
    public func subscribe() -> AsyncStream<ServerMessage> {
        AsyncStream { continuation in
            self.continuations.append(continuation)
        }
    }

    /// Inject a server message into all active subscribers.
    public func emit(_ message: ServerMessage) {
        for continuation in continuations {
            continuation.yield(message)
        }
    }
}

public typealias MockDaemonStatus = MockDaemonClient
#endif
