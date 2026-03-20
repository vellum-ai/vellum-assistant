import Foundation
import os
private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - AssistantEvent Envelope

/// Envelope around `ServerMessage` for SSE events from the runtime HTTP server.
struct AssistantEvent: Decodable {
    let id: String
    let assistantId: String
    let conversationId: String?
    let emittedAt: String
    let message: ServerMessage
}

// MARK: - Conversations List Response

/// Response shape from `GET /v1/conversations`.
public struct ConversationsListResponse: Decodable {
    public struct Conversation: Decodable {
        public let id: String
        public let title: String
        public let createdAt: Int?
        public let updatedAt: Int
        public let conversationType: String?
        public let source: String?
        public let scheduleJobId: String?
        public let channelBinding: ChannelBinding?
        public let conversationOriginChannel: String?
        public let conversationOriginInterface: String?
        public let assistantAttention: AssistantAttention?
        public let displayOrder: Double?
        public let isPinned: Bool?
        public let forkParent: ConversationForkParent?
    }
    public let conversations: [Conversation]
    public let hasMore: Bool?
}

/// Response shape from `GET /v1/conversations/:id`.
public struct SingleConversationResponse: Decodable {
    public let conversation: ConversationsListResponse.Conversation
}

/// Response shape from `POST /v1/conversations/:id/fork`.
public struct ForkConversationResponse: Decodable {
    public let conversation: ConversationsListResponse.Conversation
}

private struct HTTPErrorEnvelope: Decodable {
    struct ErrorBody: Decodable {
        let message: String
    }

    let error: ErrorBody
}

// MARK: - Workspace API Response Types

public struct WorkspaceTreeEntry: Codable, Identifiable, Hashable, Sendable {
    public let name: String
    public let path: String
    public let type: String  // "file" or "directory"
    public let size: Int?
    public let mimeType: String?
    public let modifiedAt: String

    public var id: String { path }
    public var isDirectory: Bool { type == "directory" }
}

public struct WorkspaceTreeResponse: Codable, Sendable {
    public let path: String
    public let entries: [WorkspaceTreeEntry]
}

public struct WorkspaceFileResponse: Codable, Sendable {
    public let path: String
    public let name: String
    public let size: Int
    public let mimeType: String
    public let modifiedAt: String
    public let content: String?
    public let isBinary: Bool

    public init(path: String, name: String, size: Int, mimeType: String, modifiedAt: String, content: String?, isBinary: Bool) {
        self.path = path
        self.name = name
        self.size = size
        self.mimeType = mimeType
        self.modifiedAt = modifiedAt
        self.content = content
        self.isBinary = isBinary
    }
}

/// Minimal decode of the healthz response to extract the version field.
/// The full `DaemonHealthz` model lives in Settings and includes disk/memory/cpu;
/// this struct intentionally only decodes what the transport layer needs.
private struct HealthzVersionResponse: Decodable {
    let version: String?
}

// MARK: - HTTP Transport

/// Internal helper that handles HTTP REST + SSE communication with a remote
/// Vellum assistant runtime. Used by `DaemonClient` when configured with
/// `.http` transport via `DaemonConfig`.
///
/// Responsibilities:
/// - Periodic health check via `GET /healthz` to drive connection status
/// - SSE stream connection to `GET /v1/events` (unfiltered, on demand)
/// - Translating message types to HTTP API calls
/// - Auto-reconnect with exponential backoff
///
/// - Important: New HTTP API calls should **not** be added here. Use `GatewayHTTPClient`
///   instead, injected via a focused protocol (e.g. `ConversationClientProtocol`).
///   Existing methods are being incrementally migrated to standalone clients backed by
///   `GatewayHTTPClient`. See `clients/ARCHITECTURE.md` for details.
@MainActor
public final class HTTPTransport {

    public let baseURL: String
    public private(set) var bearerToken: String?
    let transportMetadata: TransportMetadata

    // MARK: - SSE Parse Time Tracking

    /// Accumulated main-thread time spent in `parseSSEData` within the current
    /// 1-second window. When this exceeds 500ms, a warning is logged to help
    /// diagnose main-thread saturation during rapid streaming.
    private var sseParseTimeAccumulator: TimeInterval = 0
    private var sseParseCountInWindow: Int = 0
    private var sseWindowStart: CFAbsoluteTime = 0

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

