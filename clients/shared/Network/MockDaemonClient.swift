#if DEBUG
import Foundation

/// Lightweight in-memory mock for `DaemonStatusProtocol`, used in tests and SwiftUI previews.
@MainActor
public final class MockDaemonClient: DaemonStatusProtocol, ObservableObject {
    public var isConnected: Bool = false

    /// Continuations to feed messages into active `subscribe()` streams.
    private var continuations: [AsyncStream<ServerMessage>.Continuation] = []

    public init() {}

    public func subscribe() -> AsyncStream<ServerMessage> {
        AsyncStream { continuation in
            self.continuations.append(continuation)
        }
    }

    public func connect() async throws {
        isConnected = true
    }

    public func disconnect() {
        isConnected = false
    }

    /// Messages recorded by `sendUserMessage()` for assertion in tests.
    public private(set) var sentMessages: [(content: String?, conversationId: String)] = []

    public func sendUserMessage(content: String?, conversationId: String, attachments: [UserMessageAttachment]? = nil, conversationType: String? = nil, automated: Bool? = nil) {
        sentMessages.append((content: content, conversationId: conversationId))
    }

    public func startSSE() {}
    public func stopSSE() {}

    /// Inject a server message into all active subscribers.
    public func emit(_ message: ServerMessage) {
        for continuation in continuations {
            continuation.yield(message)
        }
    }
}

/// Typealias for backward compatibility — tests and previews that reference
/// `MockDaemonClient` continue to work unchanged.
public typealias MockDaemonStatus = MockDaemonClient
#endif
