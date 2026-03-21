import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "GatewayConnectionManager")

/// Minimal decode of the healthz response to extract the version field.
private struct HealthzVersionResponse: Decodable {
    let version: String?
}

/// Manages the gateway connection lifecycle: connect, disconnect,
/// reconfigure, auto-wake, health checks, and bearer token updates.
///
/// Coordinates with `EventStreamClient` (SSE start/stop). Does NOT own
/// published state — `DaemonStatus` observes this manager's callbacks
/// to update its `@Published` properties.
@MainActor
public final class GatewayConnectionManager {

    // MARK: - Connection State

    /// Current connection configuration.
    public private(set) var config: DaemonConfig

    /// Whether a connection attempt is in flight.
    public var isConnecting: Bool = false

    /// Whether the transport has authenticated successfully.
    var isAuthenticated = false

    /// Base URL of the connected gateway/runtime.
    private var baseURL: String?

    /// Bearer token for authentication.
    private var bearerToken: String?

    /// Transport metadata (route mode, auth mode, platform assistant ID).
    private var transportMetadata: TransportMetadata?

    // MARK: - Health Check

    /// Periodic health check task.
    private var healthCheckTask: Task<Void, Never>?

    /// Health check interval in seconds.
    private let healthCheckInterval: TimeInterval = 15.0

    /// Whether the gateway is reachable (health check passes).
    private(set) var isConnected: Bool = false

    /// The daemon's self-reported version from the most recent health check.
    private(set) var daemonVersion: String?

    /// Whether we should attempt to reconnect on disconnect.
    private var shouldReconnect = true

    /// Whether a planned service group update is in progress.
    /// Accelerates health check polling for faster reconnection.
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

    // MARK: - 401 Recovery

    /// Result of an async authentication refresh attempt.
    enum AuthRefreshResult {
        case success
        case transientFailure
        case terminalFailure
    }

    /// In-flight refresh task for coalescing concurrent 401 handlers.
    private var refreshTask: Task<AuthRefreshResult, Never>?

    // MARK: - Auto-Wake

    /// Optional closure invoked when a connection attempt fails because the daemon process
    /// is not alive. The macOS app sets this to call `vellumCli.wake(name:)`.
    public var wakeHandler: (@MainActor @Sendable () async throws -> Void)?

    /// Platform identifier for automatic 401 re-bootstrap (e.g. "macos", "ios").
    public var recoveryPlatform: String?

    /// Device identifier for automatic 401 re-bootstrap.
    public var recoveryDeviceId: String?

    #if os(macOS)
    var lastAutoWakeAttempt: Date?
    var autoWakeTask: Task<Void, Never>?
    #endif

    // MARK: - Callbacks

    /// Called when health-check-driven connection state changes.
    var onConnectionStateChanged: ((_ connected: Bool) -> Void)?

    /// Called when the daemon version changes during a health check.
    var onDaemonVersionChanged: ((_ newVersion: String) -> Void)?

    /// Called when a health check 401 needs to emit an auth error to the UI.
    var onAuthError: ((_ message: ServerMessage) -> Void)?

    // MARK: - Dependencies

    /// Event stream client — starts/stops SSE and registers conversation IDs.
    private let eventStreamClient: EventStreamClient

    // MARK: - Init

    init(config: DaemonConfig, eventStreamClient: EventStreamClient) {
        self.config = config
        self.eventStreamClient = eventStreamClient
    }

    // MARK: - Connect

    public func connect() async throws {
        try await connectImpl(cancelAutoWake: true)
    }

    func connectImpl(cancelAutoWake: Bool) async throws {
        disconnectInternal(cancelAutoWake: cancelAutoWake)

        isConnecting = true

        guard case .http(let baseURL, let bearerToken, let conversationKey) = config.transport else {
            isConnecting = false
            log.info("connect: non-HTTP transport, skipping")
            return
        }

        log.info("connect: establishing connection to \(baseURL, privacy: .public)")

        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.bearerToken = bearerToken
        self.transportMetadata = config.transportMetadata

        // Register the conversation key for host tool filtering
        if !conversationKey.isEmpty {
            eventStreamClient.registerConversationId(conversationKey)
        }

        shouldReconnect = true

        do {
            // Run initial health check
            try await performHealthCheck()

            // Start periodic health checks
            startHealthCheckLoop()

            isAuthenticated = true
            isConnecting = false
            log.info("connect: connected successfully to \(baseURL, privacy: .public)")

            // Auto-start SSE now that health check passed
            eventStreamClient.startSSE()
        } catch {
            #if os(macOS)
            guard !Task.isCancelled else {
                isConnecting = false
                self.baseURL = nil
                log.info("connect: task cancelled — skipping auto-wake")
                throw error
            }

            if let wakeHandler, config.transportMetadata.routeMode == .runtimeFlat {
                let reachable = await HealthCheckClient.isReachable(instanceDir: config.instanceDir)
                if !reachable {
                    log.info("connect: gateway unreachable — attempting auto-wake before retry")
                    do {
                        try await wakeHandler()
                        log.info("connect: auto-wake succeeded, retrying connection to \(baseURL, privacy: .public)")
                        try await performHealthCheck()
                        startHealthCheckLoop()
                        isAuthenticated = true
                        isConnecting = false
                        log.info("connect: retry after auto-wake succeeded for \(baseURL, privacy: .public)")
                        eventStreamClient.startSSE()
                        return
                    } catch {
                        log.error("connect: auto-wake or retry failed for \(baseURL, privacy: .public): \(error)")
                    }
                }
            }
            #endif

            isConnecting = false
            self.baseURL = nil
            log.error("connect: connection failed for \(baseURL, privacy: .public): \(error)")
            throw error
        }
    }

