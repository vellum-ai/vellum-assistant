import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - AssistantEvent Envelope

/// Envelope around `ServerMessage` for SSE events from the runtime HTTP server.
struct AssistantEvent: Decodable {
    let id: String
    let assistantId: String
    let sessionId: String?
    let emittedAt: String
    let message: ServerMessage
}

// MARK: - HTTP Transport

/// Internal helper that handles HTTP REST + SSE communication with a remote
/// Vellum assistant runtime. Used by `DaemonClient` when configured with
/// `.http` transport via `DaemonConfig`.
///
/// Responsibilities:
/// - SSE stream connection to `GET /v1/events?conversationKey=...`
/// - Translating IPC message types to HTTP API calls
/// - Health check via `GET /healthz`
/// - Auto-reconnect with exponential backoff
@MainActor
final class HTTPTransport {

    let baseURL: String
    let bearerToken: String?
    private let conversationKey: String

    /// Currently active SSE task.
    private var sseTask: Task<Void, Never>?

    /// Currently active run ID, tracked for decision/secret endpoints.
    private(set) var activeRunId: String?

    /// Whether the SSE stream is connected.
    private(set) var isConnected: Bool = false

    /// Whether we should attempt to reconnect on disconnect.
    private var shouldReconnect = true

    /// Current reconnect backoff delay in seconds.
    private var reconnectDelay: TimeInterval = 1.0

    /// Maximum reconnect backoff delay.
    private let maxReconnectDelay: TimeInterval = 30.0

    /// Reconnect task handle.
    private var reconnectTask: Task<Void, Never>?

    /// Callback for incoming server messages (called on main actor).
    var onMessage: ((ServerMessage) -> Void)?

    /// Callback for connection state changes.
    var onConnectionStateChanged: ((Bool) -> Void)?

    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - Init

    init(baseURL: String, bearerToken: String?, conversationKey: String) {
        // Strip trailing slash for clean URL construction
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.bearerToken = bearerToken
        self.conversationKey = conversationKey
    }

    // MARK: - Connect

    /// Verify reachability via health check, then open SSE stream.
    func connect() async throws {
        shouldReconnect = true

        // 1. Health check
        let healthURL = URL(string: "\(baseURL)/healthz")!
        var healthReq = URLRequest(url: healthURL)
        healthReq.timeoutInterval = 10
        applyAuth(&healthReq)

        do {
            let (_, response) = try await URLSession.shared.data(for: healthReq)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw HTTPTransportError.healthCheckFailed
            }
            log.info("Health check passed for \(self.baseURL, privacy: .public)")
        } catch let error as HTTPTransportError {
            throw error
        } catch {
            log.error("Health check failed: \(error.localizedDescription)")
            throw HTTPTransportError.healthCheckFailed
        }

