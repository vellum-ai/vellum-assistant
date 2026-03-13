import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TerminalAPI")

/// HTTP client for the platform terminal API.
///
/// Manages creating, destroying, and communicating with PTY terminal sessions
/// on managed assistant hosts via the platform's REST + SSE endpoints.
@MainActor
final class TerminalAPIClient {

    private let baseURL: String
    private let token: String
    private let organizationId: String?

    init(baseURL: String, token: String, organizationId: String?) {
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.token = token
        self.organizationId = organizationId
    }

    // MARK: - Session Lifecycle

    /// Creates a new terminal session and returns the session ID.
    func createSession(assistantId: String) async throws -> String {
        let url = try buildURL(path: "/v1/assistants/\(assistantId)/terminal/sessions/")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        applyAuth(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if let sessionId = json?["session_id"] as? String {
            return sessionId
        }
        if let sessionId = json?["id"] as? String {
            return sessionId
        }
        throw TerminalAPIError.missingSessionId
    }

    /// Destroys an existing terminal session. Errors are swallowed (best-effort).
    func destroySession(assistantId: String, sessionId: String) async {
        guard let url = try? buildURL(path: "/v1/assistants/\(assistantId)/terminal/sessions/\(sessionId)/") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 10
        applyAuth(&request)

        _ = try? await URLSession.shared.data(for: request)
    }

    // MARK: - Input / Resize

    /// Sends keyboard input to the PTY stdin.
    func sendInput(assistantId: String, sessionId: String, data: String) async throws {
        let url = try buildURL(path: "/v1/assistants/\(assistantId)/terminal/sessions/\(sessionId)/input/")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        applyAuth(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = ["data": data]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
    }

    /// Notifies the backend of a PTY window resize.
    func resize(assistantId: String, sessionId: String, cols: Int, rows: Int) async throws {
        let url = try buildURL(path: "/v1/assistants/\(assistantId)/terminal/sessions/\(sessionId)/resize/")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        applyAuth(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = ["cols": cols, "rows": rows]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
    }

    // MARK: - SSE Output Stream

    /// Subscribes to the terminal SSE output stream.
    ///
    /// Yields `TerminalOutputEvent` values as they arrive from the PTY.
    /// The returned `AsyncThrowingStream` ends when the SSE connection closes
    /// or is cancelled.
    func subscribeEvents(
        assistantId: String,
        sessionId: String
    ) -> (stream: AsyncThrowingStream<TerminalOutputEvent, Error>, cancel: () -> Void) {
        let url = try? buildURL(path: "/v1/assistants/\(assistantId)/terminal/sessions/\(sessionId)/events/")

        let task = UncheckedSendableBox<Task<Void, Never>?>(nil)

        let stream = AsyncThrowingStream<TerminalOutputEvent, Error> { continuation in
            guard let url else {
                continuation.finish(throwing: TerminalAPIError.invalidURL)
                return
            }

            var request = URLRequest(url: url)
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.timeoutInterval = .infinity
            self.applyAuth(&request)

            let sseTask = Task { @MainActor [weak self] in
                guard self != nil else {
                    continuation.finish()
                    return
                }

                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)

                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
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

    // MARK: - Helpers

    private func buildURL(path: String) throws -> URL {
        guard let url = URL(string: "\(baseURL)\(path)") else {
            throw TerminalAPIError.invalidURL
        }
        return url
    }

    private func applyAuth(_ request: inout URLRequest) {
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        if let orgId = organizationId, !orgId.isEmpty {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
    }

    private func validateResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw TerminalAPIError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            throw TerminalAPIError.httpError(http.statusCode)
        }
    }
}

// MARK: - Types

struct TerminalOutputEvent: Sendable {
    let seq: Int
    let data: String
}

enum TerminalAPIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case httpError(Int)
    case missingSessionId
    case streamEnded

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid terminal API URL"
        case .invalidResponse: return "Invalid response from terminal API"
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
