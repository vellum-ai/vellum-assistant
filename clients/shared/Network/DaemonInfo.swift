import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonInfo")

/// Observable daemon state derived from SSE events and health checks.
///
/// Pure state object — publishes connection status, daemon version, model info,
/// and other metadata. Updated synchronously via `handleServerMessage()` before
/// messages are broadcast to subscribers, so all subscribers see consistent state.
///
/// This is the type consumers should observe for daemon metadata. Connection
/// lifecycle is managed by `GatewayConnectionManager`, and SSE/message broadcast
/// by `EventStreamClient`.
@MainActor
public final class DaemonInfo: ObservableObject {

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

    /// Instance directory for the connected assistant.
    public var instanceDir: String?

    // MARK: - Dependencies

    /// Reference to connection manager for update-in-progress state sync.
    weak var connectionManager: GatewayConnectionManager?

    /// Reference to event stream client for SSE reconnect delay reset.
    weak var eventStreamClient: EventStreamClient?

    // MARK: - Init

    public init() {}

    // MARK: - Connection State Updates

    /// Called by GatewayConnectionManager when connection state changes.
    func handleConnectionStateChanged(_ connected: Bool) {
        isConnected = connected
        if connected {
            NotificationCenter.default.post(name: .daemonDidReconnect, object: self)
        }
    }

    /// Called by GatewayConnectionManager when health check detects a version change.
    func handleDaemonVersionChanged(_ newVersion: String) {
        daemonVersion = newVersion
        checkVersionCompatibility(daemonVersion: newVersion)
        if isUpdateInProgress {
            if newVersion == updateTargetVersion {
                log.info("Health check confirmed update completed — now running \(newVersion, privacy: .public)")
            } else {
                log.warning("Health check detected version \(newVersion, privacy: .public) after update — expected \(self.updateTargetVersion ?? "?", privacy: .public), may have rolled back")
            }
            isUpdateInProgress = false
            updateTargetVersion = nil
            updateExpiresAt = nil
            connectionManager?.setUpdateInProgress(false)
            eventStreamClient?.resetSSEReconnectDelay()
        }
    }

    /// Reset all connection-specific state (called during reconfigure).
    func resetConnectionState() {
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

    // MARK: - Message Pre-Processing

    /// Handle server messages that update published state. Called synchronously
    /// before the message is broadcast to subscribers.
    func handleServerMessage(_ message: ServerMessage) {
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
                    self.connectionManager?.setUpdateInProgress(false)
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
            self.connectionManager?.setUpdateInProgress(true)
            log.info("Service group update starting — target: \(msg.targetVersion, privacy: .public), expected downtime: \(msg.expectedDowntimeSeconds)s")
        case .serviceGroupUpdateComplete:
            self.isUpdateInProgress = false
            self.updateTargetVersion = nil
            self.updateExpiresAt = nil
            self.connectionManager?.setUpdateInProgress(false)
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
}
