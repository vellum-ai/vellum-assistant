import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "GatewayConnectionManager")

/// Minimal decode of the healthz response to extract the version field.
private struct HealthzVersionResponse: Decodable {
    let version: String?
}

/// Manages the gateway connection lifecycle and publishes observable state.
///
/// Owns `EventStreamClient` (SSE + subscribe + send). Handles health checks,
/// auto-wake, and SSE message pre-processing to update `@Published` properties.
/// SwiftUI views observe this for connection status and daemon metadata.
@MainActor
public final class GatewayConnectionManager: ObservableObject {

    // MARK: - Published State

    @Published public var isConnected: Bool = false
    @Published public var isConnecting: Bool = false
    @Published public internal(set) var assistantVersion: String?
    @Published public internal(set) var versionMismatch: Bool = false
    @Published public internal(set) var isUpdateInProgress: Bool = false
    @Published public internal(set) var updateTargetVersion: String?
    var updateExpiresAt: Date?
    @Published public internal(set) var keyFingerprint: String?
    @Published public var latestMemoryStatus: MemoryStatusMessage?
    @Published public var isTrustRulesSheetOpen: Bool = false
    @Published public var currentModel: String?
    @Published public var latestModelInfo: ModelInfoMessage?

    /// Whether the transport has authenticated successfully.
    var isAuthenticated = false

    // MARK: - Connection State (internal)

    /// Whether auto-wake should be attempted on disconnect.
    /// Only applies to local assistants (not remote, Docker, or managed).
    private var isLocal: Bool {
        #if os(macOS)
        guard let id = UserDefaults.standard.string(forKey: "connectedAssistantId"),
              let assistant = LockfileAssistant.loadByName(id) else {
            return false
        }
        return !assistant.isRemote && !assistant.isManaged
        #else
        return false
        #endif
    }

    // MARK: - Health Check

    private var healthCheckTask: Task<Void, Never>?
    private let healthCheckInterval: TimeInterval = 15.0
    private var shouldReconnect = true
    private var refreshTask: Task<Void, Never>?
    private var conversationKey: String?

    func setUpdateInProgress(_ value: Bool) {
        let wasInProgress = isUpdateInProgress
        isUpdateInProgress = value
        if value && !wasInProgress && healthCheckTask != nil {
            startHealthCheckLoop()
        }
    }

    // MARK: - Auto-Wake

    public var wakeHandler: (@MainActor @Sendable () async throws -> Void)?
    public var recoveryPlatform: String?
    public var recoveryDeviceId: String?

    #if os(macOS)
    var lastAutoWakeAttempt: Date?
    var autoWakeTask: Task<Void, Never>?
    #endif

    // MARK: - Event Stream

    /// The event stream client for SSE and message broadcast.
    public let eventStreamClient = EventStreamClient()

    // MARK: - Init

    public init() {
        // Wire SSE pre-processor to update @Published state before broadcast
        eventStreamClient.messagePreProcessor = { [weak self] message in
            self?.handleServerMessage(message)
        }

        // Wire conversation ID resolution to subscribers.
        eventStreamClient.onConversationIdResolved = { [weak eventStreamClient] localId, serverId in
            eventStreamClient?.broadcastMessage(.conversationIdResolved(localId: localId, serverId: serverId))
        }

        // Persist refreshed bearer tokens so the client survives app restarts.
        eventStreamClient.onTokenRefreshed = { newToken in
            #if os(iOS)
            let _ = APIKeyManager.shared.setAPIKey(newToken, provider: "runtime-bearer-token")
            #elseif os(macOS)
            // macOS re-reads from disk on each request; no persistence needed here.
            #endif
        }
    }

    // MARK: - Connect

    public func connect() async throws {
        try await connectImpl(cancelAutoWake: true)
    }