    /// The daemon's self-reported version from the most recent health check.
    /// Updated on every successful health check that includes a version.
    private(set) var daemonVersion: String?

    /// Whether we should attempt to reconnect on disconnect.
    private var shouldReconnect = true

    /// Set by the owning DaemonClient when a planned service group update
    /// is in progress. Accelerates health check polling for faster reconnection.
    /// Use `setUpdateInProgress(_:)` to restart the health-check loop when
    /// the flag transitions to `true`, avoiding a stale 15s sleep.
    var isUpdateInProgress: Bool = false

    /// Update the in-progress flag and restart the health-check loop when
    /// transitioning to `true`. This avoids waiting out a stale 15s sleep
    /// before the accelerated 2s polling kicks in.
    func setUpdateInProgress(_ value: Bool) {
        let wasInProgress = isUpdateInProgress
        isUpdateInProgress = value
        if value && !wasInProgress && healthCheckTask != nil {
            startHealthCheckLoop()
        }
    }

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

    /// Called when the daemon version changes during a health check.
    /// Allows DaemonClient to confirm update completion without waiting for SSE.
    var onDaemonVersionChanged: ((String) -> Void)?

    /// Callback when the bearer token is refreshed via a `token_rotated` SSE event.
    /// Clients should persist the new token (e.g. to Keychain).
    var onTokenRefreshed: ((String) -> Void)?

    /// Called when the server-assigned conversation ID differs from the
    /// client-local ID. Observers should replace the local ID so that
    /// subsequent API calls use the ID the daemon recognises.
    var onConversationIdResolved: ((_ localId: String, _ serverId: String) -> Void)?

    /// Maps the daemon's server-side conversationId → client-local conversationId.
    /// Used to remap conversationId in incoming SSE events so ChatViewModel's
    /// belongsToConversation() filter passes. Supports multiple concurrent conversations.
    /// Capped at `serverToLocalConversationMapCap` entries to prevent unbounded growth.
    var serverToLocalConversationMap: [String: String] = [:]
    private let serverToLocalConversationMapCap = 500

    /// Conversation IDs that originated from this client instance.
    /// Host tool requests are only executed for these conversation IDs.
    private var locallyOwnedConversationIds: Set<String> = []
    /// Conversation IDs that belong to private (temporary) conversations.
    /// Populated when a conversation_create with conversationType "private" is handled locally.
    var privateConversationIds: Set<String> = []

    let decoder = JSONDecoder()
    let encoder = JSONEncoder()

    /// Registered domain dispatchers. Each handler receives the message as `Any`
    /// and returns `true` if it handled the message, `false` otherwise.
    /// Dispatchers are tried in registration order; the first match wins.
    private var domainDispatchers: [(Any) -> Bool] = []

    /// Register a domain dispatcher that can handle specific message types.
    /// The handler receives the message as `Any` and returns `true` if it
    /// handled the message. Return `false` to let subsequent dispatchers
    /// (or the default fallback) handle it.
    func registerDomainDispatcher(_ handler: @escaping (Any) -> Bool) {
        domainDispatchers.append(handler)
    }

    // MARK: - Init

    init(baseURL: String, bearerToken: String?, conversationKey: String, transportMetadata: TransportMetadata = .defaultLocal) {
        // Strip trailing slash for clean URL construction
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.bearerToken = bearerToken
        if !conversationKey.isEmpty {
            locallyOwnedConversationIds.insert(conversationKey)
        }
        self.transportMetadata = transportMetadata

        // Register dispatchers for existing HTTP-transported message types
        registerExistingRoutes()
        registerComputerUseRoutes()
        registerSettingsRoutes()
        registerAppsRoutes()
        registerSubagentsRoutes()
        registerConversationRoutes()
    }

    // MARK: - Endpoint Builder

    /// All HTTP endpoints used by the transport, centralized for consistent
    /// URL construction. Query parameters that are integral to the endpoint
    /// identity are modelled as associated values.
    enum Endpoint {
        case healthz
        case eventsAll  // SSE subscription for all events
    }

