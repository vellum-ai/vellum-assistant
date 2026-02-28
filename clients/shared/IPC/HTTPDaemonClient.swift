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

// MARK: - Conversations List Response

/// Response shape from `GET /v1/conversations`.
struct ConversationsListResponse: Decodable {
    struct Session: Decodable {
        let id: String
        let title: String
        let createdAt: Int?
        let updatedAt: Int
        let threadType: String?
        let source: String?
        let channelBinding: IPCChannelBinding?
        let conversationOriginChannel: String?
        let conversationOriginInterface: String?
        let assistantAttention: IPCAssistantAttention?
    }
    let sessions: [Session]
    let hasMore: Bool?
}

// MARK: - HTTP Transport

/// Internal helper that handles HTTP REST + SSE communication with a remote
/// Vellum assistant runtime. Used by `DaemonClient` when configured with
/// `.http` transport via `DaemonConfig`.
///
/// Responsibilities:
/// - Periodic health check via `GET /healthz` to drive connection status
/// - SSE stream connection to `GET /v1/events?conversationKey=...` (on demand)
/// - Translating IPC message types to HTTP API calls
/// - Auto-reconnect with exponential backoff
@MainActor
final class HTTPTransport {

    let baseURL: String
    private(set) var bearerToken: String?
    private let conversationKey: String
    private let sourceChannel: String

    private static var defaultSourceChannel: String {
        return "vellum"
    }

    /// Platform-derived default interface identifier.
    private static var defaultInterface: String {
        #if os(macOS)
        return "macos"
        #elseif os(iOS)
        return "ios"
        #else
        return "vellum"
        #endif
    }

    /// Currently active SSE task.
    private var sseTask: Task<Void, Never>?

    /// Periodic health check task.
    private var healthCheckTask: Task<Void, Never>?

    /// Health check interval in seconds.
    private let healthCheckInterval: TimeInterval = 15.0

    /// Whether the assistant is reachable (health check passes).
    private(set) var isConnected: Bool = false

    /// Whether the SSE stream is active and receiving events.
    private(set) var isSSEConnected: Bool = false

    /// Whether we should attempt to reconnect on disconnect.
    private var shouldReconnect = true

    /// Current reconnect backoff delay in seconds (for SSE).
    private var sseReconnectDelay: TimeInterval = 1.0

    /// Maximum reconnect backoff delay.
    private let maxReconnectDelay: TimeInterval = 30.0

    /// SSE reconnect task handle.
    private var sseReconnectTask: Task<Void, Never>?

    /// Callback for incoming server messages (called on main actor).
    var onMessage: ((ServerMessage) -> Void)?

    /// Callback for connection state changes (health check driven).
    var onConnectionStateChanged: ((Bool) -> Void)?

    /// Callback when the bearer token is refreshed via a `token_rotated` SSE event.
    /// Clients should persist the new token (e.g. to Keychain).
    var onTokenRefreshed: ((String) -> Void)?

    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - Init

    init(baseURL: String, bearerToken: String?, conversationKey: String) {
        // Strip trailing slash for clean URL construction
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.bearerToken = bearerToken
        self.conversationKey = conversationKey
        self.sourceChannel = Self.defaultSourceChannel
    }

    // MARK: - Connect (health check driven)

    /// Verify reachability via health check and start periodic health monitoring.
    /// Connection status is driven by health checks, not SSE.
    /// SSE is auto-started after the first successful health check so that
    /// system events (e.g. pairing approval requests) are received immediately,
    /// even before any UI window appears.
    func connect() async throws {
        shouldReconnect = true

        // Run initial health check
        try await performHealthCheck()

        // Start periodic health checks
        startHealthCheckLoop()

        // Auto-start SSE so system events (pairing, etc.) are received
        // immediately. MainWindowView.onAppear also calls startSSE() but
        // that's a no-op when the stream is already running.
        startSSE()
    }

