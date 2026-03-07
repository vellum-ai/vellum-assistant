import Foundation
import os
import CryptoKit
#if os(macOS)
import IOKit
#endif

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
public final class HTTPTransport {

    public let baseURL: String
    public private(set) var bearerToken: String?
    private let conversationKey: String
    private let sourceChannel: String
    let transportMetadata: TransportMetadata

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

    /// Result of an async authentication refresh attempt.
    enum AuthRefreshResult {
        case success
        case transientFailure
        case terminalFailure
    }

    /// In-flight refresh task. Concurrent 401 handlers await this instead of
    /// returning false immediately, so user actions aren't dropped while a
    /// refresh triggered by another codepath is still in progress.
    private var refreshTask: Task<AuthRefreshResult, Never>?

    /// Callback for incoming server messages (called on main actor).
    var onMessage: ((ServerMessage) -> Void)?

    /// Callback for connection state changes (health check driven).
    var onConnectionStateChanged: ((Bool) -> Void)?

    /// Callback when the bearer token is refreshed via a `token_rotated` SSE event.
    /// Clients should persist the new token (e.g. to Keychain).
    var onTokenRefreshed: ((String) -> Void)?

    /// The local session ID used by the client (set from the synthetic session_info).
    /// Used to remap the daemon's internal conversation ID to the client's session ID
    /// so that ChatViewModel's belongsToSession() filter passes.
    private var activeLocalSessionId: String?

    /// The daemon's internal conversation ID, learned from the first SSE event.
    /// All occurrences are remapped to `activeLocalSessionId` in incoming events.
    private var remoteSessionId: String?

    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - Init

    init(baseURL: String, bearerToken: String?, conversationKey: String, transportMetadata: TransportMetadata = .defaultLocal) {
        // Strip trailing slash for clean URL construction
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.bearerToken = bearerToken
        self.conversationKey = conversationKey
        self.sourceChannel = Self.defaultSourceChannel
        self.transportMetadata = transportMetadata
    }

    // MARK: - Endpoint Builder

    /// All HTTP endpoints used by the transport, centralized for consistent
    /// URL construction. Query parameters that are integral to the endpoint
    /// identity are modelled as associated values.
    enum Endpoint {
        case healthz
        case events(conversationKey: String)
        case sendMessage
        case getMessages(conversationId: String?)
        case conversations(limit: Int, offset: Int)
        case confirm
        case secret
        case guardianActionsPending(conversationId: String)
        case guardianActionsDecision
        case conversationsSeen
        case conversationsUnread
        case identity
        case featureFlags
        case featureFlagUpdate(key: String)
        case surfaceAction
        case trustRulesManage
        case trustRuleManageById(id: String)
        case pendingInteractions(conversationKey: String?)
        case contactsList(limit: Int, role: String?)
        case contactsGet(id: String)
        case contactsDelete(id: String)
        case contactChannelUpdate(contactChannelId: String)
        case contactChannelVerify(contactChannelId: String)
        case contactsUpsert
        case contactsInvitesCreate
        case channelsReadiness
        case surfaceContent(surfaceId: String, sessionId: String)
        case usageTotals(from: Int, to: Int)
        case usageDaily(from: Int, to: Int)
        case usageBreakdown(from: Int, to: Int, groupBy: String)
    }

    /// Build a URL for the given endpoint using the current route mode.
    /// Returns nil if the URL string is malformed.
    private func buildURL(for endpoint: Endpoint) -> URL? {
        let path: String
        let query: String?

        switch transportMetadata.routeMode {
        case .runtimeFlat:
            (path, query) = buildRuntimeFlatPath(for: endpoint)
        case .platformAssistantProxy:
            guard let assistantId = transportMetadata.platformAssistantId else {
                log.error("platformAssistantProxy route mode requires platformAssistantId")
                return nil
            }
            (path, query) = buildPlatformProxyPath(for: endpoint, assistantId: assistantId)
        }

        var urlString = "\(baseURL)\(path)"
        if let query {
            urlString += "?\(query)"
        }
        return URL(string: urlString)
    }

