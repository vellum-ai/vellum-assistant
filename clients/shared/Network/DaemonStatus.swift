import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonStatus")

/// Protocol for daemon status and connection management, enabling dependency injection and testing.
@MainActor
public protocol DaemonStatusProtocol: AnyObject {
    var isConnected: Bool { get }
    func connect() async throws
    func disconnect()
}

/// Observable status of the assistant daemon connection. Publishes connection state,
/// daemon version, model info, and other status properties derived from SSE events.
///
/// Pure state object — connection lifecycle is managed by `GatewayConnectionManager`,
/// SSE and message broadcast by `EventStreamClient`. This class wires the three
/// together and reacts to events by updating `@Published` properties.
@MainActor
public final class DaemonStatus: ObservableObject, DaemonStatusProtocol {

    // MARK: - Published State

    @Published public var isConnected: Bool = false

    /// The runtime HTTP server port, populated via `daemon_status` on connect.
    @Published public var httpPort: Int?

    /// Returns a closure that resolves the current HTTP port at call time.
    public var httpPortResolver: () -> Int? {
        { [weak self] in self?.httpPort }
    }

    /// The daemon version string, populated via `daemon_status` on connect.
    @Published public internal(set) var daemonVersion: String?

    /// Whether the connected daemon's major.minor version differs from this client's version.
    @Published public internal(set) var versionMismatch: Bool = false

    /// Whether a planned service group update is in progress.
    @Published public internal(set) var isUpdateInProgress: Bool = false

    /// The version being upgraded to, if an update is in progress.
    @Published public internal(set) var updateTargetVersion: String?

    /// Deadline after which `isUpdateInProgress` is considered stale.
    var updateExpiresAt: Date?

    /// Signing key fingerprint from the connected daemon, populated via `daemon_status`.
    @Published public internal(set) var keyFingerprint: String?

    /// Latest memory health payload from daemon `memory_status` events.
    @Published public var latestMemoryStatus: MemoryStatusMessage?

    /// Whether a TrustRulesView sheet is currently open from any settings surface.
    @Published public var isTrustRulesSheetOpen: Bool = false

    /// The currently active model ID, populated via `model_info` responses.
    @Published public var currentModel: String?

    /// The latest full model info response from the daemon stream.
    @Published public var latestModelInfo: ModelInfoMessage?

    // MARK: - Auth

    /// Legacy authentication errors — retained for compatibility.
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

    // MARK: - Components

    /// Event stream client for SSE and message broadcast.
    public let eventStreamClient: EventStreamClient

    /// Connection lifecycle manager (health checks, auto-wake, transport).
    public let connectionManager: GatewayConnectionManager

    // MARK: - Forwarding accessors (backward compat)

    /// Whether a connection attempt is in flight.
    public var isConnecting: Bool {
        get { connectionManager.isConnecting }
        set { connectionManager.isConnecting = newValue }
    }

    /// Instance directory for the connected assistant. Used by consumers
    /// that need to resolve file paths (e.g. workspace, identity).
    public var instanceDir: String?

    /// Platform identifier for automatic 401 re-bootstrap.
    public var recoveryPlatform: String? {
        get { connectionManager.recoveryPlatform }
        set { connectionManager.recoveryPlatform = newValue }
    }

    /// Device identifier for automatic 401 re-bootstrap.
    public var recoveryDeviceId: String? {
        get { connectionManager.recoveryDeviceId }
        set { connectionManager.recoveryDeviceId = newValue }
    }

    /// Optional closure invoked when the daemon process is not alive.
    public var wakeHandler: (@MainActor @Sendable () async throws -> Void)? {
        get { connectionManager.wakeHandler }
        set { connectionManager.wakeHandler = newValue }
    }

    // MARK: - Init

    public init(config: DaemonConfig = .default) {
        let esc = EventStreamClient()
        self.eventStreamClient = esc
        self.connectionManager = GatewayConnectionManager(eventStreamClient: esc)

        // Extract fields from initial config
        self.currentConfig = config
        self.instanceDir = config.instanceDir
        self.connectionManager.reconfigure(
            instanceDir: config.instanceDir,
            isRuntimeFlat: config.transportMetadata.routeMode == .runtimeFlat
        )

        // Wire the pre-processor so state is updated before subscribers see messages
        esc.messagePreProcessor = { [weak self] message in
            self?.handleServerMessage(message)
        }

        // Wire conversation ID resolution to subscribers.
        esc.onConversationIdResolved = { [weak esc] localId, serverId in
            esc?.broadcastMessage(.conversationIdResolved(localId: localId, serverId: serverId))
        }

        // Persist refreshed bearer tokens so the client survives app restarts.
        esc.onTokenRefreshed = { newToken in
            #if os(iOS)
            let _ = APIKeyManager.shared.setAPIKey(newToken, provider: "runtime-bearer-token")
            #elseif os(macOS)
            // macOS re-reads from disk on each request; no persistence needed here.
            #endif
        }

        // Wire GatewayConnectionManager callbacks to update DaemonStatus state.
        connectionManager.onConnectionStateChanged = { [weak self] connected in
            guard let self else { return }
            self.isConnected = connected
            if connected {
                NotificationCenter.default.post(name: .daemonDidReconnect, object: self)
            }
        }

        connectionManager.onDaemonVersionChanged = { [weak self] newVersion in
            guard let self else { return }
            self.daemonVersion = newVersion
            self.checkVersionCompatibility(daemonVersion: newVersion)
            if self.isUpdateInProgress {
                if newVersion == self.updateTargetVersion {
                    log.info("Health check confirmed update completed — now running \(newVersion, privacy: .public)")
                } else {
                    log.warning("Health check detected version \(newVersion, privacy: .public) after update — expected \(self.updateTargetVersion ?? "?", privacy: .public), may have rolled back")
                }
                self.isUpdateInProgress = false
                self.updateTargetVersion = nil
                self.updateExpiresAt = nil
                self.connectionManager.setUpdateInProgress(false)
                self.eventStreamClient.resetSSEReconnectDelay()
            }
        }

        connectionManager.onAuthError = { [weak self] message in
            self?.eventStreamClient.broadcastMessage(message)
        }
    }

