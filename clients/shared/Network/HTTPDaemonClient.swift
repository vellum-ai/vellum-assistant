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

/// Internal helper that handles health checks and host tool execution for
/// a remote Vellum assistant runtime. Used by `DaemonStatus` for connection
/// monitoring.
///
/// Responsibilities:
/// - Periodic health check via `GET /healthz` to drive connection status
/// - Host bash and file request execution (via extensions)
///
/// SSE and message sending are handled by `EventStreamClient`.
///
/// - Important: New HTTP API calls should **not** be added here. Use `GatewayHTTPClient`
///   instead, injected via a focused protocol (e.g. `ConversationClientProtocol`).
@MainActor
public final class HTTPTransport {

    public let baseURL: String
    public private(set) var bearerToken: String?
    let transportMetadata: TransportMetadata

    /// Periodic health check task.
    private var healthCheckTask: Task<Void, Never>?

    /// Health check interval in seconds.
    private let healthCheckInterval: TimeInterval = 15.0

    /// Whether the assistant is reachable (health check passes).
    private(set) var isConnected: Bool = false

    /// The daemon's self-reported version from the most recent health check.
    private(set) var daemonVersion: String?

    /// Whether we should attempt to reconnect on disconnect.
    private var shouldReconnect = true

    /// Set by the owning DaemonStatus when a planned service group update
    /// is in progress. Accelerates health check polling for faster reconnection.
    var isUpdateInProgress: Bool = false

    /// Update the in-progress flag and restart the health-check loop when
    /// transitioning to `true`.
    func setUpdateInProgress(_ value: Bool) {
        let wasInProgress = isUpdateInProgress
        isUpdateInProgress = value
        if value && !wasInProgress && healthCheckTask != nil {
            startHealthCheckLoop()
        }
    }

    /// Result of an async authentication refresh attempt.
    enum AuthRefreshResult {
        case success
        case transientFailure
        case terminalFailure
    }

    /// In-flight refresh task for coalescing concurrent 401 handlers.
    private var refreshTask: Task<AuthRefreshResult, Never>?

    /// Callback for connection state changes (health check driven).
    var onConnectionStateChanged: ((Bool) -> Void)?

    /// Called when the daemon version changes during a health check.
    var onDaemonVersionChanged: ((String) -> Void)?

    /// Called when a health check 401 needs to emit an auth error to the UI.
    var onAuthError: ((ServerMessage) -> Void)?

    // MARK: - Init

    init(baseURL: String, bearerToken: String?, conversationKey: String, transportMetadata: TransportMetadata = .defaultLocal) {
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.bearerToken = bearerToken
        self.transportMetadata = transportMetadata
    }

    // MARK: - Endpoint Builder

    enum Endpoint {
        case healthz
    }

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

    private func buildRuntimeFlatPath(for endpoint: Endpoint) -> (path: String, query: String?) {
        switch endpoint {
        case .healthz:
            return ("/healthz", nil)
        }
    }

    private func buildPlatformProxyPath(for endpoint: Endpoint, assistantId: String) -> (path: String, query: String?) {
        let prefix = "/v1/assistants/\(assistantId)"

        switch endpoint {
        case .healthz:
            return ("\(prefix)/healthz/", nil)
        }
    }

    // MARK: - Connect (health check driven)

    /// Verify reachability via health check and start periodic health monitoring.
    /// SSE is managed separately by `EventStreamClient`.
    func connect() async throws {
        shouldReconnect = true

        // Run initial health check
        try await performHealthCheck()

        // Start periodic health checks
        startHealthCheckLoop()
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
                    onDaemonVersionChanged?(newVersion)
                } else if let newVersion = decoded.version {
                    daemonVersion = newVersion
                }
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

    /// Replace the bearer token used for HTTP requests.
    func updateBearerToken(_ newToken: String) {
        bearerToken = newToken
    }

    // MARK: - Disconnect

    func disconnect() {
        shouldReconnect = false
        healthCheckTask?.cancel()
        healthCheckTask = nil
        setConnected(false)
    }

    // MARK: - 401 Recovery

    /// Fire-and-forget token refresh for health check 401 errors.
    private func handleAuthenticationFailure(responseData: Data? = nil) {
        if isManagedMode {
            log.warning("401 in managed mode — session token may be expired")
            onAuthError?(.conversationError(ConversationErrorMessage(
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

    func handleAuthenticationFailureAsync(responseData: Data? = nil) async -> AuthRefreshResult {
        if isManagedMode {
            log.warning("401 in managed mode — session token may be expired")
            onAuthError?(.conversationError(ConversationErrorMessage(
                conversationId: "",
                code: .authenticationRequired,
                userMessage: "Session expired. Please sign in again.",
                retryable: false
            )))
            disconnect()
            return .terminalFailure
        }

        let terminalCodes: Set<String> = ["credentials_revoked"]
        if let data = responseData,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let code = (json["error"] as? [String: Any])?["code"] as? String
            if let code, terminalCodes.contains(code) {
                log.error("Terminal 401 code: \(code) — re-auth required")
                self.onAuthError?(.conversationError(ConversationErrorMessage(
                    conversationId: "",
                    code: .authenticationRequired,
                    userMessage: "Session expired. Please re-pair your device.",
                    retryable: false
                )))
                return .terminalFailure
            }
        }

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

    private func performRefresh() async -> AuthRefreshResult {
        #if os(macOS)
        let refreshPlatform = "macos"
        let refreshDeviceId = Self.computeMacOSDeviceId()
        #else
        let refreshPlatform = "ios"
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
            log.info("Token refresh succeeded")
            return .success

        case .terminalError(let reason):
            log.error("Token refresh failed terminally: \(reason) — re-pair required")
            self.onAuthError?(.conversationError(ConversationErrorMessage(
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

    #if os(macOS)
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