        // 2. Open SSE stream
        startSSEStream()
    }

    // MARK: - SSE Stream

    private func startSSEStream() {
        sseTask?.cancel()

        let urlString = "\(baseURL)/v1/events?conversationKey=\(conversationKey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? conversationKey)"
        guard let url = URL(string: urlString) else {
            log.error("Invalid SSE URL: \(urlString)")
            return
        }

        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = .infinity
        applyAuth(&request)

        sseTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                let (bytes, response) = try await URLSession.shared.bytes(for: request)

                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                    log.error("SSE connection failed with status \(statusCode)")
                    self.handleDisconnect()
                    return
                }

                self.setConnected(true)
                log.info("SSE stream connected to \(urlString, privacy: .public)")

                var dataBuffer = ""

                for try await line in bytes.lines {
                    if Task.isCancelled { break }

                    if line.hasPrefix("data: ") {
                        dataBuffer += String(line.dropFirst(6))
                    } else if line.isEmpty && !dataBuffer.isEmpty {
                        // End of SSE event — parse accumulated data
                        self.parseSSEData(dataBuffer)
                        dataBuffer = ""
                    }
                    // Skip event:, id:, retry: lines — we only need data:
                }
            } catch {
                if !Task.isCancelled {
                    log.error("SSE stream error: \(error.localizedDescription)")
                }
            }

            if !Task.isCancelled {
                self.handleDisconnect()
            }
        }
    }

    private func parseSSEData(_ data: String) {
        guard let jsonData = data.data(using: .utf8) else { return }

        do {
            let event = try decoder.decode(AssistantEvent.self, from: jsonData)
            onMessage?(event.message)
        } catch {
            // Try decoding as a bare ServerMessage (some endpoints may send unwrapped)
            do {
                let message = try decoder.decode(ServerMessage.self, from: jsonData)
                onMessage?(message)
            } catch {
                let byteCount = jsonData.count
                log.error("Failed to decode SSE event: \(error.localizedDescription), bytes: \(byteCount)")
            }
        }
    }

    // MARK: - Send (HTTP API Calls)

    /// Translate an IPC message to the appropriate HTTP API call.
    func send<T: Encodable>(_ message: T) throws {
        if let msg = message as? UserMessageMessage {
            Task { await self.createRun(content: msg.content, sessionId: msg.sessionId) }
        } else if let msg = message as? ConfirmationResponseMessage {
            Task { await self.sendDecision(requestId: msg.requestId, decision: msg.decision) }
        } else if let msg = message as? SecretResponseMessage {
            Task { await self.sendSecret(requestId: msg.requestId, value: msg.value) }
        } else if let msg = message as? CancelMessage {
            // Best-effort cancel — no dedicated endpoint yet
            log.info("Cancel requested for session \(msg.sessionId ?? "unknown") (no-op over HTTP)")
        } else if let msg = message as? SessionCreateMessage {
            // For HTTP transport, session creation is implicit — the conversationKey
            // acts as the session. Emit a synthetic session_info so ChatViewModel
            // records the session ID.
            let sessionId = msg.correlationId ?? UUID().uuidString
            let info = ServerMessage.sessionInfo(
                SessionInfoMessage(sessionId: sessionId, title: msg.title ?? "New Chat", correlationId: msg.correlationId)
            )
            onMessage?(info)
        } else if message is HistoryRequestMessage {
            Task { await self.fetchHistory() }
        } else if message is PingMessage {
            // No-op for HTTP transport — SSE keepalive is handled by the connection
        } else {
            // For unhandled message types, log and skip
            log.debug("HTTPTransport: unhandled send message type \(String(describing: type(of: message)))")
        }
    }

    // MARK: - HTTP Endpoints

    private func createRun(content: String?, sessionId: String) async {
        guard let url = URL(string: "\(baseURL)/v1/runs") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = ["conversationKey": conversationKey]
        if let content, !content.isEmpty {
            body["content"] = content
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 201 || http.statusCode == 200 {
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let runId = json["id"] as? String {
                    self.activeRunId = runId
                    log.info("Run created: \(runId)")
                }
            } else {
                let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
                log.error("Create run failed (\(http.statusCode)): \(errorBody)")
                onMessage?(.sessionError(SessionErrorMessage(
                    sessionId: sessionId,
                    code: .providerApi,
                    userMessage: "Failed to send message (HTTP \(http.statusCode))",
                    retryable: true
                )))
            }
        } catch {
            log.error("Create run error: \(error.localizedDescription)")
            onMessage?(.sessionError(SessionErrorMessage(
                sessionId: sessionId,
                code: .providerApi,
                userMessage: error.localizedDescription,
                retryable: true
            )))
        }
    }

    private func sendDecision(requestId: String, decision: String) async {
        guard let runId = activeRunId else {
            log.warning("No active run ID for decision response")
            return
        }

        guard let url = URL(string: "\(baseURL)/v1/runs/\(runId)/decision") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["decision": decision]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                log.error("Decision response failed (\(http.statusCode))")
            }
        } catch {
            log.error("Decision response error: \(error.localizedDescription)")
        }
    }

    private func sendSecret(requestId: String, value: String?) async {
        // Secrets can be delivered via the /v1/secrets endpoint for persistence,
        // or via the run's decision flow. Use the secrets endpoint.
        guard let url = URL(string: "\(baseURL)/v1/secrets") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        // The secret_request includes service/field info but we receive it via
        // the SecretResponseMessage which only has requestId and value.
        // For now, send as a credential with the requestId as name.
        let body: [String: Any] = [
            "type": "credential",
            "name": requestId,
            "value": value ?? ""
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse, http.statusCode != 201 {
                log.error("Secret response failed (\(http.statusCode))")
            }
        } catch {
            log.error("Secret response error: \(error.localizedDescription)")
        }
    }

    private func fetchHistory() async {
        let urlString = "\(baseURL)/v1/messages?conversationKey=\(conversationKey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? conversationKey)"
        guard let url = URL(string: urlString) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                log.error("Fetch history failed")
                return
            }

            // The /v1/messages endpoint returns { messages: [...] } which doesn't
            // directly map to a HistoryResponseMessage. We need to construct one.
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let messages = json["messages"] as? [[String: Any]] {
                // Convert REST messages to IPC history format
                var historyMessages: [[String: Any]] = []
                for msg in messages {
                    historyMessages.append(msg)
                }

                // Emit as raw JSON that the history response decoder can handle
                var historyPayload: [String: Any] = [
                    "type": "history_response",
                    "sessionId": conversationKey,
                    "messages": historyMessages
                ]
                _ = historyPayload.removeValue(forKey: "")

                if let historyData = try? JSONSerialization.data(withJSONObject: historyPayload),
                   let historyResponse = try? decoder.decode(ServerMessage.self, from: historyData) {
                    onMessage?(historyResponse)
                }
            }
        } catch {
            log.error("Fetch history error: \(error.localizedDescription)")
        }
    }

    // MARK: - Disconnect

    func disconnect() {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        sseTask?.cancel()
        sseTask = nil
        setConnected(false)
        activeRunId = nil
    }

    // MARK: - Reconnect

    private func handleDisconnect() {
        setConnected(false)
        guard shouldReconnect else { return }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()

        let delay = reconnectDelay
        log.info("HTTP transport: scheduling reconnect in \(delay)s")

        reconnectTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }

            guard let self, self.shouldReconnect else { return }
            self.reconnectDelay = min(self.reconnectDelay * 2, self.maxReconnectDelay)

            do {
                try await self.connect()
            } catch {
                log.error("HTTP reconnect failed: \(error.localizedDescription)")
                if self.shouldReconnect {
                    self.scheduleReconnect()
                }
            }
        }
    }

    // MARK: - Helpers

    private func applyAuth(_ request: inout URLRequest) {
        if let token = bearerToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private func setConnected(_ connected: Bool) {
        guard isConnected != connected else { return }
        isConnected = connected
        reconnectDelay = connected ? 1.0 : reconnectDelay
        onConnectionStateChanged?(connected)
    }

    // MARK: - Errors

    enum HTTPTransportError: Error, LocalizedError {
        case healthCheckFailed
        case invalidURL

        var errorDescription: String? {
            switch self {
            case .healthCheckFailed:
                return "Remote assistant health check failed"
            case .invalidURL:
                return "Invalid remote assistant URL"
            }
        }
    }
}
