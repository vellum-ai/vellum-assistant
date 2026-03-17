import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonClient")

/// Shared signpost log for network instrumentation (Points of Interest lane in Instruments).
private let networkLog = OSLog(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: .pointsOfInterest
)

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

/// Resolve the daemon PID file path, honoring `BASE_DATA_DIR`.
public func resolvePidPath(environment: [String: String]? = nil) -> String {
    return resolveVellumDir(environment: environment) + "/vellum.pid"
}

/// Protocol for daemon client communication, enabling dependency injection and testing.
@MainActor
public protocol DaemonClientProtocol {
    var isConnected: Bool { get }
    func subscribe() -> AsyncStream<ServerMessage>
    func send<T: Encodable>(_ message: T) throws
    func sendConversationUnread(_ signal: ConversationUnreadSignal) async throws
    func connect() async throws
    func disconnect()
    func startSSE()
    func stopSSE()
    func sendBtwMessage(content: String, conversationKey: String) -> AsyncThrowingStream<String, Error>
}

extension DaemonClientProtocol {
    public func sendConversationUnread(_ signal: ConversationUnreadSignal) async throws {
        try send(signal)
    }

    /// Default no-op implementation for clients that don't support btw side-chain.
    public func sendBtwMessage(content: String, conversationKey: String) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { $0.finish() }
    }
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

    /// Posted when the daemon's signing key fingerprint changes, indicating an instance switch.
    /// Observers should trigger credential re-bootstrap.
    public static let daemonInstanceChanged = Notification.Name("daemonInstanceChanged")
}

/// Platform-agnostic client for communicating with the Vellum daemon via HTTP + SSE.
///
/// This is a long-lived singleton. Consumers call `subscribe()` to get an independent message
/// stream, enabling multiple consumers (HostCuExecutor, AmbientAgent) to each receive all
/// messages and filter for the ones relevant to them.
///
/// - Important: New HTTP API calls should **not** be added here. Use `GatewayHTTPClient`
///   instead, injected via a focused protocol (e.g. `ConversationClientProtocol`).
///   Existing methods are being incrementally migrated to standalone clients backed by
///   `GatewayHTTPClient`. See `clients/ARCHITECTURE.md` for details.
@MainActor
public final class DaemonClient: ObservableObject, DaemonClientProtocol {

    // MARK: - Static Helpers

    /// Character set for percent-encoding query-string values, excluding
    /// query-string metacharacters that would break parameter parsing.
    private static let queryValueAllowed: CharacterSet = {
        var cs = CharacterSet.urlQueryAllowed
        cs.remove(charactersIn: "&=+#")
        return cs
    }()

    // MARK: - Published State

    @Published public var isConnected: Bool = false
    public var isConnecting: Bool = false

    /// The runtime HTTP server port, populated via `daemon_status` on connect.
    /// `nil` means the HTTP server is not running.
    @Published public var httpPort: Int?

    /// Platform identifier for automatic 401 re-bootstrap (e.g. "macos", "ios").
    /// Set by the app delegate after creating the client.
    public var recoveryPlatform: String?

    /// Device identifier for automatic 401 re-bootstrap.
    /// Set by the app delegate after creating the client.
    public var recoveryDeviceId: String?

    /// Returns a closure that resolves the current HTTP port at call time.
    /// Use this instead of reading `httpPort` directly when the value must
    /// reflect the latest daemon state (e.g. after a daemon restart). The
    /// closure captures `self` weakly to avoid retain cycles.
    public var httpPortResolver: () -> Int? {
        { [weak self] in self?.httpPort }
    }

    /// The daemon version string, populated via `daemon_status` on connect.
    @Published public internal(set) var daemonVersion: String?

    /// Signing key fingerprint from the connected daemon, populated via `daemon_status`.
    /// Used to detect instance switches — if this changes, the stored actor token is stale.
    @Published public internal(set) var keyFingerprint: String?

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

    /// Called when the daemon sends a `host_bash_request` message for proxy command execution.
    public var onHostBashRequest: ((HostBashRequest) -> Void)?

    /// Called when the daemon sends a `host_file_request` message for proxy file operations.
    public var onHostFileRequest: ((HostFileRequest) -> Void)?

    /// Called when the daemon sends a `host_cu_request` message for proxy CU action execution.
    public var onHostCuRequest: ((HostCuRequest) -> Void)?

    /// Called when the daemon sends a `dictation_response` message.
    public var onDictationResponse: ((DictationResponseMessage) -> Void)?

    /// Called when the daemon emits a generic `notification_intent` payload.
    public var onNotificationIntent: ((NotificationIntentMessage) -> Void)?

