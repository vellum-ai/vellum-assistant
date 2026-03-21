import Combine
import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonStatus")

/// Protocol for daemon status and connection management, enabling dependency injection and testing.
@MainActor
public protocol DaemonStatusProtocol: AnyObject {
    var isConnected: Bool { get }
    func subscribe() -> AsyncStream<ServerMessage>
    func sendUserMessage(content: String?, conversationId: String, attachments: [UserMessageAttachment]?, conversationType: String?, automated: Bool?, bypassSecretCheck: Bool?)
    func connect() async throws
    func disconnect()
    func startSSE()
    func stopSSE()
}

/// Thin compatibility shim that wires `DaemonInfo`, `EventStreamClient`, and
/// `GatewayConnectionManager` together. Existing consumers reference this type
/// via the `DaemonClient` typealias; new code should use the individual
/// components directly.
///
/// Will be deleted in a follow-up PR when consumers are migrated to hold
/// `DaemonInfo`, `EventStreamClient`, and `GatewayConnectionManager` directly.
@MainActor
public final class DaemonStatus: ObservableObject, DaemonStatusProtocol {

    // MARK: - Components

    /// Observable daemon state (version, model, connection status, etc.).
    public let info: DaemonInfo

    /// Event stream client for SSE and message broadcast.
    public let eventStreamClient: EventStreamClient

    /// Connection lifecycle manager (health checks, auto-wake).
    public let connectionManager: GatewayConnectionManager

    // MARK: - Published State (forwarded from DaemonInfo)

    @Published public var isConnected: Bool = false
    @Published public var httpPort: Int?
    @Published public var daemonVersion: String?
    @Published public var versionMismatch: Bool = false
    @Published public var isUpdateInProgress: Bool = false
    @Published public var updateTargetVersion: String?
    @Published public var keyFingerprint: String?
    @Published public var latestMemoryStatus: MemoryStatusMessage?
    @Published public var isTrustRulesSheetOpen: Bool = false
    @Published public var currentModel: String?
    @Published public var latestModelInfo: ModelInfoMessage?

    public var httpPortResolver: () -> Int? {
        info.httpPortResolver
    }

    var updateExpiresAt: Date? {
        get { info.updateExpiresAt }
        set { info.updateExpiresAt = newValue }
    }

    // MARK: - Forwarding accessors

    public var isConnecting: Bool {
        get { connectionManager.isConnecting }
        set { connectionManager.isConnecting = newValue }
    }

    public var instanceDir: String? {
        get { info.instanceDir }
        set { info.instanceDir = newValue }
    }

    public var recoveryPlatform: String? {
        get { connectionManager.recoveryPlatform }
        set { connectionManager.recoveryPlatform = newValue }
    }

    public var recoveryDeviceId: String? {
        get { connectionManager.recoveryDeviceId }
        set { connectionManager.recoveryDeviceId = newValue }
    }