    // MARK: - Disconnect

    public func disconnect() {
        disconnectInternal()
    }

    func disconnectInternal(cancelAutoWake: Bool = true) {
        isAuthenticated = false

        #if os(macOS)
        if cancelAutoWake {
            autoWakeTask?.cancel()
            autoWakeTask = nil
        }
        #endif

        shouldReconnect = false
        healthCheckTask?.cancel()
        healthCheckTask = nil
        setConnected(false)

        // Stop SSE but preserve subscriber streams
        eventStreamClient.stopSSE()
    }

    // MARK: - Reconfigure

    public func reconfigure(config newConfig: DaemonConfig) {
        #if os(macOS)
        autoWakeTask?.cancel()
        autoWakeTask = nil
        #endif
        disconnect()
        self.config = newConfig
        isAuthenticated = false
        baseURL = nil
        bearerToken = nil
        transportMetadata = nil
        #if os(macOS)
        lastAutoWakeAttempt = nil
        #endif
    }

    // MARK: - Token Update

    public func updateBearerToken(_ token: String) {
        bearerToken = token
    }

    // MARK: - Health Check

    /// Build the health check URL based on the current route mode.
    private func buildHealthCheckURL() -> URL? {
        guard let baseURL else { return nil }

        let path: String
        switch transportMetadata?.routeMode {
        case .platformAssistantProxy:
            guard let assistantId = transportMetadata?.platformAssistantId else {
                log.error("platformAssistantProxy route mode requires platformAssistantId")
                return nil
            }
            path = "/v1/assistants/\(assistantId)/healthz/"
        default:
            path = "/healthz"
        }

        return URL(string: "\(baseURL)\(path)")
    }

    /// Run a single health check against the gateway.
    private func performHealthCheck() async throws {
        guard let healthURL = buildHealthCheckURL() else {
            throw ConnectionError.invalidURL
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
                        shouldReconnect = false
                    }
                }
                throw ConnectionError.healthCheckFailed
            }
            // Extract daemon version from response body
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
            log.info("Health check passed for \(self.baseURL ?? "?", privacy: .public)")
            setConnected(true)
        } catch let error as ConnectionError {
            setConnected(false)
            throw error
        } catch {
            log.error("Health check failed: \(error.localizedDescription)")
            setConnected(false)
            throw ConnectionError.healthCheckFailed
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
                    log.warning("Periodic health check failed: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: - 401 Recovery

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
        guard let baseURL else { return .transientFailure }

        #if os(macOS)
        let refreshPlatform = "macos"
        let refreshDeviceId = HostIdComputer.computeHostId()
        #else
        let refreshPlatform = "ios"
        let refreshDeviceId = APIKeyManager.shared.getAPIKey(provider: "pairing-device-id") ?? ""
        #endif

        let result = await ActorCredentialRefresher.refresh(
            baseURL: baseURL,
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

    // MARK: - Auto-Wake

    #if os(macOS)
    private static let autoWakeCooldown: TimeInterval = 60.0

    private func autoWakeIfDaemonDied() {
        guard let wakeHandler,
              config.transportMetadata.routeMode == .runtimeFlat
        else { return }

        if let last = lastAutoWakeAttempt,
           Date().timeIntervalSince(last) < Self.autoWakeCooldown {
            log.warning("auto-wake: skipping — last attempt was within \(Self.autoWakeCooldown)s cooldown")
            return
        }

        lastAutoWakeAttempt = Date()

        autoWakeTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let reachable = await HealthCheckClient.isReachable(instanceDir: self.config.instanceDir)
            guard !reachable else {
                self.lastAutoWakeAttempt = nil
                return
            }

            log.info("auto-wake: gateway unreachable — attempting wake")
            do {
                try await wakeHandler()
                guard !Task.isCancelled else {
                    log.info("auto-wake: cancelled after wake — skipping reconnect")
                    return
                }
                log.info("auto-wake: wake succeeded, reconnecting")
                try await self.connectImpl(cancelAutoWake: false)
                guard !Task.isCancelled else {
                    log.info("auto-wake: cancelled after connect — abandoning")
                    return
                }
                log.info("auto-wake: reconnect succeeded")
            } catch {
                log.error("auto-wake: failed: \(error)")
            }
            self.autoWakeTask = nil
        }
    }
    #endif

    // MARK: - Helpers

    private func applyAuth(_ request: inout URLRequest) {
        guard let transportMetadata else { return }
        switch transportMetadata.authMode {
        case .bearerToken:
            if let accessToken = ActorTokenManager.getToken(), !accessToken.isEmpty {
                request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            } else if let token = bearerToken {
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

    private var isManagedMode: Bool {
        transportMetadata?.routeMode == .platformAssistantProxy
    }

    private func setConnected(_ connected: Bool) {
        guard isConnected != connected else { return }
        isConnected = connected
        isConnecting = false
        onConnectionStateChanged?(connected)
        #if os(macOS)
        if !connected {
            autoWakeIfDaemonDied()
        }
        #endif
    }

    // MARK: - Errors

    public enum ConnectionError: Error, LocalizedError {
        case healthCheckFailed
        case invalidURL

        public var errorDescription: String? {
            switch self {
            case .healthCheckFailed:
                return "Gateway health check failed"
            case .invalidURL:
                return "Invalid gateway URL"
            }
        }
    }

    deinit {
        #if os(macOS)
        autoWakeTask?.cancel()
        #endif
    }
}