    /// Called when a notification delivery creates a new vellum conversation.
    public var onNotificationConversationCreated: ((NotificationConversationCreated) -> Void)?


    /// Called when the daemon sends a `skills_state_changed` push event.
    public var onSkillStateChanged: ((SkillStateChangedMessage) -> Void)?

    /// Called when the daemon sends a `trace_event` message.
    public var onTraceEvent: ((TraceEventMessage) -> Void)?

    /// Called when the daemon sends a `usage_update` message.
    public var onUsageUpdate: ((UsageUpdate) -> Void)?

    /// Called when the daemon sends a `conversation_list_response` message.
    public var onConversationListResponse: ((ConversationListResponseMessage) -> Void)?

    /// Called when the daemon sends a `conversation_title_updated` message.
    public var onConversationTitleUpdated: ((ConversationTitleUpdatedMessage) -> Void)?

    /// Called when the daemon sends a `history_response` message.
    public var onHistoryResponse: ((HistoryResponse) -> Void)?

    /// Called when the daemon sends a `message_content_response` with full (untruncated) content.
    public var onMessageContentResponse: ((MessageContentResponse) -> Void)?

    /// Called when the daemon sends a `slack_webhook_config_response` message.
    public var onSlackWebhookConfigResponse: ((SlackWebhookConfigResponseMessage) -> Void)?