    public var wakeHandler: (@MainActor @Sendable () async throws -> Void)? {
        get { connectionManager.wakeHandler }
        set { connectionManager.wakeHandler = newValue }
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

    // MARK: - Init

    public init(config: DaemonConfig = .default) {
        let esc = EventStreamClient()
        let cm = GatewayConnectionManager(eventStreamClient: esc)
        let di = DaemonInfo()

        self.eventStreamClient = esc
        self.connectionManager = cm
        self.info = di

        // Wire dependencies
        di.connectionManager = cm
        di.eventStreamClient = esc
        di.instanceDir = config.instanceDir
        self.currentConfig = config

        cm.reconfigure(
            instanceDir: config.instanceDir,
            isRuntimeFlat: config.transportMetadata.routeMode == .runtimeFlat
        )

        // Pre-process SSE messages to update DaemonInfo state before broadcast
        esc.messagePreProcessor = { [weak di] message in
            di?.handleServerMessage(message)
        }

        esc.onConversationIdResolved = { [weak esc] localId, serverId in
            esc?.broadcastMessage(.conversationIdResolved(localId: localId, serverId: serverId))
        }

        esc.onTokenRefreshed = { newToken in
            #if os(iOS)
            let _ = APIKeyManager.shared.setAPIKey(newToken, provider: "runtime-bearer-token")
            #elseif os(macOS)
            // macOS re-reads from disk on each request; no persistence needed here.
            #endif
        }

        // Wire connection state changes to DaemonInfo + sync to local @Published
        cm.onConnectionStateChanged = { [weak self, weak di] connected in
            di?.handleConnectionStateChanged(connected)
            self?.syncFromInfo()
        }

        cm.onDaemonVersionChanged = { [weak self, weak di] newVersion in
            di?.handleDaemonVersionChanged(newVersion)
            self?.syncFromInfo()
        }

        cm.onAuthError = { [weak esc] message in
            esc?.broadcastMessage(message)
        }

        // Observe DaemonInfo changes and forward to our @Published properties
        // so SwiftUI views that observe DaemonStatus see updates.
        infoObservation = di.objectWillChange.sink { [weak self] _ in
            // Schedule sync on next run loop tick (after DaemonInfo finishes updating)
            DispatchQueue.main.async { [weak self] in
                self?.syncFromInfo()
            }
        }
    }

    private var infoObservation: AnyCancellable?
    private var currentConfig: DaemonConfig?

    /// Copy DaemonInfo's state to our @Published properties.
    private func syncFromInfo() {
        if isConnected != info.isConnected { isConnected = info.isConnected }
        if httpPort != info.httpPort { httpPort = info.httpPort }
        if daemonVersion != info.daemonVersion { daemonVersion = info.daemonVersion }
        if versionMismatch != info.versionMismatch { versionMismatch = info.versionMismatch }
        if isUpdateInProgress != info.isUpdateInProgress { isUpdateInProgress = info.isUpdateInProgress }
        if updateTargetVersion != info.updateTargetVersion { updateTargetVersion = info.updateTargetVersion }
        if keyFingerprint != info.keyFingerprint { keyFingerprint = info.keyFingerprint }
        if currentModel != info.currentModel { currentModel = info.currentModel }
        // Reference types — always sync
        latestMemoryStatus = info.latestMemoryStatus
        latestModelInfo = info.latestModelInfo
    }

    // MARK: - Protocol Conformance (forwarding)

    public func subscribe() -> AsyncStream<ServerMessage> {
        eventStreamClient.subscribe()
    }

    public func sendUserMessage(
        content: String?,
        conversationId: String,
        attachments: [UserMessageAttachment]? = nil,
        conversationType: String? = nil,
        automated: Bool? = nil,
        bypassSecretCheck: Bool? = nil
    ) {
        eventStreamClient.sendUserMessage(
            content: content,
            conversationId: conversationId,
            attachments: attachments,
            conversationType: conversationType,
            automated: automated,
            bypassSecretCheck: bypassSecretCheck
        )
    }

    public func startSSE() { eventStreamClient.startSSE() }
    public func stopSSE() { eventStreamClient.stopSSE() }

    public func connect() async throws {
        guard case .http(_, _, let conversationKey) = currentConfig?.transport else {
            log.info("connect: no HTTP transport configured, skipping")
            return
        }
        try await connectionManager.connectImpl(cancelAutoWake: true, conversationKey: conversationKey)
    }

    public func disconnect() {
        connectionManager.disconnect()
        info.isConnected = false
        info.httpPort = nil
        info.latestMemoryStatus = nil
        syncFromInfo()
    }

    public func reconfigure(config newConfig: DaemonConfig) {
        currentConfig = newConfig
        info.instanceDir = newConfig.instanceDir
        connectionManager.reconfigure(
            instanceDir: newConfig.instanceDir,
            isRuntimeFlat: newConfig.transportMetadata.routeMode == .runtimeFlat
        )
        info.resetConnectionState()
        syncFromInfo()
    }

    /// Inject a synthetic server message into the event stream.
    public func injectMessage(_ message: ServerMessage) {
        info.handleServerMessage(message)
        eventStreamClient.broadcastMessage(message)
        syncFromInfo()
    }
}

// MARK: - Backward Compatibility

public typealias DaemonClient = DaemonStatus
public typealias DaemonClientProtocol = DaemonStatusProtocol