    /// Builds paths for the existing runtime-flat layout (e.g. /healthz, /v1/messages).
    private func buildRuntimeFlatPath(for endpoint: Endpoint) -> (path: String, query: String?) {
        switch endpoint {
        case .healthz:
            return ("/healthz", nil)
        case .events(let conversationKey):
            let encoded = conversationKey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? conversationKey
            return ("/v1/events", "conversationKey=\(encoded)")
        case .sendMessage:
            return ("/v1/messages", nil)
        case .getMessages(let conversationId):
            if let id = conversationId {
                let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id
                return ("/v1/messages", "conversationId=\(encoded)")
            }
            return ("/v1/messages", nil)
        case .conversations(let limit, let offset):
            return ("/v1/conversations", "limit=\(limit)&offset=\(offset)")
        case .confirm:
            return ("/v1/confirm", nil)
        case .secret:
            return ("/v1/secret", nil)
        case .guardianActionsPending(let conversationId):
            let encoded = conversationId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? conversationId
            return ("/v1/guardian-actions/pending", "conversationId=\(encoded)")
        case .guardianActionsDecision:
            return ("/v1/guardian-actions/decision", nil)
        case .conversationsSeen:
            return ("/v1/conversations/seen", nil)
        case .conversationsUnread:
            return ("/v1/conversations/unread", nil)
        case .identity:
            return ("/v1/identity", nil)
        case .featureFlags:
            return ("/v1/feature-flags", nil)
        case .featureFlagUpdate(let key):
            let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key
            return ("/v1/feature-flags/\(encoded)", nil)
        case .surfaceAction:
            return ("/v1/surface-actions", nil)
        case .trustRulesManage:
            return ("/v1/trust-rules/manage", nil)
        case .trustRuleManageById(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/trust-rules/manage/\(encoded)", nil)
        case .pendingInteractions(let conversationKey):
            if let key = conversationKey {
                let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key
                return ("/v1/pending-interactions", "conversationKey=\(encoded)")
            }
            return ("/v1/pending-interactions", nil)
        case .contactsList(let limit, let role):
            var q = "limit=\(limit)"
            if let role {
                let encoded = role.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? role
                q += "&role=\(encoded)"
            }
            return ("/v1/contacts", q)
        case .contactsGet(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/contacts/\(encoded)", nil)
        case .contactsDelete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/contacts/\(encoded)", nil)
        case .contactChannelUpdate(let contactChannelId):
            let encoded = contactChannelId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? contactChannelId
            return ("/v1/contact-channels/\(encoded)", nil)
        case .contactChannelVerify(let contactChannelId):
            let encoded = contactChannelId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? contactChannelId
            return ("/v1/contact-channels/\(encoded)/verify", nil)
        case .contactsUpsert:
            return ("/v1/contacts", nil)
        case .contactsInvitesCreate:
            return ("/v1/contacts/invites", nil)
        case .channelsReadiness:
            return ("/v1/channels/readiness", nil)
        case .surfaceContent(let surfaceId, let sessionId):
            let sEncoded = surfaceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? surfaceId
            let qEncoded = sessionId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? sessionId
            return ("/v1/surfaces/\(sEncoded)", "sessionId=\(qEncoded)")
        case .usageTotals(let from, let to):
            return ("/v1/usage/totals", "from=\(from)&to=\(to)")
        case .usageDaily(let from, let to):
            return ("/v1/usage/daily", "from=\(from)&to=\(to)")
        case .usageBreakdown(let from, let to, let groupBy):
            let encoded = groupBy.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? groupBy
            return ("/v1/usage/breakdown", "from=\(from)&to=\(to)&groupBy=\(encoded)")
        }
    }

    /// Builds paths for the platform assistant proxy layout
    /// (e.g. /v1/assistants/{id}/healthz/, /v1/assistants/{id}/messages/).
    /// Trailing slashes match the Django URL convention.
    private func buildPlatformProxyPath(for endpoint: Endpoint, assistantId: String) -> (path: String, query: String?) {
        let prefix = "/v1/assistants/\(assistantId)"

        switch endpoint {
        case .healthz:
            return ("\(prefix)/healthz/", nil)
        case .events(let conversationKey):
            let encoded = conversationKey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? conversationKey
            return ("\(prefix)/events/", "conversationKey=\(encoded)")
        case .sendMessage:
            return ("\(prefix)/messages/", nil)
        case .getMessages(let conversationId):
            if let id = conversationId {
                let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id
                return ("\(prefix)/messages/", "conversationId=\(encoded)")
            }
            return ("\(prefix)/messages/", nil)
        case .conversations(let limit, let offset):
            return ("\(prefix)/conversations/", "limit=\(limit)&offset=\(offset)")
        case .confirm:
            return ("\(prefix)/confirm/", nil)
        case .secret:
            return ("\(prefix)/secret/", nil)
        case .guardianActionsPending(let conversationId):
            let encoded = conversationId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? conversationId
            return ("\(prefix)/guardian-actions/pending/", "conversationId=\(encoded)")
        case .guardianActionsDecision:
            return ("\(prefix)/guardian-actions/decision/", nil)
        case .conversationsSeen:
            return ("\(prefix)/conversations/seen/", nil)
        case .conversationsUnread:
            return ("\(prefix)/conversations/unread/", nil)
        case .identity:
            return ("\(prefix)/identity/", nil)
        case .featureFlags:
            return ("\(prefix)/feature-flags/", nil)
        case .featureFlagUpdate(let key):
            let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key
            return ("\(prefix)/feature-flags/\(encoded)/", nil)
        case .surfaceAction:
            return ("\(prefix)/surface-actions/", nil)
        case .trustRulesManage:
            return ("\(prefix)/trust-rules/manage/", nil)
        case .trustRuleManageById(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/trust-rules/manage/\(encoded)/", nil)
        case .pendingInteractions(let conversationKey):
            if let key = conversationKey {
                let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key
                return ("\(prefix)/pending-interactions/", "conversationKey=\(encoded)")
            }
            return ("\(prefix)/pending-interactions/", nil)
        case .contactsList(let limit, let role):
            var q = "limit=\(limit)"
            if let role {
                let encoded = role.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? role
                q += "&role=\(encoded)"
            }
            return ("\(prefix)/contacts/", q)
        case .contactsGet(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/contacts/\(encoded)/", nil)
        case .contactsDelete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/contacts/\(encoded)/", nil)
        case .contactChannelUpdate(let contactChannelId):
            let encoded = contactChannelId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? contactChannelId
            return ("\(prefix)/contact-channels/\(encoded)/", nil)
        case .contactChannelVerify(let contactChannelId):
            let encoded = contactChannelId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? contactChannelId
            return ("\(prefix)/contact-channels/\(encoded)/verify/", nil)
        case .contactsUpsert:
            return ("\(prefix)/contacts/", nil)
        case .contactsInvitesCreate:
            return ("\(prefix)/contacts/invites/", nil)
        case .channelsReadiness:
            return ("\(prefix)/channels/readiness/", nil)
        case .surfaceContent(let surfaceId, let sessionId):
            let sEncoded = surfaceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? surfaceId
            let qEncoded = sessionId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? sessionId
            return ("\(prefix)/surfaces/\(sEncoded)/", "sessionId=\(qEncoded)")
        case .usageTotals(let from, let to):
            return ("\(prefix)/usage/totals/", "from=\(from)&to=\(to)")
        case .usageDaily(let from, let to):
            return ("\(prefix)/usage/daily/", "from=\(from)&to=\(to)")
        case .usageBreakdown(let from, let to, let groupBy):
            let encoded = groupBy.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? groupBy
            return ("\(prefix)/usage/breakdown/", "from=\(from)&to=\(to)&groupBy=\(encoded)")
        }
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
        guard let healthURL = buildURL(for: .healthz) else {
            throw HTTPTransportError.invalidURL
        }
        var healthReq = URLRequest(url: healthURL)
        healthReq.timeoutInterval = 10
        applyAuth(&healthReq)

        do {
            let (data, response) = try await URLSession.shared.data(for: healthReq)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                if statusCode == 401 {
                    handleAuthenticationFailure(responseData: data)
                    if isManagedMode {
                        // Stop polling — the session is expired and reconnecting
                        // would just loop. The session-error event already tells
                        // the UI to prompt re-authentication.
                        shouldReconnect = false
                    }
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

        guard let url = buildURL(for: .events(conversationKey: self.conversationKey)) else {
            log.error("Invalid SSE URL for conversationKey: \(self.conversationKey)")
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
                        if self.isManagedMode {
                            // In managed mode, 401 means the session token expired.
                            // Don't reconnect — it would loop indefinitely.
                            self.shouldReconnect = false
                            self.sseTask = nil
                            self.setSSEConnected(false)
                            return
                        }
                    }
                    self.handleSSEDisconnect()
                    return
                }

                self.setSSEConnected(true)
                log.info("SSE stream connected to \(url.absoluteString, privacy: .public)")

                for try await line in bytes.lines {
                    if Task.isCancelled { break }

                    if line.hasPrefix("data: ") {
                        // AsyncLineSequence strips blank lines, so we never
                        // see the empty-line boundary that the SSE spec uses
                        // to delimit events. Flush each data line immediately
                        // to avoid delaying the last event of a turn until an
                        // unrelated line (e.g. heartbeat) arrives.
                        let payload = String(line.dropFirst(6))
                        self.parseSSEData(payload)
                    }
                    // Non-data lines (event:, id:, heartbeat) are ignored.
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
        // Remap the daemon's internal session/conversation ID to the client's
        // local session ID so that ChatViewModel.belongsToSession() passes.
        // The daemon assigns its own UUID via getOrCreateConversation(), which
        // differs from the correlationId the client uses as sessionId.
        var jsonString = data
        if let localId = activeLocalSessionId {
            if remoteSessionId == nil {
                // Learn the daemon's session ID from the first event envelope.
                if let eventData = data.data(using: .utf8),
                   let envelope = try? decoder.decode(AssistantEvent.self, from: eventData),
                   let eventSessionId = envelope.sessionId,
                   eventSessionId != localId {
                    remoteSessionId = eventSessionId
                    log.info("Learned remote sessionId \(eventSessionId, privacy: .public) → local \(localId, privacy: .public)")
                }
            }
            if let remoteId = remoteSessionId {
                // Replace only the sessionId JSON value — not arbitrary occurrences
                // of the UUID elsewhere in the payload. Handle both compact
                // ("sessionId":"…") and pretty-printed ("sessionId": "…") JSON.
                jsonString = jsonString.replacingOccurrences(
                    of: "\"sessionId\":\"\(remoteId)\"",
                    with: "\"sessionId\":\"\(localId)\""
                )
                jsonString = jsonString.replacingOccurrences(
                    of: "\"sessionId\": \"\(remoteId)\"",
                    with: "\"sessionId\": \"\(localId)\""
                )
                jsonString = jsonString.replacingOccurrences(
                    of: "\"parentSessionId\":\"\(remoteId)\"",
                    with: "\"parentSessionId\":\"\(localId)\""
                )
                jsonString = jsonString.replacingOccurrences(
                    of: "\"parentSessionId\": \"\(remoteId)\"",
                    with: "\"parentSessionId\": \"\(localId)\""
                )
            }
        }

        guard let jsonData = jsonString.data(using: .utf8) else { return }

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
            Task { await self.sendDecision(requestId: msg.requestId, decision: msg.decision, selectedPattern: msg.selectedPattern, selectedScope: msg.selectedScope) }
        } else if let msg = message as? SecretResponseMessage {
            Task { await self.sendSecret(requestId: msg.requestId, value: msg.value, delivery: msg.delivery) }
        } else if let msg = message as? CancelMessage {
            // Best-effort cancel — no dedicated endpoint yet
            log.info("Cancel requested for session \(msg.sessionId ?? "unknown") (no-op over HTTP)")
        } else if let msg = message as? SessionCreateMessage {
            // For HTTP transport, session creation is implicit — the conversationKey
            // acts as the session. Emit a synthetic session_info so ChatViewModel
            // records the session ID.
            let sessionId = (msg.correlationId.flatMap { $0.isEmpty ? nil : $0 }) ?? UUID().uuidString
            activeLocalSessionId = sessionId
            remoteSessionId = nil  // Reset — will be learned from the first SSE event
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
        } else if let msg = message as? IPCConversationUnreadSignal {
            Task { await self.sendConversationUnread(msg) }
        } else if let msg = message as? GuardianActionsPendingRequestMessage {
            Task { await self.fetchGuardianActionsPending(conversationId: msg.conversationId) }
        } else if let msg = message as? GuardianActionDecisionMessage {
            Task { await self.submitGuardianActionDecision(requestId: msg.requestId, action: msg.action, conversationId: msg.conversationId) }
        } else if let msg = message as? UiSurfaceActionMessage {
            Task { await self.sendSurfaceAction(msg) }
        } else if let msg = message as? AddTrustRuleMessage {
            Task { await self.sendAddTrustRule(msg) }
        } else if message is TrustRulesListMessage {
            Task { await self.fetchTrustRules() }
        } else if let msg = message as? RemoveTrustRuleMessage {
            Task { await self.sendRemoveTrustRule(msg) }
        } else if let msg = message as? UpdateTrustRuleMessage {
            Task { await self.sendUpdateTrustRule(msg) }
        } else if let msg = message as? ContactsRequestMessage {
            Task { await self.handleContactsRequest(msg) }
        } else if message is PingMessage {
            // No-op for HTTP transport — SSE keepalive is handled by the connection
        } else {
            // For unhandled message types, log and skip
            log.debug("HTTPTransport: unhandled send message type \(String(describing: type(of: message)))")
        }
    }

    // MARK: - HTTP Endpoints

    private func sendMessage(content: String?, sessionId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .sendMessage) else { return }

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
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                switch refreshResult {
                case .success:
                    await sendMessage(content: content, sessionId: sessionId, isRetry: true)
                case .terminalFailure:
                    // performRefresh() already emitted .authenticationRequired — don't overwrite it
                    break
                case .transientFailure:
                    onMessage?(.sessionError(SessionErrorMessage(
                        sessionId: sessionId,
                        code: .providerApi,
                        userMessage: "Failed to send message — authentication error. Please try again.",
                        retryable: true
                    )))
                }
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

    private func sendDecision(requestId: String, decision: String, selectedPattern: String? = nil, selectedScope: String? = nil, isRetry: Bool = false) async {
        guard let url = buildURL(for: .confirm) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "requestId": requestId,
            "decision": decision,
        ]
        if let selectedPattern {
            body["selectedPattern"] = selectedPattern
        }
        if let selectedScope {
            body["selectedScope"] = selectedScope
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    switch refreshResult {
                    case .success:
                        await sendDecision(requestId: requestId, decision: decision, selectedPattern: selectedPattern, selectedScope: selectedScope, isRetry: true)
                    case .terminalFailure:
                        break
                    case .transientFailure:
                        log.error("Decision response failed: authentication error after 401 refresh")
                    }
                } else if http.statusCode != 200 {
                    log.error("Decision response failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Decision response error: \(error.localizedDescription)")
        }
    }

    private func sendSecret(requestId: String, value: String?, delivery: String? = nil, isRetry: Bool = false) async {
        guard let url = buildURL(for: .secret) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "requestId": requestId,
            "value": value ?? "",
        ]
        if let delivery {
            body["delivery"] = delivery
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    switch refreshResult {
                    case .success:
                        await sendSecret(requestId: requestId, value: value, delivery: delivery, isRetry: true)
                    case .terminalFailure:
                        break
                    case .transientFailure:
                        log.error("Secret response failed: authentication error after 401 refresh")
                    }
                } else if http.statusCode != 200 {
                    log.error("Secret response failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Secret response error: \(error.localizedDescription)")
        }
    }

    private func fetchGuardianActionsPending(conversationId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .guardianActionsPending(conversationId: conversationId)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    switch refreshResult {
                    case .success:
                        await fetchGuardianActionsPending(conversationId: conversationId, isRetry: true)
                    case .terminalFailure:
                        break
                    case .transientFailure:
                        log.error("Fetch guardian actions pending failed: authentication error after 401 refresh")
                    }
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

    private func submitGuardianActionDecision(requestId: String, action: String, conversationId: String?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .guardianActionsDecision) else { return }

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
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    switch refreshResult {
                    case .success:
                        await submitGuardianActionDecision(requestId: requestId, action: action, conversationId: conversationId, isRetry: true)
                        return
                    case .terminalFailure:
                        break
                    case .transientFailure:
                        break
                    }
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

    /// JSONSerialization cannot encode AnyCodable wrappers directly, so unwrap
    /// them before inserting arbitrary payloads into request bodies.
    private func jsonCompatibleDictionary(_ values: [String: AnyCodable]) -> [String: Any] {
        var jsonCompatible: [String: Any] = [:]
        for (key, value) in values {
            jsonCompatible[key] = value.value
        }
        return jsonCompatible
    }

    private func sendConversationSeen(_ signal: IPCConversationSeenSignal, isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationsSeen) else { return }

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
            body["metadata"] = jsonCompatibleDictionary(metadata)
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await sendConversationSeen(signal, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("Conversation seen signal failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Conversation seen signal error: \(error.localizedDescription)")
        }
    }

    private func sendConversationUnread(_ signal: IPCConversationUnreadSignal, isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationsUnread) else { return }

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
            body["metadata"] = jsonCompatibleDictionary(metadata)
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await sendConversationUnread(signal, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("Conversation unread signal failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Conversation unread signal error: \(error.localizedDescription)")
        }
    }

    // MARK: - Contacts

    /// Route a `ContactsRequestMessage` to the appropriate HTTP endpoint based on its action.
    private func handleContactsRequest(_ msg: ContactsRequestMessage) async {
        switch msg.action {
        case "list":
            await fetchContactsList(limit: Int(msg.limit ?? 50), role: msg.role)
        case "get":
            guard let contactId = msg.contactId else {
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "contactId is required for get")))
                return
            }
            await fetchContact(contactId: contactId)
        case "update_channel":
            guard let channelId = msg.channelId else {
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "channelId is required for update_channel")))
                return
            }
            await updateContactChannel(channelId: channelId, status: msg.status, policy: msg.policy, reason: msg.reason)
        case "delete":
            guard let contactId = msg.contactId else {
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "contactId is required for delete")))
                return
            }
            await deleteContact(contactId: contactId)
        default:
            onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "Unknown action: \(msg.action)")))
        }
    }

    private func fetchContactsList(limit: Int, role: String?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .contactsList(limit: limit, role: role)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await fetchContactsList(limit: limit, role: role, isRetry: true)
                    }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("HTTPTransport: fetch contacts list failed (\(http.statusCode))")
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "HTTP \(http.statusCode)")))
                    return
                }
            }

            do {
                let decoded = try decoder.decode(HTTPContactsListResponse.self, from: data)
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: true, contacts: decoded.contacts)))
            } catch {
                log.error("HTTPTransport: failed to decode contacts list response: \(error)")
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
            }
        } catch {
            log.error("HTTPTransport: fetch contacts list error: \(error.localizedDescription)")
            onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
        }
    }

    private func fetchContact(contactId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .contactsGet(id: contactId)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await fetchContact(contactId: contactId, isRetry: true)
                    }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("HTTPTransport: fetch contact failed (\(http.statusCode))")
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "HTTP \(http.statusCode)")))
                    return
                }
            }

            do {
                let decoded = try decoder.decode(HTTPContactResponse.self, from: data)
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: true, contact: decoded.contact)))
            } catch {
                log.error("HTTPTransport: failed to decode contact response: \(error)")
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
            }
        } catch {
            log.error("HTTPTransport: fetch contact error: \(error.localizedDescription)")
            onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
        }
    }

    private func deleteContact(contactId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .contactsDelete(id: contactId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await deleteContact(contactId: contactId, isRetry: true)
                    }
                    return
                }
                if http.statusCode == 204 {
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: true)))
                    return
                }
                if http.statusCode == 404 {
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "Contact not found")))
                    return
                }
                if http.statusCode == 403 {
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "Permission denied")))
                    return
                }
                log.error("HTTPTransport: delete contact failed (\(http.statusCode))")
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "HTTP \(http.statusCode)")))
            }
        } catch {
            log.error("HTTPTransport: delete contact error: \(error.localizedDescription)")
            onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
        }
    }

    private func updateContactChannel(channelId: String, status: String?, policy: String?, reason: String?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .contactChannelUpdate(contactChannelId: channelId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [:]
        if let status { body["status"] = status }
        if let policy { body["policy"] = policy }
        if let reason { body["reason"] = reason }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await updateContactChannel(channelId: channelId, status: status, policy: policy, reason: reason, isRetry: true)
                    }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("HTTPTransport: update contact channel failed (\(http.statusCode))")
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "HTTP \(http.statusCode)")))
                    return
                }
            }

            do {
                let decoded = try decoder.decode(HTTPContactResponse.self, from: data)
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: true, contact: decoded.contact)))
            } catch {
                log.error("HTTPTransport: failed to decode update channel response: \(error)")
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
            }
        } catch {
            log.error("HTTPTransport: update contact channel error: \(error.localizedDescription)")
            onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
        }
    }

    /// Response wrapper for `GET /v1/contacts` (list).
    private struct HTTPContactsListResponse: Decodable {
        let ok: Bool
        let contacts: [ContactPayload]
    }

    /// Response wrapper for `GET /v1/contacts/:id` and `PATCH /v1/contact-channels/:contactChannelId`.
    private struct HTTPContactResponse: Decodable {
        let ok: Bool
        let contact: ContactPayload?
    }

    /// Response wrapper for `POST /v1/contacts` (upsert).
    private struct HTTPContactUpsertResponse: Decodable {
        let ok: Bool
        let contact: ContactPayload
    }

    /// Response wrapper for `POST /v1/contacts/invites` (create invite).
    private struct HTTPCreateInviteResponse: Decodable {
        let ok: Bool
        let invite: InvitePayload?
        struct InvitePayload: Decodable {
            let id: String
            let sourceChannel: String
            let token: String?
            let share: SharePayload?
            let status: String
            let inviteCode: String?
            let guardianInstruction: String?
            let channelHandle: String?
        }
        struct SharePayload: Decodable {
            let url: String
            let displayText: String
        }
    }

    /// Response wrapper for `GET /v1/channels/readiness`.
    private struct HTTPChannelReadinessResponse: Decodable {
        let success: Bool
        let snapshots: [ChannelReadinessSnapshot]

        struct ChannelReadinessSnapshot: Decodable {
            let channel: String
            let ready: Bool
            let channelHandle: String?
            let localChecks: [CheckResult]?
            let remoteChecks: [CheckResult]?
        }
        struct CheckResult: Decodable {
            let name: String
            let passed: Bool
            let message: String
        }
    }

    /// Update a contact's metadata via `POST /v1/contacts` and return the updated payload.
    /// Routes through `buildURL`/`applyAuth` so managed-mode URL paths and auth headers
    /// are applied correctly.
    func updateContactAndReturn(
        contactId: String,
        displayName: String,
        notes: String? = nil,
        isRetry: Bool = false
    ) async throws -> ContactPayload? {
        guard let url = buildURL(for: .contactsUpsert) else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = ["id": contactId, "displayName": displayName]
        if let notes { body["notes"] = notes }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)

        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    return try await updateContactAndReturn(contactId: contactId, displayName: displayName, notes: notes, isRetry: true)
                }
                return nil
            }
            guard (200...201).contains(http.statusCode) else {
                return nil
            }
        }

        let decoded = try decoder.decode(HTTPContactUpsertResponse.self, from: data)
        return decoded.contact
    }

    /// Create a new contact via `POST /v1/contacts` and return the created payload.
    /// Omits the `id` field to trigger creation instead of update.
    func createContactAndReturn(
        displayName: String,
        notes: String? = nil,
        channels: [DaemonClient.NewContactChannel]? = nil,
        isRetry: Bool = false
    ) async throws -> ContactPayload? {
        guard let url = buildURL(for: .contactsUpsert) else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = ["displayName": displayName]
        if let notes { body["notes"] = notes }
        if let channels {
            body["channels"] = channels.map { ch -> [String: Any] in
                ["type": ch.type, "address": ch.address, "isPrimary": ch.isPrimary]
            }
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)

        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    return try await createContactAndReturn(displayName: displayName, notes: notes, channels: channels, isRetry: true)
                }
                return nil
            }
            guard (200...201).contains(http.statusCode) else {
                return nil
            }
        }

        let decoded = try decoder.decode(HTTPContactUpsertResponse.self, from: data)
        return decoded.contact
    }

    // MARK: - Invite Creation

    /// Create an invite for a contact channel via `POST /v1/contacts/invites`.
    func createInvite(
        sourceChannel: String,
        note: String? = nil,
        maxUses: Int? = nil,
        contactName: String? = nil,
        isRetry: Bool = false
    ) async throws -> (inviteId: String, token: String, shareUrl: String?, inviteCode: String?, guardianInstruction: String?, channelHandle: String?)? {
        guard let url = buildURL(for: .contactsInvitesCreate) else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = ["sourceChannel": sourceChannel]
        if let note { body["note"] = note }
        if let maxUses { body["maxUses"] = maxUses }
        if let contactName { body["contactName"] = contactName }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)

        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    return try await createInvite(sourceChannel: sourceChannel, note: note, maxUses: maxUses, contactName: contactName, isRetry: true)
                }
                return nil
            }
            guard (200...201).contains(http.statusCode) else { return nil }
        }

        let decoded = try decoder.decode(HTTPCreateInviteResponse.self, from: data)
        guard let invite = decoded.invite, let token = invite.token else { return nil }
        return (inviteId: invite.id, token: token, shareUrl: invite.share?.url, inviteCode: invite.inviteCode, guardianInstruction: invite.guardianInstruction, channelHandle: invite.channelHandle)
    }

    // MARK: - Channel Readiness

    /// Fetch per-channel readiness from `GET /v1/channels/readiness`.
    /// Returns a dictionary mapping channel type strings to their readiness state.
    func fetchChannelReadiness(isRetry: Bool = false) async throws -> [String: DaemonClient.ChannelReadinessInfo] {
        guard let url = buildURL(for: .channelsReadiness) else { return [:] }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        applyAuth(&request)

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    return try await fetchChannelReadiness(isRetry: true)
                }
                return [:]
            }
            guard (200...299).contains(http.statusCode) else { return [:] }
        }

        let decoded = try decoder.decode(HTTPChannelReadinessResponse.self, from: data)
        var result: [String: DaemonClient.ChannelReadinessInfo] = [:]
        for snapshot in decoded.snapshots {
            let checks = ((snapshot.localChecks ?? []) + (snapshot.remoteChecks ?? []))
                .map { DaemonClient.ReadinessCheck(name: $0.name, passed: $0.passed, message: $0.message) }
            result[snapshot.channel] = DaemonClient.ChannelReadinessInfo(
                ready: snapshot.ready,
                channelHandle: snapshot.channelHandle,
                checks: checks
            )
        }
        return result
    }

    // MARK: - Channel Verification

    /// Send a verification code to a contact's channel via the gateway.
    func verifyContactChannel(contactChannelId: String, isRetry: Bool = false) async throws -> DaemonClient.ChannelVerificationResult? {
        guard let url = buildURL(for: .contactChannelVerify(contactChannelId: contactChannelId)) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    return try await verifyContactChannel(contactChannelId: contactChannelId, isRetry: true)
                }
                return nil
            }
            guard (200...299).contains(http.statusCode) else { return nil }
        }
        return try JSONDecoder().decode(DaemonClient.ChannelVerificationResult.self, from: data)
    }

    // MARK: - Surface Actions

    private func sendSurfaceAction(_ action: UiSurfaceActionMessage, isRetry: Bool = false) async {
        guard let url = buildURL(for: .surfaceAction) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "sessionId": action.sessionId,
            "surfaceId": action.surfaceId,
            "actionId": action.actionId,
        ]
        if let data = action.data {
            body["data"] = jsonCompatibleDictionary(data)
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync()
                    if case .success = refreshResult {
                        await sendSurfaceAction(action, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("HTTPTransport: surface action failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("HTTPTransport: surface action error: \(error.localizedDescription)")
        }
    }

    // MARK: - Surface Content Fetch

    /// Fetch the full surface payload from the daemon for a stripped surface.
    /// Returns the parsed `SurfaceData` on success, or `nil` if the surface
    /// was not found or the response could not be parsed.
    func fetchSurfaceData(surfaceId: String, sessionId: String, isRetry: Bool = false) async -> SurfaceData? {
        guard let url = buildURL(for: .surfaceContent(surfaceId: surfaceId, sessionId: sessionId)) else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        return await fetchSurfaceData(surfaceId: surfaceId, sessionId: sessionId, isRetry: true)
                    }
                    return nil
                }
                guard (200...299).contains(http.statusCode) else {
                    log.error("HTTPTransport: surface content fetch failed (\(http.statusCode))")
                    return nil
                }
            }

            guard let surfaceData = Surface.parseSurfaceDataFromResponse(data) else {
                log.error("HTTPTransport: surface content response could not be parsed")
                return nil
            }

            return surfaceData
        } catch {
            log.error("HTTPTransport: surface content fetch error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Trust Rule Management

    private func sendAddTrustRule(_ rule: AddTrustRuleMessage, isRetry: Bool = false) async {
        guard let url = buildURL(for: .trustRulesManage) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "toolName": rule.toolName,
            "pattern": rule.pattern,
            "scope": rule.scope,
            "decision": rule.decision,
        ]
        if let allowHighRisk = rule.allowHighRisk {
            body["allowHighRisk"] = allowHighRisk
        }
        if let executionTarget = rule.executionTarget {
            body["executionTarget"] = executionTarget
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync()
                    if case .success = refreshResult {
                        await sendAddTrustRule(rule, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("HTTPTransport: add trust rule failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("HTTPTransport: add trust rule error: \(error.localizedDescription)")
        }
    }

    private func fetchTrustRules(isRetry: Bool = false) async {
        guard let url = buildURL(for: .trustRulesManage) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync()
                    if case .success = refreshResult {
                        await fetchTrustRules(isRetry: true)
                    }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("HTTPTransport: fetch trust rules failed (\(http.statusCode))")
                    return
                }
            }

            do {
                let decoded = try decoder.decode(IPCTrustRulesListResponse.self, from: data)
                onMessage?(.trustRulesListResponse(decoded))
            } catch {
                log.error("HTTPTransport: failed to decode trust rules response: \(error)")
            }
        } catch {
            log.error("HTTPTransport: fetch trust rules error: \(error.localizedDescription)")
        }
    }

    private func sendRemoveTrustRule(_ rule: RemoveTrustRuleMessage, isRetry: Bool = false) async {
        guard let url = buildURL(for: .trustRuleManageById(id: rule.id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuth(&request)

        do {
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync()
                    if case .success = refreshResult {
                        await sendRemoveTrustRule(rule, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("HTTPTransport: remove trust rule failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("HTTPTransport: remove trust rule error: \(error.localizedDescription)")
        }
    }

    private func sendUpdateTrustRule(_ rule: UpdateTrustRuleMessage, isRetry: Bool = false) async {
        guard let url = buildURL(for: .trustRuleManageById(id: rule.id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [:]
        if let tool = rule.tool {
            body["tool"] = tool
        }
        if let pattern = rule.pattern {
            body["pattern"] = pattern
        }
        if let scope = rule.scope {
            body["scope"] = scope
        }
        if let decision = rule.decision {
            body["decision"] = decision
        }
        if let priority = rule.priority {
            body["priority"] = priority
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync()
                    if case .success = refreshResult {
                        await sendUpdateTrustRule(rule, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("HTTPTransport: update trust rule failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("HTTPTransport: update trust rule error: \(error.localizedDescription)")
        }
    }

    private func fetchSessionList(offset: Int = 0, limit: Int = 50, isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversations(limit: limit, offset: offset)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                if statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await fetchSessionList(offset: offset, limit: limit, isRetry: true)
                        return
                    }
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

    private func fetchHistory(sessionId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .getMessages(conversationId: sessionId)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                if statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await fetchHistory(sessionId: sessionId, isRetry: true)
                        return
                    }
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
        guard let url = buildURL(for: .featureFlags) else {
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
        guard let url = buildURL(for: .featureFlagUpdate(key: key)) else {
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
        guard let url = buildURL(for: .featureFlags) else {
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
        guard let url = buildURL(for: .identity) else { return nil }

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

    // MARK: - Usage Reporting

    /// Fetch aggregate usage totals from `GET /v1/usage/totals`.
    func fetchUsageTotals(from: Int, to: Int, isRetry: Bool = false) async -> UsageTotalsResponse? {
        guard let url = buildURL(for: .usageTotals(from: from, to: to)) else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        return await fetchUsageTotals(from: from, to: to, isRetry: true)
                    }
                    return nil
                }
                guard (200...299).contains(http.statusCode) else { return nil }
            }
            return try decoder.decode(UsageTotalsResponse.self, from: data)
        } catch {
            log.error("fetchUsageTotals failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Fetch per-day usage buckets from `GET /v1/usage/daily`.
    func fetchUsageDaily(from: Int, to: Int, isRetry: Bool = false) async -> UsageDailyResponse? {
        guard let url = buildURL(for: .usageDaily(from: from, to: to)) else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        return await fetchUsageDaily(from: from, to: to, isRetry: true)
                    }
                    return nil
                }
                guard (200...299).contains(http.statusCode) else { return nil }
            }
            return try decoder.decode(UsageDailyResponse.self, from: data)
        } catch {
            log.error("fetchUsageDaily failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Fetch grouped usage breakdown from `GET /v1/usage/breakdown`.
    func fetchUsageBreakdown(from: Int, to: Int, groupBy: String, isRetry: Bool = false) async -> UsageBreakdownResponse? {
        guard let url = buildURL(for: .usageBreakdown(from: from, to: to, groupBy: groupBy)) else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        return await fetchUsageBreakdown(from: from, to: to, groupBy: groupBy, isRetry: true)
                    }
                    return nil
                }
                guard (200...299).contains(http.statusCode) else { return nil }
            }
            return try decoder.decode(UsageBreakdownResponse.self, from: data)
        } catch {
            log.error("fetchUsageBreakdown failed: \(error.localizedDescription)")
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

    /// Fire-and-forget token refresh for non-async callers (health check, SSE).
    /// Async callers that need retry-or-skip semantics should use
    /// handleAuthenticationFailureAsync() directly.
    private func handleAuthenticationFailure(responseData: Data? = nil) {
        // Managed mode uses session tokens — the bearer refresh flow does not apply.
        // Signal session expiry and disconnect to stop SSE/health-check loops
        // from re-hitting the 401 and re-emitting the error indefinitely.
        if isManagedMode {
            log.warning("401 in managed mode — session token may be expired")
            onMessage?(.sessionError(SessionErrorMessage(
                sessionId: "",
                code: .authenticationRequired,
                userMessage: "Session expired. Please sign in again.",
                retryable: false
            )))
            disconnect()
            return
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            _ = await self.handleAuthenticationFailureAsync(responseData: responseData)
        }
    }

    /// Async variant of handleAuthenticationFailure that returns the refresh outcome.
    /// On `.success`, callers should retry the original request.
    /// On `.terminalFailure`, callers must NOT emit their own error — `performRefresh()`
    /// already emitted `.authenticationRequired` which is the correct final user-facing state.
    /// On `.transientFailure`, callers may emit a generic error (refresh will retry on next 401).
    ///
    /// When the server returns 401, the client attempts a credential refresh and
    /// retries once. Only explicitly terminal codes (e.g. `credentials_revoked`)
    /// skip refresh and force re-pairing. All other 401 codes — including
    /// `refresh_required`, `UNAUTHORIZED` (expired JWT), and unknown codes —
    /// are treated as refreshable.
    private func handleAuthenticationFailureAsync(responseData: Data? = nil) async -> AuthRefreshResult {
        // Managed mode: no bearer refresh — emit session-expired, disconnect to
        // stop loops, and return terminal so callers don't retry.
        if isManagedMode {
            log.warning("401 in managed mode — session token may be expired")
            onMessage?(.sessionError(SessionErrorMessage(
                sessionId: "",
                code: .authenticationRequired,
                userMessage: "Session expired. Please sign in again.",
                retryable: false
            )))
            disconnect()
            return .terminalFailure
        }

        // Parse the 401 body to check for terminal (non-refreshable) error codes.
        // The server's auth middleware returns errors in a standard envelope:
        //   { "error": { "code": "...", "message": "..." } }
        // We also accept a top-level "code" for forward compatibility.
        let terminalCodes: Set<String> = ["credentials_revoked"]
        if let data = responseData,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let code: String? = {
                if let errorObj = json["error"] as? [String: Any] {
                    return errorObj["code"] as? String
                }
                return json["code"] as? String
            }()
            if let code, terminalCodes.contains(code) {
                // Explicitly terminal — no refresh possible
                log.error("Terminal 401 code: \(code) — re-auth required")
                self.onMessage?(.sessionError(SessionErrorMessage(
                    sessionId: "",
                    code: .authenticationRequired,
                    userMessage: "Session expired. Please re-pair your device.",
                    retryable: false
                )))
                return .terminalFailure
            }
        }
        // If a refresh is already in flight, wait for its outcome instead of
        // returning false (which would drop the caller's user action).
        if let existing = refreshTask {
            return await existing.value
        }

        let task = Task<AuthRefreshResult, Never> { @MainActor [weak self] in
            guard let self else { return .transientFailure }
            defer { self.refreshTask = nil }
            return await self.performRefresh()
        }
        refreshTask = task
        return await task.value
    }

    /// Performs the actual credential refresh. Split out so handleAuthenticationFailureAsync
    /// can manage the coalescing task lifecycle separately.
    private func performRefresh() async -> AuthRefreshResult {
        #if os(macOS)
        let refreshPlatform = "macos"
        // macOS uses SHA-256 of IOPlatformUUID as device ID (matches PairingQRCodeSheet.computeHostId())
        let refreshDeviceId = Self.computeMacOSDeviceId()
        #else
        let refreshPlatform = "ios"
        // iOS uses Keychain-stored device ID (matches AppDelegate.getOrCreateDeviceId())
        let refreshDeviceId = APIKeyManager.shared.getAPIKey(provider: "pairing-device-id") ?? ""
        #endif

        let result = await ActorCredentialRefresher.refresh(
            baseURL: self.baseURL,
            bearerToken: self.bearerToken,
            platform: refreshPlatform,
            deviceId: refreshDeviceId
        )

        switch result {
        case .success:
            log.info("Token refresh succeeded — reconnecting SSE")
            // Reconnect SSE with new credentials
            self.stopSSE()
            self.startSSE()
            return .success

        case .terminalError(let reason):
            log.error("Token refresh failed terminally: \(reason) — re-pair required")
            self.onMessage?(.sessionError(SessionErrorMessage(
                sessionId: "",
                code: .authenticationRequired,
                userMessage: "Session expired. Please re-pair your device.",
                retryable: false
            )))
            return .terminalFailure

        case .transientError:
            log.warning("Token refresh encountered transient error — will retry on next 401")
            return .transientFailure
        }
    }

    // MARK: - macOS Device ID

    #if os(macOS)
    /// Compute a stable device ID matching PairingQRCodeSheet.computeHostId().
    /// SHA-256 of the IOPlatformUUID + an app-specific salt.
    private static func computeMacOSDeviceId() -> String {
        let platformUUID = getMacOSPlatformUUID() ?? UUID().uuidString
        let salt = "vellum-assistant-host-id"
        let input = Data((platformUUID + salt).utf8)
        let hash = SHA256.hash(data: input)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }

    /// Read the IOPlatformUUID from the IORegistry (macOS hardware identifier).
    private static func getMacOSPlatformUUID() -> String? {
        let service = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPlatformExpertDevice")
        )
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }

        let key = kIOPlatformUUIDKey as CFString
        guard let uuid = IORegistryEntryCreateCFProperty(service, key, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? String else {
            return nil
        }
        return uuid
    }
    #endif

    // MARK: - Helpers

    private func applyAuth(_ request: inout URLRequest) {
        switch transportMetadata.authMode {
        case .bearerToken:
            // The JWT access token is the sole auth credential — it serves as
            // both authentication and identity.
            if let accessToken = ActorTokenManager.getToken(), !accessToken.isEmpty {
                request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            } else if let token = bearerToken {
                // Fallback to legacy bearer token for initial bootstrap before
                // the first JWT is issued.
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
        case .sessionToken:
            if let token = SessionTokenManager.getToken() {
                request.setValue(token, forHTTPHeaderField: "X-Session-Token")
            }
            if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
                request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
            }
        }
    }

    /// Whether this transport is operating in managed mode.
    var isManagedMode: Bool {
        transportMetadata.routeMode == .platformAssistantProxy
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