    // MARK: - Connection (forwarding)

    public func connect() async throws {
        guard case .http(_, _, let conversationKey) = currentConfig?.transport else {
            log.info("connect: no HTTP transport configured, skipping")
            return
        }
        try await connectionManager.connectImpl(cancelAutoWake: true, conversationKey: conversationKey)
    }

    public func disconnect() {
        connectionManager.disconnect()
        isConnected = false
        httpPort = nil
        latestMemoryStatus = nil
    }

    /// Reconfigure the transport in place without replacing object identity.
    public func reconfigure(config newConfig: DaemonConfig) {
        currentConfig = newConfig
        instanceDir = newConfig.instanceDir
        connectionManager.reconfigure(
            instanceDir: newConfig.instanceDir,
            isRuntimeFlat: newConfig.transportMetadata.routeMode == .runtimeFlat
        )
        // Reset connection-specific published state
        isConnected = false
        httpPort = nil
        daemonVersion = nil
        versionMismatch = false
        isUpdateInProgress = false
        updateTargetVersion = nil
        updateExpiresAt = nil
        keyFingerprint = nil
        latestMemoryStatus = nil
        currentModel = nil
    }

    /// Current config — stored only so `connect()` can extract the conversation key.
    /// Will be removed when DaemonStatus is deleted.
    private var currentConfig: DaemonConfig?

    // MARK: - Version Compatibility

    private func parseMajorMinor(_ version: String) -> (Int, Int)? {
        let cleaned = version.hasPrefix("v") ? String(version.dropFirst()) : version
        let components = cleaned.split(separator: ".").compactMap { Int($0) }
        guard components.count >= 2 else { return nil }
        return (components[0], components[1])
    }

    func checkVersionCompatibility(daemonVersion: String) {
        guard let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String else {
            return
        }
        guard let (daemonMajor, daemonMinor) = parseMajorMinor(daemonVersion),
              let (clientMajor, clientMinor) = parseMajorMinor(clientVersion) else {
            return
        }
        let mismatch = daemonMajor != clientMajor || daemonMinor != clientMinor
        if mismatch != versionMismatch {
            versionMismatch = mismatch
        }
        if mismatch {
            log.warning("Version mismatch: client \(clientVersion, privacy: .public) vs daemon \(daemonVersion, privacy: .public)")
        }
    }

    // MARK: - Message Pre-Processing

    /// Handle server messages that update DaemonStatus state. Called synchronously
    /// before the message is broadcast to subscribers.
    private func handleServerMessage(_ message: ServerMessage) {
        if case .daemonStatus(let status) = message {
            httpPort = status.httpPort.flatMap { Int(exactly: $0) }
            if let version = status.version {
                daemonVersion = version
                checkVersionCompatibility(daemonVersion: version)
                if self.isUpdateInProgress {
                    if version == self.updateTargetVersion {
                        log.info("Planned update completed — now running \(version, privacy: .public)")
                    } else {
                        log.warning("Planned update may have rolled back — expected \(self.updateTargetVersion ?? "?", privacy: .public) but running \(version, privacy: .public)")
                    }
                    self.isUpdateInProgress = false
                    self.updateTargetVersion = nil
                    self.updateExpiresAt = nil
                    self.connectionManager.setUpdateInProgress(false)
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
            self.connectionManager.setUpdateInProgress(true)
            log.info("Service group update starting — target: \(msg.targetVersion, privacy: .public), expected downtime: \(msg.expectedDowntimeSeconds)s")
        case .serviceGroupUpdateComplete:
            self.isUpdateInProgress = false
            self.updateTargetVersion = nil
            self.updateExpiresAt = nil
            self.connectionManager.setUpdateInProgress(false)
        case .modelInfo(let msg):
            currentModel = msg.model
            latestModelInfo = msg
        case .memoryStatus(let msg):
            latestMemoryStatus = msg
        case .authResult(let result):
            connectionManager.isAuthenticated = result.success
        default:
            break
        }
    }
}

// MARK: - Backward Compatibility

/// Typealias so existing code referencing `DaemonClient` compiles unchanged.
/// New code should use `DaemonStatus` directly.
public typealias DaemonClient = DaemonStatus

/// Typealias so existing code referencing `DaemonClientProtocol` compiles unchanged.
public typealias DaemonClientProtocol = DaemonStatusProtocol
