import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonStatus")

/// Shared signpost log for network instrumentation (Points of Interest lane in Instruments).
private let networkLog = OSLog(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: .pointsOfInterest
)

/// Protocol for daemon status and connection management, enabling dependency injection and testing.
@MainActor
public protocol DaemonStatusProtocol: AnyObject {
    var isConnected: Bool { get }
    func subscribe() -> AsyncStream<ServerMessage>
    func sendUserMessage(content: String?, conversationId: String, attachments: [UserMessageAttachment]?, conversationType: String?, automated: Bool?)
    func connect() async throws
    func disconnect()
    func startSSE()
    func stopSSE()
}

/// Observable status of the assistant daemon connection. Publishes connection state,
/// daemon version, model info, and other status properties derived from SSE events.
///
/// Replaces `DaemonClient` as the single observable object for daemon state.
/// Owns `EventStreamClient` (SSE + subscribe) and `HTTPTransport` (health checks).
/// SwiftUI views observe this for connection status and daemon metadata.
@MainActor
public final class DaemonStatus: ObservableObject, DaemonStatusProtocol {

    // MARK: - Published State

    @Published public var isConnected: Bool = false
    public var isConnecting: Bool = false

    /// The runtime HTTP server port, populated via `daemon_status` on connect.
    @Published public var httpPort: Int?

    /// Platform identifier for automatic 401 re-bootstrap (e.g. "macos", "ios").
    public var recoveryPlatform: String?

    /// Device identifier for automatic 401 re-bootstrap.
    public var recoveryDeviceId: String?

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

    var isAuthenticated = false

    // MARK: - Auto-Wake

    /// Optional closure invoked when a connection attempt fails because the daemon process
    /// is not alive. The macOS app sets this to call `vellumCli.wake(name:)`.
    public var wakeHandler: (@MainActor @Sendable () async throws -> Void)?

    #if os(macOS)
    var lastAutoWakeAttempt: Date?
    var autoWakeTask: Task<Void, Never>?
    #endif

    // MARK: - Connection

    /// HTTP transport for health checks and host tool execution.
    public var httpTransport: HTTPTransport?

    public private(set) var config: DaemonConfig

    /// Event stream client for SSE and message broadcast.
    public let eventStreamClient: EventStreamClient

    // MARK: - Init

    public init(config: DaemonConfig = .default) {
        self.config = config
        self.eventStreamClient = EventStreamClient()

        // Wire the pre-processor so state is updated before subscribers see messages
        eventStreamClient.messagePreProcessor = { [weak self] message in
            self?.handleServerMessage(message)
        }
    }

    // MARK: - Subscribe (forwarding)

    public func subscribe() -> AsyncStream<ServerMessage> {
        eventStreamClient.subscribe()
    }

    // MARK: - Send (forwarding)

    /// Fire-and-forget user message send. Delegates to EventStreamClient.
    public func sendUserMessage(
        content: String?,
        conversationId: String,
        attachments: [UserMessageAttachment]? = nil,
        conversationType: String? = nil,
        automated: Bool? = nil
    ) {
        eventStreamClient.sendUserMessage(
            content: content,
            conversationId: conversationId,
            attachments: attachments,
            conversationType: conversationType,
            automated: automated
        )
    }

    // MARK: - SSE (forwarding)

    public func startSSE() {
        eventStreamClient.startSSE()
    }

    public func stopSSE() {
        eventStreamClient.stopSSE()
    }

    // MARK: - Reconfigure

    /// Reconfigure the daemon status transport in place without replacing
    /// the object identity. Preserves subscriber references held by long-lived
    /// objects across assistant switches.
    public func reconfigure(config newConfig: DaemonConfig) {
        #if os(macOS)
        autoWakeTask?.cancel()
        autoWakeTask = nil
        #endif
        disconnect()
        self.config = newConfig
        isAuthenticated = false
        httpPort = nil
        daemonVersion = nil
        versionMismatch = false
        isUpdateInProgress = false
        updateTargetVersion = nil
        updateExpiresAt = nil
        keyFingerprint = nil
        latestMemoryStatus = nil
        currentModel = nil
        #if os(macOS)
        lastAutoWakeAttempt = nil
        #endif
    }

    // MARK: - Connect

    public func connect() async throws {
        try await connectImpl(cancelAutoWake: true)
    }

