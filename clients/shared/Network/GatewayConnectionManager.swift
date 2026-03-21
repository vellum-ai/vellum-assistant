import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "GatewayConnectionManager")

/// Minimal decode of the healthz response to extract the version field.
private struct HealthzVersionResponse: Decodable {
    let version: String?
}

/// Manages the gateway connection lifecycle: connect, disconnect,
/// reconfigure, auto-wake, and health checks.
///
/// Uses `GatewayHTTPClient` for authenticated health checks (no manual URL
/// construction or auth handling). Coordinates with `EventStreamClient`
/// for SSE start/stop.
@MainActor
public final class GatewayConnectionManager {

    // MARK: - Connection State

    /// Whether a connection attempt is in flight.
    public var isConnecting: Bool = false

    /// Whether the transport has authenticated successfully.
    var isAuthenticated = false

    /// Instance directory for HealthCheckClient reachability checks (auto-wake).
    /// Set during `reconfigure()`.
    private var instanceDir: String?

    /// Whether auto-wake should be attempted on disconnect.
    /// Only applies to runtimeFlat mode (local assistants).
    private var isRuntimeFlat: Bool = false

    // MARK: - Health Check

    private var healthCheckTask: Task<Void, Never>?
    private let healthCheckInterval: TimeInterval = 15.0
    private(set) var isConnected: Bool = false
    private(set) var daemonVersion: String?
    private var shouldReconnect = true

    /// Whether a planned service group update is in progress.
    var isUpdateInProgress: Bool = false

    func setUpdateInProgress(_ value: Bool) {
        let wasInProgress = isUpdateInProgress
        isUpdateInProgress = value
        if value && !wasInProgress && healthCheckTask != nil {
            startHealthCheckLoop()
        }
    }

    // MARK: - 401 Recovery

    private var refreshTask: Task<Void, Never>?

    // MARK: - Auto-Wake

    public var wakeHandler: (@MainActor @Sendable () async throws -> Void)?
    public var recoveryPlatform: String?
    public var recoveryDeviceId: String?

    #if os(macOS)
    var lastAutoWakeAttempt: Date?
    var autoWakeTask: Task<Void, Never>?
    #endif

    // MARK: - Callbacks

    var onConnectionStateChanged: ((_ connected: Bool) -> Void)?
    var onDaemonVersionChanged: ((_ newVersion: String) -> Void)?
    var onAuthError: ((_ message: ServerMessage) -> Void)?

    // MARK: - Event Stream

    /// The event stream client for SSE and message broadcast.
    /// Consumers should reference this directly for subscribe/send.
    public let eventStreamClient = EventStreamClient()

    // MARK: - Init

    public init() {}

    // MARK: - Connect

    public func connect() async throws {
        try await connectImpl(cancelAutoWake: true)
    }

