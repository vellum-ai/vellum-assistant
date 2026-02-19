import Foundation
import Network
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonClient")

#if os(macOS)
private func expandHomePath(_ path: String) -> String {
    if path == "~" {
        return NSHomeDirectory()
    }
    if path.hasPrefix("~/") {
        return NSHomeDirectory() + "/" + String(path.dropFirst(2))
    }
    return path
}

/// Resolve the Unix domain socket path for the daemon connection.
/// Returns the path in priority order:
/// 1. `VELLUM_DAEMON_SOCKET` environment variable (trimmed, with ~/ expansion)
/// 2. `~/.vellum/vellum.sock`
///
/// Accepts an optional environment dictionary for testability.
func resolveSocketPath(environment: [String: String]? = nil) -> String {
    let env = environment ?? ProcessInfo.processInfo.environment
    if let envPath = env["VELLUM_DAEMON_SOCKET"], !envPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        let trimmed = envPath.trimmingCharacters(in: .whitespacesAndNewlines)
        return expandHomePath(trimmed)
    }
    if let baseDir = env["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines), !baseDir.isEmpty {
        return expandHomePath(baseDir) + "/.vellum/vellum.sock"
    }
    return NSHomeDirectory() + "/.vellum/vellum.sock"
}

/// Resolve the daemon session token path.
/// Uses BASE_DATA_DIR when set to match daemon root resolution.
func resolveSessionTokenPath(environment: [String: String]? = nil) -> String {
    let env = environment ?? ProcessInfo.processInfo.environment
    if let baseDir = env["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines), !baseDir.isEmpty {
        return expandHomePath(baseDir) + "/.vellum/session-token"
    }
    return NSHomeDirectory() + "/.vellum/session-token"
}

/// Read the daemon session token from disk.
func readSessionToken(environment: [String: String]? = nil) -> String? {
    let tokenPath = resolveSessionTokenPath(environment: environment)
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: tokenPath)),
          let token = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
          !token.isEmpty else {
        return nil
    }
    return token
}

#endif

/// Protocol for daemon client communication, enabling dependency injection and testing.
@MainActor
public protocol DaemonClientProtocol {
    var isConnected: Bool { get }
    var isBlobTransportAvailable: Bool { get }
    func subscribe() -> AsyncStream<ServerMessage>
    func send<T: Encodable>(_ message: T) throws
    func connect() async throws
    func disconnect()
}

extension Notification.Name {
    /// Posted by `DaemonClient` on the main actor immediately after `isConnected` transitions to `true`.
    public static let daemonDidReconnect = Notification.Name("daemonDidReconnect")
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
    private var isConnecting: Bool = false

    /// Whether blob transport has been verified for this connection.
    /// Resets to `false` on disconnect/reconnect. Only set to `true` after
    /// a successful probe round-trip on macOS local-socket connections.
    @Published public private(set) var isBlobTransportAvailable: Bool = false

    /// The runtime HTTP server port, populated via `daemon_status` on connect.
    /// `nil` means the HTTP server is not running.
    @Published public var httpPort: Int?

    /// Latest memory health payload from daemon `memory_status` events.
    @Published public var latestMemoryStatus: MemoryStatusMessage?

    /// Whether a TrustRulesView sheet is currently open from any settings surface.
    /// Used to prevent multiple trust rules sheets from racing on the shared callback.
    @Published public var isTrustRulesSheetOpen: Bool = false

    // MARK: - Surface Event Callbacks

    /// Called when the daemon sends a `ui_surface_show` message.
    /// Set by the app layer to forward to SurfaceManager without coupling DaemonClient to it.
    public var onSurfaceShow: ((UiSurfaceShowMessage) -> Void)?

    /// Called when the daemon sends a `ui_surface_update` message.
    public var onSurfaceUpdate: ((UiSurfaceUpdateMessage) -> Void)?

    /// Called when the daemon sends a `ui_surface_dismiss` message.
    public var onSurfaceDismiss: ((UiSurfaceDismissMessage) -> Void)?

    /// Called when the daemon sends a `ui_surface_complete` message.
    public var onSurfaceComplete: ((UiSurfaceCompleteMessage) -> Void)?

    /// Called when the daemon sends a `document_editor_show` message.
    public var onDocumentEditorShow: ((DocumentEditorShowMessage) -> Void)?

    /// Called when the daemon sends a `document_editor_update` message.
    public var onDocumentEditorUpdate: ((DocumentEditorUpdateMessage) -> Void)?

    /// Called when the daemon sends a `document_save_response` message.
    public var onDocumentSaveResponse: ((DocumentSaveResponseMessage) -> Void)?

    /// Called when the daemon sends a `document_list_response` message.
    public var onDocumentListResponse: ((DocumentListResponseMessage) -> Void)?

    /// Called when the daemon sends a `document_load_response` message.
    public var onDocumentLoadResponse: ((DocumentLoadResponseMessage) -> Void)?

    /// Called when the daemon sends an `app_files_changed` broadcast.
    public var onAppFilesChanged: ((String) -> Void)?

    /// Called when the daemon sends an `app_data_response` message.
    public var onAppDataResponse: ((AppDataResponseMessage) -> Void)?

    /// Called when the daemon sends a `message_queued` message.
    public var onMessageQueued: ((MessageQueuedMessage) -> Void)?

    /// Called when the daemon sends a `message_dequeued` message.
    public var onMessageDequeued: ((MessageDequeuedMessage) -> Void)?