    /// Build a URL for the given endpoint using the current route mode.
    /// Returns nil if the URL string is malformed.
    func buildURL(for endpoint: Endpoint) -> URL? {
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
        case .eventsAll:
            return ("/v1/events", nil)
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
        case .eventsAll:
            return ("\(prefix)/events/", nil)
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
            // Extract daemon version from response body (best-effort, never fails the health check).
            // Persist to lockfile only when the version actually changes to avoid constant disk I/O.
            if let decoded = try? JSONDecoder().decode(HealthzVersionResponse.self, from: data) {
                if let newVersion = decoded.version, newVersion != daemonVersion {
                    daemonVersion = newVersion
                    if let id = UserDefaults.standard.string(forKey: "connectedAssistantId"), !id.isEmpty {
                        LockfilePaths.updateServiceGroupVersion(assistantId: id, version: newVersion)
                    }
                    // Reset SSE reconnect backoff BEFORE the version-change
                    // callback, which clears isUpdateInProgress synchronously.
                    if isUpdateInProgress {
                        sseReconnectDelay = 1.0
                    }
                    onDaemonVersionChanged?(newVersion)
                } else if let newVersion = decoded.version {
                    daemonVersion = newVersion
                }
            }
            log.info("Health check passed for \(self.baseURL, privacy: .public)")
            // When the daemon comes back during a planned update, reset the
            // SSE reconnect backoff so the event stream reconnects quickly
            // instead of waiting up to 30s of exponential backoff.
            if isUpdateInProgress {
                sseReconnectDelay = 1.0
            }
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
                    let interval = (self?.isUpdateInProgress == true) ? 2.0 : (self?.healthCheckInterval ?? 15.0)
                    try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
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
        guard sseTask == nil else {
            log.info("startSSE: already running, skipping")
            return
        }
        log.info("startSSE: starting SSE stream for \(self.baseURL, privacy: .public)")
        startSSEStream()
    }

