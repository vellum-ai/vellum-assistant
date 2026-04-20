import Observation
import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "GatewayConnectionManager")

/// Thrown by `attemptRePair` when the injected bootstrap handler exceeds the
/// timeout budget. Keeping this as a distinct type lets the catch site log a
/// clear "timed out" message and avoid treating a stuck bootstrap as a regular
/// failure.
private struct RePairTimeout: Error {}

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
/// auto-wake, and SSE message pre-processing to update observable properties.
/// SwiftUI views observe this for connection status and assistant metadata.
@Observable @MainActor
public final class GatewayConnectionManager {

    // MARK: - Observable State

    public var isConnected: Bool = false
    /// Independent signal from `isConnected`: flips to `true` after sustained
    /// auth failures (401/429) observed by `authFailureTracker`. Cleared on
    /// the next successful health check. Observe alongside `isConnected` —
    /// the two represent orthogonal failure modes of "unable to make progress".
    public var isAuthFailed: Bool = false
    public var isConnecting: Bool = false
    public internal(set) var assistantVersion: String?
    public internal(set) var versionMismatch: Bool = false
    public internal(set) var isUpdateInProgress: Bool = false
    public internal(set) var updateTargetVersion: String?
    public internal(set) var updateStatusMessage: String?
    @ObservationIgnored var updateExpiresAt: Date?
    @ObservationIgnored private var outcomeEmittedForCurrentCycle = false
    public internal(set) var lastUpdateOutcome: UpdateOutcome?
    public internal(set) var keyFingerprint: String?
    public var latestMemoryStatus: MemoryStatusMessage?
    public var isTrustRulesSheetOpen: Bool = false
    public var currentModel: String?
    public var latestModelInfo: ModelInfoMessage?

    /// Whether the transport has authenticated successfully.
    @ObservationIgnored var isAuthenticated = false

    // MARK: - Connection State (internal)

    #if os(macOS)
    /// Cached snapshot of the active assistant from the lockfile.
    /// Refreshed on connect, reconfigure, and when the active assistant changes
    /// externally (e.g. CLI `vellum use`). Reads from this cache replace the
    /// synchronous `LockfileAssistant.loadAll()` calls that previously blocked
    /// the main thread on every health check cycle.
    @ObservationIgnored private var cachedAssistant: LockfileAssistant?
    @ObservationIgnored private var assistantChangeObserver: NSObjectProtocol?
    #endif

    /// Whether auto-wake should be attempted on disconnect.
    /// Applies to local and Docker assistants (not remote or managed).
    private var isLocal: Bool {
        #if os(macOS)
        guard let assistant = cachedAssistant else { return false }
        return (!assistant.isRemote || assistant.isDocker) && !assistant.isManaged
        #else
        return false
        #endif
    }

    /// Whether the connected assistant is a managed (platform-hosted) assistant.
    private var isManaged: Bool {
        #if os(macOS)
        return cachedAssistant?.isManaged ?? false
        #else
        return false
        #endif
    }

    // MARK: - Health Check

    @ObservationIgnored private var healthCheckTask: Task<Void, Never>?
    @ObservationIgnored private let authFailureTracker = AuthFailureTracker()
    private let healthCheckInterval: TimeInterval = 15.0
    @ObservationIgnored private var shouldReconnect = true
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var conversationKey: String?
    /// Number of consecutive successful health checks. Used to suppress
    /// repetitive "Health check passed" logs after the first three passes.
    @ObservationIgnored private var consecutiveHealthCheckSuccesses = 0
    func setUpdateInProgress(_ value: Bool) {
        let wasInProgress = isUpdateInProgress
        if value != wasInProgress { isUpdateInProgress = value }
        if value && !wasInProgress {
            outcomeEmittedForCurrentCycle = false
            if healthCheckTask != nil {
                startHealthCheckLoop()
            }
        }
    }

    // MARK: - Auto-Wake

