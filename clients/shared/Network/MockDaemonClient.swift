#if DEBUG
import Foundation

/// Lightweight in-memory mock for `DaemonStatusProtocol`, used in tests and SwiftUI previews.
@MainActor
public final class MockDaemonClient: DaemonStatusProtocol, ObservableObject {
    public var isConnected: Bool = false

    /// Event stream client — tests use `eventStreamClient.subscribe()` to
    /// receive messages and `eventStreamClient.broadcastMessage()` to inject them.
    public let eventStreamClient = EventStreamClient()

    public init() {}

    public func connect() async throws {
        isConnected = true
    }

    public func disconnect() {
        isConnected = false
    }

    /// Convenience: inject a server message into all subscribers.
    public func emit(_ message: ServerMessage) {
        eventStreamClient.broadcastMessage(message)
    }
}

public typealias MockDaemonStatus = MockDaemonClient
#endif