    private func connectImpl(cancelAutoWake: Bool) async throws {
        disconnectInternal(triggerReconnect: false, cancelAutoWake: cancelAutoWake)

        isConnecting = true

        guard case .http(let baseURL, let bearerToken, let conversationKey) = config.transport else {
            isConnecting = false
            log.info("connect: non-HTTP transport, skipping")
            return
        }

        log.info("connect: establishing HTTP transport to \(baseURL, privacy: .public)")

        let transport = HTTPTransport(
            baseURL: baseURL,
            bearerToken: bearerToken,
            conversationKey: conversationKey,
            transportMetadata: config.transportMetadata
        )

        // Bridge HTTP transport connection state (health-check driven) to DaemonStatus.
        transport.onConnectionStateChanged = { [weak self] connected in
            guard let self else { return }
            self.isConnected = connected
            self.isConnecting = false
            if connected {
                NotificationCenter.default.post(name: .daemonDidReconnect, object: self)
            }
            #if os(macOS)
            if !connected {
                self.autoWakeIfDaemonDied()
            }
            #endif
        }

        // Wire conversation ID resolution from EventStreamClient to subscribers.
        // Only clean up the SSE remapping entry when a subscriber actually handles
        // the resolution (on macOS, ConversationManager updates the VM's conversationId).
        // On iOS, no handler exists — the mapping and synthetic ID must stay so
        // parseSSEData can continue remapping for the unchanged synthetic ID.
        eventStreamClient.onConversationIdResolved = { [weak self] localId, serverId in
            guard let self else { return }
            self.eventStreamClient.broadcastMessage(.conversationIdResolved(localId: localId, serverId: serverId))
        }

        // Persist refreshed bearer tokens so the client survives app restarts.
        eventStreamClient.onTokenRefreshed = { newToken in
            #if os(iOS)
            let _ = APIKeyManager.shared.setAPIKey(newToken, provider: "runtime-bearer-token")
            #elseif os(macOS)
            // macOS re-reads from disk on each request; no persistence needed here.
            #endif
        }

        // Sync daemon version from health checks and confirm update completion.
        transport.onDaemonVersionChanged = { [weak self] newVersion in
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
                self.httpTransport?.setUpdateInProgress(false)
                self.eventStreamClient.resetSSEReconnectDelay()
            }
        }

        // Broadcast auth errors from health check 401 handling to subscribers.
        transport.onAuthError = { [weak self] message in
            guard let self else { return }
            self.eventStreamClient.broadcastMessage(message)
        }

        self.httpTransport = transport

        // Propagate update-in-progress state to new transport
        if isUpdateInProgress {
            transport.isUpdateInProgress = true
        }

        // Register the conversation key for host tool filtering
        if !conversationKey.isEmpty {
            eventStreamClient.registerConversationId(conversationKey)
        }

        do {
            try await transport.connect()
            isAuthenticated = true
            isConnecting = false
            log.info("connect: transport connected successfully to \(baseURL, privacy: .public)")

            // Auto-start SSE now that health check passed
            eventStreamClient.startSSE()
        } catch {
            #if os(macOS)
            guard !Task.isCancelled else {
                isConnecting = false
                httpTransport = nil
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
                        try await transport.connect()
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
            httpTransport = nil
            log.error("connect: transport connection failed for \(baseURL, privacy: .public): \(error)")
            throw error
        }
    }

    // MARK: - Disconnect

    public func disconnect() {
        disconnectInternal(triggerReconnect: false)
    }

    func disconnectInternal(triggerReconnect: Bool, cancelAutoWake: Bool = true) {
        isAuthenticated = false

        #if os(macOS)
        if cancelAutoWake {
            autoWakeTask?.cancel()
            autoWakeTask = nil
        }
        #endif

        httpTransport?.disconnect()
        httpTransport = nil
        // Stop SSE but preserve subscriber streams — consumers (AppDelegate,
        // SettingsStore, ConversationRestorer, etc.) start one-shot for-await
        // loops that must survive reconnects and assistant switches.
        eventStreamClient.stopSSE()

        isConnected = false
        isConnecting = false
        httpPort = nil
        latestMemoryStatus = nil
    }

    // MARK: - Auto-Wake

    #if os(macOS)
    private static let autoWakeCooldown: TimeInterval = 60.0

