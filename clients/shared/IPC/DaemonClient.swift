import Foundation
import Network
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonClient")

/// Protocol for daemon client communication, enabling dependency injection and testing.
@MainActor
public protocol DaemonClientProtocol {
    func subscribe() -> AsyncStream<ServerMessage>
    func send<T: Encodable>(_ message: T) throws
}

/// Platform-agnostic client for communicating with the Vellum daemon.
///
/// **macOS**: Connects via Unix domain socket at `~/.vellum/vellum.sock` (or `VELLUM_DAEMON_SOCKET` env override).
/// **iOS**: Connects via TCP to configurable hostname:port (UserDefaults: `daemon_hostname`, `daemon_port`).
///
/// Sends and receives newline-delimited JSON messages over the connection.
///
/// This is a long-lived singleton. Consumers call `subscribe()` to get an independent message
/// stream, enabling multiple consumers (ComputerUseSession, AmbientAgent) to each receive all
/// messages and filter for the ones relevant to them.
@MainActor
public final class DaemonClient: ObservableObject, DaemonClientProtocol {

    // MARK: - Published State

    @Published public var isConnected: Bool = false

    // MARK: - Surface Event Callbacks

    /// Called when the daemon sends a `ui_surface_show` message.
    /// Set by the app layer to forward to SurfaceManager without coupling DaemonClient to it.
    public var onSurfaceShow: ((UiSurfaceShowMessage) -> Void)?

    /// Called when the daemon sends a `ui_surface_update` message.
    public var onSurfaceUpdate: ((UiSurfaceUpdateMessage) -> Void)?

    /// Called when the daemon sends a `ui_surface_dismiss` message.
    public var onSurfaceDismiss: ((UiSurfaceDismissMessage) -> Void)?

    /// Called when the daemon sends an `app_data_response` message.
    public var onAppDataResponse: ((AppDataResponseMessage) -> Void)?

    /// Called when the daemon sends a `message_queued` message.
    public var onMessageQueued: ((MessageQueuedMessage) -> Void)?

    /// Called when the daemon sends a `message_dequeued` message.
    public var onMessageDequeued: ((MessageDequeuedMessage) -> Void)?

    /// Called when the daemon sends a `generation_handoff` message.
    public var onGenerationHandoff: ((GenerationHandoffMessage) -> Void)?

    /// Called when the daemon sends a `confirmation_request` message for tool permission approval.
    public var onConfirmationRequest: ((ConfirmationRequestMessage) -> Void)?

    /// Called when the daemon sends a `secret_request` message for secure credential input.
    public var onSecretRequest: ((SecretRequestMessage) -> Void)?

    /// Called when the daemon sends a `task_routed` message (e.g. escalation from text_qa to CU).
    public var onTaskRouted: ((TaskRoutedMessage) -> Void)?

    /// Called when a pomodoro timer completes.
    public var onTimerCompleted: ((TimerCompletedMessage) -> Void)?

    /// Called when the daemon sends a `trust_rules_list_response` message.
    public var onTrustRulesListResponse: (([TrustRuleItem]) -> Void)?

    /// Called when the daemon sends a `skills_state_changed` push event.
    public var onSkillStateChanged: ((SkillStateChangedMessage) -> Void)?

    /// Called when the daemon sends a `skills_updates_available` push event.
    public var onSkillsUpdatesAvailable: ((SkillsUpdatesAvailableMessage) -> Void)?

    /// Called when the daemon sends a `skills_operation_response` message.
    public var onSkillsOperationResponse: ((SkillsOperationResponseMessage) -> Void)?

    /// Called when the daemon sends a `skills_inspect_response` message.
    public var onSkillsInspectResponse: ((SkillsInspectResponseMessage) -> Void)?

    /// Called when the daemon sends an `apps_list_response` message.
    public var onAppsListResponse: ((AppsListResponseMessage) -> Void)?

    /// Called when the daemon sends a `shared_apps_list_response` message.
    public var onSharedAppsListResponse: ((SharedAppsListResponseMessage) -> Void)?

    /// Called when the daemon sends a `shared_app_delete_response` message.
    public var onSharedAppDeleteResponse: ((SharedAppDeleteResponseMessage) -> Void)?

    /// Called when the daemon sends a `bundle_app_response` message.
    public var onBundleAppResponse: ((BundleAppResponseMessage) -> Void)?

    /// Called when the daemon sends an `open_bundle_response` message.
    public var onOpenBundleResponse: ((OpenBundleResponseMessage) -> Void)?

