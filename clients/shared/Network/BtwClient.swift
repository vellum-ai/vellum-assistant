import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "BtwClient")

/// Focused client for BTW side-chain messages routed through the gateway.
public protocol BtwClientProtocol {
    func sendMessage(content: String, conversationKey: String) -> AsyncThrowingStream<String, Error>
}

/// Gateway-backed implementation of ``BtwClientProtocol``.
public struct BtwClient: BtwClientProtocol {
    nonisolated public init() {}

    /// Send a BTW side-chain question and stream the response text.
    /// Returns an `AsyncThrowingStream` that yields text deltas from SSE `btw_text_delta` events.
    public func sendMessage(content: String, conversationKey: String) -> AsyncThrowingStream<String, Error> {
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await Self.streamBtw(content: content, conversationKey: conversationKey, continuation: continuation)
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    /// Performs the actual BTW streaming request and feeds parsed SSE deltas into the continuation.
    private static func streamBtw(
        content: String,
        conversationKey: String,
        continuation: AsyncThrowingStream<String, Error>.Continuation
    ) async throws {
        let body: [String: String] = [
            "conversationKey": conversationKey,
            "content": content,
        ]
        let bodyData = try JSONSerialization.data(withJSONObject: body)

        // Dedicated per-call session so `invalidateAndCancel()` can tear down
        // the underlying data task on its own terms when the stream ends or
        // the consumer cancels — avoids a use-after-free race between
        // `Task.cancel()` and the `AsyncBytes` iterator on `URLSession.shared`.
        let session = URLSession(configuration: .default)
        defer { session.invalidateAndCancel() }

        let (bytes, response) = try await GatewayHTTPClient.streamPostWithRetry(
            path: "assistants/{assistantId}/btw",
            body: bodyData,
            timeout: 120,
            session: session
        )

        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        guard http.statusCode == 200 else {
            throw URLError(.badServerResponse, userInfo: [
                NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"
            ])
        }

        var currentEventType: String?
        for try await line in bytes.lines {
            if Task.isCancelled { break }

            if line.hasPrefix("event: ") {
                currentEventType = String(line.dropFirst(7))
            } else if line.hasPrefix("data: ") {
                let jsonString = String(line.dropFirst(6))
                if let data = jsonString.data(using: .utf8),
                   let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if currentEventType == "btw_error" {
                        let errorMessage = parsed["message"] as? String ?? parsed["error"] as? String ?? "Unknown btw error"
                        throw URLError(.badServerResponse, userInfo: [
                            NSLocalizedDescriptionKey: errorMessage
                        ])
                    }
                    if let text = parsed["text"] as? String {
                        continuation.yield(text)
                    }
                    if currentEventType == "btw_complete" {
                        break
                    }
                }
                currentEventType = nil
            } else if line.isEmpty {
                currentEventType = nil
            }
        }
        continuation.finish()
    }
}