    private func autoWakeIfDaemonDied() {
        if isUpdateInProgress {
            if let expiry = updateExpiresAt, Date() >= expiry {
                log.warning("auto-wake: planned update expired — clearing stale update state and proceeding")
                isUpdateInProgress = false
                updateTargetVersion = nil
                updateExpiresAt = nil
                httpTransport?.setUpdateInProgress(false)
            } else {
                log.info("auto-wake: skipping — planned service group update in progress")
                return
            }
        }

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

    // MARK: - Token Update

    /// Push a new bearer token to the active HTTP transport.
    public func updateTransportBearerToken(_ token: String) {
        httpTransport?.updateBearerToken(token)
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

    // MARK: - Synthetic Message Injection

    /// Inject a synthetic server message into the event stream. The message
    /// is processed by the state pre-processor and then broadcast to all
    /// subscribers, exactly as if it arrived via SSE.
    ///
    /// Used by focused clients (e.g. `AppsClient`) that need to trigger UI
    /// updates (surface show) without a real SSE event.
    public func injectMessage(_ message: ServerMessage) {
        handleServerMessage(message)
        eventStreamClient.broadcastMessage(message)
    }

    // MARK: - Message Pre-Processing

    /// Handle server messages that update DaemonStatus state. Called synchronously
    /// before the message is broadcast to subscribers.
    private func handleServerMessage(_ message: ServerMessage) {
        // Handle daemon status updates
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
                    self.httpTransport?.setUpdateInProgress(false)
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

        // Handle service group update lifecycle
        switch message {
        case .serviceGroupUpdateStarting(let msg):
            self.isUpdateInProgress = true
            self.updateTargetVersion = msg.targetVersion
            self.updateExpiresAt = Date().addingTimeInterval(msg.expectedDowntimeSeconds * 2)
            self.httpTransport?.setUpdateInProgress(true)
            log.info("Service group update starting — target: \(msg.targetVersion, privacy: .public), expected downtime: \(msg.expectedDowntimeSeconds)s")
        case .serviceGroupUpdateComplete:
            self.isUpdateInProgress = false
            self.updateTargetVersion = nil
            self.updateExpiresAt = nil
            self.httpTransport?.setUpdateInProgress(false)
        case .modelInfo(let msg):
            currentModel = msg.model
            latestModelInfo = msg
        case .memoryStatus(let msg):
            latestMemoryStatus = msg
        case .authResult(let result):
            isAuthenticated = result.success

        // Handle host tool requests
        case .hostBashRequest(let msg):
            handleHostBashRequest(msg)
        case .hostFileRequest(let msg):
            handleHostFileRequest(msg)

        // Handle signing identity (macOS only)
        #if os(macOS)
        case .signBundlePayload(let msg):
            handleSignBundlePayload(msg)
        case .getSigningIdentity(let msg):
            handleGetSigningIdentity(msg)
        #elseif os(iOS)
        case .signBundlePayload(let msg):
            log.warning("Received sign_bundle_payload request on iOS — signing not supported")
            // Response sending is a no-op in HTTP transport; omitted.
        case .getSigningIdentity(let msg):
            log.warning("Received get_signing_identity request on iOS — signing not supported")
            // Response sending is a no-op in HTTP transport; omitted.
        #endif

        default:
            break
        }
    }

    // MARK: - Host File Proxy

    private func handleHostFileRequest(_ msg: HostFileRequest) {
        #if os(macOS)
        httpTransport?.executeHostFileRequest(msg)
        #else
        log.warning("Received host_file_request on iOS — local file operations not supported")
        Task {
            let result = HostFileResultPayload(
                requestId: msg.requestId,
                content: "Host file operations are not supported on iOS",
                isError: true
            )
            _ = await HostProxyClient().postFileResult(result)
        }
        #endif
    }

    // MARK: - Host Bash Proxy

    private func handleHostBashRequest(_ msg: HostBashRequest) {
        #if os(macOS)
        httpTransport?.executeHostBashRequest(msg)
        #else
        log.warning("Received host_bash_request on iOS — local execution not supported")
        Task {
            let result = HostBashResultPayload(
                requestId: msg.requestId,
                stdout: "",
                stderr: "Host bash execution is not supported on iOS",
                exitCode: nil,
                timedOut: false
            )
            _ = await HostProxyClient().postBashResult(result)
        }
        #endif
    }

    // MARK: - Signing Identity (macOS only)

    #if os(macOS)
    private func handleSignBundlePayload(_ msg: SignBundlePayloadMessage) {
        do {
            let payloadData = Data(msg.payload.utf8)
            let signature = try SigningIdentityManager.shared.sign(payloadData)
            let keyId = try SigningIdentityManager.shared.getKeyId()
            let publicKey = try SigningIdentityManager.shared.getPublicKey()

            // Sign response — post via HTTP since SSE is one-way
            Task {
                _ = try? await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/sign-bundle-response",
                    json: [
                        "requestId": msg.requestId,
                        "signature": signature.base64EncodedString(),
                        "keyId": keyId,
                        "publicKey": publicKey.rawRepresentation.base64EncodedString()
                    ] as [String: Any]
                )
            }
        } catch {
            log.error("Failed to sign bundle payload: \(error.localizedDescription)")
        }
    }

    private func handleGetSigningIdentity(_ msg: GetSigningIdentityRequest) {
        do {
            let keyId = try SigningIdentityManager.shared.getKeyId()
            let publicKey = try SigningIdentityManager.shared.getPublicKey()

            Task {
                _ = try? await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/signing-identity-response",
                    json: [
                        "requestId": msg.requestId,
                        "keyId": keyId,
                        "publicKey": publicKey.rawRepresentation.base64EncodedString()
                    ] as [String: Any]
                )
            }
        } catch {
            log.error("Failed to get signing identity: \(error.localizedDescription)")
        }
    }
    #endif

    deinit {
        #if os(macOS)
        autoWakeTask?.cancel()
        #endif
    }
}

// MARK: - Backward Compatibility

/// Typealias so existing code referencing `DaemonClient` compiles unchanged.
/// New code should use `DaemonStatus` directly.
public typealias DaemonClient = DaemonStatus

/// Typealias so existing code referencing `DaemonClientProtocol` compiles unchanged.
public typealias DaemonClientProtocol = DaemonStatusProtocol