    /// Called when the daemon sends a `message_queued_deleted` message.
    public var onMessageQueuedDeleted: ((MessageQueuedDeletedMessage) -> Void)?

    /// Called when the daemon sends a `generation_handoff` message.
    public var onGenerationHandoff: ((GenerationHandoffMessage) -> Void)?

    /// Called when the daemon sends a `confirmation_request` message for tool permission approval.
    public var onConfirmationRequest: ((ConfirmationRequestMessage) -> Void)?

    /// Called when the daemon sends a `secret_request` message for secure credential input.
    public var onSecretRequest: ((SecretRequestMessage) -> Void)?

    /// Called when the daemon sends a `task_routed` message (e.g. escalation from text_qa to CU).
    public var onTaskRouted: ((TaskRoutedMessage) -> Void)?

    /// Called when a reminder fires.
    public var onReminderFired: ((ReminderFiredMessage) -> Void)?

    /// Called when a scheduled task completes.
    public var onScheduleComplete: ((ScheduleCompleteMessage) -> Void)?

    /// Called when the daemon sends a `trust_rules_list_response` message.
    public var onTrustRulesListResponse: (([TrustRuleItem]) -> Void)?

    /// Called when the daemon sends a `schedules_list_response` message.
    public var onSchedulesListResponse: (([ScheduleItem]) -> Void)?

    /// Called when the daemon sends a `reminders_list_response` message.
    public var onRemindersListResponse: (([ReminderItem]) -> Void)?

    /// Called when the daemon sends a `skills_state_changed` push event.
    public var onSkillStateChanged: ((SkillStateChangedMessage) -> Void)?

    /// Called when the daemon sends a `skills_operation_response` message.
    public var onSkillsOperationResponse: ((SkillsOperationResponseMessage) -> Void)?

    /// Called when the daemon sends a `skills_inspect_response` message.
    public var onSkillsInspectResponse: ((SkillsInspectResponseMessage) -> Void)?

    /// Called when the daemon sends a `trace_event` message.
    public var onTraceEvent: ((TraceEventMessage) -> Void)?

    /// Called when the daemon sends an `apps_list_response` message.
    public var onAppsListResponse: ((AppsListResponseMessage) -> Void)?

    /// Called when the daemon sends an `app_preview_response` message.
    public var onAppPreviewResponse: ((AppPreviewResponseMessage) -> Void)?

    /// Called when the daemon sends a `home_base_get_response` message.
    public var onHomeBaseGetResponse: ((HomeBaseGetResponseMessage) -> Void)?

    /// Called when the daemon sends a `shared_apps_list_response` message.
    public var onSharedAppsListResponse: ((SharedAppsListResponseMessage) -> Void)?

    /// Called when the daemon sends a `shared_app_delete_response` message.
    public var onSharedAppDeleteResponse: ((SharedAppDeleteResponseMessage) -> Void)?

    /// Called when the daemon sends a `fork_shared_app_response` message.
    public var onForkSharedAppResponse: ((ForkSharedAppResponseMessage) -> Void)?

    /// Called when the daemon sends a `bundle_app_response` message.
    public var onBundleAppResponse: ((BundleAppResponseMessage) -> Void)?

    /// Called when the daemon sends an `open_bundle_response` message.
    public var onOpenBundleResponse: ((OpenBundleResponseMessage) -> Void)?

    /// Called when the daemon sends a `session_list_response` message.
    public var onSessionListResponse: ((SessionListResponseMessage) -> Void)?

    /// Called when the daemon sends a `history_response` message.
    public var onHistoryResponse: ((HistoryResponseMessage) -> Void)?

    /// Called when the daemon sends a `share_to_slack_response` message.
    public var onShareToSlackResponse: ((ShareToSlackResponseMessage) -> Void)?