    /// Called when the daemon sends an `ingress_config_response` message.
    public var onIngressConfigResponse: ((IngressConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `platform_config_response` message.
    public var onPlatformConfigResponse: ((PlatformConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `vercel_api_config_response` message.
    public var onVercelApiConfigResponse: ((VercelApiConfigResponseMessage) -> Void)?

    /// Called when the daemon sends a `channel_verification_session_response` message.
    public var onChannelVerificationSessionResponse: ((ChannelVerificationSessionResponseMessage) -> Void)?

    /// Called when the daemon sends a `telegram_config_response` message.
    public var onTelegramConfigResponse: ((TelegramConfigResponseMessage) -> Void)?


    /// The currently active model ID, populated via `model_info` responses.
    @Published public var currentModel: String?

    /// The latest full model info response from the daemon stream.
    @Published public var latestModelInfo: ModelInfoMessage?

    /// Called when the daemon sends an `open_url` message.
    public var onOpenUrl: ((OpenUrlMessage) -> Void)?

    /// Called when the daemon sends a `navigate_settings` message.
    public var onNavigateSettings: ((NavigateSettings) -> Void)?

    /// Called when the daemon sends a `ui_layout_config` message.
    public var onLayoutConfig: ((UiLayoutConfigMessage) -> Void)?

    /// Called when the daemon sends a `diagnostics_export_response` message.
    public var onDiagnosticsExportResponse: ((DiagnosticsExportResponseMessage) -> Void)?

    /// Called when the daemon sends an `env_vars_response` message (debug builds only).
    public var onEnvVarsResponse: ((EnvVarsResponseMessage) -> Void)?


    /// Called when the daemon sends a `work_item_status_changed` broadcast.
    public var onWorkItemStatusChanged: ((WorkItemStatusChanged) -> Void)?

    /// Called when the daemon sends a `tasks_changed` broadcast.
    public var onTasksChanged: ((TasksChanged) -> Void)?






    /// Called when the daemon sends a generic `error` message (e.g. when a handler fails).
    public var onError: ((ErrorMessage) -> Void)?

    /// Called when a task run creates a conversation so the client can show it as a visible chat conversation.
    public var onTaskRunConversationCreated: ((TaskRunConversationCreated) -> Void)?

    /// Called when a schedule creates a conversation so the client can show it as a visible chat conversation.
    public var onScheduleConversationCreated: ((ScheduleConversationCreated) -> Void)?

    /// Called when the daemon requests pairing approval from macOS.
    public var onPairingApprovalRequest: ((PairingApprovalRequestMessage) -> Void)?

    /// Called when a subagent is spawned.
    public var onSubagentSpawned: ((SubagentSpawned) -> Void)?

    /// Called when a subagent's status changes (running, completed, failed, aborted).
    public var onSubagentStatusChanged: ((SubagentStatusChanged) -> Void)?


    /// Called when the daemon sends a `recording_pause` message.
    public var onRecordingPause: ((RecordingPause) -> Void)?

    /// Called when the daemon sends a `recording_resume` message.
    public var onRecordingResume: ((RecordingResume) -> Void)?

    /// Called when the daemon sends a `recording_start` message.
    public var onRecordingStart: ((RecordingStart) -> Void)?

    /// Called when the daemon sends a `recording_stop` message.
    public var onRecordingStop: ((RecordingStop) -> Void)?

    /// Called when the daemon sends a `client_settings_update` message.
    public var onClientSettingsUpdate: ((ClientSettingsUpdate) -> Void)?

    /// Called when the daemon broadcasts an `identity_changed` event (IDENTITY.md changed on disk).
    public var onIdentityChanged: ((IdentityChanged) -> Void)?

    /// Called when the daemon sends an `avatar_updated` message after regenerating the avatar.
    public var onAvatarUpdated: ((AvatarUpdated) -> Void)?

    /// Called when the daemon sends a `generate_avatar_response` message.
    public var onGenerateAvatarResponse: ((GenerateAvatarResponse) -> Void)?

    /// Called when the daemon sends a `contacts_response` message.
    public var onContactsResponse: ((ContactsResponseMessage) -> Void)?

    /// Called when the daemon broadcasts a `contacts_changed` event (contact table mutated).
    public var onContactsChanged: ((ContactsChanged) -> Void)?

    // MARK: - Auto-Wake

    /// Optional closure invoked when a connection attempt fails because the daemon process
    /// is not alive. The macOS app sets this to call `assistantCli.wake(name:)` so the
    /// daemon is automatically restarted before retrying the connection.
    /// Set by the app layer — `DaemonClient` never imports platform-specific types.
    public var wakeHandler: (@MainActor @Sendable () async throws -> Void)?

    // MARK: - Broadcast Subscribers

    /// Creates a new message stream for the caller. Each subscriber receives all messages
    /// independently, enabling multiple consumers (HostCuExecutor, AmbientAgent) to
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

    var subscribers: [UUID: AsyncStream<ServerMessage>.Continuation] = [:]

    var isAuthenticated = false

    /// HTTP transport for communicating with the assistant.
    public var httpTransport: HTTPTransport?

    public private(set) var config: DaemonConfig

    // MARK: - Init

    public init(config: DaemonConfig = .default) {
        self.config = config
    }

    // MARK: - Reconfigure

    /// Reconfigure the daemon client's transport in place without replacing
    /// the object identity. This preserves all callback closures and
    /// subscriber references held by long-lived objects (ConversationManager,
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
        httpPort = nil
        daemonVersion = nil
        keyFingerprint = nil
        latestMemoryStatus = nil
        currentModel = nil
    }

    deinit {
        // Swift 5.9+: deinit on @MainActor class is NOT guaranteed to run on main actor.
        // Only call thread-safe cancellation methods here — Task.cancel() is safe from any thread.
        //
        // We must finish subscriber continuations to prevent hanging `for await` loops.
        // deinit guarantees exclusive access (no other strong references exist), so
        // direct property access is safe without actor isolation dispatch.
        let continuations = subscribers.values
        for continuation in continuations {
            continuation.finish()
        }
        // httpTransport is cleaned up via disconnectInternal() before dealloc;
    }

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

        public var errorDescription: String? {
            switch self {
            case .notConnected:
                return "Cannot send: not connected to assistant"
            }
        }
    }

    /// Legacy authentication errors — retained for compatibility with code
    /// that catches `AuthError` (e.g. bootstrap retry coordinator).
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
    /// Used in tests to avoid needing a live HTTP connection.
    internal var sendOverride: ((Any) throws -> Void)?

    /// Send a message to the daemon via HTTP transport.
    /// Throws `SendError.notConnected` when the transport is unavailable.
    public func send<T: Encodable>(_ message: T) throws {
        let sendID = OSSignpostID(log: networkLog)
        os_signpost(.begin, log: networkLog, name: "daemonHTTPSend", signpostID: sendID)

        if let override = sendOverride {
            os_signpost(.end, log: networkLog, name: "daemonHTTPSend", signpostID: sendID)
            try override(message)
            return
        }

        guard let httpTransport else {
            os_signpost(.end, log: networkLog, name: "daemonHTTPSend", signpostID: sendID)
            log.warning("Cannot send: not connected")
            throw SendError.notConnected
        }

        guard httpTransport.isConnected else {
            os_signpost(.end, log: networkLog, name: "daemonHTTPSend", signpostID: sendID)
            throw SendError.notConnected
        }

        do {
            try httpTransport.send(message)
            os_signpost(.end, log: networkLog, name: "daemonHTTPSend", signpostID: sendID)
        } catch {
            os_signpost(.end, log: networkLog, name: "daemonHTTPSend", signpostID: sendID)
            throw error
        }
    }

    public func sendConversationUnread(_ signal: ConversationUnreadSignal) async throws {
        if let override = sendOverride {
            try override(signal)
            return
        }

        guard let httpTransport else {
            throw SendError.notConnected
        }
        guard httpTransport.isConnected else {
            throw SendError.notConnected
        }
        try await httpTransport.sendConversationUnread(signal)
    }

    // MARK: - Surface Actions

    /// Convenience method for sending a surface action response to the daemon.
    /// Keeps the message construction co-located with the client.
    public func sendSurfaceAction(conversationId: String?, surfaceId: String, actionId: String, data: [String: AnyCodable]?) throws {
        let message = UiSurfaceActionMessage(
            conversationId: conversationId,
            surfaceId: surfaceId,
            actionId: actionId,
            data: data
        )
        try send(message)
    }

    // MARK: - BTW Side-Chain

    /// Send a /btw side-chain question and stream the response text.
    /// Delegates to HTTPTransport for remote connections, or calls the local daemon HTTP server.
    public func sendBtwMessage(content: String, conversationKey: String) -> AsyncThrowingStream<String, Error> {
        if let httpTransport {
            return httpTransport.sendBtwMessage(content: content, conversationKey: conversationKey)
        }

        // Local daemon path — stream SSE from the daemon's /v1/btw endpoint.
        return AsyncThrowingStream { continuation in
            let task = Task { @MainActor [weak self] in
                guard let self else {
                    continuation.finish()
                    return
                }

                guard var request = self.buildLocalRequest(
                    target: .daemon,
                    path: "v1/btw",
                    method: "POST",
                    timeout: 120
                ) else {
                    continuation.finish(throwing: URLError(.badURL))
                    return
                }

                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

                let body: [String: String] = [
                    "conversationKey": conversationKey,
                    "content": content,
                ]

                do {
                    request.httpBody = try JSONSerialization.data(withJSONObject: body)

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)

                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                        throw URLError(.badServerResponse, userInfo: [
                            NSLocalizedDescriptionKey: "HTTP \(statusCode)"
                        ])
                    }

                    var currentEventType: String?
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }

                        if line.hasPrefix("event: ") {
                            currentEventType = String(line.dropFirst(7))
                        } else if line.hasPrefix("data: ") {
                            let jsonString = String(line.dropFirst(6))
                            if let data = jsonString.data(using: .utf8),
                               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                                if currentEventType == "btw_error" {
                                    let errorMessage = parsed["message"] as? String ?? parsed["error"] as? String ?? "Unknown btw error"
                                    throw URLError(.badServerResponse, userInfo: [
                                        NSLocalizedDescriptionKey: errorMessage
                                    ])
                                }
                                if let text = parsed["text"] as? String {
                                    continuation.yield(text)
                                }
                                if currentEventType == "btw_complete" {
                                    break
                                }
                            }
                            currentEventType = nil
                        } else if line.isEmpty {
                            currentEventType = nil
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    // MARK: - Surface Undo

    /// Send a surface undo request to revert the last refinement on a workspace surface.
    public func sendSurfaceUndo(conversationId: String, surfaceId: String) throws {
        let message = UiSurfaceUndoMessage(conversationId: conversationId, surfaceId: surfaceId)
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



    // MARK: - Queue Management

    /// Delete a specific queued message by its requestId.
    public func sendDeleteQueuedMessage(conversationId: String, requestId: String) throws {
        try send(DeleteQueuedMessageMessage(conversationId: conversationId, requestId: requestId))
    }

    // MARK: - Regenerate

    /// Regenerate the last assistant response for a conversation.
    public func sendRegenerate(conversationId: String) throws {
        try send(RegenerateMessage(conversationId: conversationId))
    }

    // MARK: - Conversations

    /// Request the list of past conversations from the daemon.
    public func sendConversationList(offset: Int? = nil, limit: Int? = nil) throws {
        try send(ConversationListRequestMessage(offset: offset, limit: limit))
    }

    /// Request message history for a specific conversation.
    /// - Parameters:
    ///   - conversationId: The conversation to fetch history for.
    ///   - limit: Max messages to return per page.
    ///   - beforeTimestamp: Pagination cursor — only return messages before this timestamp (ms since epoch).
    ///   - mode: `"light"` omits heavy payloads (attachments, tool images, surface data); `"full"` includes everything.
    ///   - maxTextChars: When set, truncates assistant text content to this many characters.
    ///   - maxToolResultChars: When set, truncates tool result content to this many characters.
    public func sendHistoryRequest(conversationId: String, limit: Int? = nil, beforeTimestamp: Double? = nil, mode: String? = nil, maxTextChars: Int? = nil, maxToolResultChars: Int? = nil) throws {
        try send(HistoryRequestMessage(conversationId: conversationId, limit: limit, beforeTimestamp: beforeTimestamp, mode: mode, maxTextChars: maxTextChars, maxToolResultChars: maxToolResultChars))
    }

    /// Request full (untruncated) content for a specific message.
    /// Used to rehydrate messages that were loaded with truncated text/tool results.
    public func sendMessageContentRequest(conversationId: String, messageId: String) throws {
        try send(MessageContentRequest(type: "message_content_request", conversationId: conversationId, messageId: messageId))
    }

    /// Get, set, or delete the Vercel API token configuration.
    public func sendVercelApiConfig(action: String, apiToken: String? = nil) throws {
        try send(VercelApiConfigRequestMessage(action: action, apiToken: apiToken))
    }

    /// Channel verification session management: "create_session", "status", "cancel_session", "revoke", "resend_session".
    public func sendChannelVerificationSession(
        action: String,
        channel: String? = nil,
        conversationId: String? = nil,
        rebind: Bool? = nil,
        destination: String? = nil,
        originConversationId: String? = nil,
        purpose: String? = nil,
        contactChannelId: String? = nil
    ) throws {
        try send(ChannelVerificationSessionRequestMessage(
            action: action,
            channel: channel,
            conversationId: conversationId,
            rebind: rebind,
            destination: destination,
            originConversationId: originConversationId,
            purpose: purpose,
            contactChannelId: contactChannelId
        ))
    }

    // MARK: - Local Daemon HTTP Helpers

    /// Which local server a request should target.
    private enum LocalHTTPTarget {
        /// The daemon runtime HTTP server (port from httpPort, default 7821).
        case daemon
        /// The gateway server (port resolved via LockfilePaths: env > lockfile > 7830).
        case gateway
    }

    /// Build an authenticated URLRequest for a local HTTP endpoint.
    ///
    /// Token resolution order:
    /// 1. `tokenOverride` (for callers that need a specific token)
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
            let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
            let port = LockfilePaths.resolveGatewayPort(connectedAssistantId: connectedId)
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

    /// Execute a local HTTP request with automatic 401 recovery.
    ///
    /// On 401, attempts to re-bootstrap the actor token via `guardian/init`
    /// and retries the request once. Logs all failure paths for diagnostics.
    private func executeLocalRequest<T: Decodable>(
        target: LocalHTTPTarget = .daemon,
        path: String,
        method: String = "GET",
        body: Data? = nil,
        timeout: TimeInterval = 10,
        tokenOverride: String? = nil
    ) async -> T? {
        guard var request = buildLocalRequest(target: target, path: path, method: method, timeout: timeout, tokenOverride: tokenOverride) else {
            log.warning("Local HTTP: no port available for \(path, privacy: .public)")
            return nil
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                log.warning("Local HTTP: no HTTPURLResponse for \(path, privacy: .public)")
                return nil
            }

            if http.statusCode == 401 {
                // If caller provided an explicit token override, 401 recovery via
                // actor-token re-bootstrap won't help — it's a different credential.
                if tokenOverride != nil {
                    log.warning("Local HTTP 401 for \(path, privacy: .public) — tokenOverride set, skipping retry")
                    return nil
                }
                guard let platform = recoveryPlatform, let deviceId = recoveryDeviceId else {
                    log.warning("Local HTTP 401 for \(path, privacy: .public) — no recovery credentials configured")
                    return nil
                }
                log.info("Local HTTP 401 for \(path, privacy: .public) — attempting re-bootstrap")
                let success = await bootstrapActorToken(platform: platform, deviceId: deviceId)
                guard success else {
                    log.warning("Local HTTP re-bootstrap failed for \(path, privacy: .public)")
                    return nil
                }
                // Retry with fresh token
                guard var retryRequest = buildLocalRequest(target: target, path: path, method: method, timeout: timeout) else { return nil }
                if let body {
                    retryRequest.httpBody = body
                    retryRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                }
                let (retryData, retryResponse) = try await URLSession.shared.data(for: retryRequest)
                guard let retryHttp = retryResponse as? HTTPURLResponse, (200...299).contains(retryHttp.statusCode) else {
                    log.warning("Local HTTP retry failed for \(path, privacy: .public) status=\((retryResponse as? HTTPURLResponse)?.statusCode ?? -1)")
                    return nil
                }
                return try JSONDecoder().decode(T.self, from: retryData)
            }

            guard (200...299).contains(http.statusCode) else {
                log.warning("Local HTTP \(http.statusCode) for \(path, privacy: .public)")
                return nil
            }
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            log.warning("Local HTTP error for \(path, privacy: .public): \(error.localizedDescription, privacy: .public)")
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


    // MARK: - Contacts Management

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