    @ObservationIgnored public var wakeHandler: (@MainActor @Sendable () async throws -> Void)?
    /// Handler invoked by `attemptRePair()` to re-run the bootstrap flow
    /// (clear stored credentials + re-provision). Set by the macOS app to
    /// `AppDelegate.forceReBootstrap()`; iOS does not currently wire one up.
    /// Keeping this as an injected closure avoids a shared-module dependency
    /// on the macOS-only `AppDelegate`.
    @ObservationIgnored public var rePairHandler: (@MainActor @Sendable () async throws -> Void)?
    /// Guards against concurrent `attemptRePair()` invocations. The flag is
    /// flipped on the main actor before the handler runs and cleared when the
    /// call returns (success or failure).
    @ObservationIgnored private var isAttemptingRePair: Bool = false
    /// Handler called after a Sparkle update is detected.
    /// Receives `(name: String, fromVersion: String)` so the macOS app can invoke
    /// CLI `upgradeFinalize` without the shared module depending on `AppDelegate`.
    @ObservationIgnored public var postSparkleUpdateHandler: (@MainActor @Sendable (_ name: String, _ fromVersion: String) async -> Void)?
    @ObservationIgnored public var recoveryPlatform: String?
    @ObservationIgnored public var recoveryDeviceId: String?

    #if os(macOS)
    @ObservationIgnored var lastAutoWakeAttempt: Date?
    @ObservationIgnored var autoWakeTask: Task<Void, Never>?
    @ObservationIgnored var reconnectionTask: Task<Void, Never>?
    @ObservationIgnored var reconnectionGeneration: Int = 0
    #endif

    // MARK: - Event Stream

    /// The event stream client for SSE and message broadcast.
    public let eventStreamClient = EventStreamClient()

    // MARK: - Init

