import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonStatus")

/// Protocol for daemon connection status, enabling dependency injection and testing.
@MainActor
public protocol DaemonStatusProtocol: AnyObject {
    var isConnected: Bool { get }
    func connect() async throws
    func disconnect()
}

/// Observable daemon state. Publishes connection status, daemon version,
/// model info, and other metadata derived from SSE events and health checks.
///
/// Does NOT own `GatewayConnectionManager` or `EventStreamClient` — those
/// are owned by `AppServices` (macOS) or `AppDelegate` (iOS). This class
/// subscribes to their callbacks to update `@Published` properties.
@MainActor
public final class DaemonStatus: ObservableObject, DaemonStatusProtocol {

    // MARK: - Published State

    @Published public var isConnected: Bool = false
    @Published public var httpPort: Int?
    @Published public internal(set) var daemonVersion: String?
    @Published public internal(set) var versionMismatch: Bool = false
    @Published public internal(set) var isUpdateInProgress: Bool = false
    @Published public internal(set) var updateTargetVersion: String?
    var updateExpiresAt: Date?
    @Published public internal(set) var keyFingerprint: String?
    @Published public var latestMemoryStatus: MemoryStatusMessage?
    @Published public var isTrustRulesSheetOpen: Bool = false
    @Published public var currentModel: String?
    @Published public var latestModelInfo: ModelInfoMessage?

    /// Instance directory for the connected assistant.
    public var instanceDir: String?

    /// Returns a closure that resolves the current HTTP port at call time.
    public var httpPortResolver: () -> Int? {
        { [weak self] in self?.httpPort }
    }

    /// Whether a connection attempt is in flight.
    public var isConnecting: Bool {
        _connectionManager?.isConnecting ?? false
    }

    // MARK: - Auth

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

    // MARK: - Private references for callbacks

    /// Weak reference to connection manager for update-in-progress sync.
    private weak var _connectionManager: GatewayConnectionManager?

    // MARK: - Init

    public init(connectionManager: GatewayConnectionManager) {
        self._connectionManager = connectionManager

        let esc = connectionManager.eventStreamClient

        // Wire the pre-processor so state is updated before subscribers see messages
        esc.messagePreProcessor = { [weak self, weak connectionManager] message in
            self?.handleServerMessage(message, connectionManager: connectionManager)
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

        // Wire connection state changes to @Published properties.
        connectionManager.onConnectionStateChanged = { [weak self] connected in
            guard let self else { return }
            self.isConnected = connected
            if connected {
                NotificationCenter.default.post(name: .daemonDidReconnect, object: self)
            }
        }

        connectionManager.onDaemonVersionChanged = { [weak self, weak connectionManager] newVersion in
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
                connectionManager?.setUpdateInProgress(false)
                connectionManager?.eventStreamClient.resetSSEReconnectDelay()
            }
        }

        connectionManager.onAuthError = { [weak connectionManager] message in
            connectionManager?.eventStreamClient.broadcastMessage(message)
        }
    }

    /// Convenience init for iOS where DaemonStatus creates its own GatewayConnectionManager.
    public convenience init(config: DaemonConfig = .default) {
        let cm = GatewayConnectionManager()
        self.init(connectionManager: cm)
        self.currentConfig = config
        self.instanceDir = config.instanceDir
        cm.reconfigure(
            instanceDir: config.instanceDir,
            isRuntimeFlat: config.transportMetadata.routeMode == .runtimeFlat
        )
    }

    // MARK: - Connection (forwarding)

    /// Current config — stored only so `connect()` can extract the conversation key.
    private var currentConfig: DaemonConfig?

    public func connect() async throws {
        guard let cm = _connectionManager,
              case .http(_, _, let conversationKey) = currentConfig?.transport else {
            log.info("connect: no HTTP transport configured, skipping")
            return
        }
        try await cm.connectImpl(cancelAutoWake: true, conversationKey: conversationKey)
    }

    public func disconnect() {
        _connectionManager?.disconnect()
        isConnected = false
        httpPort = nil
        latestMemoryStatus = nil
    }

    /// Reconfigure the transport in place without replacing object identity.
    public func reconfigure(config newConfig: DaemonConfig) {
        currentConfig = newConfig
        instanceDir = newConfig.instanceDir
        _connectionManager?.reconfigure(
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

    private func handleServerMessage(_ message: ServerMessage, connectionManager: GatewayConnectionManager?) {
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
                    connectionManager?.setUpdateInProgress(false)
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
            connectionManager?.setUpdateInProgress(true)
            log.info("Service group update starting — target: \(msg.targetVersion, privacy: .public), expected downtime: \(msg.expectedDowntimeSeconds)s")
        case .serviceGroupUpdateComplete:
            self.isUpdateInProgress = false
            self.updateTargetVersion = nil
            self.updateExpiresAt = nil
            connectionManager?.setUpdateInProgress(false)
        case .modelInfo(let msg):
            currentModel = msg.model
            latestModelInfo = msg
        case .memoryStatus(let msg):
            latestMemoryStatus = msg
        case .authResult(let result):
            connectionManager?.isAuthenticated = result.success
        default:
            break
        }
    }

    // MARK: - Recovery Credentials (forwarded to GatewayConnectionManager)

    public var recoveryPlatform: String? {
        get { _connectionManager?.recoveryPlatform }
        set { _connectionManager?.recoveryPlatform = newValue }
    }

    public var recoveryDeviceId: String? {
        get { _connectionManager?.recoveryDeviceId }
        set { _connectionManager?.recoveryDeviceId = newValue }
    }
}

// MARK: - Backward Compatibility

public typealias DaemonClient = DaemonStatus
public typealias DaemonClientProtocol = DaemonStatusProtocol
