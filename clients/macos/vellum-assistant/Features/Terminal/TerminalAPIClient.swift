import Foundation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TerminalAPI")

/// HTTP client for the platform terminal API.
///
/// Manages creating, destroying, and communicating with PTY terminal sessions
/// on managed assistant hosts via the platform's REST + SSE endpoints.
/// Uses `GatewayHTTPClient` for authentication and request construction.
@MainActor
final class TerminalAPIClient {

    // MARK: - Session Lifecycle

    /// Creates a new terminal session and returns the session ID.
    func createSession() async throws -> String {
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/terminal/sessions",
            timeout: 30
        )
        guard response.isSuccess else {
            throw TerminalAPIError.httpError(response.statusCode)
        }

        let json = try JSONSerialization.jsonObject(with: response.data) as? [String: Any]
        if let sessionId = json?["session_id"] as? String {
            return sessionId
        }
        if let sessionId = json?["id"] as? String {
            return sessionId
        }
        throw TerminalAPIError.missingSessionId
    }

    /// Destroys an existing terminal session. Errors are swallowed (best-effort).
    func destroySession(sessionId: String) async {
        _ = try? await GatewayHTTPClient.delete(
            path: "assistants/{assistantId}/terminal/sessions/\(sessionId)",
            timeout: 10
        )
    }

    // MARK: - Input / Resize

    /// Sends keyboard input to the PTY stdin.
    func sendInput(sessionId: String, data: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["data": data])
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/terminal/sessions/\(sessionId)/input",
            body: body,
            timeout: 10
        )
        guard response.isSuccess else {
            throw TerminalAPIError.httpError(response.statusCode)
        }
    }

    /// Notifies the backend of a PTY window resize.
    func resize(sessionId: String, cols: Int, rows: Int) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["cols": cols, "rows": rows] as [String: Any])
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/terminal/sessions/\(sessionId)/resize",
            body: body,
            timeout: 10
        )
        guard response.isSuccess else {
            throw TerminalAPIError.httpError(response.statusCode)
        }
    }

    // MARK: - SSE Output Stream

    /// Subscribes to the terminal SSE output stream.
    ///
    /// Yields `TerminalOutputEvent` values as they arrive from the PTY.
    /// The returned `AsyncThrowingStream` ends when the SSE connection closes
    /// or is cancelled.
    func subscribeEvents(
        sessionId: String
    ) -> (stream: AsyncThrowingStream<TerminalOutputEvent, Error>, cancel: () -> Void) {
        let task = UncheckedSendableBox<Task<Void, Never>?>(nil)

        let stream = AsyncThrowingStream<TerminalOutputEvent, Error> { continuation in
            let sseTask = Task { @MainActor in
                do {
                    let (bytes, urlResponse) = try await GatewayHTTPClient.stream(
                        path: "assistants/{assistantId}/terminal/sessions/\(sessionId)/events",
                        timeout: .infinity
                    )

                    guard let http = urlResponse as? HTTPURLResponse, http.statusCode == 200 else {
                        let statusCode = (urlResponse as? HTTPURLResponse)?.statusCode ?? -1
                        continuation.finish(throwing: TerminalAPIError.httpError(statusCode))
                        return
                    }

                    for try await line in bytes.lines {
                        if Task.isCancelled { break }

                        guard line.hasPrefix("data: ") else { continue }
                        let payload = String(line.dropFirst(6))

                        guard let payloadData = payload.data(using: .utf8),
                              let json = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any] else {
                            continue
                        }

                        // Support envelope format: { message: { seq, data } }
                        let eventData: [String: Any]
                        if let message = json["message"] as? [String: Any] {
                            eventData = message
                        } else {
                            eventData = json
                        }

                        guard let seq = eventData["seq"] as? Int,
                              let data = eventData["data"] as? String,
                              seq >= 0, !data.isEmpty else {
                            continue
                        }

                        continuation.yield(TerminalOutputEvent(seq: seq, data: data))
                    }

                    if !Task.isCancelled {
                        continuation.finish(throwing: TerminalAPIError.streamEnded)
                    } else {
                        continuation.finish()
                    }
                } catch {
                    if !Task.isCancelled {
                        continuation.finish(throwing: error)
                    } else {
                        continuation.finish()
                    }
                }
            }

            task.value = sseTask

            continuation.onTermination = { @Sendable _ in
                sseTask.cancel()
            }
        }

        let cancel: () -> Void = {
            task.value?.cancel()
        }

        return (stream, cancel)
    }

}

// MARK: - Types

struct TerminalOutputEvent: Sendable {
    let seq: Int
    let data: String
}

enum TerminalAPIError: LocalizedError {
    case httpError(Int)
    case missingSessionId
    case streamEnded

    var errorDescription: String? {
        switch self {
        case .httpError(let code): return "Terminal API error (HTTP \(code))"
        case .missingSessionId: return "Backend did not return a session ID"
        case .streamEnded: return "Terminal stream ended unexpectedly"
        }
    }
}

/// Sendable wrapper for mutable reference types used across concurrency boundaries.
private final class UncheckedSendableBox<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}