    /// Called when the daemon sends a `slack_webhook_config_response` message.
    public var onSlackWebhookConfigResponse: ((SlackWebhookConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `vercel_api_config_response` message.
    public var onVercelApiConfigResponse: ((VercelApiConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `model_info` message.
    public var onModelInfo: ((ModelInfoMessage) -> Void)?

    /// The currently active model ID, populated via `model_info` responses.
    @Published public var currentModel: String?

    /// Called when the daemon sends a `publish_page_response` message.
    public var onPublishPageResponse: ((PublishPageResponseMessage) -> Void)?

    /// Called when the daemon sends an `open_url` message.
    public var onOpenUrl: ((OpenUrlMessage) -> Void)?

    /// Called when the daemon sends a `ui_layout_config` message.
    public var onLayoutConfig: ((UiLayoutConfigMessage) -> Void)?

    /// Called when the daemon sends an `integration_list_response` message.
    public var onIntegrationListResponse: ((IPCIntegrationListResponse) -> Void)?

    /// Called when the daemon sends an `integration_connect_result` message.
    public var onIntegrationConnectResult: ((IPCIntegrationConnectResult) -> Void)?

    /// Called when the daemon sends a `browser_frame` message with a new screenshot frame.
    public var onBrowserFrame: ((BrowserFrameMessage) -> Void)?

    /// Called when the daemon sends a `browser_interactive_mode_changed` message.
    public var onBrowserInteractiveModeChanged: ((BrowserInteractiveModeChangedMessage) -> Void)?

    /// Called when the daemon sends a `browser_cdp_request` message.
    public var onBrowserCDPRequest: ((BrowserCDPRequestMessage) -> Void)?

    /// Called when the daemon sends a `diagnostics_export_response` message.
    public var onDiagnosticsExportResponse: ((DiagnosticsExportResponseMessage) -> Void)?

    /// Called when the daemon sends an `env_vars_response` message (debug builds only).
    public var onEnvVarsResponse: ((EnvVarsResponseMessage) -> Void)?

    /// Called when the daemon sends a `work_items_list_response` message.
    public var onWorkItemsListResponse: ((IPCWorkItemsListResponse) -> Void)?

    /// Called when the daemon sends a `work_item_status_changed` broadcast.
    public var onWorkItemStatusChanged: ((IPCWorkItemStatusChanged) -> Void)?

    /// Called when the daemon sends a `tasks_changed` broadcast.
    public var onTasksChanged: ((IPCTasksChanged) -> Void)?

    /// Called when the daemon sends a `work_item_delete_response` message.
    public var onWorkItemDeleteResponse: ((IPCWorkItemDeleteResponse) -> Void)?

    /// Called when the daemon sends a `work_item_run_task_response` message.
    public var onWorkItemRunTaskResponse: ((IPCWorkItemRunTaskResponse) -> Void)?

    /// Called when the daemon sends a `work_item_output_response` message.
    public var onWorkItemOutputResponse: ((IPCWorkItemOutputResponse) -> Void)?

    /// Called when the daemon sends a `work_item_update_response` message.
    public var onWorkItemUpdateResponse: ((IPCWorkItemUpdateResponse) -> Void)?

    /// Called when the daemon sends a generic `error` message (e.g. when a handler fails).
    public var onError: ((ErrorMessage) -> Void)?

    /// Called when the daemon wants us to open/focus the tasks window.
    public var onOpenTasksWindow: (() -> Void)?

    /// Called when a subagent is spawned.
    public var onSubagentSpawned: ((IPCSubagentSpawned) -> Void)?

    /// Called when a subagent's status changes (running, completed, failed, aborted).
    public var onSubagentStatusChanged: ((IPCSubagentStatusChanged) -> Void)?

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

    private var isAuthenticated = false
    private var authContinuation: CheckedContinuation<Void, Error>?
    private var authTimeoutTask: Task<Void, Never>?

    /// Buffer for accumulating incoming data until we have complete newline-delimited messages.
    private var receiveBuffer = Data()

    /// Maximum line size: 96 MB (for screenshots with base64).
    private let maxLineSize = 96 * 1024 * 1024

    /// Monotonic per-session sequence for CU observation sends.
    private var cuObservationSequenceBySession: [String: Int] = [:]

    /// Whether we should attempt to reconnect on disconnect.
    private var shouldReconnect = true

    /// Current reconnect backoff delay in seconds.
    private var reconnectDelay: TimeInterval = 1.0

    /// Maximum reconnect backoff delay.
    private let maxReconnectDelay: TimeInterval = 30.0

    /// Reconnect task handle.
    private var reconnectTask: Task<Void, Never>?

    /// Network path monitor — triggers immediate reconnect when network becomes available.
    private var pathMonitor: NWPathMonitor?
    private let pathMonitorQueue = DispatchQueue(label: "com.vellum.vellum-assistant.network-monitor", qos: .background)

    /// Ping timer task handle.
    private var pingTask: Task<Void, Never>?

    /// Whether we're waiting for a pong response.
    private var awaitingPong = false

    /// Pong timeout task handle.
    private var pongTimeoutTask: Task<Void, Never>?

    /// Blob probe task handle — fire-and-forget after connect on macOS.
    private var blobProbeTask: Task<Void, Never>?

    /// The probe ID we're currently waiting for a response to.
    /// Used to match ipc_blob_probe_result to the outstanding probe.
    /// Internal (not private) for testability via @testable import.
    var pendingProbeId: String?

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private let config: DaemonConfig

    // MARK: - Init

    public init(config: DaemonConfig = .default) {
        self.config = config
    }

    deinit {
        // Swift 5.9+: deinit on @MainActor class is NOT guaranteed to run on main actor.
        // Only call thread-safe cancellation methods here — Task.cancel() and
        // NWConnection.cancel() are safe from any thread.
        //
        // We must finish subscriber continuations to prevent hanging `for await` loops.
        // deinit guarantees exclusive access (no other strong references exist), so
        // direct property access is safe without actor isolation dispatch.
        let continuations = subscribers.values
        for continuation in continuations {
            continuation.finish()
        }

        reconnectTask?.cancel()
        pingTask?.cancel()
        pongTimeoutTask?.cancel()
        blobProbeTask?.cancel()
        pathMonitor?.cancel()
        connection?.cancel()
    }

    // MARK: - Socket Path

    /// Resolves the daemon socket path (macOS only).
    /// Delegates to the standalone `resolveSocketPath()` function for DRY.
    #if os(macOS)
    public static func resolveSocketPath(environment: [String: String]? = nil) -> String {
        return VellumAssistantShared.resolveSocketPath(environment: environment)
    }
    #endif

    // MARK: - Connect

    /// How long to wait for a connection before giving up.
    private static let connectTimeout: TimeInterval = 5.0
    private static let authTimeout: TimeInterval = 5.0

    /// Connect to the daemon. If already connected, disconnects first.
    /// - macOS: Connects to Unix domain socket at `~/.vellum/vellum.sock`
    /// - iOS: Connects to TCP endpoint (hostname from UserDefaults or localhost:8765)
    public func connect() async throws {
        // Disconnect any existing connection without triggering reconnect.
        disconnectInternal(triggerReconnect: false)

        isConnecting = true
        shouldReconnect = true

        #if os(macOS)
        log.info("Connecting to daemon socket at \(self.config.socketPath)")
        let endpoint = NWEndpoint.unix(path: self.config.socketPath)
        let parameters = NWParameters()
        parameters.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()
        #elseif os(iOS)
        // Check UserDefaults first to pick up runtime changes, fall back to config
        // This allows reconnects to pick up changed settings while preserving custom configs for tests
        let hostname: String
        let port: UInt16

        if let userHostname = UserDefaults.standard.string(forKey: "daemon_hostname"), !userHostname.isEmpty {
            hostname = userHostname
        } else {
            hostname = self.config.hostname
        }

        let rawPort = UserDefaults.standard.integer(forKey: "daemon_port")
        if rawPort > 0 && rawPort <= 65535 {
            port = UInt16(rawPort)
        } else {
            port = self.config.port
        }

        // Also re-read TLS setting from UserDefaults on each connect to match hostname/port behaviour
        let tlsEnabled: Bool
        if UserDefaults.standard.object(forKey: "daemon_tls_enabled") != nil {
            tlsEnabled = UserDefaults.standard.bool(forKey: "daemon_tls_enabled")
        } else {
            tlsEnabled = self.config.tlsEnabled
        }

        log.info("Connecting to daemon at \(hostname):\(port) (tls=\(tlsEnabled))")
        let endpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host(hostname),
            port: NWEndpoint.Port(integerLiteral: port)
        )
        let parameters: NWParameters = tlsEnabled ? .tls : .tcp
        #else
        #error("DaemonClient is only supported on macOS and iOS")
        #endif

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
                self?.isConnecting = false
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
                            self.startReceiveLoop()
                            Task { @MainActor in
                                do {
                                    #if os(macOS)
                                    try await self.authenticate()
                                    #elseif os(iOS)
                                    try await self.authenticateIfNeeded()
                                    #else
                                    self.isAuthenticated = true
                                    #endif
                                    self.isConnected = true
                                    self.isConnecting = false
                                    self.startNetworkMonitor()
                                    NotificationCenter.default.post(name: .daemonDidReconnect, object: self)
                                    self.reconnectDelay = 1.0
                                    self.startPingTimer()
                                    #if os(macOS)
                                    self.runBlobProbe()
                                    #endif
                                    checkedContinuation.resume()
                                } catch {
                                    log.error("Daemon authentication failed: \(error.localizedDescription)")
                                    self.isConnected = false
                                    self.isConnecting = false
                                    self.isAuthenticated = false
                                    self.stopPingTimer()
                                    conn.stateUpdateHandler = nil
                                    conn.cancel()
                                    checkedContinuation.resume(throwing: error)
                                }
                            }
                        }

                    case .failed(let error):
                        log.error("Connection failed: \(error.localizedDescription)")
                        self.isConnected = false
                        self.isConnecting = false
                        self.isAuthenticated = false
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
                        self.isConnecting = false
                        self.isAuthenticated = false
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

    // MARK: - Authentication

    #if os(macOS)
    private func authenticate() async throws {
        guard let token = readSessionToken() else {
            throw AuthError.missingToken
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            authContinuation?.resume(throwing: AuthError.rejected("Authentication superseded"))
            authContinuation = continuation

            authTimeoutTask?.cancel()
            authTimeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: UInt64(Self.authTimeout * 1_000_000_000))
                } catch {
                    return
                }
                guard let self, let pending = self.authContinuation else { return }
                self.authContinuation = nil
                self.authTimeoutTask = nil
                self.isAuthenticated = false
                pending.resume(throwing: AuthError.timeout)
            }

            do {
                try self.send(AuthMessage(token: token))
            } catch {
                authContinuation = nil
                authTimeoutTask?.cancel()
                authTimeoutTask = nil
                continuation.resume(throwing: error)
            }
        }
    }
    #endif

