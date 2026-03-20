#if DEBUG
import Foundation

/// Lightweight in-memory mock for `DaemonClientProtocol`, used in tests and SwiftUI previews.
@MainActor
public final class MockDaemonClient: DaemonClientProtocol, ObservableObject {
    public var isConnected: Bool = false

    /// Messages recorded by `send(_:)` for assertion in tests.
    public private(set) var sentMessages: [Any] = []

    /// Continuations to feed messages into active `subscribe()` streams.
    private var continuations: [AsyncStream<ServerMessage>.Continuation] = []

    public init() {}

    public func subscribe() -> AsyncStream<ServerMessage> {
        AsyncStream { continuation in
            self.continuations.append(continuation)
        }
    }

    public func send<T: Encodable>(_ message: T) throws {
        sentMessages.append(message)
    }

    public func sendMessage(content: String?, conversationId: String, attachments: [UserMessageAttachment]? = nil, conversationType: String? = nil, automated: Bool? = nil) throws {
        sentMessages.append(UserMessageMessage(conversationId: conversationId, content: content ?? "", attachments: attachments))
    }

    public func connect() async throws {
        isConnected = true
    }

    public func disconnect() {
        isConnected = false
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
#endif