    /// Called when the daemon sends a `session_list_response` message.
    public var onSessionListResponse: ((SessionListResponseMessage) -> Void)?

    /// Called when the daemon sends a `history_response` message.
    public var onHistoryResponse: ((HistoryResponseMessage) -> Void)?

    /// Called when the daemon sends a generic `error` message (e.g. when a handler fails).
    public var onError: ((ErrorMessage) -> Void)?

    // MARK: - Broadcast Subscribers

    /// Creates a new message stream for the caller. Each subscriber receives all messages
    /// independently, enabling multiple consumers (ComputerUseSession, AmbientAgent) to
    /// filter for messages relevant to them without competing for elements.
    public func subscribe() -> AsyncStream<ServerMessage> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.subscribers.removeValue(forKey: id)
            }
        }
        return stream
    }

    // MARK: - Private State

    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "com.vellum.vellum-assistant.daemon-client", qos: .userInitiated)

    private var subscribers: [UUID: AsyncStream<ServerMessage>.Continuation] = [:]

    /// Buffer for accumulating incoming data until we have complete newline-delimited messages.
    private var receiveBuffer = Data()

    /// Maximum line size: 96 MB (for screenshots with base64).
    private let maxLineSize = 96 * 1024 * 1024

    /// Whether we should attempt to reconnect on disconnect.
    private var shouldReconnect = true

    /// Current reconnect backoff delay in seconds.
    private var reconnectDelay: TimeInterval = 1.0

    /// Maximum reconnect backoff delay.
    private let maxReconnectDelay: TimeInterval = 30.0

    /// Reconnect task handle.
    private var reconnectTask: Task<Void, Never>?

    /// Ping timer task handle.
    private var pingTask: Task<Void, Never>?

    /// Whether we're waiting for a pong response.
    private var awaitingPong = false

    /// Pong timeout task handle.
    private var pongTimeoutTask: Task<Void, Never>?

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - Init

    public init() {}

    deinit {
        // Swift 5.9+: deinit on @MainActor class is NOT guaranteed to run on main actor.
        // Cannot use MainActor.assumeIsolated here as it would crash if deinit runs on
        // a background thread (e.g., if last reference is released from a background context).
        //
        // Instead, we access the properties directly. While this is technically a data race,
        // the cleanup operations are all thread-safe:
        // - Task.cancel() is thread-safe
        // - NWConnection.cancel() is thread-safe
        // - AsyncStream.Continuation.finish() is thread-safe
        //
        // Setting shouldReconnect and accessing subscribers are data races, but they're
        // benign in deinit since the object is being destroyed and no other code can
        // access these properties.
        shouldReconnect = false
        reconnectTask?.cancel()
        pingTask?.cancel()
        pongTimeoutTask?.cancel()
        connection?.cancel()
        for continuation in subscribers.values {
            continuation.finish()
        }
        subscribers.removeAll()
    }

    // MARK: - Socket Path

    /// Resolves the daemon socket path (macOS only):
    /// 1. `VELLUM_DAEMON_SOCKET` environment variable (or override dictionary)
    /// 2. `~/.vellum/vellum.sock`
    ///
    /// Accepts an optional environment dictionary for testability.
    #if os(macOS)
    public static func resolveSocketPath(environment: [String: String]? = nil) -> String {
        let env = environment ?? ProcessInfo.processInfo.environment
        if let envPath = env["VELLUM_DAEMON_SOCKET"], !envPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let trimmed = envPath.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("~/") {
                return NSHomeDirectory() + "/" + String(trimmed.dropFirst(2))
            }
            return trimmed
        }
        return NSHomeDirectory() + "/.vellum/vellum.sock"
    }
    #endif

    // MARK: - Connect

    /// How long to wait for a connection before giving up.
    private static let connectTimeout: TimeInterval = 5.0

    /// Connect to the daemon. If already connected, disconnects first.
    /// - macOS: Connects to Unix domain socket at `~/.vellum/vellum.sock`
    /// - iOS: Connects to TCP endpoint (hostname from UserDefaults or localhost:8765)
    public func connect() async throws {
        // Disconnect any existing connection without triggering reconnect.
        disconnectInternal(triggerReconnect: false)

        shouldReconnect = true

        #if os(macOS)
        let socketPath = Self.resolveSocketPath()
        log.info("Connecting to daemon socket at \(socketPath)")
        let endpoint = NWEndpoint.unix(path: socketPath)
        #elseif os(iOS)
        let hostname = UserDefaults.standard.string(forKey: "daemon_hostname") ?? "localhost"
        let rawPort = UserDefaults.standard.integer(forKey: "daemon_port")
        let port = UInt16(clamping: rawPort > 0 && rawPort <= 65535 ? rawPort : 8765)
        log.info("Connecting to daemon at \(hostname):\(port)")
        let endpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host(hostname),
            port: NWEndpoint.Port(integerLiteral: port)
        )
        #else
        #error("DaemonClient is only supported on macOS and iOS")
        #endif

        let parameters = NWParameters()
        parameters.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()

        let conn = NWConnection(to: endpoint, using: parameters)
        self.connection = conn

        try await withCheckedThrowingContinuation { (checkedContinuation: CheckedContinuation<Void, Error>) in
            var resumed = false

            // Timeout: if we haven't connected within the deadline, fail.
            let timeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: UInt64(Self.connectTimeout * 1_000_000_000))
                } catch { return }

                guard !resumed else { return }
                resumed = true
                log.error("Connection timed out after \(Self.connectTimeout)s")
                self?.isConnected = false
                self?.stopPingTimer()
                conn.stateUpdateHandler = nil
                conn.cancel()
                checkedContinuation.resume(throwing: NWError.posix(.ETIMEDOUT))
            }

            conn.stateUpdateHandler = { [weak self] state in
                guard let self else { return }

                Task { @MainActor in
                    switch state {
                    case .ready:
                        if !resumed {
                            resumed = true
                            timeoutTask.cancel()
                            log.info("Connected to daemon socket")
                            self.isConnected = true
                            self.reconnectDelay = 1.0
                            self.startReceiveLoop()
                            self.startPingTimer()
                            checkedContinuation.resume()
                        }

                    case .failed(let error):
                        log.error("Connection failed: \(error.localizedDescription)")
                        self.isConnected = false
                        self.stopPingTimer()
                        if !resumed {
                            resumed = true
                            timeoutTask.cancel()
                            checkedContinuation.resume(throwing: error)
                        } else {
                            self.scheduleReconnect()
                        }

                    case .cancelled:
                        log.info("Connection cancelled")
                        self.isConnected = false
                        self.stopPingTimer()
                        if !resumed {
                            resumed = true
                            timeoutTask.cancel()
                            checkedContinuation.resume(throwing: NWError.posix(.ECANCELED))
                        }

                    case .waiting(let error):
                        log.warning("Connection waiting: \(error.localizedDescription)")
                        // Don't resume the continuation yet; NWConnection may still transition to .ready.
                        // The timeout task will handle the case where it never does.

                    default:
                        break
                    }
                }
            }

            conn.start(queue: self.queue)
        }
    }

    // MARK: - Send

    public enum SendError: Error, LocalizedError {
        case notConnected

        public var errorDescription: String? {
            switch self {
            case .notConnected:
                return "Cannot send: not connected to daemon"
            }
        }
    }

    /// Send a message to the daemon.
    /// Encodes the message as JSON, appends a newline, and writes to the connection.
    /// Throws `SendError.notConnected` when the connection is nil so callers can
    /// distinguish a silently-dropped message from a successful write.
    public func send<T: Encodable>(_ message: T) throws {
        guard let conn = connection else {
            log.warning("Cannot send: not connected")
            throw SendError.notConnected
        }

        var data = try encoder.encode(message)
        data.append(contentsOf: [0x0A]) // newline byte

        conn.send(content: data, completion: .contentProcessed { error in
            if let error {
                log.error("Send failed: \(error.localizedDescription)")
            }
        })
    }

    // MARK: - Surface Actions

    /// Convenience method for sending a surface action response to the daemon.
    /// Keeps the IPC message construction co-located with the client.
    public func sendSurfaceAction(sessionId: String, surfaceId: String, actionId: String, data: [String: AnyCodable]?) throws {
        let message = UiSurfaceActionMessage(
            sessionId: sessionId,
            surfaceId: surfaceId,
            actionId: actionId,
            data: data
        )
        try send(message)
    }

    // MARK: - Confirmation Response

    /// Send a confirmation response for a tool permission request.
    public func sendConfirmationResponse(
        requestId: String,
        decision: String,
        selectedPattern: String? = nil,
        selectedScope: String? = nil
    ) throws {
        try send(ConfirmationResponseMessage(
            requestId: requestId,
            decision: decision,
            selectedPattern: selectedPattern,
            selectedScope: selectedScope
        ))
    }

    // MARK: - Secret Response

    /// Send a secret response for a credential prompt request.
    public func sendSecretResponse(requestId: String, value: String?) throws {
        try send(SecretResponseMessage(requestId: requestId, value: value))
    }

    // MARK: - Trust Rule Addition

    /// Send an add_trust_rule message to persist a trust rule on the daemon.
    public func sendAddTrustRule(
        toolName: String,
        pattern: String,
        scope: String,
        decision: String
    ) throws {
        try send(AddTrustRuleMessage(
            toolName: toolName,
            pattern: pattern,
            scope: scope,
            decision: decision
        ))
    }

    // MARK: - Trust Rule Management

    /// Request the list of all trust rules from the daemon.
    public func sendListTrustRules() throws {
        try send(TrustRulesListMessage())
    }

    /// Remove a trust rule by its ID.
    public func sendRemoveTrustRule(id: String) throws {
        try send(RemoveTrustRuleMessage(id: id))
    }

    /// Update fields on an existing trust rule.
    public func sendUpdateTrustRule(
        id: String,
        tool: String? = nil,
        pattern: String? = nil,
        scope: String? = nil,
        decision: String? = nil,
        priority: Int? = nil
    ) throws {
        try send(UpdateTrustRuleMessage(
            id: id,
            tool: tool,
            pattern: pattern,
            scope: scope,
            decision: decision,
            priority: priority
        ))
    }

    // MARK: - Skills Management

    /// Enable a skill by name.
    public func enableSkill(_ name: String) throws {
        try send(SkillsEnableMessage(name: name))
    }

    /// Disable a skill by name.
    public func disableSkill(_ name: String) throws {
        try send(SkillsDisableMessage(name: name))
    }

    /// Install a skill from ClaWHub.
    public func installSkill(slug: String, version: String? = nil) throws {
        try send(SkillsInstallMessage(slug: slug, version: version))
    }

    /// Uninstall a skill by name.
    public func uninstallSkill(_ name: String) throws {
        try send(SkillsUninstallMessage(name: name))
    }

    /// Update a skill to its latest version.
    public func updateSkill(_ name: String) throws {
        try send(SkillsUpdateMessage(name: name))
    }

    /// Check for available skill updates.
    public func checkSkillUpdates() throws {
        try send(SkillsCheckUpdatesMessage())
    }

    /// Search for skills on ClaWHub.
    public func searchSkills(query: String) throws {
        try send(SkillsSearchMessage(query: query))
    }

    /// Inspect a ClaWHub skill for detailed metadata.
    public func inspectSkill(slug: String) throws {
        try send(SkillsInspectMessage(slug: slug))
    }

    /// Configure a skill's environment, API key, or config.
    public func configureSkill(name: String, env: [String: String]? = nil, apiKey: String? = nil, config: [String: AnyCodable]? = nil) throws {
        try send(SkillsConfigureMessage(name: name, env: env, apiKey: apiKey, config: config))
    }

    // MARK: - Regenerate

    /// Regenerate the last assistant response for a session.
    func sendRegenerate(sessionId: String) throws {
        try send(RegenerateMessage(sessionId: sessionId))
    }

    // MARK: - Sessions

    /// Request the list of past sessions from the daemon.
    public func sendSessionList() throws {
        try send(SessionListRequestMessage())
    }

    /// Request message history for a specific session.
    public func sendHistoryRequest(sessionId: String) throws {
        try send(HistoryRequestMessage(sessionId: sessionId))
    }

    // MARK: - Apps

    /// Request the list of all apps from the daemon.
    public func sendAppsList() throws {
        try send(AppsListRequestMessage())
    }

    /// Request bundling an app for sharing.
    public func sendBundleApp(appId: String) throws {
        try send(BundleAppRequestMessage(appId: appId))
    }

    /// Request opening and scanning a .vellumapp bundle.
    public func sendOpenBundle(filePath: String) throws {
        try send(OpenBundleMessage(filePath: filePath))
    }

    /// Request the list of shared/received apps.
    public func sendSharedAppsList() throws {
        try send(SharedAppsListRequestMessage())
    }

    /// Delete a shared app by UUID.
    public func sendSharedAppDelete(uuid: String) throws {
        try send(SharedAppDeleteRequestMessage(uuid: uuid))
    }

    // MARK: - Signing Identity (macOS only)

    #if os(macOS)
    /// Handle a sign_bundle_payload request from the daemon.
    private func handleSignBundlePayload(_ msg: SignBundlePayloadMessage) {
        do {
            let payloadData = Data(msg.payload.utf8)
            let signature = try SigningIdentityManager.shared.sign(payloadData)
            let keyId = try SigningIdentityManager.shared.getKeyId()
            let publicKey = try SigningIdentityManager.shared.getPublicKey()

            try send(SignBundlePayloadResponseMessage(
                signature: signature.base64EncodedString(),
                keyId: keyId,
                publicKey: publicKey.rawRepresentation.base64EncodedString()
            ))
        } catch {
            log.error("Failed to sign bundle payload: \(error.localizedDescription)")
        }
    }

    /// Handle a get_signing_identity request from the daemon.
    private func handleGetSigningIdentity() {
        do {
            let keyId = try SigningIdentityManager.shared.getKeyId()
            let publicKey = try SigningIdentityManager.shared.getPublicKey()

            try send(GetSigningIdentityResponseMessage(
                keyId: keyId,
                publicKey: publicKey.rawRepresentation.base64EncodedString()
            ))
        } catch {
            log.error("Failed to get signing identity: \(error.localizedDescription)")
        }
    }
    #endif

    // MARK: - Disconnect

    /// Disconnect from the daemon. Stops reconnect and ping timers.
    public func disconnect() {
        disconnectInternal(triggerReconnect: false)
    }

    private func disconnectInternal(triggerReconnect: Bool) {
        shouldReconnect = triggerReconnect
        reconnectTask?.cancel()
        reconnectTask = nil
        stopPingTimer()

        if let conn = connection {
            conn.stateUpdateHandler = nil
            conn.cancel()
            connection = nil
        }

        receiveBuffer = Data()
        isConnected = false

        // Finish all subscriber streams so `for await` loops terminate
        // instead of hanging forever on disconnect.
        for continuation in subscribers.values {
            continuation.finish()
        }
        subscribers.removeAll()
    }

    // MARK: - Receive Loop

    private func startReceiveLoop() {
        guard let conn = connection else { return }
        receiveData(on: conn)
    }

    private func receiveData(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] content, _, isComplete, error in
            guard let self else { return }

            Task { @MainActor in
                if let data = content, !data.isEmpty {
                    self.processReceivedData(data)
                }

                if isComplete {
                    log.info("Connection received EOF")
                    self.handleUnexpectedDisconnect()
                    return
                }

                if let error {
                    log.error("Receive error: \(error.localizedDescription)")
                    self.handleUnexpectedDisconnect()
                    return
                }

                // Continue reading.
                self.receiveData(on: conn)
            }
        }
    }

    /// Buffer incoming data, split on newlines, decode each complete line as ServerMessage.
    private func processReceivedData(_ data: Data) {
        receiveBuffer.append(data)

        // Check max buffer size.
        if receiveBuffer.count > maxLineSize {
            log.error("Receive buffer exceeded max line size (\(self.maxLineSize) bytes), clearing buffer")
            receiveBuffer = Data()
            return
        }

        // Split on newlines.
        let newline = UInt8(0x0A)
        while let newlineIndex = receiveBuffer.firstIndex(of: newline) {
            let lineData = receiveBuffer[receiveBuffer.startIndex..<newlineIndex]
            receiveBuffer = receiveBuffer[(newlineIndex + 1)...]

            // Skip empty lines.
            guard !lineData.isEmpty else { continue }

            do {
                let message = try decoder.decode(ServerMessage.self, from: Data(lineData))
                handleServerMessage(message)
            } catch {
                let lineString = String(data: Data(lineData), encoding: .utf8) ?? "<binary>"
                let prefix = lineString.count > 200 ? String(lineString.prefix(200)) + "..." : lineString
                log.error("Failed to decode server message: \(error.localizedDescription), line: \(prefix)")
            }
        }
    }

    private func handleServerMessage(_ message: ServerMessage) {
        // Handle pong internally.
        if case .pong = message {
            awaitingPong = false
            pongTimeoutTask?.cancel()
            pongTimeoutTask = nil
        }

        // Forward surface messages to registered callbacks.
        switch message {
        case .uiSurfaceShow(let msg):
            // Inline surfaces are rendered in-chat by ChatViewModel; skip the floating panel.
            if msg.display != "inline" {
                onSurfaceShow?(msg)
            }
        case .uiSurfaceUpdate(let msg):
            onSurfaceUpdate?(msg)
        case .uiSurfaceDismiss(let msg):
            onSurfaceDismiss?(msg)
        case .appDataResponse(let msg):
            onAppDataResponse?(msg)
        case .messageQueued(let msg):
            onMessageQueued?(msg)
        case .messageDequeued(let msg):
            onMessageDequeued?(msg)
        case .generationHandoff(let msg):
            onGenerationHandoff?(msg)
        case .confirmationRequest(let msg):
            onConfirmationRequest?(msg)
        case .secretRequest(let msg):
            onSecretRequest?(msg)
        case .taskRouted(let msg):
            onTaskRouted?(msg)
        case .timerCompleted(let msg):
            onTimerCompleted?(msg)
        case .trustRulesListResponse(let msg):
            onTrustRulesListResponse?(msg.rules)
        case .skillStateChanged(let msg):
            onSkillStateChanged?(msg)
        case .skillsUpdatesAvailable(let msg):
            onSkillsUpdatesAvailable?(msg)
        case .skillsOperationResponse(let msg):
            onSkillsOperationResponse?(msg)
        case .skillsInspectResponse(let msg):
            onSkillsInspectResponse?(msg)
        case .appsListResponse(let msg):
            onAppsListResponse?(msg)
        case .sharedAppsListResponse(let msg):
            onSharedAppsListResponse?(msg)
        case .sharedAppDeleteResponse(let msg):
            onSharedAppDeleteResponse?(msg)
        case .bundleAppResponse(let msg):
            onBundleAppResponse?(msg)
        case .openBundleResponse(let msg):
            onOpenBundleResponse?(msg)
        case .sessionListResponse(let msg):
            onSessionListResponse?(msg)
        case .historyResponse(let msg):
            onHistoryResponse?(msg)
        case .error(let msg):
            onError?(msg)
        #if os(macOS)
        case .signBundlePayload(let msg):
            handleSignBundlePayload(msg)
        case .getSigningIdentity:
            handleGetSigningIdentity()
        #elseif os(iOS)
        case .signBundlePayload:
            log.error("Received sign_bundle_payload request on iOS - signing operations are not supported on iOS due to sandboxing restrictions")
        case .getSigningIdentity:
            log.error("Received get_signing_identity request on iOS - signing operations are not supported on iOS due to sandboxing restrictions")
        #else
        case .signBundlePayload, .getSigningIdentity:
            log.error("Signing operations are not supported on this platform")
        #endif
        default:
            break
        }

        // Broadcast to all subscribers.
        for continuation in subscribers.values {
            continuation.yield(message)
        }
    }

    // MARK: - Reconnect

    private func handleUnexpectedDisconnect() {
        disconnectInternal(triggerReconnect: shouldReconnect)
        if shouldReconnect {
            // Re-enable reconnect since disconnectInternal sets it based on the parameter.
            self.shouldReconnect = true
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard shouldReconnect else { return }
        reconnectTask?.cancel()

        let delay = reconnectDelay
        log.info("Scheduling reconnect in \(delay)s")

        reconnectTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return // Cancelled.
            }

            guard let self, self.shouldReconnect else { return }

            // Increase backoff for next attempt.
            self.reconnectDelay = min(self.reconnectDelay * 2, self.maxReconnectDelay)

            do {
                try await self.connect()
            } catch {
                log.error("Reconnect failed: \(error.localizedDescription)")
                // connect() failure will trigger another scheduleReconnect via stateUpdateHandler
                // only if we haven't already scheduled one.
                if self.shouldReconnect && self.reconnectTask == nil {
                    self.scheduleReconnect()
                }
            }
        }
    }

    // MARK: - Ping / Pong

    private func startPingTimer() {
        stopPingTimer()

        pingTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 30_000_000_000) // 30 seconds
                } catch {
                    return // Cancelled.
                }

                guard let self, self.isConnected else { return }

                self.sendPing()
            }
        }
    }

    private func stopPingTimer() {
        pingTask?.cancel()
        pingTask = nil
        pongTimeoutTask?.cancel()
        pongTimeoutTask = nil
        awaitingPong = false
    }

    private func sendPing() {
        do {
            try send(PingMessage())
            awaitingPong = true

            // Start pong timeout.
            pongTimeoutTask?.cancel()
            pongTimeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: 10_000_000_000) // 10 seconds
                } catch {
                    return // Cancelled.
                }

                guard let self, self.awaitingPong else { return }
                log.warning("Pong timeout, reconnecting")
                self.handleUnexpectedDisconnect()
            }
        } catch {
            log.error("Failed to send ping: \(error.localizedDescription)")
        }
    }
}