    #if os(iOS)
    /// Perform token-based authentication if `config.authToken` is set.
    /// Sends an `AuthMessage` and waits for an `auth_result` response before
    /// allowing the connection to be marked as ready.
    /// If no token is configured, marks the connection as authenticated immediately.
    private func authenticateIfNeeded() async throws {
        // Re-read from Keychain on each call to pick up runtime changes (mirrors hostname/port pattern).
        // Falls back to legacy UserDefaults key with one-time migration (same logic as DaemonConfig).
        let tokenFromKeychain = APIKeyManager.shared.getAPIKey(provider: "daemon-token")
            ?? DaemonConfig.migrateAuthToken()
        guard let token = tokenFromKeychain ?? config.authToken else {
            // No token configured — treat as unauthenticated (plain TCP, no handshake).
            isAuthenticated = true
            return
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            authContinuation?.resume(throwing: AuthError.rejected("Authentication superseded"))
            authContinuation = continuation

            authTimeoutTask?.cancel()
            authTimeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: UInt64(Self.authTimeout * 1_000_000_000))
                } catch {
                    return
                }
                guard let self, let pending = self.authContinuation else { return }
                self.authContinuation = nil
                self.authTimeoutTask = nil
                self.isAuthenticated = false
                pending.resume(throwing: AuthError.timeout)
            }

            do {
                try self.send(AuthMessage(token: token))
            } catch {
                authContinuation = nil
                authTimeoutTask?.cancel()
                authTimeoutTask = nil
                continuation.resume(throwing: error)
            }
        }
    }
    #endif

    // MARK: - Send

    public enum SendError: Error, LocalizedError {
        case notConnected
        case notAuthenticated

        public var errorDescription: String? {
            switch self {
            case .notConnected:
                return "Cannot send: not connected to daemon"
            case .notAuthenticated:
                return "Cannot send: daemon authentication not complete"
            }
        }
    }

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

    /// Closure that, when set, replaces the real send path.
    /// Used in tests to avoid needing a live NWConnection.
    internal var sendOverride: ((Any) throws -> Void)?

    /// Send a message to the daemon.
    /// Encodes the message as JSON, appends a newline, and writes to the connection.
    /// Throws `SendError.notConnected` when the connection is nil so callers can
    /// distinguish a silently-dropped message from a successful write.
    public func send<T: Encodable>(_ message: T) throws {
        if let override = sendOverride {
            try override(message)
            return
        }

        guard let conn = connection else {
            log.warning("Cannot send: not connected")
            throw SendError.notConnected
        }

        if !isAuthenticated, !(message is AuthMessage) {
            log.warning("Cannot send: authentication not complete")
            throw SendError.notAuthenticated
        }

        var data = try encoder.encode(message)
        data.append(contentsOf: [0x0A]) // newline byte

        if let observation = message as? CuObservationMessage {
            let previousSequence = cuObservationSequenceBySession[observation.sessionId] ?? 0
            let sequence = previousSequence + 1
            cuObservationSequenceBySession[observation.sessionId] = sequence
            let payloadJSONBytes = max(0, data.count - 1)
            let screenshotBase64Bytes = observation.screenshot?.utf8.count ?? 0
            let axTreeBytes = observation.axTree?.utf8.count ?? 0
            let sendTimestampMs = Int(Date().timeIntervalSince1970 * 1_000)
            log.info(
                "IPC_METRIC cu_observation_send sessionId=\(observation.sessionId) sequence=\(sequence) sendTsMs=\(sendTimestampMs) payloadJsonBytes=\(payloadJSONBytes) screenshotBase64Bytes=\(screenshotBase64Bytes) axTreeBytes=\(axTreeBytes)"
            )
        }

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

    // MARK: - Surface Undo

    /// Send a surface undo request to revert the last refinement on a workspace surface.
    public func sendSurfaceUndo(sessionId: String, surfaceId: String) throws {
        let message = UiSurfaceUndoMessage(sessionId: sessionId, surfaceId: surfaceId)
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
    public func sendSecretResponse(requestId: String, value: String?, delivery: String? = nil) throws {
        try send(SecretResponseMessage(requestId: requestId, value: value, delivery: delivery))
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

    // MARK: - Schedules Management

    /// Request the list of all scheduled tasks from the daemon.
    public func sendListSchedules() throws {
        try send(SchedulesListMessage())
    }

    /// Toggle a schedule's enabled state.
    public func sendToggleSchedule(id: String, enabled: Bool) throws {
        try send(ScheduleToggleMessage(id: id, enabled: enabled))
    }

    /// Remove a schedule by its ID.
    public func sendRemoveSchedule(id: String) throws {
        try send(ScheduleRemoveMessage(id: id))
    }

    // MARK: - Reminders Management

    /// Request the list of all reminders from the daemon.
    public func sendListReminders() throws {
        try send(RemindersListMessage())
    }

    /// Cancel a reminder by its ID.
    public func sendCancelReminder(id: String) throws {
        try send(ReminderCancelMessage(id: id))
    }

    // MARK: - Work Items (Task Queue)

    /// Request the list of work items from the daemon, optionally filtered by status.
    public func sendWorkItemsList(status: String? = nil) throws {
        try send(IPCWorkItemsListRequest(type: "work_items_list", status: status))
    }

    /// Mark a work item as complete (reviewed).
    public func sendWorkItemComplete(id: String) throws {
        try send(IPCWorkItemCompleteRequest(type: "work_item_complete", id: id))
    }

    /// Delete a work item.
    public func sendWorkItemDelete(id: String) throws {
        try send(IPCWorkItemDeleteRequest(type: "work_item_delete", id: id))
    }

    /// Run the task associated with a work item.
    public func sendWorkItemRunTask(id: String) throws {
        try send(IPCWorkItemRunTaskRequest(type: "work_item_run_task", id: id))
    }

    /// Request the latest output for a work item.
    public func sendWorkItemOutput(id: String) throws {
        try send(IPCWorkItemOutputRequest(type: "work_item_output", id: id))
    }

    /// Update fields on an existing work item.
    public func sendWorkItemUpdate(id: String, title: String? = nil, notes: String? = nil, status: String? = nil, priorityTier: Double? = nil, sortIndex: Int? = nil) throws {
        try send(IPCWorkItemUpdateRequest(type: "work_item_update", id: id, title: title, notes: notes, status: status, priorityTier: priorityTier, sortIndex: sortIndex))
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

    // MARK: - Queue Management

    /// Delete a specific queued message by its requestId.
    public func sendDeleteQueuedMessage(sessionId: String, requestId: String) throws {
        try send(DeleteQueuedMessageMessage(sessionId: sessionId, requestId: requestId))
    }

    // MARK: - Regenerate

    /// Regenerate the last assistant response for a session.
    public func sendRegenerate(sessionId: String) throws {
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

    /// Request opening an app by ID. The daemon responds with a `ui_surface_show` message.
    public func sendAppOpen(appId: String) throws {
        try send(AppOpenRequestMessage(appId: appId))
    }

    /// Send a preview screenshot for an app.
    public func sendAppUpdatePreview(appId: String, preview: String) throws {
        try send(AppUpdatePreviewRequestMessage(appId: appId, preview: preview))
    }

    /// Request the list of all apps from the daemon.
    public func sendAppsList() throws {
        try send(AppsListRequestMessage())
    }

    /// Request a single app's preview screenshot.
    public func sendAppPreview(appId: String) throws {
        try send(AppPreviewRequestMessage(type: "app_preview_request", appId: appId))
    }

    /// Request Home Base metadata from the daemon.
    public func sendHomeBaseGet(ensureLinked: Bool = true) throws {
        try send(HomeBaseGetRequestMessage(ensureLinked: ensureLinked))
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

    /// Fork a shared app into a local editable copy.
    public func sendForkSharedApp(uuid: String) throws {
        try send(ForkSharedAppRequestMessage(uuid: uuid))
    }

    /// Share a local app to Slack via configured webhook.
    public func sendShareToSlack(appId: String) throws {
        try send(ShareToSlackRequestMessage(appId: appId))
    }

    /// Get or set the Slack webhook URL configuration.
    public func sendSlackWebhookConfig(action: String, webhookUrl: String? = nil) throws {
        try send(SlackWebhookConfigRequestMessage(action: action, webhookUrl: webhookUrl))
    }

    /// Get, set, or delete the Vercel API token configuration.
    public func sendVercelApiConfig(action: String, apiToken: String? = nil) throws {
        try send(VercelApiConfigRequestMessage(action: action, apiToken: apiToken))
    }

    /// Publish a static page to Vercel.
    public func sendPublishPage(html: String, title: String? = nil, appId: String? = nil) throws {
        try send(PublishPageRequestMessage(html: html, title: title, appId: appId))
    }

    /// Unpublish a page and delete its Vercel deployment.
    public func sendUnpublishPage(deploymentId: String) throws {
        try send(UnpublishPageRequestMessage(deploymentId: deploymentId))
    }

    // MARK: - Model Config

    /// Request the current model/provider configuration from the daemon.
    public func sendModelGet() throws {
        try send(ModelGetRequestMessage())
    }

    /// Set the active model on the daemon.
    public func sendModelSet(model: String) throws {
        try send(ModelSetRequestMessage(model: model))
    }

    /// Set the image generation model on the daemon.
    public func sendImageGenModelSet(model: String) throws {
        try send(ImageGenModelSetRequestMessage(model: model))
    }

    // MARK: - Integrations

    /// Request the list of registered integrations and their connection status.
    public func sendIntegrationList() throws {
        try send(IPCIntegrationListRequest(type: "integration_list"))
    }

    /// Initiate an OAuth2 connection flow for an integration.
    public func sendIntegrationConnect(integrationId: String) throws {
        try send(IPCIntegrationConnectRequest(type: "integration_connect", integrationId: integrationId))
    }

    /// Disconnect an integration (revoke tokens + remove from vault).
    public func sendIntegrationDisconnect(integrationId: String) throws {
        try send(IPCIntegrationDisconnectRequest(type: "integration_disconnect", integrationId: integrationId))
    }

    // MARK: - Diagnostics Export

    /// Request a diagnostics export (zip) for a conversation.
    public func sendDiagnosticsExportRequest(conversationId: String, anchorMessageId: String? = nil) throws {
        try send(DiagnosticsExportRequestMessage(conversationId: conversationId, anchorMessageId: anchorMessageId))
    }

    // MARK: - Environment Variables (Debug)

    /// Request the daemon's environment variables (debug builds only).
    public func sendEnvVarsRequest() throws {
        try send(EnvVarsRequestMessage())
    }

    // MARK: - Link Open

    /// Send a link_open_request to the daemon, requesting it open a URL externally.
    public func sendLinkOpenRequest(url: String, metadata: [String: AnyCodable]?) throws {
        try send(LinkOpenRequestMessage(url: url, metadata: metadata))
    }

    // MARK: - Document Persistence

    public func sendDocumentSave(surfaceId: String, conversationId: String, title: String, content: String, wordCount: Int) throws {
        try send(DocumentSaveRequestMessage(
            type: "document_save",
            surfaceId: surfaceId,
            conversationId: conversationId,
            title: title,
            content: content,
            wordCount: wordCount
        ))
    }

    public func sendDocumentLoad(surfaceId: String) throws {
        try send(DocumentLoadRequestMessage(
            type: "document_load",
            surfaceId: surfaceId
        ))
    }

    public func sendDocumentList(conversationId: String? = nil) throws {
        try send(DocumentListRequestMessage(
            type: "document_list",
            conversationId: conversationId
        ))
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
                requestId: msg.requestId,
                signature: signature.base64EncodedString(),
                keyId: keyId,
                publicKey: publicKey.rawRepresentation.base64EncodedString()
            ))
        } catch {
            log.error("Failed to sign bundle payload: \(error.localizedDescription)")
        }
    }

    /// Handle a get_signing_identity request from the daemon.
    private func handleGetSigningIdentity(_ msg: IPCGetSigningIdentityRequest) {
        do {
            let keyId = try SigningIdentityManager.shared.getKeyId()
            let publicKey = try SigningIdentityManager.shared.getPublicKey()

            try send(GetSigningIdentityResponseMessage(
                requestId: msg.requestId,
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
        if !triggerReconnect {
            stopNetworkMonitor()
        }
        stopPingTimer()
        #if os(macOS) || os(iOS)
        if let pending = authContinuation {
            authContinuation = nil
            authTimeoutTask?.cancel()
            authTimeoutTask = nil
            pending.resume(throwing: AuthError.rejected("Disconnected"))
        }
        authTimeoutTask?.cancel()
        authTimeoutTask = nil
        #endif
        blobProbeTask?.cancel()
        blobProbeTask = nil
        pendingProbeId = nil
        isBlobTransportAvailable = false
        isAuthenticated = false

        if let conn = connection {
            conn.stateUpdateHandler = nil
            conn.cancel()
            connection = nil
        }

        receiveBuffer = Data()
        cuObservationSequenceBySession.removeAll()
        isConnected = false
        isConnecting = false
        httpPort = nil
        latestMemoryStatus = nil

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
                // Log a safe summary — never include raw line content which may contain secrets.
                let byteCount = lineData.count
                let typeHint = extractMessageType(from: Data(lineData))
                log.error("Failed to decode server message: \(error.localizedDescription), bytes: \(byteCount), type: \(typeHint)")
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

        // Handle daemon status internally.
        if case .daemonStatus(let status) = message {
            httpPort = status.httpPort.flatMap { Int(exactly: $0) }
        }

        // Handle blob probe result internally.
        if case .ipcBlobProbeResult(let result) = message {
            handleBlobProbeResult(result)
        }

        // Forward surface messages to registered callbacks.
        switch message {
        case .authResult(let msg):
            handleAuthResult(msg)
        case .uiSurfaceShow(let msg):
            // Inline surfaces are rendered in-chat by ChatViewModel; skip the floating panel.
            if msg.display != "inline" {
                onSurfaceShow?(msg)
            }
        case .uiSurfaceUpdate(let msg):
            onSurfaceUpdate?(msg)
        case .uiSurfaceDismiss(let msg):
            onSurfaceDismiss?(msg)
        case .uiSurfaceComplete(let msg):
            onSurfaceComplete?(msg)
        case .documentEditorShow(let msg):
            log.debug("documentEditorShow received — surfaceId=\(msg.surfaceId, privacy: .public), title=\(msg.title, privacy: .public)")
            onDocumentEditorShow?(msg)
            log.debug("documentEditorShow callback invoked")
        case .documentEditorUpdate(let msg):
            onDocumentEditorUpdate?(msg)
        case .documentSaveResponse(let msg):
            onDocumentSaveResponse?(msg)
        case .documentLoadResponse(let msg):
            onDocumentLoadResponse?(msg)
        case .documentListResponse(let msg):
            onDocumentListResponse?(msg)
        case .uiLayoutConfig(let msg):
            onLayoutConfig?(msg)
        case .appFilesChanged(let msg):
            onAppFilesChanged?(msg.appId)
        case .appDataResponse(let msg):
            onAppDataResponse?(msg)
        case .messageQueued(let msg):
            onMessageQueued?(msg)
        case .messageDequeued(let msg):
            onMessageDequeued?(msg)
        case .messageQueuedDeleted(let msg):
            onMessageQueuedDeleted?(msg)
        case .generationHandoff(let msg):
            onGenerationHandoff?(msg)
        case .confirmationRequest(let msg):
            onConfirmationRequest?(msg)
        case .secretRequest(let msg):
            onSecretRequest?(msg)
        case .taskRouted(let msg):
            onTaskRouted?(msg)
        case .reminderFired(let msg):
            onReminderFired?(msg)
        case .scheduleComplete(let msg):
            onScheduleComplete?(msg)
        case .trustRulesListResponse(let msg):
            onTrustRulesListResponse?(msg.rules)
        case .schedulesListResponse(let msg):
            onSchedulesListResponse?(msg.schedules)
        case .remindersListResponse(let msg):
            onRemindersListResponse?(msg.reminders)
        case .skillStateChanged(let msg):
            onSkillStateChanged?(msg)
        case .skillsOperationResponse(let msg):
            onSkillsOperationResponse?(msg)
        case .skillsInspectResponse(let msg):
            onSkillsInspectResponse?(msg)
        case .appsListResponse(let msg):
            onAppsListResponse?(msg)
        case .homeBaseGetResponse(let msg):
            onHomeBaseGetResponse?(msg)
        case .appUpdatePreviewResponse:
            break // Fire-and-forget; no callback needed
        case .appPreviewResponse(let msg):
            onAppPreviewResponse?(msg)
        case .sharedAppsListResponse(let msg):
            onSharedAppsListResponse?(msg)
        case .sharedAppDeleteResponse(let msg):
            onSharedAppDeleteResponse?(msg)
        case .forkSharedAppResponse(let msg):
            onForkSharedAppResponse?(msg)
        case .bundleAppResponse(let msg):
            onBundleAppResponse?(msg)
        case .openBundleResponse(let msg):
            onOpenBundleResponse?(msg)
        case .sessionListResponse(let msg):
            onSessionListResponse?(msg)
        case .historyResponse(let msg):
            onHistoryResponse?(msg)
        case .shareToSlackResponse(let msg):
            onShareToSlackResponse?(msg)
        case .slackWebhookConfigResponse(let msg):
            onSlackWebhookConfigResponse?(msg)
        case .vercelApiConfigResponse(let msg):
            onVercelApiConfigResponse?(msg)
        case .modelInfo(let msg):
            currentModel = msg.model
            onModelInfo?(msg)
        case .publishPageResponse(let msg):
            onPublishPageResponse?(msg)
        case .openUrl(let msg):
            onOpenUrl?(msg)
        case .unpublishPageResponse:
            break // Handled via specific callback if needed
        case .memoryStatus(let msg):
            latestMemoryStatus = msg
        case .traceEvent(let msg):
            onTraceEvent?(msg)
        case .error(let msg):
            onError?(msg)
        #if os(macOS)
        case .signBundlePayload(let msg):
            handleSignBundlePayload(msg)
        case .getSigningIdentity(let msg):
            handleGetSigningIdentity(msg)
        #elseif os(iOS)
        case .signBundlePayload:
            log.error("Received sign_bundle_payload request on iOS - signing operations are not supported on iOS due to sandboxing restrictions")
        case .getSigningIdentity:
            log.error("Received get_signing_identity request on iOS - signing operations are not supported on iOS due to sandboxing restrictions")
        #else
        case .signBundlePayload, .getSigningIdentity:
            log.error("Signing operations are not supported on this platform")
        #endif
        case .integrationListResponse(let msg):
            onIntegrationListResponse?(msg)
        case .integrationConnectResult(let msg):
            onIntegrationConnectResult?(msg)
        case .diagnosticsExportResponse(let msg):
            onDiagnosticsExportResponse?(msg)
        case .browserFrame(let msg):
            onBrowserFrame?(msg)
        case .browserInteractiveModeChanged(let msg):
            onBrowserInteractiveModeChanged?(msg)
        case .browserCDPRequest(let msg):
            onBrowserCDPRequest?(msg)
        case .envVarsResponse(let msg):
            onEnvVarsResponse?(msg)
        case .workItemsListResponse(let msg):
            onWorkItemsListResponse?(msg)
        case .workItemStatusChanged(let msg):
            onWorkItemStatusChanged?(msg)
        case .tasksChanged(let msg):
            onTasksChanged?(msg)
        case .workItemDeleteResponse(let msg):
            onWorkItemDeleteResponse?(msg)
        case .workItemRunTaskResponse(let msg):
            onWorkItemRunTaskResponse?(msg)
        case .workItemOutputResponse(let msg):
            onWorkItemOutputResponse?(msg)
        case .workItemUpdateResponse(let msg):
            onWorkItemUpdateResponse?(msg)
        case .openTasksWindow:
            onOpenTasksWindow?()
        case .subagentSpawned(let msg):
            onSubagentSpawned?(msg)
        case .subagentStatusChanged(let msg):
            onSubagentStatusChanged?(msg)
        default:
            break
        }

        // Broadcast to all subscribers.
        for continuation in subscribers.values {
            continuation.yield(message)
        }
    }

    private func handleAuthResult(_ result: AuthResultMessage) {
        #if os(macOS) || os(iOS)
        isAuthenticated = result.success
        if let pending = authContinuation {
            authContinuation = nil
            authTimeoutTask?.cancel()
            authTimeoutTask = nil
            if result.success {
                pending.resume(returning: ())
            } else {
                pending.resume(throwing: AuthError.rejected(result.message))
            }
        }
        #endif
    }

    // MARK: - Blob Probe (macOS only)

    #if os(macOS)
    /// Initiate a blob probe after connecting. Writes a nonce file to the shared
    /// blob directory and sends a probe message to the daemon. The daemon reads
    /// the file, hashes it, and responds. If the hashes match, blob transport
    /// is confirmed available for this connection.
    private func runBlobProbe() {
        blobProbeTask?.cancel()
        isBlobTransportAvailable = false

        blobProbeTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let store = IpcBlobStore.shared
            store.ensureDirectory()

            guard let probe = store.writeProbeFile() else {
                log.warning("Blob probe: failed to write probe file")
                return
            }

            self.pendingProbeId = probe.probeId

            do {
                try self.send(IpcBlobProbeMessage(
                    probeId: probe.probeId,
                    nonceSha256: probe.nonceSha256
                ))
                log.info("Blob probe sent: \(probe.probeId)")
            } catch {
                log.warning("Blob probe: failed to send probe message: \(error.localizedDescription)")
                self.pendingProbeId = nil
            }
        }
    }
    #endif

    /// Process a blob probe result from the daemon.
    /// Internal (not private) for testability via @testable import.
    func handleBlobProbeResult(_ result: IpcBlobProbeResultMessage) {
        guard result.probeId == pendingProbeId else {
            log.warning("Blob probe: ignoring stale result for \(result.probeId) (expected \(self.pendingProbeId ?? "nil"))")
            return
        }
        pendingProbeId = nil

        if result.ok {
            isBlobTransportAvailable = true
            log.info("Blob transport verified for this connection")
        } else {
            isBlobTransportAvailable = false
            log.warning("Blob probe failed: \(result.reason ?? "unknown")")
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

    // MARK: - Network Reachability

    private func startNetworkMonitor() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                self?.handleNetworkPathChange(path)
            }
        }
        monitor.start(queue: pathMonitorQueue)
        pathMonitor = monitor
    }

    private func stopNetworkMonitor() {
        pathMonitor?.cancel()
        pathMonitor = nil
    }

    private func handleNetworkPathChange(_ path: NWPath) {
        guard path.status == .satisfied, !isConnected, !isConnecting, shouldReconnect else { return }
        log.info("Network available — resetting backoff and reconnecting immediately")
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectDelay = 1.0
        isConnecting = true
        Task { @MainActor [weak self] in
            guard let self, self.shouldReconnect else {
                self?.isConnecting = false
                return
            }
            do {
                try await self.connect()
            } catch {
                log.error("Immediate reconnect on network change failed: \(error.localizedDescription)")
                self.scheduleReconnect()
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

    /// Extract the "type" field from raw JSON data for safe logging.
    /// Returns the type string if parseable, otherwise "<unknown>".
    /// This avoids logging the entire line which may contain sensitive values.
    private func extractMessageType(from data: Data) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return "<unknown>"
        }
        return type
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