    /// Replace the bearer token used for HTTP requests and SSE authentication.
    /// If SSE is currently disconnected (e.g. due to prior 403 errors), restarts
    /// the stream so it can authenticate with the new token.
    func updateBearerToken(_ newToken: String) {
        bearerToken = newToken
        // If SSE is not connected, restart it with the new token
        if !isSSEConnected && sseTask != nil {
            log.info("Bearer token updated — restarting SSE stream")
            sseReconnectTask?.cancel()
            sseReconnectTask = nil
            sseTask?.cancel()
            sseTask = nil
            sseReconnectDelay = 1.0
            startSSEStream()
        } else if !isSSEConnected && sseTask == nil && shouldReconnect {
            log.info("Bearer token updated — starting SSE stream")
            startSSE()
        }
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

        guard let url = buildURL(for: .eventsAll) else {
            log.error("Invalid SSE URL for unfiltered events")
            return
        }

        log.info("SSE connecting to \(url.absoluteString, privacy: .public)")

        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = .infinity
        applyAuth(&request)

        sseTask = Task { @MainActor [weak self] in
            guard let self else {
                log.warning("SSE task: self was deallocated before stream started")
                return
            }

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
                    if statusCode == 403 {
                        // 403 during assistant switch: the bearer token may lack
                        // chat.read scope needed for SSE. The actor token is still
                        // bootstrapping. Use a short retry delay so SSE reconnects
                        // quickly once the actor token is available.
                        self.sseReconnectDelay = 1.0
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

    /// Extract the value of a JSON string field using lightweight string search.
    /// Handles both `"key":"value"` and `"key": "value"` (with optional space after colon).
    private func extractJsonStringValue(from jsonString: String, key: String) -> String? {
        for pattern in ["\"\(key)\":\"", "\"\(key)\": \""] {
            if let range = jsonString.range(of: pattern) {
                let valueStart = range.upperBound
                if let valueEnd = jsonString[valueStart...].firstIndex(of: "\"") {
                    return String(jsonString[valueStart..<valueEnd])
                }
            }
        }
        return nil
    }

    private func parseSSEData(_ data: String) {
        let byteCount = data.utf8.count
        let start = CFAbsoluteTimeGetCurrent()
        defer {
            let elapsed = CFAbsoluteTimeGetCurrent() - start
            if elapsed > 0.05 || byteCount > 100_000 {
                log.warning("Slow SSE event: \(String(format: "%.1f", elapsed * 1000))ms, \(byteCount) bytes")
            }
            // Track rolling main-thread time spent parsing SSE events.
            // Flags when >500ms of a 1-second window is consumed by SSE parsing.
            sseParseTimeAccumulator += elapsed
            sseParseCountInWindow += 1
            let now = CFAbsoluteTimeGetCurrent()
            if now - sseWindowStart > 1.0 {
                if sseParseTimeAccumulator > 0.5 {
                    let totalMs = String(format: "%.0f", sseParseTimeAccumulator * 1000)
                    let count = sseParseCountInWindow
                    log.warning("SSE main-thread saturation: \(totalMs)ms in \(count) events over 1s")
                }
                sseParseTimeAccumulator = 0
                sseParseCountInWindow = 0
                sseWindowStart = now
            }
        }
        var jsonString = data
        // Remap server conversation IDs to client-local conversation IDs via O(1) dictionary lookup
        if let conversationId = extractJsonStringValue(from: jsonString, key: "conversationId"),
           let localId = serverToLocalConversationMap[conversationId] {
            jsonString = jsonString.replacingOccurrences(
                of: "\"conversationId\":\"\(conversationId)\"",
                with: "\"conversationId\":\"\(localId)\""
            )
            jsonString = jsonString.replacingOccurrences(
                of: "\"conversationId\": \"\(conversationId)\"",
                with: "\"conversationId\": \"\(localId)\""
            )
        }
        if let parentConversationId = extractJsonStringValue(from: jsonString, key: "parentConversationId"),
           let localId = serverToLocalConversationMap[parentConversationId] {
            jsonString = jsonString.replacingOccurrences(
                of: "\"parentConversationId\":\"\(parentConversationId)\"",
                with: "\"parentConversationId\":\"\(localId)\""
            )
            jsonString = jsonString.replacingOccurrences(
                of: "\"parentConversationId\": \"\(parentConversationId)\"",
                with: "\"parentConversationId\": \"\(localId)\""
            )
        }

        guard let jsonData = jsonString.data(using: .utf8) else { return }

        do {
            let event = try decoder.decode(AssistantEvent.self, from: jsonData)
            if shouldIgnoreHostToolRequest(event.message) { return }
            handleServerMessage(event.message)
        } catch {
            // Try decoding as a bare ServerMessage (some endpoints may send unwrapped)
            do {
                let message = try decoder.decode(ServerMessage.self, from: jsonData)
                if shouldIgnoreHostToolRequest(message) { return }
                handleServerMessage(message)
            } catch {
                let byteCount = jsonData.count
                log.error("Failed to decode SSE event: \(error.localizedDescription), bytes: \(byteCount)")
            }
        }
    }

    /// Returns `true` if the message is a host tool request whose conversationId
    /// does not belong to this client, meaning it should be silently dropped.
    private func shouldIgnoreHostToolRequest(_ message: ServerMessage) -> Bool {
        switch message {
        case .hostBashRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_bash_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        case .hostFileRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_file_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        case .hostCuRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_cu_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        default:
            return false
        }
    }

    /// Clean up transport-level state after the observer has resolved a synthetic
    /// conversation ID to the real server ID. Removes the now-stale SSE remapping
    /// entry (events should flow through with the server ID that matches the VM),
    /// replaces the synthetic ID in locallyOwnedConversationIds, and migrates
    /// privateConversationIds so that the conversationType flag persists.
    func cleanupAfterConversationIdResolution(localId: String, serverId: String) {
        serverToLocalConversationMap.removeValue(forKey: serverId)
        locallyOwnedConversationIds.remove(localId)
        if privateConversationIds.remove(localId) != nil {
            privateConversationIds.insert(serverId)
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

    /// Translate a message to the appropriate HTTP API call.
    /// Domain dispatchers are tried in registration order; the first match wins.
    /// If no dispatcher handles the message, it falls through to a default log.
    func send<T: Encodable>(_ message: T) throws {
        // Try registered domain dispatchers first
        for dispatcher in domainDispatchers {
            if dispatcher(message) {
                return
            }
        }

        // No dispatcher handled the message
        log.debug("HTTPTransport: unhandled send message type \(String(describing: type(of: message)))")
    }

    // MARK: - Message Sending (via MessageClient)

    func sendMessage(content: String?, conversationId: String, attachments: [UserMessageAttachment]? = nil, conversationType: String? = nil, automated: Bool? = nil) async {
        locallyOwnedConversationIds.insert(conversationId)

        let messageClient = MessageClient()
        let attachmentCount = attachments?.count ?? 0
        log.info("[send-pipeline] sendMessage start — attachmentCount=\(attachmentCount)")

        // Upload attachments
        var attachmentIds: [String] = []
        if let attachments, !attachments.isEmpty {
            for attachment in attachments {
                let result = await messageClient.uploadAttachment(
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    data: attachment.data,
                    filePath: attachment.filePath
                )
                switch result {
                case .success(let id):
                    attachmentIds.append(id)
                case .terminalAuthFailure:
                    return
                case .transientFailure:
                    log.error("Failed to upload attachment: \(attachment.filename)")
                    let failedCount = attachments.count - attachmentIds.count
                    onMessage?(.conversationError(ConversationErrorMessage(
                        conversationId: conversationId,
                        code: .providerApi,
                        userMessage: "Failed to upload \(failedCount) attachment\(failedCount == 1 ? "" : "s"). Please try again.",
                        retryable: true,
                        failedMessageContent: content
                    )))
                    return
                }
            }
        }

        // Send the message
        let resolvedConversationType = conversationType ?? (privateConversationIds.contains(conversationId) ? "private" : nil)
        let sendResult = await messageClient.sendMessage(
            content: content,
            conversationKey: conversationId,
            attachmentIds: attachmentIds,
            conversationType: resolvedConversationType,
            automated: automated
        )

        switch sendResult {
        case .success(let serverConvId):
            // Learn the server's conversationId for this conversation's conversationKey.
            if let serverConvId, serverConvId != conversationId {
                self.serverToLocalConversationMap[serverConvId] = conversationId
                self.locallyOwnedConversationIds.insert(serverConvId)
                self.onConversationIdResolved?(conversationId, serverConvId)

                while self.serverToLocalConversationMap.count > self.serverToLocalConversationMapCap {
                    if let key = self.serverToLocalConversationMap.keys.first {
                        self.serverToLocalConversationMap.removeValue(forKey: key)
                    }
                }

                log.info("Mapped conversation \(conversationId, privacy: .public) → server ID \(serverConvId, privacy: .public)")
            }
        case .authRequired:
            onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: conversationId,
                code: .providerApi,
                userMessage: "Failed to send message — authentication error. Please try again.",
                retryable: true,
                failedMessageContent: content
            )))
        case .secretBlocked(let message):
            onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: conversationId,
                code: .providerApi,
                userMessage: message,
                retryable: false
            )))
        case .error(_, let message, _):
            onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: conversationId,
                code: .providerApi,
                userMessage: message,
                retryable: true,
                failedMessageContent: content
            )))
        }
    }


    /// JSONSerialization cannot encode AnyCodable wrappers directly, so unwrap
    /// them before inserting arbitrary payloads into request bodies.
    func jsonCompatibleDictionary(_ values: [String: AnyCodable]) -> [String: Any] {
        var jsonCompatible: [String: Any] = [:]
        for (key, value) in values {
            jsonCompatible[key] = value.value
        }
        return jsonCompatible
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
            onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: "",
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
    func handleAuthenticationFailureAsync(responseData: Data? = nil) async -> AuthRefreshResult {
        // Managed mode: no bearer refresh — emit session-expired, disconnect to
        // stop loops, and return terminal so callers don't retry.
        if isManagedMode {
            log.warning("401 in managed mode — session token may be expired")
            onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: "",
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
        let terminalCodes: Set<String> = ["credentials_revoked"]
        if let data = responseData,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let code = (json["error"] as? [String: Any])?["code"] as? String
            if let code, terminalCodes.contains(code) {
                // Explicitly terminal — no refresh possible
                log.error("Terminal 401 code: \(code) — re-auth required")
                self.onMessage?(.conversationError(ConversationErrorMessage(
                    conversationId: "",
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
            self.onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: "",
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
    /// Compute a stable device ID via the shared HostIdComputer.
    private static func computeMacOSDeviceId() -> String {
        return HostIdComputer.computeHostId()
    }
    #endif

    // MARK: - Helpers

    func applyAuth(_ request: inout URLRequest) {
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
        case requestFailed(statusCode: Int, message: String?)
        case authenticationFailed(message: String)

        var errorDescription: String? {
            switch self {
            case .healthCheckFailed:
                return "Remote assistant health check failed"
            case .invalidURL:
                return "Invalid remote assistant URL"
            case .requestFailed(let statusCode, let message):
                return message ?? "HTTP request failed (\(statusCode))"
            case .authenticationFailed(let message):
                return message
            }
        }
    }
}