    func connectImpl(cancelAutoWake: Bool) async throws {
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

            if let wakeHandler, isLocal {
                let reachable = await HealthCheckClient.isReachable()
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
    public func reconfigure(conversationKey: String? = nil) {
        self.conversationKey = conversationKey
        #if os(macOS)
        autoWakeTask?.cancel()
        autoWakeTask = nil
        #endif
        disconnect()
        isAuthenticated = false
        refreshTask?.cancel()
        refreshTask = nil
        #if os(macOS)
        lastAutoWakeAttempt = nil
        #endif

        // Reset published state
        isConnected = false
        assistantVersion = nil
        versionMismatch = false
        isUpdateInProgress = false
        updateTargetVersion = nil
        updateExpiresAt = nil
        keyFingerprint = nil
        latestMemoryStatus = nil
        currentModel = nil
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
                if let newVersion = decoded.version, newVersion != assistantVersion {
                    assistantVersion = newVersion
                    if let id = UserDefaults.standard.string(forKey: "connectedAssistantId"), !id.isEmpty {
                        LockfilePaths.updateServiceGroupVersion(assistantId: id, version: newVersion)
                    }
                    handleDaemonVersionChanged(newVersion)
                } else if let newVersion = decoded.version {
                    assistantVersion = newVersion
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

    // MARK: - Version Change Handling

    private func handleDaemonVersionChanged(_ newVersion: String) {
        checkVersionCompatibility(assistantVersion: newVersion)
        if isUpdateInProgress {
            if newVersion == updateTargetVersion {
                log.info("Health check confirmed update completed — now running \(newVersion, privacy: .public)")
            } else {
                log.warning("Health check detected version \(newVersion, privacy: .public) after update — expected \(self.updateTargetVersion ?? "?", privacy: .public), may have rolled back")
            }
            isUpdateInProgress = false
            updateTargetVersion = nil
            updateExpiresAt = nil
            eventStreamClient.resetSSEReconnectDelay()
        }
    }

    // MARK: - Version Compatibility

    private func parseMajorMinor(_ version: String) -> (Int, Int)? {
        let cleaned = version.hasPrefix("v") ? String(version.dropFirst()) : version
        let components = cleaned.split(separator: ".").compactMap { Int($0) }
        guard components.count >= 2 else { return nil }
        return (components[0], components[1])
    }

    func checkVersionCompatibility(assistantVersion: String) {
        guard let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String else {
            return
        }
        guard let (daemonMajor, daemonMinor) = parseMajorMinor(assistantVersion),
              let (clientMajor, clientMinor) = parseMajorMinor(clientVersion) else {
            return
        }
        let mismatch = daemonMajor != clientMajor || daemonMinor != clientMinor
        if mismatch != versionMismatch {
            versionMismatch = mismatch
        }
        if mismatch {
            log.warning("Version mismatch: client \(clientVersion, privacy: .public) vs daemon \(assistantVersion, privacy: .public)")
        }
    }

    // MARK: - SSE Message Pre-Processing

    private func handleServerMessage(_ message: ServerMessage) {
        if case .assistantStatus(let status) = message {
            if let version = status.version {
                assistantVersion = version
                checkVersionCompatibility(assistantVersion: version)
                if self.isUpdateInProgress {
                    if version == self.updateTargetVersion {
                        log.info("Planned update completed — now running \(version, privacy: .public)")
                    } else {
                        log.warning("Planned update may have rolled back — expected \(self.updateTargetVersion ?? "?", privacy: .public) but running \(version, privacy: .public)")
                    }
                    self.isUpdateInProgress = false
                    self.updateTargetVersion = nil
                    self.updateExpiresAt = nil
                    self.eventStreamClient.resetSSEReconnectDelay()
                }
            }
            if let newFingerprint = status.keyFingerprint {
                let oldFingerprint = keyFingerprint
                keyFingerprint = newFingerprint

                if let oldFingerprint, oldFingerprint != newFingerprint {
                    log.info("Daemon key fingerprint changed (\(oldFingerprint, privacy: .public) → \(newFingerprint, privacy: .public)) — invalidating credentials")
                    ActorTokenManager.deleteAllCredentials()
                    NotificationCenter.default.post(name: .daemonInstanceChanged, object: nil)
                }
            }
        }

        switch message {
        case .serviceGroupUpdateStarting(let msg):
            self.isUpdateInProgress = true
            self.updateTargetVersion = msg.targetVersion
            self.updateExpiresAt = Date().addingTimeInterval(msg.expectedDowntimeSeconds * 2)
            log.info("Service group update starting — target: \(msg.targetVersion, privacy: .public), expected downtime: \(msg.expectedDowntimeSeconds)s")
        case .serviceGroupUpdateComplete:
            self.isUpdateInProgress = false
            self.updateTargetVersion = nil
            self.updateExpiresAt = nil
            self.eventStreamClient.resetSSEReconnectDelay()
        case .modelInfo(let msg):
            currentModel = msg.model
            latestModelInfo = msg
        case .memoryStatus(let msg):
            latestMemoryStatus = msg
        case .authResult(let result):
            isAuthenticated = result.success
        default:
            break
        }
    }

    // MARK: - 401 Recovery

    private func handleAuthenticationFailure() {
        let isManaged = (try? GatewayHTTPClient.isConnectionManaged()) ?? false
        if isManaged {
            log.warning("401 in managed mode — session token may be expired")
            eventStreamClient.broadcastMessage(.conversationError(ConversationErrorMessage(
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
                self.eventStreamClient.broadcastMessage(.conversationError(ConversationErrorMessage(
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
        guard let wakeHandler, isLocal else { return }

        if let last = lastAutoWakeAttempt,
           Date().timeIntervalSince(last) < Self.autoWakeCooldown {
            log.warning("auto-wake: skipping — last attempt was within \(Self.autoWakeCooldown)s cooldown")
            return
        }

        lastAutoWakeAttempt = Date()

        autoWakeTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let reachable = await HealthCheckClient.isReachable()
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
        if connected {
            NotificationCenter.default.post(name: .daemonDidReconnect, object: self)
        }
        #if os(macOS)
        if !connected {
            autoWakeIfDaemonDied()
        }
        #endif
    }

    // MARK: - Errors

    /// Legacy authentication errors — retained for compatibility with
    /// code that catches `AuthError` (e.g. bootstrap retry coordinator).
    public enum AuthError: Error, LocalizedError {
        case missingToken
        case timeout
        case rejected(String?)

        public var errorDescription: String? {
            switch self {
            case .missingToken:
                return "Missing daemon session token"
            case .timeout:
                return "Daemon authentication timed out"
            case .rejected(let message):
                return message ?? "Daemon authentication rejected"
            }
        }
    }

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