    public init() {
        // Wire SSE pre-processor to update state before broadcast
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

        #if os(macOS)
        assistantChangeObserver = NotificationCenter.default.addObserver(
            forName: LockfileAssistant.activeAssistantDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.refreshCachedAssistant()
            }
        }
        #endif
    }

    // MARK: - Connect

    public func connect() async throws {
        try await connectImpl(cancelAutoWake: true)
    }

    func connectImpl(cancelAutoWake: Bool) async throws {
        #if os(macOS)
        reconnectionTask?.cancel()
        reconnectionTask = nil
        #endif
        disconnectInternal(cancelAutoWake: cancelAutoWake)

        #if os(macOS)
        refreshCachedAssistant()
        LockfileAssistant.startWatching()
        #endif

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
        consecutiveHealthCheckSuccesses = 0
        setConnected(false)

        // Reset auth-failed state on teardown. Every reconnect should start
        // from a clean slate — otherwise a stale `isAuthFailed = true` can
        // leak through a disconnect/reconnect cycle (e.g. the managed
        // 404-retired path, or an explicit `disconnect()` from the app)
        // until the tracker's sliding window drains naturally. Route through
        // `updateAuthFailedSignal()` so the single-transition log line still
        // fires and the invariant "`isAuthFailed` is only mutated through the
        // helper" is preserved. `reconfigure()` reaches this via
        // `disconnect()`, so it automatically inherits the reset.
        authFailureTracker.recordSuccess()
        updateAuthFailedSignal()

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
        #if os(macOS)
        cachedAssistant = nil
        #endif
        disconnect()
        isAuthenticated = false
        refreshTask?.cancel()
        refreshTask = nil
        #if os(macOS)
        lastAutoWakeAttempt = nil
        #endif

        // Reset published state. `isAuthFailed` + the underlying tracker are
        // cleared by `disconnectInternal()` (called via `disconnect()` above),
        // so no explicit reset is needed here.
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
        latestModelInfo = nil
    }

    /// Clears the last update outcome after the UI has consumed it.
    public func clearLastUpdateOutcome() {
        lastUpdateOutcome = nil
    }

    // MARK: - Health Check (via GatewayHTTPClient)

    /// Decoded result of a single health check round-trip.
    ///
    /// Populated off the main actor (see ``performHealthCheck()``) so that
    /// URL construction, `URLSession` work, and JSON decoding don't occupy
    /// the main dispatch queue while the `@MainActor` class is otherwise
    /// busy.
    private struct HealthCheckOutcome: Sendable {
        let statusCode: Int
        let version: String?
    }

    private func performHealthCheck() async throws {
        let healthPath: String
        #if os(macOS)
        healthPath = (cachedAssistant?.isManaged ?? false) ? "assistants/{assistantId}/health" : "health"
        #else
        healthPath = ((try? GatewayHTTPClient.isConnectionManaged()) ?? false) ? "assistants/{assistantId}/health" : "health"
        #endif

        // Run the HTTP GET + JSON decode off the main actor. `GatewayHTTPClient`
        // is nonisolated but, when called from a `@MainActor` context, its
        // synchronous work (lockfile read on macOS, URL construction, JSON
        // parsing of the response) inherits main-actor isolation. Under memory
        // pressure or a saturated main queue this has been observed to cause
        // >2000ms hangs (see LUM-914). Offloading via `Task.detached` follows
        // Apple's guidance to keep state on `@MainActor` and push CPU-bound /
        // I/O-bound work off it — WWDC25 "Embracing Swift concurrency"
        // (https://developer.apple.com/videos/play/wwdc2025/268/).
        //
        // Detached tasks are unstructured, so cancelling the enclosing
        // `healthCheckTask` (e.g. from `disconnectInternal()`) does not
        // automatically propagate to the network call. `withTaskCancellationHandler`
        // forwards the parent's cancellation to the detached handle, and the
        // explicit `checkCancellation()` below guards the subsequent
        // `@MainActor` state mutations so a late-arriving success cannot flip
        // `isConnected` back to `true` after disconnect.
        let detachedHealthCheck = Task.detached(priority: .userInitiated) {
            let response = try await GatewayHTTPClient.get(
                path: healthPath,
                timeout: 10,
                quiet: true
            )
            let version: String? = response.isSuccess
                ? (try? JSONDecoder().decode(HealthVersionResponse.self, from: response.data))?.version
                : nil
            return HealthCheckOutcome(statusCode: response.statusCode, version: version)
        }
        let outcome: HealthCheckOutcome
        do {
            outcome = try await withTaskCancellationHandler {
                try await detachedHealthCheck.value
            } onCancel: {
                detachedHealthCheck.cancel()
            }
            try Task.checkCancellation()
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as GatewayHTTPClient.ClientError {
            consecutiveHealthCheckSuccesses = 0
            log.error("Health check client error: \(error.localizedDescription, privacy: .public)")
            setConnected(false)
            updateAuthFailedSignal()
            throw ConnectionError.healthCheckFailed
        } catch {
            consecutiveHealthCheckSuccesses = 0
            log.error("Health check failed: \(error.localizedDescription, privacy: .public)")
            setConnected(false)
            updateAuthFailedSignal()
            throw ConnectionError.healthCheckFailed
        }

        guard (200..<300).contains(outcome.statusCode) else {
            // Feed auth-relevant statuses into the sliding-window tracker.
            // AuthFailureTracker itself filters to the 401/429 it cares about;
            // passing 403 here is harmless and keeps the call site honest
            // about which statuses look like auth problems.
            if outcome.statusCode == 401 || outcome.statusCode == 403 || outcome.statusCode == 429 {
                authFailureTracker.recordFailure(statusCode: outcome.statusCode, path: "/v1/health")
            }
            if outcome.statusCode == 401 {
                handleAuthenticationFailure()
            } else if outcome.statusCode == 404, isManaged {
                handleManagedAssistantGoneFromPlatform()
            }
            consecutiveHealthCheckSuccesses = 0
            setConnected(false)
            updateAuthFailedSignal()
            throw ConnectionError.healthCheckFailed
        }

        // 2xx — auth is working. Any accumulated window is cleared.
        authFailureTracker.recordSuccess()
        updateAuthFailedSignal()

        if let newVersion = outcome.version, newVersion != assistantVersion {
            assistantVersion = newVersion
            handleDaemonVersionChanged(newVersion)
        }

        consecutiveHealthCheckSuccesses += 1
        if consecutiveHealthCheckSuccesses <= 3 {
            log.info("Health check passed")
        }
        setConnected(true)
    }

    /// Reconciles `isAuthFailed` against the tracker's current state and logs
    /// the single transition lines. Idempotent — safe to call on every health
    /// check cycle. The two signals (`isConnected`, `isAuthFailed`) are
    /// independent; a tripped auth signal never forces `isConnected = false`
    /// on its own and vice-versa.
    private func updateAuthFailedSignal() {
        let tripped = authFailureTracker.isAuthFailed
        guard tripped != isAuthFailed else { return }
        isAuthFailed = tripped
        if tripped {
            let status = authFailureTracker.lastStatusCode ?? -1
            let path = authFailureTracker.lastPath ?? "?"
            log.warning("AuthFailureTracker tripped: status=\(status, privacy: .public) path=\(path, privacy: .public) window=\(self.authFailureTracker.windowSeconds, privacy: .public) failures=\(self.authFailureTracker.minFailures, privacy: .public)")
        } else {
            log.info("AuthFailureTracker cleared")
        }
    }

    // MARK: - Test Hooks

    /// Internal hook used by unit tests to drive the same code path as
    /// `performHealthCheck()` without standing up a URLProtocol fake. Mirrors
    /// the tracker-update + signal-update behavior used on real HTTP
    /// outcomes. Production code must not call this.
    internal func _testIngestHealthStatus(_ statusCode: Int) {
        if (200..<300).contains(statusCode) {
            authFailureTracker.recordSuccess()
        } else if statusCode == 401 || statusCode == 403 || statusCode == 429 {
            authFailureTracker.recordFailure(statusCode: statusCode, path: "/v1/health")
        }
        updateAuthFailedSignal()
    }

    private func startHealthCheckLoop() {
        healthCheckTask?.cancel()

        // The loop runs on a detached task at `.utility` priority so the
        // 15 s `Task.sleep` scheduling and between-check overhead do not
        // occupy `@MainActor`. Work that touches observable state
        // (`performHealthCheck` and the update-timeout cleanup) stays on
        // the main actor; every other state read hops explicitly via
        // `MainActor.run {}`.
        healthCheckTask = Task.detached(priority: .utility) { [weak self] in
            while !Task.isCancelled {
                let interval: TimeInterval = await MainActor.run { [weak self] in
                    guard let self else { return 15.0 }
                    return self.isUpdateInProgress ? 2.0 : self.healthCheckInterval
                }
                do {
                    try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }

                guard let self else { return }
                let shouldContinue = await MainActor.run { self.shouldReconnect }
                guard shouldContinue else { return }

                do {
                    try await self.performHealthCheck()
                } catch {
                    log.warning("Periodic health check failed: \(error.localizedDescription, privacy: .public)")
                }

                await self.checkUpdateTimeoutIfNeeded()
            }
        }
    }

    /// Clears update state if the update deadline has passed. Runs on the
    /// main actor because it mutates observable properties.
    private func checkUpdateTimeoutIfNeeded() {
        guard isUpdateInProgress, let expiresAt = updateExpiresAt, Date() > expiresAt else { return }
        log.warning("Update timed out — clearing isUpdateInProgress after deadline passed")
        lastUpdateOutcome = UpdateOutcome(result: .timedOut, timestamp: Date())
        isUpdateInProgress = false
        updateTargetVersion = nil
        updateExpiresAt = nil
        updateStatusMessage = nil
        eventStreamClient.resetSSEReconnectDelay()
    }

    // MARK: - Version Comparison

    /// Compare two version strings using parsed semver components so that
    /// prefix differences (e.g. "v1.2.3" vs "1.2.3") are ignored.
    private func versionsMatch(_ a: String, _ b: String) -> Bool {
        guard let parsedA = VersionCompat.parse(a),
              let parsedB = VersionCompat.parse(b) else {
            return a == b
        }
        return parsedA.coreEquals(parsedB)
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
                if version != assistantVersion { assistantVersion = version }
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
                if newFingerprint != oldFingerprint { keyFingerprint = newFingerprint }

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

    // MARK: - 404 Recovery (managed assistant gone from platform)

    /// Called when the managed-assistant health endpoint returns 404. The
    /// assistant was retired on the platform (here, from the web UI, or from
    /// another device) but local state still references it, so the health
    /// check loop is hitting a dead endpoint forever. Stop reconnecting and
    /// post a notification so the platform-layer observer can clean up.
    private func handleManagedAssistantGoneFromPlatform() {
        log.warning("Managed assistant returned 404 from health endpoint — disconnecting and notifying observer for cleanup")
        disconnect()
        NotificationCenter.default.post(name: .managedAssistantRetiredRemotely, object: self)
    }

    // MARK: - 401 Recovery

    private func handleAuthenticationFailure() {
        #if os(macOS)
        let managedConnection = cachedAssistant?.isManaged ?? false
        #else
        let managedConnection = (try? GatewayHTTPClient.isConnectionManaged()) ?? false
        #endif
        if managedConnection {
            log.warning("401 in managed mode — session token may be expired")
            eventStreamClient.broadcastMessage(.conversationError(ConversationErrorMessage(
                conversationId: "",
                code: .authenticationRequired,
                userMessage: "Session expired. Please sign in again.",
                retryable: false
            )))
            // Managed mode surfaces auth failures through the SSE `authenticationRequired` error
            // stream, not through the menu-bar `.authFailed` state. The disconnect path's tracker
            // reset is intentional — see AuthFailureTracker / GatewayConnectionManager integration.
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

            let result = await TokenRefreshCoordinator.shared.refreshIfNeeded(
                platform: platform,
                deviceId: deviceId
            )

            switch result {
            case .success:
                break // Coordinator already logs success
            case .terminalError(let reason):
                log.error("Token refresh failed terminally: \(reason, privacy: .public) — re-pair required")
                self.eventStreamClient.broadcastMessage(.conversationError(ConversationErrorMessage(
                    conversationId: "",
                    code: .authenticationRequired,
                    userMessage: "Session expired. Please re-pair your device.",
                    retryable: false
                )))
            case .transientError:
                break // Coordinator already logs warning
            }
        }
    }

    // MARK: - Re-Pair Recovery

    /// Default timeout for `attemptRePair`. Long enough for a real bootstrap
    /// (guardian token poll + provision) to land, short enough that the
    /// Re-pair menu item becomes clickable again after a stuck attempt.
    public nonisolated static let defaultRePairTimeout: TimeInterval = 90.0

    /// Attempts to recover from a stuck `isAuthFailed` state by re-running
    /// the bootstrap flow (clear stored credentials + re-provision). Runs the
    /// injected `rePairHandler` by default, but callers (e.g. unit tests) may
    /// supply an explicit `bootstrap` closure to substitute a fake.
    ///
    /// Concurrent invocations coalesce — if a re-pair is already in flight,
    /// subsequent calls return immediately without re-running the handler.
    /// The handler is bounded by `timeout` (default 90s) so a stuck bootstrap
    /// — e.g. offline network, guardian endpoint flapping, indefinite retry
    /// loop inside `performInitialBootstrap` — cannot latch
    /// `isAttemptingRePair = true` forever and silently swallow every
    /// subsequent menu click.
    ///
    /// On success, the `AuthFailureTracker` is reset so the UI flips back
    /// promptly on the next health check. On failure/timeout, the tracker is
    /// left alone (the next successful health check will eventually clear it)
    /// and `isAttemptingRePair` is released via `defer` regardless of path.
    public func attemptRePair(
        bootstrap: (@MainActor @Sendable () async throws -> Void)? = nil,
        timeout: TimeInterval = GatewayConnectionManager.defaultRePairTimeout
    ) async {
        if isAttemptingRePair {
            log.info("attemptRePair: already in flight — skipping")
            return
        }
        isAttemptingRePair = true
        defer { isAttemptingRePair = false }

        log.info("attemptRePair: started")

        // Cancel and drain any in-flight `refreshTask`. Without this, a 401
        // refresh that concludes as a terminal error AFTER the new bootstrap
        // has provisioned fresh credentials will call
        // `ActorTokenManager.deleteAllCredentials()` and clobber them,
        // putting the app right back in the stuck `isAuthFailed` state we
        // were trying to exit.
        if let inFlightRefresh = refreshTask {
            log.info("attemptRePair: cancelling in-flight refresh task")
            inFlightRefresh.cancel()
            await inFlightRefresh.value
        }

        let handler = bootstrap ?? rePairHandler
        guard let handler else {
            log.error("attemptRePair: failed — no bootstrap handler configured")
            return
        }
        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask { try await handler() }
                group.addTask {
                    let nanoseconds = UInt64(max(0, timeout) * 1_000_000_000)
                    try await Task.sleep(nanoseconds: nanoseconds)
                    throw RePairTimeout()
                }
                // Wait for the first task to complete (handler or timer) then
                // cancel the loser so it doesn't keep running in the
                // background.
                try await group.next()
                group.cancelAll()
            }
            authFailureTracker.recordSuccess()
            updateAuthFailedSignal()
            log.info("attemptRePair: completed")
        } catch is RePairTimeout {
            log.error("attemptRePair: timed out after \(timeout, privacy: .public)s")
        } catch {
            log.error("attemptRePair: failed — \(error.localizedDescription, privacy: .public)")
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
    /// Applies to local and managed assistants on macOS. Uses health checks and auto-wake
    /// (local only) to reconnect without calling `connectImpl()` (which would interfere via
    /// `disconnectInternal()`). Cancelled on explicit `disconnect()` or `reconfigure()`.
    private func startReconnectionLoop() {
        guard (isLocal || isManaged), shouldReconnect else { return }
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
                // Honor explicit disconnect/reconfigure
                guard self.shouldReconnect else {
                    log.info("reconnect-loop: shouldReconnect is false, exiting")
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
                    // Managed assistants have no local gateway to wake — just retry
                    if self.isManaged {
                        log.warning("reconnect-loop: health check failed for managed assistant: \(error)")
                        continue
                    }

                    // Health check failed — try auto-wake if gateway unreachable
                    if let wakeHandler = self.wakeHandler {
                        let reachable = await HealthCheckClient.isReachable()
                        if !reachable {
                            // Cancel competing auto-wake triggered by performHealthCheck → setConnected(false)
                            self.autoWakeTask?.cancel()
                            self.autoWakeTask = nil
                            log.info("reconnect-loop: gateway unreachable — attempting wake")
                            guard !Task.isCancelled, self.shouldReconnect else { break }
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
                  let name = cachedAssistant?.assistantId ?? LockfileAssistant.loadActiveAssistantId() else { return }
            await handler(name, preUpdateVersion)
        }
    }
    #endif

    // MARK: - Async Observation

    /// An async sequence that emits whenever `isConnected` changes.
    /// Yields the current value immediately, then emits on each subsequent change.
    /// Cancellation-cooperative: when the consuming task is cancelled, `next()`
    /// returns `nil` promptly and all captured references are released.
    public var isConnectedStream: ObservationValues<Bool> {
        observationStream { [weak self] in self?.isConnected ?? false }
    }

    // MARK: - Helpers

    private func setConnected(_ connected: Bool) {
        guard isConnected != connected else { return }
        isConnected = connected
        if isConnecting { isConnecting = false }
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

    // MARK: - Cached Assistant

    #if os(macOS)
    /// Synchronously refreshes the cached assistant snapshot from the lockfile.
    /// Called during connect and when `activeAssistantDidChange` fires.
    private func refreshCachedAssistant() {
        let id: String?
        if let activeId = LockfileAssistant.loadActiveAssistantId(), !activeId.isEmpty {
            id = activeId
        } else if let legacyId = UserDefaults.standard.string(forKey: "connectedAssistantId"), !legacyId.isEmpty {
            id = legacyId
        } else {
            id = nil
        }
        guard let id else {
            cachedAssistant = nil
            return
        }
        cachedAssistant = LockfileAssistant.loadByName(id)
    }
    #endif

    deinit {
        #if os(macOS)
        autoWakeTask?.cancel()
        reconnectionTask?.cancel()
        if let observer = assistantChangeObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        LockfileAssistant.stopWatching()
        #endif
    }
}