    /// Connect using a conversation key for host tool filtering.
    /// Call `reconfigure()` first to set instance directory and route mode.
    func connectImpl(cancelAutoWake: Bool, conversationKey: String? = nil) async throws {
        disconnectInternal(cancelAutoWake: cancelAutoWake)

        isConnecting = true

        if let conversationKey, !conversationKey.isEmpty {
            eventStreamClient.registerConversationId(conversationKey)
        }

        shouldReconnect = true

        do {
            try await performHealthCheck()
            startHealthCheckLoop()

            isAuthenticated = true
            isConnecting = false
            log.info("connect: connected successfully")

            eventStreamClient.startSSE()
        } catch {
            #if os(macOS)
            guard !Task.isCancelled else {
                isConnecting = false
                log.info("connect: task cancelled — skipping auto-wake")
                throw error
            }

            if let wakeHandler, isRuntimeFlat {
                let reachable = await HealthCheckClient.isReachable(instanceDir: instanceDir)
                if !reachable {
                    log.info("connect: gateway unreachable — attempting auto-wake before retry")
                    do {
                        try await wakeHandler()
                        try await performHealthCheck()
                        startHealthCheckLoop()
                        isAuthenticated = true
                        isConnecting = false
                        log.info("connect: retry after auto-wake succeeded")
                        eventStreamClient.startSSE()
                        return
                    } catch {
                        log.error("connect: auto-wake or retry failed: \(error)")
                    }
                }
            }
            #endif

            isConnecting = false
            log.error("connect: connection failed: \(error)")
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

        eventStreamClient.stopSSE()
    }

    // MARK: - Reconfigure

    /// Reconfigure connection parameters for a new assistant.
    /// Callers must call `connect()` after reconfiguring.
    public func reconfigure(instanceDir: String?, isRuntimeFlat: Bool) {
        #if os(macOS)
        autoWakeTask?.cancel()
        autoWakeTask = nil
        #endif
        disconnect()
        self.instanceDir = instanceDir
        self.isRuntimeFlat = isRuntimeFlat
        isAuthenticated = false
        refreshTask?.cancel()
        refreshTask = nil
        #if os(macOS)
        lastAutoWakeAttempt = nil
        #endif
    }

    // MARK: - Health Check (via GatewayHTTPClient)

    private func performHealthCheck() async throws {
        do {
            let isManaged = (try? GatewayHTTPClient.isConnectionManaged()) ?? false
            let healthPath = isManaged ? "assistants/{assistantId}/health" : "health"
            let response = try await GatewayHTTPClient.get(
                path: healthPath,
                timeout: 10
            )

            guard response.isSuccess else {
                if response.statusCode == 401 {
                    handleAuthenticationFailure()
                    let isManaged = (try? GatewayHTTPClient.isConnectionManaged()) ?? false
                    if isManaged {
                        shouldReconnect = false
                    }
                }
                throw ConnectionError.healthCheckFailed
            }

            if let decoded = try? JSONDecoder().decode(HealthzVersionResponse.self, from: response.data) {
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

            log.info("Health check passed")
            setConnected(true)
        } catch let error as GatewayHTTPClient.ClientError {
            log.error("Health check client error: \(error.localizedDescription)")
            setConnected(false)
            throw ConnectionError.healthCheckFailed
        } catch let error as ConnectionError {
            setConnected(false)
            throw error
        } catch {
            log.error("Health check failed: \(error.localizedDescription)")
            setConnected(false)
            throw ConnectionError.healthCheckFailed
        }
    }

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

    private func handleAuthenticationFailure() {
        let isManaged = (try? GatewayHTTPClient.isConnectionManaged()) ?? false
        if isManaged {
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

        guard refreshTask == nil else { return }

        refreshTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.refreshTask = nil }

            #if os(macOS)
            let platform = "macos"
            let deviceId = HostIdComputer.computeHostId()
            #else
            let platform = "ios"
            let deviceId = APIKeyManager.shared.getAPIKey(provider: "pairing-device-id") ?? ""
            #endif

            let result = await ActorCredentialRefresher.refresh(
                platform: platform,
                deviceId: deviceId
            )

            switch result {
            case .success:
                log.info("Token refresh succeeded")
            case .terminalError(let reason):
                log.error("Token refresh failed terminally: \(reason) — re-pair required")
                self.onAuthError?(.conversationError(ConversationErrorMessage(
                    conversationId: "",
                    code: .authenticationRequired,
                    userMessage: "Session expired. Please re-pair your device.",
                    retryable: false
                )))
            case .transientError:
                log.warning("Token refresh encountered transient error — will retry on next 401")
            }
        }
    }

    // MARK: - Auto-Wake

    #if os(macOS)
    private static let autoWakeCooldown: TimeInterval = 60.0

    private func autoWakeIfDaemonDied() {
        guard let wakeHandler, isRuntimeFlat else { return }

        if let last = lastAutoWakeAttempt,
           Date().timeIntervalSince(last) < Self.autoWakeCooldown {
            log.warning("auto-wake: skipping — last attempt was within \(Self.autoWakeCooldown)s cooldown")
            return
        }

        lastAutoWakeAttempt = Date()

        autoWakeTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let reachable = await HealthCheckClient.isReachable(instanceDir: self.instanceDir)
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

        public var errorDescription: String? {
            switch self {
            case .healthCheckFailed:
                return "Gateway health check failed"
            }
        }
    }

    deinit {
        #if os(macOS)
        autoWakeTask?.cancel()
        #endif
    }
}
