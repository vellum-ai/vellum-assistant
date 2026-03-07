import Foundation
import Network
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonClient")

/// Shared signpost log for IPC instrumentation (Points of Interest lane in Instruments).
private let ipcLog = OSLog(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: .pointsOfInterest
)

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
    return resolveVellumDir(environment: environment) + "/vellum.sock"
}

/// Resolve the daemon session token path.
/// Uses BASE_DATA_DIR when set to match daemon root resolution.
func resolveSessionTokenPath(environment: [String: String]? = nil) -> String {
    return resolveVellumDir(environment: environment) + "/session-token"
}

/// Read the daemon session token from disk.
func readSessionToken(environment: [String: String]? = nil) -> String? {
    let tokenPath = resolveSessionTokenPath(environment: environment)
    let data: Data
    do {
        data = try Data(contentsOf: URL(fileURLWithPath: tokenPath))
    } catch {
        log.error("Failed to read session token from \(tokenPath, privacy: .private): \(error)")
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

/// Resolve the `.vellum` data directory, honoring `BASE_DATA_DIR` when set.
public func resolveVellumDir(environment: [String: String]? = nil) -> String {
    let env = environment ?? ProcessInfo.processInfo.environment
    if let baseDir = env["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines), !baseDir.isEmpty {
        let resolved = baseDir == "~" ? NSHomeDirectory() : (baseDir.hasPrefix("~/") ? NSHomeDirectory() + "/" + String(baseDir.dropFirst(2)) : baseDir)
        return resolved + "/.vellum"
    }
    // Check the lockfile for instance-specific directory (multi-instance support)
    if let instanceDir = resolveInstanceDirFromLockfile() {
        return instanceDir + "/.vellum"
    }
    return NSHomeDirectory() + "/.vellum"
}

/// Read the instanceDir from the latest lockfile entry's resources.
private func resolveInstanceDirFromLockfile() -> String? {
    guard let json = LockfilePaths.read(),
          let assistants = json["assistants"] as? [[String: Any]],
          !assistants.isEmpty else {
        return nil
    }
    // Find the most recently hatched entry
    let sorted = assistants.sorted { a, b in
        let dateA = a["hatchedAt"] as? String ?? ""
        let dateB = b["hatchedAt"] as? String ?? ""
        return dateA > dateB
    }
    guard let latest = sorted.first,
          let resources = latest["resources"] as? [String: Any],
          let instanceDir = resources["instanceDir"] as? String,
          !instanceDir.isEmpty else {
        return nil
    }
    return instanceDir
}

/// Resolve the runtime HTTP bearer token path.
/// Uses BASE_DATA_DIR when set to match daemon root resolution.
/// Available on all platforms since HTTP transport is used on both macOS and iOS.
public func resolveHttpTokenPath(environment: [String: String]? = nil) -> String {
    return resolveVellumDir(environment: environment) + "/http-token"
}

/// Resolve the feature-flag bearer token path.
/// Uses BASE_DATA_DIR when set to match daemon root resolution.
public func resolveFeatureFlagTokenPath(environment: [String: String]? = nil) -> String {
    return resolveVellumDir(environment: environment) + "/feature-flag-token"
}

/// Resolve the daemon PID file path, honoring `BASE_DATA_DIR`.
public func resolvePidPath(environment: [String: String]? = nil) -> String {
    return resolveVellumDir(environment: environment) + "/vellum.pid"
}

/// Read the feature-flag bearer token from disk.
/// Used to authenticate PATCH /v1/feature-flags/:flagKey requests.
public func readFeatureFlagToken(environment: [String: String]? = nil) -> String? {
    let tokenPath = resolveFeatureFlagTokenPath(environment: environment)
    let data: Data
    do {
        data = try Data(contentsOf: URL(fileURLWithPath: tokenPath))
    } catch {
        log.error("Failed to read feature-flag token from \(tokenPath, privacy: .private): \(error)")
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
    func sendConversationUnread(_ signal: IPCConversationUnreadSignal) async throws
    func connect() async throws
    func disconnect()
    func startSSE()
    func stopSSE()
    func fetchSurfaceData(surfaceId: String, sessionId: String) async -> SurfaceData?
    func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse?
    func fetchUsageDaily(from: Int, to: Int) async -> UsageDailyResponse?
    func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageBreakdownResponse?
}

extension DaemonClientProtocol {
    public func sendConversationUnread(_ signal: IPCConversationUnreadSignal) async throws {
        try send(signal)
    }

    /// Default no-op implementation for clients that don't support HTTP surface fetches.
    public func fetchSurfaceData(surfaceId: String, sessionId: String) async -> SurfaceData? { nil }
    public func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse? { nil }
    public func fetchUsageDaily(from: Int, to: Int) async -> UsageDailyResponse? { nil }
    public func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageBreakdownResponse? { nil }
}

// MARK: - Usage Response Models

/// Aggregate totals for a time range from `GET /v1/usage/totals`.
public struct UsageTotalsResponse: Decodable, Equatable, Sendable {
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let totalCacheCreationTokens: Int
    public let totalCacheReadTokens: Int
    public let totalEstimatedCostUsd: Double
    public let eventCount: Int
    public let pricedEventCount: Int
    public let unpricedEventCount: Int

    public init(
        totalInputTokens: Int,
        totalOutputTokens: Int,
        totalCacheCreationTokens: Int,
        totalCacheReadTokens: Int,
        totalEstimatedCostUsd: Double,
        eventCount: Int,
        pricedEventCount: Int,
        unpricedEventCount: Int
    ) {
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.totalCacheCreationTokens = totalCacheCreationTokens
        self.totalCacheReadTokens = totalCacheReadTokens
        self.totalEstimatedCostUsd = totalEstimatedCostUsd
        self.eventCount = eventCount
        self.pricedEventCount = pricedEventCount
        self.unpricedEventCount = unpricedEventCount
    }
}

/// A single day bucket from `GET /v1/usage/daily`.
public struct UsageDayBucket: Decodable, Equatable, Sendable {
    public let date: String
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let totalEstimatedCostUsd: Double
    public let eventCount: Int

    public init(date: String, totalInputTokens: Int, totalOutputTokens: Int, totalEstimatedCostUsd: Double, eventCount: Int) {
        self.date = date
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.totalEstimatedCostUsd = totalEstimatedCostUsd
        self.eventCount = eventCount
    }
}

/// Response wrapper for `GET /v1/usage/daily`.
public struct UsageDailyResponse: Decodable, Equatable, Sendable {
    public let buckets: [UsageDayBucket]

    public init(buckets: [UsageDayBucket]) {
        self.buckets = buckets
    }
}

/// A single grouped breakdown row from `GET /v1/usage/breakdown`.
public struct UsageGroupBreakdownEntry: Decodable, Equatable, Sendable {
    public let group: String
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let totalCacheCreationTokens: Int
    public let totalCacheReadTokens: Int
    public let totalEstimatedCostUsd: Double
    public let eventCount: Int

    public init(
        group: String,
        totalInputTokens: Int,
        totalOutputTokens: Int,
        totalCacheCreationTokens: Int = 0,
        totalCacheReadTokens: Int = 0,
        totalEstimatedCostUsd: Double,
        eventCount: Int
    ) {
        self.group = group
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.totalCacheCreationTokens = totalCacheCreationTokens
        self.totalCacheReadTokens = totalCacheReadTokens
        self.totalEstimatedCostUsd = totalEstimatedCostUsd
        self.eventCount = eventCount
    }

    private enum CodingKeys: String, CodingKey {
        case group
        case totalInputTokens
        case totalOutputTokens
        case totalCacheCreationTokens
        case totalCacheReadTokens
        case totalEstimatedCostUsd
        case eventCount
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        group = try container.decode(String.self, forKey: .group)
        totalInputTokens = try container.decode(Int.self, forKey: .totalInputTokens)
        totalOutputTokens = try container.decode(Int.self, forKey: .totalOutputTokens)
        totalCacheCreationTokens = try container.decodeIfPresent(Int.self, forKey: .totalCacheCreationTokens) ?? 0
        totalCacheReadTokens = try container.decodeIfPresent(Int.self, forKey: .totalCacheReadTokens) ?? 0
        totalEstimatedCostUsd = try container.decode(Double.self, forKey: .totalEstimatedCostUsd)
        eventCount = try container.decode(Int.self, forKey: .eventCount)
    }
}

/// Response wrapper for `GET /v1/usage/breakdown`.
public struct UsageBreakdownResponse: Decodable, Equatable, Sendable {
    public let breakdown: [UsageGroupBreakdownEntry]

    public init(breakdown: [UsageGroupBreakdownEntry]) {
        self.breakdown = breakdown
    }
}

extension Notification.Name {
    /// Posted by `DaemonClient` on the main actor immediately after `isConnected` transitions to `true`.
    public static let daemonDidReconnect = Notification.Name("daemonDidReconnect")

    /// Posted when a connection attempt fails because the daemon socket does not exist (ENOENT).
    /// The health monitor observes this to trigger an immediate restart instead of waiting
    /// for the next periodic health check.
    public static let daemonSocketNotFound = Notification.Name("daemonSocketNotFound")
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

    /// Returns a closure that resolves the current HTTP port at call time.
    /// Use this instead of reading `httpPort` directly when the value must
    /// reflect the latest daemon state (e.g. after a daemon restart). The
    /// closure captures `self` weakly to avoid retain cycles.
    public var httpPortResolver: () -> Int? {
        { [weak self] in self?.httpPort }
    }

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

    /// Called when the daemon sends a `confirmation_state_changed` message with authoritative state transitions.
    public var onConfirmationStateChanged: ((ConfirmationStateChangedMessage) -> Void)?

    /// Called when the daemon sends an `assistant_activity_state` message for thinking/streaming lifecycle.
    public var onAssistantActivityState: ((AssistantActivityStateMessage) -> Void)?

    /// Called when the daemon sends a `secret_request` message for secure credential input.
    public var onSecretRequest: ((SecretRequestMessage) -> Void)?

    /// Called when the daemon sends a `task_routed` message (e.g. escalation from text_qa to CU).
    public var onTaskRouted: ((TaskRoutedMessage) -> Void)?

    /// Called when the daemon sends a `dictation_response` message.
    public var onDictationResponse: ((DictationResponseMessage) -> Void)?

    /// Called when the daemon emits a generic `notification_intent` payload.
    public var onNotificationIntent: ((NotificationIntentMessage) -> Void)?

    /// Called when a notification delivery creates a new vellum conversation thread.
    public var onNotificationThreadCreated: ((IPCNotificationThreadCreated) -> Void)?

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

    /// Called when the daemon sends a `skills_draft_response` message.
    public var onSkillsDraftResponse: ((SkillsDraftResponseMessage) -> Void)?

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

    /// Called when the daemon sends an `app_delete_response` message.
    public var onAppDeleteResponse: ((AppDeleteResponseMessage) -> Void)?

    /// Called when the daemon sends a `shared_app_delete_response` message.
    public var onSharedAppDeleteResponse: ((SharedAppDeleteResponseMessage) -> Void)?

    /// Called when the daemon sends a `fork_shared_app_response` message.
    public var onForkSharedAppResponse: ((ForkSharedAppResponseMessage) -> Void)?

    /// Called when the daemon sends an `app_history_response` message.
    public var onAppHistoryResponse: ((IPCAppHistoryResponse) -> Void)?

    /// Called when the daemon sends an `app_diff_response` message.
    public var onAppDiffResponse: ((IPCAppDiffResponse) -> Void)?

    /// Called when the daemon sends an `app_restore_response` message.
    public var onAppRestoreResponse: ((IPCAppRestoreResponse) -> Void)?

    /// Called when the daemon sends a `bundle_app_response` message.
    public var onBundleAppResponse: ((BundleAppResponseMessage) -> Void)?

    /// Called when the daemon sends an `open_bundle_response` message.
    public var onOpenBundleResponse: ((OpenBundleResponseMessage) -> Void)?

    /// Called when the daemon sends a `session_list_response` message.
    public var onSessionListResponse: ((SessionListResponseMessage) -> Void)?

    /// Called when the daemon sends a `session_title_updated` message.
    public var onSessionTitleUpdated: ((SessionTitleUpdatedMessage) -> Void)?

    /// Called when the daemon sends a `history_response` message.
    public var onHistoryResponse: ((HistoryResponseMessage) -> Void)?

    /// Called when the daemon sends a `message_content_response` with full (untruncated) content.
    public var onMessageContentResponse: ((IPCMessageContentResponse) -> Void)?

    /// Called when the daemon sends a `share_app_cloud_response` message.
    public var onShareAppCloudResponse: ((ShareAppCloudResponseMessage) -> Void)?

    /// Called when the daemon sends a `slack_webhook_config_response` message.
    public var onSlackWebhookConfigResponse: ((SlackWebhookConfigResponseMessage) -> Void)?

    /// Called when the daemon sends an `ingress_config_response` message.
    public var onIngressConfigResponse: ((IngressConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `platform_config_response` message.
    public var onPlatformConfigResponse: ((PlatformConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `vercel_api_config_response` message.
    public var onVercelApiConfigResponse: ((VercelApiConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `guardian_verification_response` message.
    public var onGuardianVerificationResponse: ((GuardianVerificationResponseMessage) -> Void)?

    /// Called when the daemon sends a `telegram_config_response` message.
    public var onTelegramConfigResponse: ((TelegramConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `heartbeat_config_response` message.
    public var onHeartbeatConfigResponse: ((IPCHeartbeatConfigResponse) -> Void)?

    /// Called when the daemon sends a `heartbeat_runs_list_response` message.
    public var onHeartbeatRunsListResponse: ((IPCHeartbeatRunsListResponse) -> Void)?

    /// Called when the daemon sends a `heartbeat_run_now_response` message.
    public var onHeartbeatRunNowResponse: ((IPCHeartbeatRunNowResponse) -> Void)?

    /// Called when the daemon sends a `heartbeat_checklist_response` message.
    public var onHeartbeatChecklistResponse: ((IPCHeartbeatChecklistResponse) -> Void)?

    /// Called when the daemon sends a `heartbeat_checklist_write_response` message.
    public var onHeartbeatChecklistWriteResponse: ((IPCHeartbeatChecklistWriteResponse) -> Void)?

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

    /// Called when the daemon sends a `navigate_settings` message.
    public var onNavigateSettings: ((IPCNavigateSettings) -> Void)?

    /// Called when the daemon sends a `ui_layout_config` message.
    public var onLayoutConfig: ((UiLayoutConfigMessage) -> Void)?

    /// Called when the daemon sends an `integration_list_response` message.
    public var onIntegrationListResponse: ((IPCIntegrationListResponse) -> Void)?

    /// Called when the daemon sends an `integration_connect_result` message.
    public var onIntegrationConnectResult: ((IPCIntegrationConnectResult) -> Void)?

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

    /// Called when a schedule creates a conversation so the client can show it as a visible chat thread.
    public var onScheduleThreadCreated: ((IPCScheduleThreadCreated) -> Void)?

    /// Called when the daemon requests pairing approval from macOS.
    public var onPairingApprovalRequest: ((PairingApprovalRequestMessage) -> Void)?

    /// Called when the daemon sends the approved devices list.
    public var onApprovedDevicesListResponse: ((ApprovedDevicesListResponseMessage) -> Void)?

    /// Called when the daemon confirms a device removal.
    public var onApprovedDeviceRemoveResponse: ((ApprovedDeviceRemoveResponseMessage) -> Void)?

    /// Called when a subagent is spawned.
    public var onSubagentSpawned: ((IPCSubagentSpawned) -> Void)?

    /// Called when a subagent's status changes (running, completed, failed, aborted).
    public var onSubagentStatusChanged: ((IPCSubagentStatusChanged) -> Void)?

    /// Called when the daemon sends a `subagent_detail_response` with lazy-loaded events.
    public var onSubagentDetailResponse: ((IPCSubagentDetailResponse) -> Void)?

    /// Called when the daemon sends a `recording_pause` message.
    public var onRecordingPause: ((IPCRecordingPause) -> Void)?

    /// Called when the daemon sends a `recording_resume` message.
    public var onRecordingResume: ((IPCRecordingResume) -> Void)?

    /// Called when the daemon sends a `recording_start` message.
    public var onRecordingStart: ((IPCRecordingStart) -> Void)?

    /// Called when the daemon sends a `recording_stop` message.
    public var onRecordingStop: ((IPCRecordingStop) -> Void)?

    /// Called when the daemon sends a `client_settings_update` message.
    public var onClientSettingsUpdate: ((IPCClientSettingsUpdate) -> Void)?

    /// Called when the daemon broadcasts an `identity_changed` event (IDENTITY.md changed on disk).
    public var onIdentityChanged: ((IPCIdentityChanged) -> Void)?

    /// Called when the daemon sends an `avatar_updated` message after regenerating the avatar.
    public var onAvatarUpdated: ((IPCAvatarUpdated) -> Void)?

    /// Called when the daemon sends a `generate_avatar_response` message.
    public var onGenerateAvatarResponse: ((IPCGenerateAvatarResponse) -> Void)?

    /// Called when the daemon sends a `contacts_response` message.
    public var onContactsResponse: ((ContactsResponseMessage) -> Void)?

    /// Called when the daemon broadcasts a `contacts_changed` event (contact table mutated).
    public var onContactsChanged: ((IPCContactsChanged) -> Void)?

    // MARK: - Broadcast Subscribers

    /// Creates a new message stream for the caller. Each subscriber receives all messages
    /// independently, enabling multiple consumers (ComputerUseSession, AmbientAgent) to
    /// filter for messages relevant to them without competing for elements.
    public func subscribe() -> AsyncStream<ServerMessage> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        subscribers[id] = continuation
        // onTermination fires on an arbitrary thread, but `subscribers` is
        // MainActor-isolated. Dispatching via Task { @MainActor } is correct —
        // the removal happens on the next MainActor tick, which is safe because
        // a terminated continuation ignores further yields. The weak capture
        // prevents a retain cycle if DaemonClient is deallocated first.
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
    /// Legacy — only cleared on disconnect. Buffering + decoding now happens on the
    /// NWConnection queue via `decodeBuffer`.
    var receiveBuffer = Data()

    /// Buffer for accumulating incoming data on the NWConnection background queue.
    /// Accessed ONLY from NWConnection receive callbacks (which run on `queue`),
    /// so concurrent access is safe despite the @MainActor class isolation.
    nonisolated(unsafe) var decodeBuffer = Data()

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
    public var httpTransport: HTTPTransport?

    let encoder = JSONEncoder()
    let decoder = JSONDecoder()

    public private(set) var config: DaemonConfig

    // MARK: - Init

    public init(config: DaemonConfig = .default) {
        self.config = config
    }

    // MARK: - Reconfigure

    /// Reconfigure the daemon client's transport in place without replacing
    /// the object identity. This preserves all callback closures and
    /// subscriber references held by long-lived objects (ThreadManager,
    /// ChatViewModel, RecordingManager, etc.) across assistant switches.
    ///
    /// The method disconnects the current transport, updates the config,
    /// and resets connection-specific state. Callers must call `connect()`
    /// after reconfiguring to establish the new connection.
    public func reconfigure(config newConfig: DaemonConfig) {
        disconnect()
        self.config = newConfig
        // Reset connection-specific state
        isAuthenticated = false
        isBlobTransportAvailable = false
        httpPort = nil
        daemonVersion = nil
        latestMemoryStatus = nil
        currentModel = nil
        cuObservationSequenceBySession.removeAll()
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

    // MARK: - PID Validation

    /// Check whether the daemon process is alive by reading the PID file and
    /// sending signal 0 to the process. Returns `false` if the PID file is
    /// missing, unreadable, or the process is not running.
    #if os(macOS)
    public static func isDaemonProcessAlive(environment: [String: String]? = nil) -> Bool {
        let pidPath = VellumAssistantShared.resolvePidPath(environment: environment)
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: pidPath)),
              let pidString = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = pid_t(pidString) else {
            return false
        }
        return kill(pid, 0) == 0
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
        let sendID = OSSignpostID(log: ipcLog)
        os_signpost(.begin, log: ipcLog, name: "daemonIPCSend", signpostID: sendID)

        if let override = sendOverride {
            os_signpost(.end, log: ipcLog, name: "daemonIPCSend", signpostID: sendID)
            try override(message)
            return
        }

        // Route through HTTP transport when active (remote assistants).
        // Note: httpTransport.send() dispatches the actual HTTP request
        // asynchronously (Task { ... }), so the signpost only captures the
        // synchronous dispatch overhead, not the full network round-trip.
        // Full HTTP latency instrumentation belongs in HTTPDaemonClient.
        if let httpTransport {
            guard httpTransport.isConnected else {
                os_signpost(.end, log: ipcLog, name: "daemonIPCSend", signpostID: sendID)
                throw SendError.notConnected
            }
            do {
                try httpTransport.send(message)
                os_signpost(.end, log: ipcLog, name: "daemonIPCSend", signpostID: sendID)
            } catch {
                os_signpost(.end, log: ipcLog, name: "daemonIPCSend", signpostID: sendID)
                throw error
            }
            return
        }

        guard let conn = connection else {
            os_signpost(.end, log: ipcLog, name: "daemonIPCSend", signpostID: sendID)
            log.warning("Cannot send: not connected")
            throw SendError.notConnected
        }

        if !isAuthenticated, !(message is AuthMessage) {
            os_signpost(.end, log: ipcLog, name: "daemonIPCSend", signpostID: sendID)
            log.warning("Cannot send: authentication not complete")
            throw SendError.notAuthenticated
        }

        let data: Data
        do {
            var encoded = try encoder.encode(message)
            encoded.append(contentsOf: [0x0A]) // newline byte
            data = encoded
        } catch {
            os_signpost(.end, log: ipcLog, name: "daemonIPCSend", signpostID: sendID)
            throw error
        }

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
            os_signpost(.end, log: ipcLog, name: "daemonIPCSend", signpostID: sendID)
            if let error {
                log.error("Send failed: \(error.localizedDescription)")
            }
        })
    }

    public func sendConversationUnread(_ signal: IPCConversationUnreadSignal) async throws {
        if let override = sendOverride {
            try override(signal)
            return
        }

        if let httpTransport {
            guard httpTransport.isConnected else {
                throw SendError.notConnected
            }
            try await httpTransport.sendConversationUnread(signal)
            return
        }

        try send(signal)
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

    // MARK: - Surface Content Fetch

    /// Fetch the full surface payload for a stripped surface from the daemon HTTP API.
    /// For remote connections, delegates to `HTTPTransport`. For local connections,
    /// builds a request against the daemon's HTTP server directly.
    /// Returns the parsed `SurfaceData`, or `nil` on failure.
    public func fetchSurfaceData(surfaceId: String, sessionId: String) async -> SurfaceData? {
        if let httpTransport {
            return await httpTransport.fetchSurfaceData(surfaceId: surfaceId, sessionId: sessionId)
        }

        // Local daemon path — build request using the daemon HTTP port.
        let sEncoded = surfaceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? surfaceId
        let qEncoded = sessionId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? sessionId
        guard let request = buildLocalRequest(
            target: .daemon,
            path: "v1/surfaces/\(sEncoded)?sessionId=\(qEncoded)",
            timeout: 10
        ) else { return nil }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return nil }
            return Surface.parseSurfaceDataFromResponse(data)
        } catch {
            return nil
        }
    }

    // MARK: - Usage Reporting

    /// Fetch aggregate usage totals for a time range (epoch milliseconds).
    /// Delegates to HTTPTransport for remote connections, or calls the local daemon HTTP server.
    public func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse? {
        if let httpTransport {
            return await httpTransport.fetchUsageTotals(from: from, to: to)
        }

        guard let request = buildLocalRequest(
            target: .daemon,
            path: "v1/usage/totals?from=\(from)&to=\(to)",
            timeout: 10
        ) else { return nil }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return nil }
            return try JSONDecoder().decode(UsageTotalsResponse.self, from: data)
        } catch {
            return nil
        }
    }

    /// Fetch per-day usage buckets for a time range (epoch milliseconds).
    public func fetchUsageDaily(from: Int, to: Int) async -> UsageDailyResponse? {
        if let httpTransport {
            return await httpTransport.fetchUsageDaily(from: from, to: to)
        }

        guard let request = buildLocalRequest(
            target: .daemon,
            path: "v1/usage/daily?from=\(from)&to=\(to)",
            timeout: 10
        ) else { return nil }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return nil }
            return try JSONDecoder().decode(UsageDailyResponse.self, from: data)
        } catch {
            return nil
        }
    }

    /// Fetch grouped usage breakdown for a time range (epoch milliseconds).
    public func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageBreakdownResponse? {
        if let httpTransport {
            return await httpTransport.fetchUsageBreakdown(from: from, to: to, groupBy: groupBy)
        }

        let encoded = groupBy.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? groupBy
        guard let request = buildLocalRequest(
            target: .daemon,
            path: "v1/usage/breakdown?from=\(from)&to=\(to)&groupBy=\(encoded)",
            timeout: 10
        ) else { return nil }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return nil }
            return try JSONDecoder().decode(UsageBreakdownResponse.self, from: data)
        } catch {
            return nil
        }
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

    /// Run a schedule immediately as a one-off execution.
    public func sendRunScheduleNow(id: String) throws {
        try send(ScheduleRunNowMessage(id: id))
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

    /// Draft metadata for a skill from source text.
    public func draftSkill(sourceText: String) throws {
        try send(SkillsDraftRequestMessage(sourceText: sourceText))
    }

    /// Create a new managed skill.
    public func createSkill(skillId: String, name: String, description: String, emoji: String? = nil, bodyMarkdown: String, userInvocable: Bool? = nil, disableModelInvocation: Bool? = nil, overwrite: Bool? = nil) throws {
        try send(SkillsCreateMessage(skillId: skillId, name: name, description: description, emoji: emoji, bodyMarkdown: bodyMarkdown, userInvocable: userInvocable, disableModelInvocation: disableModelInvocation, overwrite: overwrite))
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
    public func sendSessionList(offset: Int? = nil, limit: Int? = nil) throws {
        try send(SessionListRequestMessage(offset: offset, limit: limit))
    }

    /// Request message history for a specific session.
    /// - Parameters:
    ///   - sessionId: The session to fetch history for.
    ///   - limit: Max messages to return per page.
    ///   - beforeTimestamp: Pagination cursor — only return messages before this timestamp (ms since epoch).
    ///   - mode: `"light"` omits heavy payloads (attachments, tool images, surface data); `"full"` includes everything.
    ///   - maxTextChars: When set, truncates assistant text content to this many characters.
    ///   - maxToolResultChars: When set, truncates tool result content to this many characters.
    public func sendHistoryRequest(sessionId: String, limit: Int? = nil, beforeTimestamp: Double? = nil, mode: String? = nil, maxTextChars: Int? = nil, maxToolResultChars: Int? = nil) throws {
        try send(HistoryRequestMessage(sessionId: sessionId, limit: limit, beforeTimestamp: beforeTimestamp, mode: mode, maxTextChars: maxTextChars, maxToolResultChars: maxToolResultChars))
    }

    /// Request full (untruncated) content for a specific message.
    /// Used to rehydrate messages that were loaded with truncated text/tool results.
    public func sendMessageContentRequest(sessionId: String, messageId: String) throws {
        try send(IPCMessageContentRequest(type: "message_content_request", sessionId: sessionId, messageId: messageId))
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

    /// Request version history for an app.
    public func sendAppHistory(appId: String, limit: Int? = nil) throws {
        try send(IPCAppHistoryRequest(type: "app_history_request", appId: appId, limit: limit.map { Double($0) }))
    }

    /// Request a diff between two versions of an app.
    public func sendAppDiff(appId: String, fromCommit: String, toCommit: String? = nil) throws {
        try send(IPCAppDiffRequest(type: "app_diff_request", appId: appId, fromCommit: fromCommit, toCommit: toCommit))
    }

    /// Restore an app to a previous version.
    public func sendAppRestore(appId: String, commitHash: String) throws {
        try send(IPCAppRestoreRequest(type: "app_restore_request", appId: appId, commitHash: commitHash))
    }

    /// Request Home Base metadata from the daemon.
    public func sendHomeBaseGet(ensureLinked: Bool = true) throws {
        try send(HomeBaseGetRequestMessage(ensureLinked: ensureLinked))
    }

    /// Request bundling an app for sharing.
    public func sendBundleApp(appId: String) throws {
        try send(BundleAppRequestMessage(appId: appId))
    }

    /// Request opening and scanning a .vellum bundle.
    public func sendOpenBundle(filePath: String) throws {
        try send(OpenBundleMessage(filePath: filePath))
    }

    /// Request the list of shared/received apps.
    public func sendSharedAppsList() throws {
        try send(SharedAppsListRequestMessage())
    }

    /// Delete a persistent user-created app by ID.
    public func sendAppDelete(appId: String) throws {
        try send(AppDeleteRequestMessage(appId: appId))
    }

    /// Delete a shared app by UUID.
    public func sendSharedAppDelete(uuid: String) throws {
        try send(SharedAppDeleteRequestMessage(uuid: uuid))
    }

    /// Fork a shared app into a local editable copy.
    public func sendForkSharedApp(uuid: String) throws {
        try send(ForkSharedAppRequestMessage(uuid: uuid))
    }

    /// Share a local app via a cloud link.
    public func sendShareAppCloud(appId: String) throws {
        try send(ShareAppCloudRequestMessage(appId: appId))
    }

    /// Get or set the Slack webhook URL configuration.
    public func sendSlackWebhookConfig(action: String, webhookUrl: String? = nil) throws {
        try send(SlackWebhookConfigRequestMessage(action: action, webhookUrl: webhookUrl))
    }

    /// Get, set, or delete the Vercel API token configuration.
    public func sendVercelApiConfig(action: String, apiToken: String? = nil) throws {
        try send(VercelApiConfigRequestMessage(action: action, apiToken: apiToken))
    }

    /// Guardian verification session management: "create_session", "status", "cancel_session", "revoke", "resend_session".
    public func sendGuardianVerification(
        action: String,
        channel: String? = nil,
        sessionId: String? = nil,
        rebind: Bool? = nil,
        destination: String? = nil,
        originConversationId: String? = nil
    ) throws {
        try send(GuardianVerificationRequestMessage(
            action: action,
            channel: channel,
            sessionId: sessionId,
            rebind: rebind,
            destination: destination,
            originConversationId: originConversationId
        ))
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

    /// Request avatar generation via the daemon's set_avatar tool.
    public func sendGenerateAvatar(description: String) throws {
        try send(GenerateAvatarRequestMessage(description: description))
    }

    // MARK: - Local Daemon HTTP Helpers

    /// Which local server a request should target.
    private enum LocalHTTPTarget {
        /// The daemon runtime HTTP server (port from httpPort, default 7821).
        case daemon
        /// The gateway server (port from GATEWAY_PORT env, default 7830).
        case gateway
    }

    /// Build an authenticated URLRequest for a local HTTP endpoint.
    ///
    /// Token resolution order:
    /// 1. `tokenOverride` (for callers that need a specific token, e.g. feature-flag token)
    /// 2. JWT from `ActorTokenManager.getToken()` — persisted in Keychain, so available
    ///    across app restarts once the initial bootstrap has completed. On first-ever
    ///    launch the bootstrap endpoint is unprotected (pre-auth), so the lack of a
    ///    token at that point is expected and harmless.
    ///
    /// Returns `nil` when the required port is unavailable.
    private func buildLocalRequest(
        target: LocalHTTPTarget,
        path: String,
        method: String = "GET",
        timeout: TimeInterval = 10,
        tokenOverride: String? = nil
    ) -> URLRequest? {
        let baseURL: String
        switch target {
        case .daemon:
            guard let port = httpPort else { return nil }
            baseURL = "http://localhost:\(port)"
        case .gateway:
            let port = ProcessInfo.processInfo.environment["GATEWAY_PORT"]
                .flatMap(Int.init) ?? 7830
            baseURL = "http://127.0.0.1:\(port)"
        }

        guard let url = URL(string: "\(baseURL)/\(path)") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout

        let token = tokenOverride.flatMap { $0.isEmpty ? nil : $0 }
            ?? ActorTokenManager.getToken().flatMap { $0.isEmpty ? nil : $0 }
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    // MARK: - Integrations Status

    public struct IntegrationsStatusResponse: Decodable {
        public struct Email: Decodable {
            public let address: String?
        }
        public let email: Email
    }

    /// Fetches integration status (e.g. assigned email) from the gateway via HTTP.
    /// For remote connections, uses `httpTransport` (which points at the gateway).
    /// For local connections, uses the provided `gatewayBaseURL` since
    /// `/integrations/status` is served by the gateway, not the daemon HTTP server.
    /// Returns `nil` when the gateway is unreachable or the request fails.
    public func fetchIntegrationsStatus(gatewayBaseURL: String? = nil) async -> IntegrationsStatusResponse? {
        let baseURL: String
        let bearerToken: String?

        if let httpTransport {
            baseURL = httpTransport.baseURL
            bearerToken = httpTransport.bearerToken
        } else if let gatewayBaseURL {
            baseURL = gatewayBaseURL
            bearerToken = ActorTokenManager.getToken().flatMap { $0.isEmpty ? nil : $0 }
        } else {
            return nil
        }

        guard let url = URL(string: "\(baseURL)/integrations/status") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        if let token = bearerToken, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(IntegrationsStatusResponse.self, from: data)
        } catch {
            return nil
        }
    }

    // MARK: - Interface Files

    /// Fetch an interface file from the daemon via HTTP (`GET /v1/interfaces/<path>`).
    /// Uses `httpTransport` for remote assistants or `httpPort` for local connections.
    /// Returns the file content as a string, or `nil` if the file does not exist.
    public func fetchInterfaceFile(path: String) async -> String? {
        let request: URLRequest

        if let httpTransport {
            guard let url = URL(string: "\(httpTransport.baseURL)/v1/interfaces/\(path)") else { return nil }
            var r = URLRequest(url: url)
            r.timeoutInterval = 5
            if let token = httpTransport.bearerToken, !token.isEmpty {
                r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request = r
        } else if let r = buildLocalRequest(target: .daemon, path: "v1/interfaces/\(path)", timeout: 5) {
            request = r
        } else {
            return nil
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

    // MARK: - Heartbeat

    /// Get the current heartbeat configuration.
    public func sendHeartbeatConfigGet() throws {
        try send(IPCHeartbeatConfig(type: "heartbeat_config", action: "get"))
    }

    /// Set heartbeat configuration fields.
    public func sendHeartbeatConfigSet(enabled: Bool? = nil, intervalMs: Double? = nil, activeHoursStart: Double? = nil, activeHoursEnd: Double? = nil) throws {
        try send(IPCHeartbeatConfig(type: "heartbeat_config", action: "set", enabled: enabled, intervalMs: intervalMs, activeHoursStart: activeHoursStart, activeHoursEnd: activeHoursEnd))
    }

    /// Request the list of recent heartbeat runs.
    public func sendHeartbeatRunsList(limit: Int? = nil) throws {
        try send(IPCHeartbeatRunsList(type: "heartbeat_runs_list", limit: limit.map { Double($0) }))
    }

    /// Trigger an immediate heartbeat run.
    public func sendHeartbeatRunNow() throws {
        try send(IPCHeartbeatRunNow(type: "heartbeat_run_now"))
    }

    /// Read the heartbeat checklist (HEARTBEAT.md).
    public func sendHeartbeatChecklistRead() throws {
        try send(IPCHeartbeatChecklistRead(type: "heartbeat_checklist_read"))
    }

    /// Write the heartbeat checklist (HEARTBEAT.md).
    public func sendHeartbeatChecklistWrite(content: String) throws {
        try send(IPCHeartbeatChecklistWrite(type: "heartbeat_checklist_write", content: content))
    }

    // MARK: - Pairing

    /// Send the user's pairing approval decision.
    public func sendPairingApprovalResponse(pairingRequestId: String, decision: String) throws {
        try send(PairingApprovalResponseMessage(pairingRequestId: pairingRequestId, decision: decision))
    }

    /// Request the list of always-allowed devices.
    public func sendApprovedDevicesList() throws {
        try send(ApprovedDevicesListMessage())
    }

    /// Remove a device from the always-allow list.
    public func sendApprovedDeviceRemove(hashedDeviceId: String) throws {
        try send(ApprovedDeviceRemoveMessage(hashedDeviceId: hashedDeviceId))
    }

    /// Clear all approved devices.
    public func sendApprovedDevicesClear() throws {
        try send(ApprovedDevicesClearMessage())
    }

    // MARK: - Guardian Actions

    /// Request pending guardian action prompts for a conversation.
    public func sendGuardianActionsPendingRequest(conversationId: String) throws {
        try send(GuardianActionsPendingRequestMessage(conversationId: conversationId))
    }

    /// Submit a guardian action decision.
    public func sendGuardianActionDecision(requestId: String, action: String, conversationId: String? = nil) throws {
        try send(GuardianActionDecisionMessage(requestId: requestId, action: action, conversationId: conversationId))
    }

    // MARK: - Contacts Management

    /// Response from the channel verification endpoint.
    public struct ChannelVerificationResult: Decodable {
        public let ok: Bool
        public let verificationSessionId: String?
        public let expiresAt: Int?
        public let sendCount: Int?
        public let telegramBootstrapUrl: String?
        public let error: String?
    }

    /// A channel to attach when creating a new contact.
    public struct NewContactChannel: Codable {
        public let type: String
        public let address: String
        public let isPrimary: Bool

        public init(type: String, address: String, isPrimary: Bool = false) {
            self.type = type
            self.address = address
            self.isPrimary = isPrimary
        }
    }

    /// Request the list of all contacts from the daemon, optionally filtered by role.
    public func sendListContacts(role: String? = nil, limit: Int? = nil) throws {
        try send(ContactsRequestMessage(action: "list", role: role, limit: limit))
    }

    /// Request a single contact by ID.
    public func sendGetContact(contactId: String) throws {
        try send(ContactsRequestMessage(action: "get", contactId: contactId))
    }

    /// Update a contact channel's status and/or policy.
    public func sendUpdateContactChannel(channelId: String, status: String? = nil, policy: String? = nil, reason: String? = nil) throws {
        try send(ContactsRequestMessage(action: "update_channel", channelId: channelId, status: status, policy: policy, reason: reason))
    }

    /// Request deletion of a contact by ID.
    public func sendDeleteContact(contactId: String) throws {
        try send(ContactsRequestMessage(action: "delete", contactId: contactId))
    }

    /// Update a contact's metadata via the HTTP API (`POST /v1/contacts`).
    /// Routes through `HTTPTransport` when available so that managed-mode
    /// URL paths (`/v1/assistants/{id}/contacts/`) and auth headers
    /// (`X-Session-Token`) are applied correctly. Falls back to the local
    /// daemon HTTP server for socket-based connections.
    public func updateContact(
        contactId: String,
        displayName: String,
        notes: String? = nil
    ) async throws -> ContactPayload? {
        // Delegate to HTTPTransport when active — it handles buildURL/applyAuth
        // for both runtimeFlat and platformAssistantProxy route modes.
        if let httpTransport {
            return try await httpTransport.updateContactAndReturn(
                contactId: contactId,
                displayName: displayName,
                notes: notes
            )
        }

        // Local daemon path: direct HTTP call using the runtime server port.
        guard var request = buildLocalRequest(target: .daemon, path: "v1/contacts", method: "POST") else { return nil }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["id": contactId, "displayName": displayName]
        if let notes { body["notes"] = notes }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200...201).contains(http.statusCode) else { return nil }

        struct UpsertResponse: Decodable {
            let ok: Bool
            let contact: ContactPayload
        }
        let decoded = try JSONDecoder().decode(UpsertResponse.self, from: data)
        return decoded.contact
    }

    /// Create a new contact via the HTTP API (`POST /v1/contacts`).
    /// Omits the `id` field to trigger creation instead of update.
    /// Routes through `HTTPTransport` when available so that managed-mode
    /// URL paths and auth headers are applied correctly. Falls back to the
    /// local daemon HTTP server for socket-based connections.
    public func createContact(
        displayName: String,
        notes: String? = nil,
        channels: [NewContactChannel]? = nil
    ) async throws -> ContactPayload? {
        if let httpTransport {
            return try await httpTransport.createContactAndReturn(
                displayName: displayName,
                notes: notes,
                channels: channels
            )
        }

        guard var request = buildLocalRequest(target: .daemon, path: "v1/contacts", method: "POST") else { return nil }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["displayName": displayName]
        if let notes { body["notes"] = notes }
        if let channels {
            body["channels"] = channels.map { ch -> [String: Any] in
                ["type": ch.type, "address": ch.address, "isPrimary": ch.isPrimary]
            }
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200...201).contains(http.statusCode) else { return nil }

        struct UpsertResponse: Decodable {
            let ok: Bool
            let contact: ContactPayload
        }
        let decoded = try JSONDecoder().decode(UpsertResponse.self, from: data)
        return decoded.contact
    }

    /// Create an invite for a contact channel via `POST /v1/contacts/invites`.
    /// Routes through `HTTPTransport` when available. Falls back to the
    /// local gateway (port 7830) for socket-based connections.
    public func createInvite(
        sourceChannel: String,
        note: String? = nil,
        maxUses: Int? = nil,
        contactName: String? = nil
    ) async throws -> (inviteId: String, token: String, shareUrl: String?, inviteCode: String?, guardianInstruction: String?, channelHandle: String?)? {
        if let httpTransport {
            return try await httpTransport.createInvite(sourceChannel: sourceChannel, note: note, maxUses: maxUses, contactName: contactName)
        }

        #if os(macOS)
        guard var request = buildLocalRequest(target: .gateway, path: "v1/contacts/invites", method: "POST") else { return nil }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["sourceChannel": sourceChannel]
        if let note { body["note"] = note }
        if let maxUses { body["maxUses"] = maxUses }
        if let contactName { body["contactName"] = contactName }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200...201).contains(http.statusCode) else { return nil }

        struct CreateInviteResponse: Decodable {
            let ok: Bool
            let invite: InviteData?
            struct InviteData: Decodable {
                let id: String
                let token: String?
                let share: ShareData?
                let inviteCode: String?
                let guardianInstruction: String?
                let channelHandle: String?
            }
            struct ShareData: Decodable {
                let url: String
                let displayText: String
            }
        }
        let decoded = try JSONDecoder().decode(CreateInviteResponse.self, from: data)
        guard let invite = decoded.invite, let token = invite.token else { return nil }
        return (inviteId: invite.id, token: token, shareUrl: invite.share?.url, inviteCode: invite.inviteCode, guardianInstruction: invite.guardianInstruction, channelHandle: invite.channelHandle)
        #else
        return nil
        #endif
    }

    /// A single readiness check result from the API.
    public struct ReadinessCheck {
        public let name: String
        public let passed: Bool
        public let message: String
    }

    /// Rich channel readiness information returned by `fetchChannelReadiness()`.
    public struct ChannelReadinessInfo {
        public let ready: Bool
        public let channelHandle: String?
        public let checks: [ReadinessCheck]

        /// Human-readable reason why this channel is not ready, derived from
        /// the first failing check. Returns `nil` when the channel is ready.
        public var reasonSummary: String? {
            guard !ready else { return nil }
            return checks.first(where: { !$0.passed })?.message
        }
    }

    /// Fetch per-channel readiness state from the gateway.
    /// Routes through `HTTPTransport` when available. Falls back to the
    /// local gateway for socket-based connections.
    public func fetchChannelReadiness() async throws -> [String: ChannelReadinessInfo] {
        if let httpTransport {
            return try await httpTransport.fetchChannelReadiness()
        }

        #if os(macOS)
        guard let request = buildLocalRequest(target: .gateway, path: "v1/channels/readiness", method: "GET") else { return [:] }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode) else { return [:] }

        struct ReadinessResponse: Decodable {
            let success: Bool
            let snapshots: [Snapshot]
            struct Snapshot: Decodable {
                let channel: String
                let ready: Bool
                let channelHandle: String?
                let localChecks: [CheckResult]?
                let remoteChecks: [CheckResult]?
            }
            struct CheckResult: Decodable {
                let name: String
                let passed: Bool
                let message: String
            }
        }
        let decoded = try JSONDecoder().decode(ReadinessResponse.self, from: data)
        var result: [String: ChannelReadinessInfo] = [:]
        for snapshot in decoded.snapshots {
            let checks = ((snapshot.localChecks ?? []) + (snapshot.remoteChecks ?? []))
                .map { ReadinessCheck(name: $0.name, passed: $0.passed, message: $0.message) }
            result[snapshot.channel] = ChannelReadinessInfo(
                ready: snapshot.ready,
                channelHandle: snapshot.channelHandle,
                checks: checks
            )
        }
        return result
        #else
        return [:]
        #endif
    }

    /// Send a verification code to a contact's channel via the gateway.
    /// Routes through `HTTPTransport` when available. Falls back to the
    /// local gateway (port 7830) for socket-based connections.
    public func verifyContactChannel(
        contactChannelId: String
    ) async throws -> ChannelVerificationResult? {
        if let httpTransport {
            return try await httpTransport.verifyContactChannel(
                contactChannelId: contactChannelId
            )
        }

        #if os(macOS)
        let encoded = contactChannelId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? contactChannelId
        guard var request = buildLocalRequest(target: .gateway, path: "v1/contact-channels/\(encoded)/verify", method: "POST") else { return nil }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode) else { return nil }
        return try JSONDecoder().decode(ChannelVerificationResult.self, from: data)
        #else
        return nil
        #endif
    }

    // MARK: - Feature Flags

    /// A single assistant feature flag entry returned by `GET /v1/feature-flags`.
    /// Used by the `fetchAssistantFeatureFlags()` API path.
    public struct AssistantFeatureFlagEntry: Decodable, Identifiable {
        public let key: String
        public let enabled: Bool
        public let defaultEnabled: Bool
        public let description: String
        public let label: String?

        public var id: String { key }

        public init(key: String, enabled: Bool, defaultEnabled: Bool, description: String, label: String? = nil) {
            self.key = key
            self.enabled = enabled
            self.defaultEnabled = defaultEnabled
            self.description = description
            self.label = label
        }
    }

    /// A feature flag sourced from the gateway API.
    /// Used by the `getFeatureFlags()` API path and the settings UI.
    public struct AssistantFeatureFlag: Decodable, Identifiable {
        public let key: String
        public let enabled: Bool
        public let defaultEnabled: Bool?
        public let description: String?
        public let label: String?

        public var id: String { key }

        public init(key: String, enabled: Bool, defaultEnabled: Bool? = true, description: String? = nil, label: String? = nil) {
            self.key = key
            self.enabled = enabled
            self.defaultEnabled = defaultEnabled
            self.description = description
            self.label = label
        }

        /// Derive a human-readable name from the flag key.
        /// e.g. "feature_flags.hatch-new-assistant.enabled" -> "Hatch New Assistant"
        public var displayName: String {
            if let label = label { return label }
            var name = key
            // Strip common prefix/suffix patterns
            if name.hasPrefix("feature_flags.") {
                name = String(name.dropFirst("feature_flags.".count))
            }
            if name.hasSuffix(".enabled") {
                name = String(name.dropLast(".enabled".count))
            }
            // Convert snake_case/dot.case to Title Case
            return name
                .replacingOccurrences(of: "_", with: " ")
                .replacingOccurrences(of: "-", with: " ")
                .replacingOccurrences(of: ".", with: " ")
                .split(separator: " ")
                .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
                .joined(separator: " ")
        }
    }

    /// Response shape for `GET /v1/feature-flags` (AssistantFeatureFlagEntry variant).
    private struct AssistantFeatureFlagsResponse: Decodable {
        let flags: [AssistantFeatureFlagEntry]
    }

    /// Response shape from `GET /v1/feature-flags` (AssistantFeatureFlag variant).
    private struct FeatureFlagsResponse: Decodable {
        let flags: [AssistantFeatureFlag]
    }

    /// Resolve an auth token for feature-flag requests.
    /// The gateway requires JWT edge tokens with `feature_flags.read`/`feature_flags.write`
    /// scopes (via `requireEdgeAuthWithScope`). The JWT access token from
    /// `ActorTokenManager` carries these scopes in the `actor_client_v1` profile.
    private func resolveFeatureFlagAuthToken() -> String? {
        // Prefer the JWT access token — it carries the required scopes
        if let jwt = ActorTokenManager.getToken(), !jwt.isEmpty { return jwt }
        if let ff = config.featureFlagToken, !ff.isEmpty { return ff }
        if let httpTransport { return httpTransport.bearerToken }
        return nil
    }

    /// Fetch all assistant feature flags from the gateway's `GET /v1/feature-flags` endpoint.
    /// Uses the runtime bearer token or feature-flag token for auth.
    ///
    /// Routing logic mirrors `setFeatureFlag`: remote mode delegates to `httpTransport`,
    /// local mode calls the gateway directly on port 7830.
    public func fetchAssistantFeatureFlags() async throws -> [AssistantFeatureFlagEntry] {
        guard let token = resolveFeatureFlagAuthToken() else {
            throw FeatureFlagError.missingToken
        }

        #if os(macOS)
        if let httpTransport = self.httpTransport, !Self.isLocalBaseURL(httpTransport.baseURL) {
            let sid = OSSignpostID(log: ipcLog)
            os_signpost(.begin, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid)
            defer { os_signpost(.end, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid) }
            return try await httpTransport.fetchAssistantFeatureFlags(featureFlagToken: token)
        }

        guard let request = buildLocalRequest(target: .gateway, path: "v1/feature-flags", tokenOverride: token) else {
            throw FeatureFlagError.invalidURL
        }

        let sid = OSSignpostID(log: ipcLog)
        os_signpost(.begin, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid)
        defer { os_signpost(.end, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid) }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw FeatureFlagError.requestFailed(statusCode)
        }

        let decoded = try JSONDecoder().decode(AssistantFeatureFlagsResponse.self, from: data)
        return decoded.flags
        #else
        guard let httpTransport else {
            throw FeatureFlagError.requestFailed(0)
        }
        let sid = OSSignpostID(log: ipcLog)
        os_signpost(.begin, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid)
        defer { os_signpost(.end, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid) }
        return try await httpTransport.fetchAssistantFeatureFlags(featureFlagToken: token)
        #endif
    }

    /// Fetch all assistant feature flags from the gateway's GET /v1/feature-flags endpoint.
    /// Authenticates with the feature-flag token when available, otherwise falls back
    /// to the runtime bearer token (the gateway accepts both).
    public func getFeatureFlags() async throws -> [AssistantFeatureFlag] {
        guard let token = resolveFeatureFlagAuthToken() else {
            throw FeatureFlagError.missingToken
        }

        #if os(macOS)
        if let httpTransport = self.httpTransport, !Self.isLocalBaseURL(httpTransport.baseURL) {
            let sid = OSSignpostID(log: ipcLog)
            os_signpost(.begin, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid)
            defer { os_signpost(.end, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid) }
            return try await httpTransport.getFeatureFlags(featureFlagToken: token)
        }

        // Local mode: call the gateway directly.
        guard let request = buildLocalRequest(target: .gateway, path: "v1/feature-flags", tokenOverride: token) else {
            throw FeatureFlagError.invalidURL
        }

        let sid = OSSignpostID(log: ipcLog)
        os_signpost(.begin, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid)
        defer { os_signpost(.end, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid) }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw FeatureFlagError.requestFailed(statusCode)
        }

        let decoded = try JSONDecoder().decode(FeatureFlagsResponse.self, from: data)
        return decoded.flags
        #else
        guard let httpTransport else {
            throw FeatureFlagError.requestFailed(0)
        }
        let sid = OSSignpostID(log: ipcLog)
        os_signpost(.begin, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid)
        defer { os_signpost(.end, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid) }
        return try await httpTransport.getFeatureFlags(featureFlagToken: token)
        #endif
    }

    /// Toggle a feature flag via the gateway's PATCH /v1/feature-flags/:flagKey endpoint.
    /// Authenticates with the feature-flag token when available, otherwise falls back
    /// to the runtime bearer token (the gateway accepts both).
    ///
    /// On macOS: if `httpTransport` targets a **remote** gateway (non-localhost baseURL),
    /// delegates to it. Otherwise (socket transport or local HTTP via `localHttpEnabled`),
    /// calls the local gateway directly on port 7830 because the runtime HTTP server
    /// doesn't serve feature-flag routes.
    /// On iOS, always delegates to `httpTransport` which targets the remote gateway.
    public func setFeatureFlag(key: String, enabled: Bool) async throws {
        guard let token = resolveFeatureFlagAuthToken() else {
            throw FeatureFlagError.missingToken
        }

        #if os(macOS)
        // Remote mode: httpTransport targets a non-local gateway (e.g. cloud).
        // Delegate to it directly. When localHttpEnabled is on, httpTransport
        // points at localhost (the runtime), which does NOT serve feature-flag
        // routes — so we must fall through to the local gateway path below.
        if let httpTransport = self.httpTransport, !Self.isLocalBaseURL(httpTransport.baseURL) {
            let sid = OSSignpostID(log: ipcLog)
            os_signpost(.begin, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid)
            defer { os_signpost(.end, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid) }
            try await httpTransport.setFeatureFlag(key: key, enabled: enabled, featureFlagToken: token)
            return
        }

        // Local mode (socket, TCP, or local HTTP): call the gateway directly.
        let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key
        guard var request = buildLocalRequest(target: .gateway, path: "v1/feature-flags/\(encoded)", method: "PATCH", tokenOverride: token) else {
            throw FeatureFlagError.invalidURL
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = ["enabled": enabled]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let sid = OSSignpostID(log: ipcLog)
        os_signpost(.begin, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid)
        defer { os_signpost(.end, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid) }

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw FeatureFlagError.requestFailed(statusCode)
        }
        #else
        // iOS: httpTransport targets the remote gateway, which serves feature-flag routes.
        guard let httpTransport else {
            throw FeatureFlagError.requestFailed(0)
        }
        let sid = OSSignpostID(log: ipcLog)
        os_signpost(.begin, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid)
        defer { os_signpost(.end, log: ipcLog, name: "daemonHTTPRequest", signpostID: sid) }
        try await httpTransport.setFeatureFlag(key: key, enabled: enabled, featureFlagToken: token)
        #endif
    }

    /// Returns true if the given base URL points to localhost / 127.0.0.1.
    private static func isLocalBaseURL(_ urlString: String) -> Bool {
        guard let comps = URLComponents(string: urlString), let host = comps.host?.lowercased() else {
            return false
        }
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
    }

    public enum FeatureFlagError: Error, LocalizedError {
        case missingToken
        case invalidURL
        case requestFailed(Int)

        public var errorDescription: String? {
            switch self {
            case .missingToken:
                return "Feature-flag token not available"
            case .invalidURL:
                return "Invalid feature-flag endpoint URL"
            case .requestFailed(let code):
                return "Feature-flag request failed (HTTP \(code))"
            }
        }
    }

    // MARK: - Actor Token Bootstrap

    /// Response from `POST /v1/guardian/init`.
    /// Accepts both `accessToken` (new) and `actorToken` (legacy) field names.
    public struct GuardianBootstrapResponse: Decodable {
        public let guardianPrincipalId: String
        /// The JWT access token — accepts either `accessToken` or legacy `actorToken`.
        public let accessToken: String
        public let accessTokenExpiresAt: Int?
        public let refreshToken: String?
        public let refreshTokenExpiresAt: Int?
        public let refreshAfter: Int?
        public let isNew: Bool

        private enum CodingKeys: String, CodingKey {
            case guardianPrincipalId
            case accessToken
            case actorToken
            case accessTokenExpiresAt
            case actorTokenExpiresAt
            case refreshToken
            case refreshTokenExpiresAt
            case refreshAfter
            case isNew
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            guardianPrincipalId = try container.decode(String.self, forKey: .guardianPrincipalId)
            // Accept "accessToken" first, fall back to legacy "actorToken"
            if let token = try container.decodeIfPresent(String.self, forKey: .accessToken) {
                accessToken = token
            } else {
                accessToken = try container.decode(String.self, forKey: .actorToken)
            }
            // Accept "accessTokenExpiresAt" first, fall back to legacy "actorTokenExpiresAt"
            if let expiresAt = try container.decodeIfPresent(Int.self, forKey: .accessTokenExpiresAt) {
                accessTokenExpiresAt = expiresAt
            } else {
                accessTokenExpiresAt = try container.decodeIfPresent(Int.self, forKey: .actorTokenExpiresAt)
            }
            refreshToken = try container.decodeIfPresent(String.self, forKey: .refreshToken)
            refreshTokenExpiresAt = try container.decodeIfPresent(Int.self, forKey: .refreshTokenExpiresAt)
            refreshAfter = try container.decodeIfPresent(Int.self, forKey: .refreshAfter)
            isNew = try container.decode(Bool.self, forKey: .isNew)
        }
    }

    /// Calls the runtime's guardian bootstrap endpoint to obtain a JWT access token.
    /// The token is bound to (assistantId, platform, deviceId) and persisted
    /// in Keychain via `ActorTokenManager`.
    ///
    /// Returns `true` on success, `false` on failure.
    public func bootstrapActorToken(platform: String, deviceId: String) async -> Bool {
        var request: URLRequest

        if let httpTransport {
            guard let url = URL(string: "\(httpTransport.baseURL)/v1/guardian/init") else {
                log.error("Invalid bootstrap URL")
                return false
            }
            var r = URLRequest(url: url)
            r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.timeoutInterval = 15
            if let token = httpTransport.bearerToken, !token.isEmpty {
                r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request = r
        } else if var r = buildLocalRequest(target: .daemon, path: "v1/guardian/init", method: "POST", timeout: 15) {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request = r
        } else {
            log.error("Cannot bootstrap access token — no HTTP endpoint available")
            return false
        }

        let body: [String: Any] = [
            "platform": platform,
            "deviceId": deviceId
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                log.error("Access token bootstrap failed (HTTP \(statusCode))")
                return false
            }

            let decoded = try JSONDecoder().decode(GuardianBootstrapResponse.self, from: data)
            if let refreshToken = decoded.refreshToken,
               let accessTokenExpiresAt = decoded.accessTokenExpiresAt,
               let refreshTokenExpiresAt = decoded.refreshTokenExpiresAt,
               let refreshAfter = decoded.refreshAfter {
                ActorTokenManager.storeCredentials(
                    actorToken: decoded.accessToken,
                    actorTokenExpiresAt: accessTokenExpiresAt,
                    refreshToken: refreshToken,
                    refreshTokenExpiresAt: refreshTokenExpiresAt,
                    refreshAfter: refreshAfter,
                    guardianPrincipalId: decoded.guardianPrincipalId
                )
            } else {
                // Legacy fallback for older runtimes that don't return refresh tokens.
                // Clear any stale refresh metadata from prior pairings so proactive
                // refresh / 401 recovery don't send an expired token.
                ActorTokenManager.setToken(decoded.accessToken)
                ActorTokenManager.setGuardianPrincipalId(decoded.guardianPrincipalId)
                ActorTokenManager.clearRefreshMetadata()
            }
            log.info("Access token bootstrap succeeded (isNew=\(decoded.isNew))")
            return true
        } catch {
            log.error("Access token bootstrap error: \(error.localizedDescription)")
            return false
        }
    }

}