    /// Run a single health check against the gateway.
    private func performHealthCheck() async throws {
        let healthURL = URL(string: "\(baseURL)/healthz")!
        var healthReq = URLRequest(url: healthURL)
        healthReq.timeoutInterval = 10
        applyAuth(&healthReq)

        do {
            let (_, response) = try await URLSession.shared.data(for: healthReq)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                if statusCode == 401 {
                    handleAuthenticationFailure()
                }
                throw HTTPTransportError.healthCheckFailed
            }
            log.info("Health check passed for \(self.baseURL, privacy: .public)")
            setConnected(true)
        } catch let error as HTTPTransportError {
            setConnected(false)
            throw error
        } catch {
            log.error("Health check failed: \(error.localizedDescription)")
            setConnected(false)
            throw HTTPTransportError.healthCheckFailed
        }
    }

    /// Periodically poll `/healthz` to maintain connection status.
    private func startHealthCheckLoop() {
        healthCheckTask?.cancel()

        healthCheckTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: UInt64((self?.healthCheckInterval ?? 15.0) * 1_000_000_000))
                } catch {
                    return
                }

                guard let self, self.shouldReconnect else { return }

                do {
                    try await self.performHealthCheck()
                } catch {
                    // Health check failed — isConnected already set to false
                    log.warning("Periodic health check failed: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: - SSE Stream (on demand)

    /// Start the SSE event stream. Call when a chat window opens.
    func startSSE() {
        guard sseTask == nil else { return }
        startSSEStream()
    }

    /// Stop the SSE event stream. Call when a chat window closes.
    func stopSSE() {
        sseReconnectTask?.cancel()
        sseReconnectTask = nil
        sseTask?.cancel()
        sseTask = nil
        setSSEConnected(false)
    }

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
                    if statusCode == 401 {
                        self.handleAuthenticationFailure()
                    }
                    self.handleSSEDisconnect()
                    return
                }

                self.setSSEConnected(true)
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
                self.handleSSEDisconnect()
            }
        }
    }

    private func parseSSEData(_ data: String) {
        guard let jsonData = data.data(using: .utf8) else { return }

        do {
            let event = try decoder.decode(AssistantEvent.self, from: jsonData)
            handleServerMessage(event.message)
        } catch {
            // Try decoding as a bare ServerMessage (some endpoints may send unwrapped)
            do {
                let message = try decoder.decode(ServerMessage.self, from: jsonData)
                handleServerMessage(message)
            } catch {
                let byteCount = jsonData.count
                log.error("Failed to decode SSE event: \(error.localizedDescription), bytes: \(byteCount)")
            }
        }
    }

    private func handleServerMessage(_ message: ServerMessage) {
        if case .tokenRotated(let msg) = message {
            log.info("Received token_rotated event — updating bearer token and reconnecting SSE")
            bearerToken = msg.newToken
            onTokenRefreshed?(msg.newToken)
            stopSSE()
            startSSE()
            return
        }
        onMessage?(message)
    }

    // MARK: - Send (HTTP API Calls)

    /// Translate an IPC message to the appropriate HTTP API call.
    func send<T: Encodable>(_ message: T) throws {
        if let msg = message as? UserMessageMessage {
            Task { await self.sendMessage(content: msg.content, sessionId: msg.sessionId) }
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
        } else if let msg = message as? SessionListRequestMessage {
            Task { await self.fetchSessionList(offset: Int(msg.offset ?? 0), limit: Int(msg.limit ?? 50)) }
        } else if let msg = message as? HistoryRequestMessage {
            Task { await self.fetchHistory(sessionId: msg.sessionId) }
        } else if let msg = message as? IPCConversationSeenSignal {
            Task { await self.sendConversationSeen(msg) }
        } else if let msg = message as? GuardianActionsPendingRequestMessage {
            Task { await self.fetchGuardianActionsPending(conversationId: msg.conversationId) }
        } else if let msg = message as? GuardianActionDecisionMessage {
            Task { await self.submitGuardianActionDecision(requestId: msg.requestId, action: msg.action, conversationId: msg.conversationId) }
        } else if message is PingMessage {
            // No-op for HTTP transport — SSE keepalive is handled by the connection
        } else {
            // For unhandled message types, log and skip
            log.debug("HTTPTransport: unhandled send message type \(String(describing: type(of: message)))")
        }
    }

    // MARK: - HTTP Endpoints

    private func sendMessage(content: String?, sessionId: String) async {
        guard let url = URL(string: "\(baseURL)/v1/messages") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "conversationKey": conversationKey,
            "sourceChannel": sourceChannel,
            "interface": Self.defaultInterface
        ]
        if let content, !content.isEmpty {
            body["content"] = content
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 202 || http.statusCode == 200 {
                log.info("Message sent successfully")
            } else if http.statusCode == 401 {
                handleAuthenticationFailure()
            } else {
                let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
                log.error("Send message failed (\(http.statusCode)): \(errorBody)")
                onMessage?(.sessionError(SessionErrorMessage(
                    sessionId: sessionId,
                    code: .providerApi,
                    userMessage: "Failed to send message (HTTP \(http.statusCode))",
                    retryable: true
                )))
            }
        } catch {
            log.error("Send message error: \(error.localizedDescription)")
            onMessage?(.sessionError(SessionErrorMessage(
                sessionId: sessionId,
                code: .providerApi,
                userMessage: error.localizedDescription,
                retryable: true
            )))
        }
    }

    private func sendDecision(requestId: String, decision: String) async {
        guard let url = URL(string: "\(baseURL)/v1/confirm") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = [
            "requestId": requestId,
            "decision": decision
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 {
                    handleAuthenticationFailure()
                } else if http.statusCode != 200 {
                    log.error("Decision response failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Decision response error: \(error.localizedDescription)")
        }
    }

    private func sendSecret(requestId: String, value: String?) async {
        guard let url = URL(string: "\(baseURL)/v1/secret") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = [
            "requestId": requestId,
            "value": value ?? ""
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 {
                    handleAuthenticationFailure()
                } else if http.statusCode != 200 {
                    log.error("Secret response failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Secret response error: \(error.localizedDescription)")
        }
    }

    private func fetchGuardianActionsPending(conversationId: String) async {
        let encoded = conversationId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? conversationId
        guard let url = URL(string: "\(baseURL)/v1/guardian-actions/pending?conversationId=\(encoded)") else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 {
                    handleAuthenticationFailure()
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch guardian actions pending failed (\(http.statusCode))")
                    return
                }
            }

            do {
                let decoded = try JSONDecoder().decode(GuardianActionsPendingHTTPResponse.self, from: data)
                onMessage?(.guardianActionsPendingResponse(GuardianActionsPendingResponseMessage(conversationId: decoded.conversationId, prompts: decoded.prompts)))
            } catch {
                log.error("Failed to decode guardian actions pending response: \(error)")
            }
        } catch {
            log.error("Fetch guardian actions pending error: \(error.localizedDescription)")
        }
    }

    private func submitGuardianActionDecision(requestId: String, action: String, conversationId: String?) async {
        guard let url = URL(string: "\(baseURL)/v1/guardian-actions/decision") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "requestId": requestId,
            "action": action
        ]
        if let conversationId {
            body["conversationId"] = conversationId
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 {
                    handleAuthenticationFailure()
                    onMessage?(.guardianActionDecisionResponse(GuardianActionDecisionResponseMessage(
                        applied: false,
                        reason: "authentication_failed",
                        resolverFailureReason: nil,
                        requestId: requestId,
                        userText: nil
                    )))
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Guardian action decision failed (\(http.statusCode))")
                    // Emit a synthetic failure response so the UI clears isSubmitting state
                    onMessage?(.guardianActionDecisionResponse(GuardianActionDecisionResponseMessage(
                        applied: false,
                        reason: "HTTP \(http.statusCode)",
                        resolverFailureReason: nil,
                        requestId: requestId,
                        userText: nil
                    )))
                    return
                }
            }

            do {
                let decoded = try JSONDecoder().decode(GuardianActionDecisionResponseMessage.self, from: data)
                onMessage?(.guardianActionDecisionResponse(decoded))
            } catch {
                log.error("Failed to decode guardian action decision response: \(error)")
            }
        } catch {
            log.error("Guardian action decision error: \(error.localizedDescription)")
            // Emit a synthetic failure response so the UI clears isSubmitting state
            onMessage?(.guardianActionDecisionResponse(GuardianActionDecisionResponseMessage(
                applied: false,
                reason: error.localizedDescription,
                resolverFailureReason: nil,
                requestId: requestId,
                userText: nil
            )))
        }
    }

    /// Response wrapper for the HTTP guardian actions pending endpoint.
    private struct GuardianActionsPendingHTTPResponse: Decodable {
        let conversationId: String?
        let prompts: [GuardianDecisionPromptWire]
    }

    private func sendConversationSeen(_ signal: IPCConversationSeenSignal) async {
        guard let url = URL(string: "\(baseURL)/v1/conversations/seen") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "conversationId": signal.conversationId,
            "sourceChannel": signal.sourceChannel,
            "signalType": signal.signalType,
            "confidence": signal.confidence,
            "source": signal.source
        ]
        if let evidenceText = signal.evidenceText {
            body["evidenceText"] = evidenceText
        }
        if let observedAt = signal.observedAt {
            body["observedAt"] = observedAt
        }
        if let metadata = signal.metadata {
            body["metadata"] = metadata
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 {
                    handleAuthenticationFailure()
                } else if http.statusCode != 200 {
                    log.error("Conversation seen signal failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Conversation seen signal error: \(error.localizedDescription)")
        }
    }

    private func fetchSessionList(offset: Int = 0, limit: Int = 50) async {
        guard let url = URL(string: "\(baseURL)/v1/conversations?limit=\(limit)&offset=\(offset)") else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                if statusCode == 401 {
                    handleAuthenticationFailure()
                }
                log.error("Fetch session list failed")
                onMessage?(.sessionListResponse(SessionListResponseMessage(type: "session_list_response", sessions: [], hasMore: nil)))
                return
            }

            do {
                let decoded = try decoder.decode(ConversationsListResponse.self, from: data)
                let sessions = decoded.sessions.map {
                    IPCSessionListResponseSession(id: $0.id, title: $0.title, createdAt: $0.createdAt ?? $0.updatedAt, updatedAt: $0.updatedAt, threadType: $0.threadType, source: $0.source, channelBinding: $0.channelBinding, conversationOriginChannel: $0.conversationOriginChannel, conversationOriginInterface: $0.conversationOriginInterface, assistantAttention: $0.assistantAttention)
                }
                onMessage?(.sessionListResponse(SessionListResponseMessage(type: "session_list_response", sessions: sessions, hasMore: decoded.hasMore)))
            } catch {
                log.error("Failed to decode session list response: \(error)")
                onMessage?(.sessionListResponse(SessionListResponseMessage(type: "session_list_response", sessions: [], hasMore: nil)))
            }
        } catch {
            log.error("Fetch session list error: \(error.localizedDescription)")
            onMessage?(.sessionListResponse(SessionListResponseMessage(type: "session_list_response", sessions: [], hasMore: nil)))
        }
    }

    private func fetchHistory(sessionId: String) async {
        let encoded = sessionId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? sessionId
        let urlString = "\(baseURL)/v1/messages?conversationId=\(encoded)"
        guard let url = URL(string: urlString) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                if statusCode == 401 {
                    handleAuthenticationFailure()
                }
                log.error("Fetch history failed (HTTP \(statusCode))")
                return
            }

            // The runtime's /v1/messages endpoint returns messages with `content`
            // (string) and `timestamp` (ISO 8601 string), but IPCHistoryResponseMessage
            // expects `text` and `timestamp` as a Double (ms since epoch). Transform
            // the response to match the expected IPC format.
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let messages = json["messages"] as? [[String: Any]] {

                    let isoFormatter = ISO8601DateFormatter()
                    isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

                    let transformed: [[String: Any]] = messages.map { msg in
                        var m = msg
                        // Rename `content` → `text`
                        if let content = m.removeValue(forKey: "content") {
                            m["text"] = content
                        }
                        // Convert ISO 8601 timestamp string → Double (ms since epoch)
                        if let tsString = m["timestamp"] as? String {
                            if let date = isoFormatter.date(from: tsString) {
                                m["timestamp"] = date.timeIntervalSince1970 * 1000.0
                            } else {
                                // Fallback: try without fractional seconds
                                let fallback = ISO8601DateFormatter()
                                if let date = fallback.date(from: tsString) {
                                    m["timestamp"] = date.timeIntervalSince1970 * 1000.0
                                }
                            }
                        }
                        return m
                    }

                    let historyPayload: [String: Any] = [
                        "type": "history_response",
                        "sessionId": sessionId,
                        "messages": transformed,
                        "hasMore": false
                    ]

                    let historyData = try JSONSerialization.data(withJSONObject: historyPayload)
                    let historyResponse = try decoder.decode(ServerMessage.self, from: historyData)
                    onMessage?(historyResponse)
                }
            } catch {
                log.error("Failed to deserialize history response: \(error)")
            }
        } catch {
            log.error("Fetch history error: \(error.localizedDescription)")
        }
    }

    // MARK: - Feature Flags

    /// Fetch all feature flags from the gateway's GET /v1/feature-flags endpoint.
    func getFeatureFlags(featureFlagToken: String) async throws -> [DaemonClient.AssistantFeatureFlag] {
        guard let url = URL(string: "\(baseURL)/v1/feature-flags") else {
            throw HTTPTransportError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(featureFlagToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HTTPTransportError.healthCheckFailed
        }

        if http.statusCode == 401 {
            log.error("Feature flags GET failed: authentication error (401)")
            throw HTTPTransportError.healthCheckFailed
        }

        guard (200..<300).contains(http.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
            log.error("Feature flags GET failed (\(http.statusCode)): \(errorBody)")
            throw HTTPTransportError.healthCheckFailed
        }

        struct FlagsResponse: Decodable {
            let flags: [DaemonClient.AssistantFeatureFlag]
        }

        let decoded = try JSONDecoder().decode(FlagsResponse.self, from: data)
        log.info("Fetched \(decoded.flags.count) feature flags")
        return decoded.flags
    }

    /// Toggle a feature flag via the gateway's PATCH endpoint.
    /// Uses the dedicated feature-flag token (not the runtime bearer token) for auth.
    func setFeatureFlag(key: String, enabled: Bool, featureFlagToken: String) async throws {
        let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key
        guard let url = URL(string: "\(baseURL)/v1/feature-flags/\(encoded)") else {
            throw HTTPTransportError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(featureFlagToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let body: [String: Any] = ["enabled": enabled]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HTTPTransportError.healthCheckFailed
        }

        if http.statusCode == 401 {
            log.error("Feature flag PATCH failed: authentication error (401)")
            throw HTTPTransportError.healthCheckFailed
        }

        guard (200..<300).contains(http.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
            log.error("Feature flag PATCH failed (\(http.statusCode)): \(errorBody)")
            throw HTTPTransportError.healthCheckFailed
        }

        log.info("Feature flag '\(key)' set to \(enabled)")
    }

    /// Fetch all assistant feature flags from the gateway's `GET /v1/feature-flags` endpoint.
    func fetchAssistantFeatureFlags(featureFlagToken: String) async throws -> [DaemonClient.AssistantFeatureFlagEntry] {
        guard let url = URL(string: "\(baseURL)/v1/feature-flags") else {
            throw HTTPTransportError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(featureFlagToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HTTPTransportError.healthCheckFailed
        }

        if http.statusCode == 401 {
            log.error("Feature flags GET failed: authentication error (401)")
            throw HTTPTransportError.healthCheckFailed
        }

        guard (200..<300).contains(http.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
            log.error("Feature flags GET failed (\(http.statusCode)): \(errorBody)")
            throw HTTPTransportError.healthCheckFailed
        }

        struct FlagsResponse: Decodable {
            let flags: [DaemonClient.AssistantFeatureFlagEntry]
        }

        let decoded = try JSONDecoder().decode(FlagsResponse.self, from: data)
        return decoded.flags
    }

    // MARK: - Remote Identity

    /// Fetch identity info from the remote daemon's `GET /v1/identity` endpoint.
    func fetchRemoteIdentity() async -> RemoteIdentityInfo? {
        guard let url = URL(string: "\(baseURL)/v1/identity") else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            do {
                return try JSONDecoder().decode(RemoteIdentityInfo.self, from: data)
            } catch {
                log.error("Failed to decode remote identity response: \(error)")
                return nil
            }
        } catch {
            log.error("fetchRemoteIdentity failed: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Disconnect

    func disconnect() {
        shouldReconnect = false
        healthCheckTask?.cancel()
        healthCheckTask = nil
        sseReconnectTask?.cancel()
        sseReconnectTask = nil
        sseTask?.cancel()
        sseTask = nil
        setConnected(false)
        setSSEConnected(false)
    }

    // MARK: - SSE Reconnect

    private func handleSSEDisconnect() {
        setSSEConnected(false)
        guard shouldReconnect, sseTask != nil else { return }
        scheduleSSEReconnect()
    }

    private func scheduleSSEReconnect() {
        sseReconnectTask?.cancel()

        let delay = sseReconnectDelay
        log.info("HTTP transport: scheduling SSE reconnect in \(delay)s")

        sseReconnectTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }

            guard let self, self.shouldReconnect else { return }
            self.sseReconnectDelay = min(self.sseReconnectDelay * 2, self.maxReconnectDelay)

            self.startSSEStream()
        }
    }

    // MARK: - 401 Recovery

    /// Surface a session-expired error to the client. On iOS this means
    /// the user must re-pair via QR code since we cannot read the token from disk.
    private func handleAuthenticationFailure() {
        log.error("Authentication failed — bearer token is stale")
        onMessage?(.sessionError(SessionErrorMessage(
            sessionId: "",
            code: .authenticationRequired,
            userMessage: "Session expired. Please re-pair your device.",
            retryable: false
        )))
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
        onConnectionStateChanged?(connected)
    }

    private func setSSEConnected(_ connected: Bool) {
        guard isSSEConnected != connected else { return }
        isSSEConnected = connected
        sseReconnectDelay = connected ? 1.0 : sseReconnectDelay
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
