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
    let data: Data
    do {
        data = try Data(contentsOf: URL(fileURLWithPath: tokenPath))
    } catch {
        log.error("Failed to read session token from \(tokenPath): \(error)")
        return nil
    }
    guard let token = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
          !token.isEmpty else {
        return nil
    }
    return token
}

#endif

/// Resolve the runtime HTTP bearer token path.
/// Uses BASE_DATA_DIR when set to match daemon root resolution.
/// Available on all platforms since HTTP transport is used on both macOS and iOS.
func resolveHttpTokenPath(environment: [String: String]? = nil) -> String {
    let env = environment ?? ProcessInfo.processInfo.environment
    if let baseDir = env["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines), !baseDir.isEmpty {
        let resolved = baseDir.hasPrefix("~/") ? NSHomeDirectory() + "/" + String(baseDir.dropFirst(2)) : baseDir
        return resolved + "/.vellum/http-token"
    }
    return NSHomeDirectory() + "/.vellum/http-token"
}

/// Read the runtime HTTP bearer token from disk.
/// Available on all platforms since HTTP transport is used on both macOS and iOS.
func readHttpToken(environment: [String: String]? = nil) -> String? {
    let tokenPath = resolveHttpTokenPath(environment: environment)
    let data: Data
    do {
        data = try Data(contentsOf: URL(fileURLWithPath: tokenPath))
    } catch {
        log.error("Failed to read HTTP token from \(tokenPath): \(error)")
        return nil
    }
    guard let token = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
          !token.isEmpty else {
        return nil
    }
    return token
}

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
    public var isConnecting: Bool = false

    /// Whether blob transport has been verified for this connection.
    /// Resets to `false` on disconnect/reconnect. Only set to `true` after
    /// a successful probe round-trip on macOS local-socket connections.
    @Published public internal(set) var isBlobTransportAvailable: Bool = false

    /// The runtime HTTP server port, populated via `daemon_status` on connect.
    /// `nil` means the HTTP server is not running.
    @Published public var httpPort: Int?

    /// The daemon version string, populated via `daemon_status` on connect.
    @Published public internal(set) var daemonVersion: String?

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

    /// Called when the daemon sends a `tool_permission_simulate_response` message.
    public var onToolPermissionSimulateResponse: ((ToolPermissionSimulateResponseMessage) -> Void)?

    /// Called when the daemon sends a `tool_names_list_response` message.
    public var onToolNamesListResponse: ((ToolNamesListResponseMessage) -> Void)?

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

    /// Called when the daemon sends an `ingress_config_response` message.
    public var onIngressConfigResponse: ((IngressConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `vercel_api_config_response` message.
    public var onVercelApiConfigResponse: ((VercelApiConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `telegram_config_response` message.
    public var onTelegramConfigResponse: ((TelegramConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `twitter_integration_config_response` message.
    public var onTwitterIntegrationConfigResponse: ((TwitterIntegrationConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `twitter_auth_result` message.
    public var onTwitterAuthResult: ((TwitterAuthResultMessage) -> Void)?

    /// Called when the daemon sends a `twitter_auth_status_response` message.
    public var onTwitterAuthStatusResponse: ((TwitterAuthStatusResponseMessage) -> Void)?

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

    /// Called when the daemon sends a `work_item_preflight_response` message.
    public var onWorkItemPreflightResponse: ((IPCWorkItemPreflightResponse) -> Void)?

    /// Called when the daemon sends a `work_item_approve_permissions_response` message.
    public var onWorkItemApprovePermissionsResponse: ((IPCWorkItemApprovePermissionsResponse) -> Void)?

    /// Called when the daemon sends a `work_item_cancel_response` message.
    public var onWorkItemCancelResponse: ((IPCWorkItemCancelResponse) -> Void)?

    /// Called when the daemon sends a generic `error` message (e.g. when a handler fails).
    public var onError: ((ErrorMessage) -> Void)?

    /// Called when a task run creates a conversation so the client can show it as a visible chat thread.
    public var onTaskRunThreadCreated: ((IPCTaskRunThreadCreated) -> Void)?

    /// Called when the daemon wants us to open/focus the tasks window.
    public var onOpenTasksWindow: (() -> Void)?

    /// Called when a subagent is spawned.
    public var onSubagentSpawned: ((IPCSubagentSpawned) -> Void)?

    /// Called when a subagent's status changes (running, completed, failed, aborted).
    public var onSubagentStatusChanged: ((IPCSubagentStatusChanged) -> Void)?

    /// Called when the daemon sends a `subagent_detail_response` with lazy-loaded events.
    public var onSubagentDetailResponse: ((IPCSubagentDetailResponse) -> Void)?

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

    // MARK: - Internal State (accessed by extensions in DaemonConnection.swift and DaemonMessageRouter.swift)

    var connection: NWConnection?
    let queue = DispatchQueue(label: "com.vellum.vellum-assistant.daemon-client", qos: .userInitiated)

    var subscribers: [UUID: AsyncStream<ServerMessage>.Continuation] = [:]

    var isAuthenticated = false
    var authContinuation: CheckedContinuation<Void, Error>?
    var authTimeoutTask: Task<Void, Never>?

    /// Buffer for accumulating incoming data until we have complete newline-delimited messages.
    var receiveBuffer = Data()

    /// Maximum line size: 96 MB (for screenshots with base64).
    let maxLineSize = 96 * 1024 * 1024

    /// Monotonic per-session sequence for CU observation sends.
    var cuObservationSequenceBySession: [String: Int] = [:]

    /// Whether we should attempt to reconnect on disconnect.
    var shouldReconnect = true

    /// Current reconnect backoff delay in seconds.
    var reconnectDelay: TimeInterval = 1.0

    /// Maximum reconnect backoff delay.
    let maxReconnectDelay: TimeInterval = 30.0

    /// Reconnect task handle.
    var reconnectTask: Task<Void, Never>?

    /// Network path monitor — triggers immediate reconnect when network becomes available.
    var pathMonitor: NWPathMonitor?
    let pathMonitorQueue = DispatchQueue(label: "com.vellum.vellum-assistant.network-monitor", qos: .background)

    /// Ping timer task handle.
    var pingTask: Task<Void, Never>?

    /// Whether we're waiting for a pong response.
    var awaitingPong = false

    /// Pong timeout task handle.
    var pongTimeoutTask: Task<Void, Never>?

    /// Blob probe task handle — fire-and-forget after connect on macOS.
    var blobProbeTask: Task<Void, Never>?

    /// The probe ID we're currently waiting for a response to.
    /// Used to match ipc_blob_probe_result to the outstanding probe.
    /// Internal (not private) for testability via @testable import.
    var pendingProbeId: String?

    /// HTTP transport used when connecting to a remote assistant via gateway.
    /// Non-nil when `config.transport` is `.http`.
    var httpTransport: HTTPTransport?

    let encoder = JSONEncoder()
    let decoder = JSONDecoder()

    public let config: DaemonConfig

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
        // httpTransport is cleaned up via disconnectInternal() before dealloc;
    }

    // MARK: - Socket Path

    /// Resolves the daemon socket path (macOS only).
    /// Delegates to the standalone `resolveSocketPath()` function for DRY.
    #if os(macOS)
    public static func resolveSocketPath(environment: [String: String]? = nil) -> String {
        return VellumAssistantShared.resolveSocketPath(environment: environment)
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

        // Route through HTTP transport when active (remote assistants).
        if let httpTransport {
            guard httpTransport.isConnected else {
                throw SendError.notConnected
            }
            try httpTransport.send(message)
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
        decision: String,
        allowHighRisk: Bool? = nil,
        executionTarget: String? = nil
    ) throws {
        try send(AddTrustRuleMessage(
            toolName: toolName,
            pattern: pattern,
            scope: scope,
            decision: decision,
            allowHighRisk: allowHighRisk,
            executionTarget: executionTarget
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

    // MARK: - Tool Permission Simulation

    /// Simulate a tool permission check without executing the tool.
    public func sendToolPermissionSimulate(
        toolName: String,
        input: [String: AnyCodable],
        workingDir: String? = nil,
        isInteractive: Bool? = nil,
        forcePromptSideEffects: Bool? = nil
    ) throws {
        try send(ToolPermissionSimulateMessage(
            toolName: toolName,
            input: input,
            workingDir: workingDir,
            isInteractive: isInteractive,
            forcePromptSideEffects: forcePromptSideEffects
        ))
    }

    /// Request the sorted list of all registered tool names from the daemon.
    public func sendToolNamesList() throws {
        try send(ToolNamesListMessage())
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

    /// Run the task associated with a work item via daemon-side execution.
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

    /// Request a permission preflight check for a work item's required tools.
    public func sendWorkItemPreflight(id: String) throws {
        try send(IPCWorkItemPreflightRequest(type: "work_item_preflight", id: id))
    }

    /// Approve specific permissions for a work item before running.
    public func sendWorkItemApprovePermissions(id: String, approvedTools: [String]) throws {
        try send(IPCWorkItemApprovePermissionsRequest(type: "work_item_approve_permissions", id: id, approvedTools: approvedTools))
    }

    /// Cancel a running work item.
    public func sendWorkItemCancel(id: String) throws {
        try send(IPCWorkItemCancelRequest(type: "work_item_cancel", id: id))
    }

    // MARK: - Subagent Management

    /// Abort a running subagent.
    public func sendSubagentAbort(subagentId: String) throws {
        try send(SubagentAbortMessage(subagentId: subagentId))
    }

    /// Request subagent detail events (lazy-loaded when the user opens the detail panel).
    public func sendSubagentDetailRequest(subagentId: String, conversationId: String) throws {
        try send(SubagentDetailRequestMessage(subagentId: subagentId, conversationId: conversationId))
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

    /// Get, set, or clear Telegram bot token configuration.
    public func sendTelegramConfig(action: String, botToken: String? = nil, commands: [IPCTelegramConfigRequestCommand]? = nil) throws {
        try send(TelegramConfigRequestMessage(action: action, botToken: botToken, commands: commands))
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

    // MARK: - Remote Identity

    /// Fetch identity info from the daemon.
    /// Uses HTTP transport directly when available, otherwise falls back to IPC.
    public func fetchRemoteIdentity() async -> RemoteIdentityInfo? {
        // If HTTP transport is active, use its direct endpoint
        if let httpTransport {
            return await httpTransport.fetchRemoteIdentity()
        }

        // Fall back to IPC-based identity fetch (TCP connections)
        let stream = subscribe()
        do {
            try sendIdentityGet()
        } catch {
            return nil
        }

        // Race the stream against a 10-second timeout so we don't wait forever
        // if the daemon doesn't support this message.
        let response: IdentityGetResponseMessage? = await withTaskGroup(of: IdentityGetResponseMessage?.self) { group in
            group.addTask {
                for await message in stream {
                    if case .identityGetResponse(let msg) = message {
                        return msg
                    }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        guard let response, response.found != false else { return nil }
        return RemoteIdentityInfo(
            name: response.name,
            role: response.role,
            personality: response.personality,
            emoji: response.emoji,
            version: response.version,
            assistantId: response.assistantId,
            home: response.home,
            createdAt: response.createdAt,
            originSystem: response.originSystem
        )
    }

    /// Request identity info via IPC.
    public func sendIdentityGet() throws {
        try send(IdentityGetRequestMessage())
    }

    // MARK: - Interface Files

    /// Fetch an interface file from the daemon via HTTP (`GET /v1/interfaces/<path>`).
    /// Uses `httpTransport` for remote assistants or `httpPort` for local connections.
    /// Returns the file content as a string, or `nil` if the file does not exist.
    public func fetchInterfaceFile(path: String) async -> String? {
        let baseURL: String
        let bearerToken: String?

        if let httpTransport {
            baseURL = httpTransport.baseURL
            bearerToken = httpTransport.bearerToken
        } else if let port = httpPort {
            baseURL = "http://localhost:\(port)"
            // Read local bearer token from disk
            let tokenBase: String
            if let baseDir = ProcessInfo.processInfo.environment["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines),
               !baseDir.isEmpty {
                tokenBase = baseDir
            } else {
                tokenBase = NSHomeDirectory()
            }
            let tokenPath = tokenBase + "/.vellum/http-token"
            do {
                bearerToken = try String(contentsOfFile: tokenPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            } catch {
                log.error("Failed to read HTTP bearer token from \(tokenPath): \(error)")
                bearerToken = nil
            }
        } else {
            return nil
        }

        guard let url = URL(string: "\(baseURL)/v1/interfaces/\(path)") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        if let token = bearerToken, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }

    // MARK: - Workspace Files

    /// Request the list of workspace files from the daemon.
    public func sendWorkspaceFilesList() throws {
        try send(WorkspaceFilesListRequestMessage())
    }

    /// Request the content of a workspace file from the daemon.
    public func sendWorkspaceFileRead(path: String) throws {
        try send(WorkspaceFileReadRequestMessage(path: path))
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

}
