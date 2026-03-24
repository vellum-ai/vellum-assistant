import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "GatewayConnectionManager")

/// Minimal decode of the /v1/health response to extract the version field.
private struct HealthVersionResponse: Decodable {
    let version: String?
}

/// The outcome of an assistant update attempt.
public struct UpdateOutcome: Equatable {
    public enum Result: Equatable {
        case succeeded(version: String)
        case rolledBack(from: String, to: String)
        case timedOut
        case failed
    }
    public let result: Result
    public let timestamp: Date
}

/// Manages the gateway connection lifecycle and publishes observable state.
///
/// Owns `EventStreamClient` (SSE + subscribe + send). Handles health checks,
/// auto-wake, and SSE message pre-processing to update `@Published` properties.
/// SwiftUI views observe this for connection status and assistant metadata.
@MainActor
public final class GatewayConnectionManager: ObservableObject {

    // MARK: - Published State

    @Published public var isConnected: Bool = false
    @Published public var isConnecting: Bool = false
    @Published public internal(set) var assistantVersion: String?
    @Published public internal(set) var versionMismatch: Bool = false
    @Published public internal(set) var isUpdateInProgress: Bool = false
    @Published public internal(set) var updateTargetVersion: String?
    @Published public internal(set) var updateStatusMessage: String?
    var updateExpiresAt: Date?
    private var outcomeEmittedForCurrentCycle = false
    @Published public internal(set) var lastUpdateOutcome: UpdateOutcome?
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
        if value && !wasInProgress {
            outcomeEmittedForCurrentCycle = false
            if healthCheckTask != nil {
                startHealthCheckLoop()
            }
        }
    }

    // MARK: - Auto-Wake

    public var wakeHandler: (@MainActor @Sendable () async throws -> Void)?
    /// Handler called after a Sparkle update is detected.
    /// Receives `(name: String, fromVersion: String)` so the macOS app can invoke
    /// CLI `upgradeFinalize` without the shared module depending on `AppDelegate`.
    public var postSparkleUpdateHandler: (@MainActor @Sendable (_ name: String, _ fromVersion: String) async -> Void)?
    public var recoveryPlatform: String?
    public var recoveryDeviceId: String?

    #if os(macOS)
    var lastAutoWakeAttempt: Date?
    var autoWakeTask: Task<Void, Never>?
    var reconnectionTask: Task<Void, Never>?
    var reconnectionGeneration: Int = 0
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
            #if os(macOS)
            reconnectionTask?.cancel()
            reconnectionTask = nil
            #endif

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
                        reconnectionTask?.cancel()
                        reconnectionTask = nil
                        eventStreamClient.startSSE()
                        return
                    } catch {
                        log.error("connect: auto-wake or retry failed: \(error)")
                    }
                }
            }

            startReconnectionLoop()
            #endif

            isConnecting = false
            log.error("connect: connection failed: \(error)")
            throw error
        }
    }

    // MARK: - Disconnect

    public func disconnect() {
        #if os(macOS)
        reconnectionTask?.cancel()
        reconnectionTask = nil
        #endif
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
        reconnectionTask?.cancel()
        reconnectionTask = nil
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
        updateStatusMessage = nil
        updateExpiresAt = nil
        lastUpdateOutcome = nil
        keyFingerprint = nil
        latestMemoryStatus = nil
        currentModel = nil
    }

    /// Clears the last update outcome after the UI has consumed it.
    public func clearLastUpdateOutcome() {
        lastUpdateOutcome = nil
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

            if let decoded = try? JSONDecoder().decode(HealthVersionResponse.self, from: response.data) {
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
            log.error("Health check client error: \(error.localizedDescription, privacy: .public)")
            setConnected(false)
            throw ConnectionError.healthCheckFailed
        } catch let error as ConnectionError {
            setConnected(false)
            throw error
        } catch {
            log.error("Health check failed: \(error.localizedDescription, privacy: .public)")
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
                    log.warning("Periodic health check failed: \(error.localizedDescription, privacy: .public)")
                }

                // Check for update timeout
                if self.isUpdateInProgress, let expiresAt = self.updateExpiresAt, Date() > expiresAt {
                    log.warning("Update timed out — clearing isUpdateInProgress after deadline passed")
                    self.lastUpdateOutcome = UpdateOutcome(result: .timedOut, timestamp: Date())
                    self.isUpdateInProgress = false
                    self.updateTargetVersion = nil
                    self.updateExpiresAt = nil
                    self.updateStatusMessage = nil
                    self.eventStreamClient.resetSSEReconnectDelay()
                }
            }
        }
    }

    // MARK: - Version Comparison

    /// Compare two version strings using parsed semver components so that
    /// prefix differences (e.g. "v1.2.3" vs "1.2.3") are ignored.
    private func versionsMatch(_ a: String, _ b: String) -> Bool {
        guard let parsedA = VersionCompat.parse(a),
              let parsedB = VersionCompat.parse(b) else {
            return a == b
        }
        return parsedA.major == parsedB.major
            && parsedA.minor == parsedB.minor
            && parsedA.patch == parsedB.patch
    }

    // MARK: - Version Change Handling

    private func handleDaemonVersionChanged(_ newVersion: String) {
        checkVersionCompatibility(assistantVersion: newVersion)
        if isUpdateInProgress && !outcomeEmittedForCurrentCycle {
            if let target = updateTargetVersion, versionsMatch(newVersion, target) {
                log.info("Health check confirmed update completed — now running \(newVersion, privacy: .public)")
                lastUpdateOutcome = UpdateOutcome(result: .succeeded(version: newVersion), timestamp: Date())
            } else {
                log.warning("Health check detected version \(newVersion, privacy: .public) after update — expected \(self.updateTargetVersion ?? "?", privacy: .public), may have rolled back")
                lastUpdateOutcome = UpdateOutcome(result: .rolledBack(from: updateTargetVersion ?? "unknown", to: newVersion), timestamp: Date())
            }
            outcomeEmittedForCurrentCycle = true
            isUpdateInProgress = false
            // Preserve updateTargetVersion — only the authoritative
            // .serviceGroupUpdateComplete SSE event or timeout clears it.
            updateExpiresAt = nil
            updateStatusMessage = nil
            eventStreamClient.resetSSEReconnectDelay()
        }
    }

    // MARK: - Version Compatibility

    func checkVersionCompatibility(assistantVersion: String) {
        guard let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String else { return }
        guard let assistant = VersionCompat.parseMajorMinor(assistantVersion),
              let client = VersionCompat.parseMajorMinor(clientVersion) else { return }
        let mismatch = assistant.major != client.major || assistant.minor != client.minor
        if mismatch != versionMismatch {
            versionMismatch = mismatch
        }
        if mismatch {
            log.warning("Version mismatch: client \(clientVersion, privacy: .public) vs assistant \(assistantVersion, privacy: .public)")
        }
    }

    // MARK: - SSE Message Pre-Processing

    private func handleServerMessage(_ message: ServerMessage) {
        if case .assistantStatus(let status) = message {
            if let version = status.version {
                assistantVersion = version
                checkVersionCompatibility(assistantVersion: version)
                if self.isUpdateInProgress && !self.outcomeEmittedForCurrentCycle {
                    if let target = self.updateTargetVersion, self.versionsMatch(version, target) {
                        log.info("Planned update completed — now running \(version, privacy: .public)")
                        self.lastUpdateOutcome = UpdateOutcome(result: .succeeded(version: version), timestamp: Date())
                    } else {
                        log.warning("Planned update may have rolled back — expected \(self.updateTargetVersion ?? "?", privacy: .public) but running \(version, privacy: .public)")
                        self.lastUpdateOutcome = UpdateOutcome(result: .rolledBack(from: self.updateTargetVersion ?? "unknown", to: version), timestamp: Date())
                    }
                    self.outcomeEmittedForCurrentCycle = true
                    self.isUpdateInProgress = false
                    // Preserve updateTargetVersion — only the authoritative
                    // .serviceGroupUpdateComplete SSE event or timeout clears it.
                    self.updateExpiresAt = nil
                    self.updateStatusMessage = nil
                    self.eventStreamClient.resetSSEReconnectDelay()
                }
            }
            if let newFingerprint = status.keyFingerprint {
                let oldFingerprint = keyFingerprint
                keyFingerprint = newFingerprint

                if let oldFingerprint, oldFingerprint != newFingerprint {
                    log.info("Assistant key fingerprint changed (\(oldFingerprint, privacy: .public) → \(newFingerprint, privacy: .public)) — invalidating credentials")
                    ActorTokenManager.deleteAllCredentials()
                    NotificationCenter.default.post(name: .daemonInstanceChanged, object: nil)
                }
            }
        }

        switch message {
        case .serviceGroupUpdateStarting(let msg):
            self.updateTargetVersion = msg.targetVersion
            self.updateExpiresAt = Date().addingTimeInterval(msg.expectedDowntimeSeconds * 2)
            self.updateStatusMessage = "Preparing to update…"
            setUpdateInProgress(true)
            log.info("Service group update starting — target: \(msg.targetVersion, privacy: .public), expected downtime: \(msg.expectedDowntimeSeconds)s")
        case .serviceGroupUpdateProgress(let msg):
            self.updateStatusMessage = msg.statusMessage
        case .serviceGroupUpdateComplete(let msg):
            outcomeEmittedForCurrentCycle = true
            if msg.success {
                lastUpdateOutcome = UpdateOutcome(result: .succeeded(version: msg.installedVersion), timestamp: Date())
            } else if let rollbackVersion = msg.rolledBackToVersion {
                lastUpdateOutcome = UpdateOutcome(result: .rolledBack(from: updateTargetVersion ?? "unknown", to: rollbackVersion), timestamp: Date())
            } else {
                lastUpdateOutcome = UpdateOutcome(result: .failed, timestamp: Date())
            }
            self.isUpdateInProgress = false
            self.updateTargetVersion = nil
            self.updateExpiresAt = nil
            self.updateStatusMessage = nil
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

    private func autoWakeIfAssistantDied() {
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

    // MARK: - Background Reconnection Loop

    /// Retries connection with increasing delays after the initial `connect()` fails.
    /// Only applies to local assistants on macOS. Uses health checks and auto-wake
    /// to reconnect without calling `connectImpl()` (which would interfere via
    /// `disconnectInternal()`). Cancelled on explicit `disconnect()` or `reconfigure()`.
    private func startReconnectionLoop() {
        guard isLocal else { return }
        reconnectionTask?.cancel()
        reconnectionGeneration += 1
        let generation = reconnectionGeneration
        reconnectionTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let delays: [UInt64] = [3, 5, 10, 15] // seconds
            var attempt = 0
            while !Task.isCancelled {
                // If another path (e.g. autoWakeIfAssistantDied) connected us, exit
                guard !self.isConnected else {
                    log.info("reconnect-loop: already connected, exiting")
                    break
                }

                let delaySec = delays[min(attempt, delays.count - 1)]
                log.info("reconnect-loop: attempt \(attempt + 1), waiting \(delaySec)s")
                try? await Task.sleep(nanoseconds: delaySec * 1_000_000_000)
                guard !Task.isCancelled else { break }

                attempt += 1

                do {
                    try await self.performHealthCheck()
                } catch {
                    // Health check failed — try auto-wake if gateway unreachable
                    if let wakeHandler = self.wakeHandler {
                        let reachable = await HealthCheckClient.isReachable()
                        if !reachable {
                            // Cancel competing auto-wake triggered by performHealthCheck → setConnected(false)
                            self.autoWakeTask?.cancel()
                            self.autoWakeTask = nil
                            log.info("reconnect-loop: gateway unreachable — attempting wake")
                            do {
                                try await wakeHandler()
                                guard !Task.isCancelled else { break }
                                try await self.performHealthCheck()
                            } catch {
                                log.warning("reconnect-loop: wake + health check failed: \(error)")
                                continue
                            }
                        } else {
                            log.warning("reconnect-loop: health check failed but gateway reachable: \(error)")
                            continue
                        }
                    } else {
                        log.warning("reconnect-loop: health check failed (no wake handler): \(error)")
                        continue
                    }
                }

                // If we reach here, health check succeeded
                guard !Task.isCancelled else { break }
                self.startHealthCheckLoop()
                self.isAuthenticated = true
                self.isConnecting = false
                log.info("reconnect-loop: connected successfully after \(attempt) attempt(s)")
                self.eventStreamClient.startSSE()
                if self.reconnectionGeneration == generation {
                    self.reconnectionTask = nil
                }
                return
            }
            log.info("reconnect-loop: cancelled")
            if self.reconnectionGeneration == generation {
                self.reconnectionTask = nil
            }
        }
    }
    #endif

    // MARK: - Post-Sparkle Update Detection

    #if os(macOS)
    /// Detects whether the app was relaunched after a Sparkle update by checking
    /// the `preUpdateVersion` UserDefaults flag (set before the update started).
    /// If the version has changed, runs the CLI finalize command which broadcasts
    /// a `complete` event and creates a workspace git commit recording the update.
    /// The flag is cleared after processing so this only runs once per update.
    private func handlePostSparkleUpdate() {
        guard let preUpdateVersion = UserDefaults.standard.string(forKey: "preUpdateVersion") else { return }
        let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        guard currentVersion != preUpdateVersion else { return }

        // Clear the flag so this only runs once
        UserDefaults.standard.removeObject(forKey: "preUpdateVersion")

        log.info("Post-Sparkle-update detected: \(preUpdateVersion, privacy: .public) → \(currentVersion, privacy: .public)")

        // Single CLI call replaces direct HTTP calls for broadcast + workspace commit
        Task {
            guard let handler = postSparkleUpdateHandler,
                  let name = UserDefaults.standard.string(forKey: "connectedAssistantId") else { return }
            await handler(name, preUpdateVersion)
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
            #if os(macOS)
            handlePostSparkleUpdate()
            #endif
        }
        #if os(macOS)
        if !connected {
            autoWakeIfAssistantDied()
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
                return "Missing session token"
            case .timeout:
                return "Authentication timed out"
            case .rejected(let message):
                return message ?? "Authentication rejected"
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
        reconnectionTask?.cancel()
        #endif
    }
}

