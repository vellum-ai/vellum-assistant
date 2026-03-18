import Foundation
import os
import CryptoKit
#if os(macOS)
import IOKit
#endif

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - AssistantEvent Envelope

/// Envelope around `ServerMessage` for SSE events from the runtime HTTP server.
struct AssistantEvent: Decodable {
    let id: String
    let assistantId: String
    let conversationId: String?
    let emittedAt: String
    let message: ServerMessage
}

// MARK: - Conversations List Response

/// Response shape from `GET /v1/conversations`.
public struct ConversationsListResponse: Decodable {
    public struct Conversation: Decodable {
        public let id: String
        public let title: String
        public let createdAt: Int?
        public let updatedAt: Int
        public let conversationType: String?
        public let source: String?
        public let scheduleJobId: String?
        public let channelBinding: ChannelBinding?
        public let conversationOriginChannel: String?
        public let conversationOriginInterface: String?
        public let assistantAttention: AssistantAttention?
        public let displayOrder: Double?
        public let isPinned: Bool?
    }
    public let conversations: [Conversation]
    public let hasMore: Bool?
}

/// Response shape from `GET /v1/conversations/:id`.
public struct SingleConversationResponse: Decodable {
    public let conversation: ConversationsListResponse.Conversation
}

private struct HTTPErrorEnvelope: Decodable {
    struct ErrorBody: Decodable {
        let message: String
    }

    let error: ErrorBody
}

// MARK: - Workspace API Response Types

public struct WorkspaceTreeEntry: Codable, Identifiable, Hashable, Sendable {
    public let name: String
    public let path: String
    public let type: String  // "file" or "directory"
    public let size: Int?
    public let mimeType: String?
    public let modifiedAt: String

    public var id: String { path }
    public var isDirectory: Bool { type == "directory" }
}

public struct WorkspaceTreeResponse: Codable, Sendable {
    public let path: String
    public let entries: [WorkspaceTreeEntry]
}

public struct WorkspaceFileResponse: Codable, Sendable {
    public let path: String
    public let name: String
    public let size: Int
    public let mimeType: String
    public let modifiedAt: String
    public let content: String?
    public let isBinary: Bool

    public init(path: String, name: String, size: Int, mimeType: String, modifiedAt: String, content: String?, isBinary: Bool) {
        self.path = path
        self.name = name
        self.size = size
        self.mimeType = mimeType
        self.modifiedAt = modifiedAt
        self.content = content
        self.isBinary = isBinary
    }
}

// MARK: - HTTP Transport

/// Internal helper that handles HTTP REST + SSE communication with a remote
/// Vellum assistant runtime. Used by `DaemonClient` when configured with
/// `.http` transport via `DaemonConfig`.
///
/// Responsibilities:
/// - Periodic health check via `GET /healthz` to drive connection status
/// - SSE stream connection to `GET /v1/events` (unfiltered, on demand)
/// - Translating message types to HTTP API calls
/// - Auto-reconnect with exponential backoff
///
/// - Important: New HTTP API calls should **not** be added here. Use `GatewayHTTPClient`
///   instead, injected via a focused protocol (e.g. `ConversationClientProtocol`).
///   Existing methods are being incrementally migrated to standalone clients backed by
///   `GatewayHTTPClient`. See `clients/ARCHITECTURE.md` for details.
@MainActor
public final class HTTPTransport {

    public let baseURL: String
    public private(set) var bearerToken: String?
    private let sourceChannel: String
    let transportMetadata: TransportMetadata

    private static var defaultSourceChannel: String {
        return "vellum"
    }

    /// Platform-derived default interface identifier.
    private static var defaultInterface: String {
        #if os(macOS)
        return "macos"
        #elseif os(iOS)
        return "ios"
        #else
        return "vellum"
        #endif
    }

    /// Currently active SSE task.
    private var sseTask: Task<Void, Never>?

    /// Periodic health check task.
    private var healthCheckTask: Task<Void, Never>?

    /// Health check interval in seconds.
    private let healthCheckInterval: TimeInterval = 15.0

    /// Whether the assistant is reachable (health check passes).
    private(set) var isConnected: Bool = false

    /// Whether the SSE stream is active and receiving events.
    private(set) var isSSEConnected: Bool = false

    /// Whether we should attempt to reconnect on disconnect.
    private var shouldReconnect = true

    /// Current reconnect backoff delay in seconds (for SSE).
    private var sseReconnectDelay: TimeInterval = 1.0

    /// Maximum reconnect backoff delay.
    private let maxReconnectDelay: TimeInterval = 30.0

    /// SSE reconnect task handle.
    private var sseReconnectTask: Task<Void, Never>?

    /// Result of an async authentication refresh attempt.
    enum AuthRefreshResult {
        case success
        case transientFailure
        case terminalFailure
    }

    /// In-flight refresh task. Concurrent 401 handlers await this instead of
    /// returning false immediately, so user actions aren't dropped while a
    /// refresh triggered by another codepath is still in progress.
    private var refreshTask: Task<AuthRefreshResult, Never>?

    /// Callback for incoming server messages (called on main actor).
    var onMessage: ((ServerMessage) -> Void)?

    /// Callback for connection state changes (health check driven).
    var onConnectionStateChanged: ((Bool) -> Void)?

    /// Callback when the bearer token is refreshed via a `token_rotated` SSE event.
    /// Clients should persist the new token (e.g. to Keychain).
    var onTokenRefreshed: ((String) -> Void)?

    /// Maps the daemon's server-side conversationId → client-local conversationId.
    /// Used to remap conversationId in incoming SSE events so ChatViewModel's
    /// belongsToConversation() filter passes. Supports multiple concurrent conversations.
    /// Capped at `serverToLocalConversationMapCap` entries to prevent unbounded growth.
    var serverToLocalConversationMap: [String: String] = [:]
    private let serverToLocalConversationMapCap = 500

    /// Conversation IDs that originated from this client instance.
    /// Host tool requests are only executed for these conversation IDs.
    private var locallyOwnedConversationIds: Set<String> = []
    /// Conversation IDs that belong to private (temporary) conversations.
    /// Populated when a conversation_create with conversationType "private" is handled locally.
    var privateConversationIds: Set<String> = []

    let decoder = JSONDecoder()
    let encoder = JSONEncoder()

    /// Registered domain dispatchers. Each handler receives the message as `Any`
    /// and returns `true` if it handled the message, `false` otherwise.
    /// Dispatchers are tried in registration order; the first match wins.
    private var domainDispatchers: [(Any) -> Bool] = []

    /// Register a domain dispatcher that can handle specific message types.
    /// The handler receives the message as `Any` and returns `true` if it
    /// handled the message. Return `false` to let subsequent dispatchers
    /// (or the default fallback) handle it.
    func registerDomainDispatcher(_ handler: @escaping (Any) -> Bool) {
        domainDispatchers.append(handler)
    }

    // MARK: - Init

    init(baseURL: String, bearerToken: String?, conversationKey: String, transportMetadata: TransportMetadata = .defaultLocal) {
        // Strip trailing slash for clean URL construction
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.bearerToken = bearerToken
        if !conversationKey.isEmpty {
            locallyOwnedConversationIds.insert(conversationKey)
        }
        self.sourceChannel = Self.defaultSourceChannel
        self.transportMetadata = transportMetadata

        // Register dispatchers for existing HTTP-transported message types
        registerExistingRoutes()
        registerComputerUseRoutes()
        registerSettingsRoutes()
        registerAppsRoutes()
        registerDocumentsRoutes()
        registerWorkItemsRoutes()
        registerSubagentsRoutes()
        registerConversationRoutes()
    }

    // MARK: - Endpoint Builder

    /// A restricted character set for encoding query parameter values.
    /// `.urlQueryAllowed` permits `&`, `=`, `+`, and `#` which are
    /// query-string metacharacters. File paths containing these characters
    /// would break parameter parsing, so we exclude them.
    private static let queryValueAllowed: CharacterSet = {
        var cs = CharacterSet.urlQueryAllowed
        cs.remove(charactersIn: "&=+#")
        return cs
    }()

    /// A restricted character set for encoding path component values.
    /// `.urlPathAllowed` permits `/` which must be escaped when embedding
    /// identifiers (e.g. namespaced skill slugs like `clawhub/my-skill`)
    /// into a single path segment so they don't create extra path components.
    private static let pathComponentAllowed: CharacterSet = {
        var cs = CharacterSet.urlPathAllowed
        cs.remove(charactersIn: "/")
        return cs
    }()

    /// All HTTP endpoints used by the transport, centralized for consistent
    /// URL construction. Query parameters that are integral to the endpoint
    /// identity are modelled as associated values.
    enum Endpoint {
        case healthz
        case eventsAll  // SSE subscription for all events
        case sendMessage
        case getMessages(conversationId: String?)
        case conversations(limit: Int, offset: Int)
        case confirm
        case secret
        case conversationsSeen
        case conversationsUnread
        case identity
        case surfaceAction
        case trustRulesManage
        case trustRuleManageById(id: String)
        case pendingInteractions(conversationKey: String?)
        // Apps
        case appData(id: String)
        case appsSignBundle
        case appsSigningIdentity
        // Subagents
        case subagentMessage(id: String)
        // Conversation management
        case conversationsSwitch
        case conversationRename(id: String)
        case conversationsClear
        case conversationCancel(id: String)
        case conversationUndo(id: String)
        case conversationRegenerate(id: String)
        case model
        case conversationSearch(query: String, limit: Int?, maxMessagesPerConversation: Int?)
        case messageContent(id: String, conversationId: String?)
        case deleteQueuedMessage(id: String, conversationId: String)
        case conversationsReorder
        // Computer Use
        case cuWatch

        // Recordings
        case recordingStatus

        // Settings
        case settingsVoice
        case settingsClient

        // Diagnostics
        case dictation

        // Tools
        case tools
        case toolsSimulatePermission

        // Integrations
        case integrationsOAuthStart
        case integrationsVercelConfig
        case integrationsIngressConfig

        // Surface Undo
        case surfaceUndo(surfaceId: String)

        // Suggestion
        case suggestion

        // Workspace Files (legacy HTTP)
        case workspaceFiles
        case workspaceFilesRead

        // Attachments
        case uploadAttachment

        // Host Bash Proxy
        case hostBashResult

        // Host File Proxy
        case hostFileResult

        // Host CU Proxy
        case hostCuResult

        // BTW side-chain
        case btw

        // Misc
        case channelVerificationSessions
        case channelVerificationSessionsResend
        case channelVerificationSessionsRevoke
        case registerDeviceToken

    }

    /// Build a URL for the given endpoint using the current route mode.
    /// Returns nil if the URL string is malformed.
    func buildURL(for endpoint: Endpoint) -> URL? {
        let path: String
        let query: String?

        switch transportMetadata.routeMode {
        case .runtimeFlat:
            (path, query) = buildRuntimeFlatPath(for: endpoint)
        case .platformAssistantProxy:
            guard let assistantId = transportMetadata.platformAssistantId else {
                log.error("platformAssistantProxy route mode requires platformAssistantId")
                return nil
            }
            (path, query) = buildPlatformProxyPath(for: endpoint, assistantId: assistantId)
        }

        var urlString = "\(baseURL)\(path)"
        if let query {
            urlString += "?\(query)"
        }
        return URL(string: urlString)
    }

    /// Builds paths for the existing runtime-flat layout (e.g. /healthz, /v1/messages).
    private func buildRuntimeFlatPath(for endpoint: Endpoint) -> (path: String, query: String?) {
        switch endpoint {
        case .healthz:
            return ("/healthz", nil)
        case .eventsAll:
            return ("/v1/events", nil)
        case .sendMessage:
            return ("/v1/messages", nil)
        case .getMessages(let conversationId):
            if let id = conversationId {
                let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? id
                return ("/v1/messages", "conversationId=\(encoded)")
            }
            return ("/v1/messages", nil)
        case .conversations(let limit, let offset):
            return ("/v1/conversations", "limit=\(limit)&offset=\(offset)")
        case .confirm:
            return ("/v1/confirm", nil)
        case .secret:
            return ("/v1/secret", nil)
        case .conversationsSeen:
            return ("/v1/conversations/seen", nil)
        case .conversationsUnread:
            return ("/v1/conversations/unread", nil)
        case .identity:
            return ("/v1/identity", nil)
        case .surfaceAction:
            return ("/v1/surface-actions", nil)
        case .trustRulesManage:
            return ("/v1/trust-rules/manage", nil)
        case .trustRuleManageById(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/trust-rules/manage/\(encoded)", nil)
        case .pendingInteractions(let conversationKey):
            if let key = conversationKey {
                let encoded = key.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? key
                return ("/v1/pending-interactions", "conversationKey=\(encoded)")
            }
            return ("/v1/pending-interactions", nil)
        // Apps
        case .appData(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/apps/\(encoded)/data", nil)
        case .appsSignBundle:
            return ("/v1/apps/sign-bundle", nil)
        case .appsSigningIdentity:
            return ("/v1/apps/signing-identity", nil)
        // Subagents
        case .subagentMessage(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/subagents/\(encoded)/message", nil)
        // Conversation management
        case .conversationsSwitch:
            return ("/v1/conversations/switch", nil)
        case .conversationRename(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/conversations/\(encoded)/name", nil)
        case .conversationsClear:
            return ("/v1/conversations", nil)
        case .conversationCancel(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/conversations/\(encoded)/cancel", nil)
        case .conversationUndo(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/conversations/\(encoded)/undo", nil)
        case .conversationRegenerate(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/conversations/\(encoded)/regenerate", nil)
        case .model:
            return ("/v1/model", nil)
        case .conversationSearch(let query, let limit, let maxMessages):
            let qEncoded = query.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? query
            var qs = "q=\(qEncoded)"
            if let limit { qs += "&limit=\(limit)" }
            if let maxMessages { qs += "&maxMessagesPerConversation=\(maxMessages)" }
            return ("/v1/conversations/search", qs)
        case .messageContent(let id, let conversationId):
            let idEncoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            if let conversationId {
                let sEncoded = conversationId.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? conversationId
                return ("/v1/messages/\(idEncoded)/content", "conversationId=\(sEncoded)")
            }
            return ("/v1/messages/\(idEncoded)/content", nil)
        case .deleteQueuedMessage(let id, let conversationId):
            let idEncoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            let sEncoded = conversationId.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? conversationId
            return ("/v1/messages/queued/\(idEncoded)", "conversationId=\(sEncoded)")
        case .conversationsReorder:
            return ("/v1/conversations/reorder", nil)
        // Computer Use
        case .cuWatch:
            return ("/v1/computer-use/watch", nil)
        // Recordings
        case .recordingStatus:
            return ("/v1/recordings/status", nil)
        // Settings
        case .settingsVoice:
            return ("/v1/settings/voice", nil)
        case .settingsClient:
            return ("/v1/settings/client", nil)
        // Diagnostics
        case .dictation:
            return ("/v1/dictation", nil)
        // Tools
        case .tools:
            return ("/v1/tools", nil)
        case .toolsSimulatePermission:
            return ("/v1/tools/simulate-permission", nil)
        // Integrations
        case .integrationsOAuthStart:
            return ("/v1/integrations/oauth/start", nil)
        case .integrationsVercelConfig:
            return ("/v1/integrations/vercel/config", nil)
        case .integrationsIngressConfig:
            return ("/v1/integrations/ingress/config", nil)
        // Surface Undo
        case .surfaceUndo(let surfaceId):
            let encoded = surfaceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? surfaceId
            return ("/v1/surfaces/\(encoded)/undo", nil)
        // Suggestion
        case .suggestion:
            return ("/v1/suggestion", nil)
        // Workspace Files (legacy HTTP)
        case .workspaceFiles:
            return ("/v1/workspace-files", nil)
        case .workspaceFilesRead:
            return ("/v1/workspace-files/read", nil)
        // Attachments
        case .uploadAttachment:
            return ("/v1/attachments", nil)
        // Host Bash Proxy
        case .hostBashResult:
            return ("/v1/host-bash-result", nil)
        // Host File Proxy
        case .hostFileResult:
            return ("/v1/host-file-result", nil)
        // Host CU Proxy
        case .hostCuResult:
            return ("/v1/host-cu-result", nil)
        // BTW side-chain
        case .btw:
            return ("/v1/btw", nil)
        // Misc
        case .channelVerificationSessions:
            return ("/v1/channel-verification-sessions", nil)
        case .channelVerificationSessionsResend:
            return ("/v1/channel-verification-sessions/resend", nil)
        case .channelVerificationSessionsRevoke:
            return ("/v1/channel-verification-sessions/revoke", nil)
        case .registerDeviceToken:
            return ("/v1/device-token", nil)
        }
    }

    /// Builds paths for the platform assistant proxy layout
    /// (e.g. /v1/assistants/{id}/healthz/, /v1/assistants/{id}/messages/).
    /// Trailing slashes match the Django URL convention.
    private func buildPlatformProxyPath(for endpoint: Endpoint, assistantId: String) -> (path: String, query: String?) {
        let prefix = "/v1/assistants/\(assistantId)"

        switch endpoint {
        case .healthz:
            return ("\(prefix)/healthz/", nil)
        case .eventsAll:
            return ("\(prefix)/events/", nil)
        case .sendMessage:
            return ("\(prefix)/messages/", nil)
        case .getMessages(let conversationId):
            if let id = conversationId {
                let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? id
                return ("\(prefix)/messages/", "conversationId=\(encoded)")
            }
            return ("\(prefix)/messages/", nil)
        case .conversations(let limit, let offset):
            return ("\(prefix)/conversations/", "limit=\(limit)&offset=\(offset)")
        case .confirm:
            return ("\(prefix)/confirm/", nil)
        case .secret:
            return ("\(prefix)/secret/", nil)
        case .conversationsSeen:
            return ("\(prefix)/conversations/seen/", nil)
        case .conversationsUnread:
            return ("\(prefix)/conversations/unread/", nil)
        case .identity:
            return ("\(prefix)/identity/", nil)
        case .surfaceAction:
            return ("\(prefix)/surface-actions/", nil)
        case .trustRulesManage:
            return ("\(prefix)/trust-rules/manage/", nil)
        case .trustRuleManageById(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/trust-rules/manage/\(encoded)/", nil)
        case .pendingInteractions(let conversationKey):
            if let key = conversationKey {
                let encoded = key.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? key
                return ("\(prefix)/pending-interactions/", "conversationKey=\(encoded)")
            }
            return ("\(prefix)/pending-interactions/", nil)
        // Apps
        case .appData(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/apps/\(encoded)/data/", nil)
        case .appsSignBundle:
            return ("\(prefix)/apps/sign-bundle/", nil)
        case .appsSigningIdentity:
            return ("\(prefix)/apps/signing-identity/", nil)
        // Subagents
        case .subagentMessage(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/subagents/\(encoded)/message/", nil)
        // Conversation management
        case .conversationsSwitch:
            return ("\(prefix)/conversations/switch/", nil)
        case .conversationRename(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/conversations/\(encoded)/name/", nil)
        case .conversationsClear:
            return ("\(prefix)/conversations/", nil)
        case .conversationCancel(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/conversations/\(encoded)/cancel/", nil)
        case .conversationUndo(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/conversations/\(encoded)/undo/", nil)
        case .conversationRegenerate(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/conversations/\(encoded)/regenerate/", nil)
        case .model:
            return ("\(prefix)/model/", nil)
        case .conversationSearch(let query, let limit, let maxMessages):
            let qEncoded = query.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? query
            var qs = "q=\(qEncoded)"
            if let limit { qs += "&limit=\(limit)" }
            if let maxMessages { qs += "&maxMessagesPerConversation=\(maxMessages)" }
            return ("\(prefix)/conversations/search/", qs)
        case .messageContent(let id, let conversationId):
            let idEncoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            if let conversationId {
                let sEncoded = conversationId.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? conversationId
                return ("\(prefix)/messages/\(idEncoded)/content/", "conversationId=\(sEncoded)")
            }
            return ("\(prefix)/messages/\(idEncoded)/content/", nil)
        case .deleteQueuedMessage(let id, let conversationId):
            let idEncoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            let sEncoded = conversationId.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? conversationId
            return ("\(prefix)/messages/queued/\(idEncoded)/", "conversationId=\(sEncoded)")
        case .conversationsReorder:
            return ("\(prefix)/conversations/reorder/", nil)
        // Computer Use
        case .cuWatch:
            return ("\(prefix)/computer-use/watch/", nil)
        // Recordings
        case .recordingStatus:
            return ("\(prefix)/recordings/status/", nil)
        // Settings
        case .settingsVoice:
            return ("\(prefix)/settings/voice/", nil)
        case .settingsClient:
            return ("\(prefix)/settings/client/", nil)
        // Diagnostics
        case .dictation:
            return ("\(prefix)/dictation/", nil)
        // Tools
        case .tools:
            return ("\(prefix)/tools/", nil)
        case .toolsSimulatePermission:
            return ("\(prefix)/tools/simulate-permission/", nil)
        // Integrations
        case .integrationsOAuthStart:
            return ("\(prefix)/integrations/oauth/start/", nil)
        case .integrationsVercelConfig:
            return ("\(prefix)/integrations/vercel/config/", nil)
        case .integrationsIngressConfig:
            return ("\(prefix)/integrations/ingress/config/", nil)
        // Surface Undo
        case .surfaceUndo(let surfaceId):
            let encoded = surfaceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? surfaceId
            return ("\(prefix)/surfaces/\(encoded)/undo/", nil)
        // Suggestion
        case .suggestion:
            return ("\(prefix)/suggestion/", nil)
        // Workspace Files (legacy HTTP)
        case .workspaceFiles:
            return ("\(prefix)/workspace-files/", nil)
        case .workspaceFilesRead:
            return ("\(prefix)/workspace-files/read/", nil)
        // Attachments
        case .uploadAttachment:
            return ("\(prefix)/attachments/", nil)
        // Host Bash Proxy
        case .hostBashResult:
            return ("\(prefix)/host-bash-result/", nil)
        // Host File Proxy
        case .hostFileResult:
            return ("\(prefix)/host-file-result/", nil)
        // Host CU Proxy
        case .hostCuResult:
            return ("\(prefix)/host-cu-result/", nil)
        // BTW side-chain
        case .btw:
            return ("\(prefix)/btw/", nil)
        // Misc
        case .channelVerificationSessions:
            return ("\(prefix)/channel-verification-sessions/", nil)
        case .channelVerificationSessionsResend:
            return ("\(prefix)/channel-verification-sessions/resend/", nil)
        case .channelVerificationSessionsRevoke:
            return ("\(prefix)/channel-verification-sessions/revoke/", nil)
        case .registerDeviceToken:
            return ("\(prefix)/device-token/", nil)
        }
    }

    // MARK: - Connect (health check driven)

    /// Verify reachability via health check and start periodic health monitoring.
    /// Connection status is driven by health checks, not SSE.
    /// SSE is auto-started after the first successful health check so that
    /// system events (e.g. pairing approval requests) are received immediately,
    /// even before any UI window appears.
    func connect() async throws {
        shouldReconnect = true

        // Run initial health check
        try await performHealthCheck()

        // Start periodic health checks
        startHealthCheckLoop()

        // Auto-start SSE so system events (pairing, etc.) are received
        // immediately. MainWindowView.onAppear also calls startSSE() but
        // that's a no-op when the stream is already running.
        startSSE()
    }

    /// Run a single health check against the gateway.
    private func performHealthCheck() async throws {
        guard let healthURL = buildURL(for: .healthz) else {
            throw HTTPTransportError.invalidURL
        }
        var healthReq = URLRequest(url: healthURL)
        healthReq.timeoutInterval = 10
        applyAuth(&healthReq)

        do {
            let (data, response) = try await URLSession.shared.data(for: healthReq)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                if statusCode == 401 {
                    handleAuthenticationFailure(responseData: data)
                    if isManagedMode {
                        // Stop polling — the session is expired and reconnecting
                        // would just loop. The session-error event already tells
                        // the UI to prompt re-authentication.
                        shouldReconnect = false
                    }
                }
                throw HTTPTransportError.healthCheckFailed
            }
            log.info("Health check passed for \(self.baseURL, privacy: .public)")
            setConnected(true)
        } catch let error as HTTPTransportError {
            setConnected(false)
            throw error
        } catch {
            log.error("Health check failed: \(error.localizedDescription)")
            setConnected(false)
            throw HTTPTransportError.healthCheckFailed
        }
    }

    /// Periodically poll `/healthz` to maintain connection status.
    private func startHealthCheckLoop() {
        healthCheckTask?.cancel()

        healthCheckTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: UInt64((self?.healthCheckInterval ?? 15.0) * 1_000_000_000))
                } catch {
                    return
                }

                guard let self, self.shouldReconnect else { return }

                do {
                    try await self.performHealthCheck()
                } catch {
                    // Health check failed — isConnected already set to false
                    log.warning("Periodic health check failed: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: - SSE Stream (on demand)

    /// Start the SSE event stream. Call when a chat window opens.
    func startSSE() {
        guard sseTask == nil else {
            log.info("startSSE: already running, skipping")
            return
        }
        log.info("startSSE: starting SSE stream for \(self.baseURL, privacy: .public)")
        startSSEStream()
    }

    /// Replace the bearer token used for HTTP requests and SSE authentication.
    /// If SSE is currently disconnected (e.g. due to prior 403 errors), restarts
    /// the stream so it can authenticate with the new token.
    func updateBearerToken(_ newToken: String) {
        bearerToken = newToken
        // If SSE is not connected, restart it with the new token
        if !isSSEConnected && sseTask != nil {
            log.info("Bearer token updated — restarting SSE stream")
            sseReconnectTask?.cancel()
            sseReconnectTask = nil
            sseTask?.cancel()
            sseTask = nil
            sseReconnectDelay = 1.0
            startSSEStream()
        } else if !isSSEConnected && sseTask == nil && shouldReconnect {
            log.info("Bearer token updated — starting SSE stream")
            startSSE()
        }
    }

    /// Stop the SSE event stream. Call when a chat window closes.
    func stopSSE() {
        sseReconnectTask?.cancel()
        sseReconnectTask = nil
        sseTask?.cancel()
        sseTask = nil
        setSSEConnected(false)
    }

    private func startSSEStream() {
        sseTask?.cancel()

        guard let url = buildURL(for: .eventsAll) else {
            log.error("Invalid SSE URL for unfiltered events")
            return
        }

        log.info("SSE connecting to \(url.absoluteString, privacy: .public)")

        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = .infinity
        applyAuth(&request)

        sseTask = Task { @MainActor [weak self] in
            guard let self else {
                log.warning("SSE task: self was deallocated before stream started")
                return
            }

            do {
                let (bytes, response) = try await URLSession.shared.bytes(for: request)

                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                    log.error("SSE connection failed with status \(statusCode)")
                    if statusCode == 401 {
                        self.handleAuthenticationFailure()
                        if self.isManagedMode {
                            // In managed mode, 401 means the session token expired.
                            // Don't reconnect — it would loop indefinitely.
                            self.shouldReconnect = false
                            self.sseTask = nil
                            self.setSSEConnected(false)
                            return
                        }
                    }
                    if statusCode == 403 {
                        // 403 during assistant switch: the bearer token may lack
                        // chat.read scope needed for SSE. The actor token is still
                        // bootstrapping. Use a short retry delay so SSE reconnects
                        // quickly once the actor token is available.
                        self.sseReconnectDelay = 1.0
                    }
                    self.handleSSEDisconnect()
                    return
                }

                self.setSSEConnected(true)
                log.info("SSE stream connected to \(url.absoluteString, privacy: .public)")

                for try await line in bytes.lines {
                    if Task.isCancelled { break }

                    if line.hasPrefix("data: ") {
                        // AsyncLineSequence strips blank lines, so we never
                        // see the empty-line boundary that the SSE spec uses
                        // to delimit events. Flush each data line immediately
                        // to avoid delaying the last event of a turn until an
                        // unrelated line (e.g. heartbeat) arrives.
                        let payload = String(line.dropFirst(6))
                        self.parseSSEData(payload)
                    }
                    // Non-data lines (event:, id:, heartbeat) are ignored.
                }
            } catch {
                if !Task.isCancelled {
                    log.error("SSE stream error: \(error.localizedDescription)")
                }
            }

            if !Task.isCancelled {
                self.handleSSEDisconnect()
            }
        }
    }

    /// Extract the value of a JSON string field using lightweight string search.
    /// Handles both `"key":"value"` and `"key": "value"` (with optional space after colon).
    private func extractJsonStringValue(from jsonString: String, key: String) -> String? {
        for pattern in ["\"\(key)\":\"", "\"\(key)\": \""] {
            if let range = jsonString.range(of: pattern) {
                let valueStart = range.upperBound
                if let valueEnd = jsonString[valueStart...].firstIndex(of: "\"") {
                    return String(jsonString[valueStart..<valueEnd])
                }
            }
        }
        return nil
    }

    private func parseSSEData(_ data: String) {
        var jsonString = data
        // Remap server conversation IDs to client-local conversation IDs via O(1) dictionary lookup
        if let conversationId = extractJsonStringValue(from: jsonString, key: "conversationId"),
           let localId = serverToLocalConversationMap[conversationId] {
            jsonString = jsonString.replacingOccurrences(
                of: "\"conversationId\":\"\(conversationId)\"",
                with: "\"conversationId\":\"\(localId)\""
            )
            jsonString = jsonString.replacingOccurrences(
                of: "\"conversationId\": \"\(conversationId)\"",
                with: "\"conversationId\": \"\(localId)\""
            )
        }
        if let parentConversationId = extractJsonStringValue(from: jsonString, key: "parentConversationId"),
           let localId = serverToLocalConversationMap[parentConversationId] {
            jsonString = jsonString.replacingOccurrences(
                of: "\"parentConversationId\":\"\(parentConversationId)\"",
                with: "\"parentConversationId\":\"\(localId)\""
            )
            jsonString = jsonString.replacingOccurrences(
                of: "\"parentConversationId\": \"\(parentConversationId)\"",
                with: "\"parentConversationId\": \"\(localId)\""
            )
        }

        guard let jsonData = jsonString.data(using: .utf8) else { return }

        do {
            let event = try decoder.decode(AssistantEvent.self, from: jsonData)
            if shouldIgnoreHostToolRequest(event.message) { return }
            handleServerMessage(event.message)
        } catch {
            // Try decoding as a bare ServerMessage (some endpoints may send unwrapped)
            do {
                let message = try decoder.decode(ServerMessage.self, from: jsonData)
                if shouldIgnoreHostToolRequest(message) { return }
                handleServerMessage(message)
            } catch {
                let byteCount = jsonData.count
                log.error("Failed to decode SSE event: \(error.localizedDescription), bytes: \(byteCount)")
            }
        }
    }

    /// Returns `true` if the message is a host tool request whose conversationId
    /// does not belong to this client, meaning it should be silently dropped.
    private func shouldIgnoreHostToolRequest(_ message: ServerMessage) -> Bool {
        switch message {
        case .hostBashRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_bash_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        case .hostFileRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_file_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        case .hostCuRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_cu_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        default:
            return false
        }
    }

    private func handleServerMessage(_ message: ServerMessage) {
        if case .tokenRotated(let msg) = message {
            log.info("Received token_rotated event — updating bearer token and reconnecting SSE")
            bearerToken = msg.newToken
            onTokenRefreshed?(msg.newToken)
            stopSSE()
            startSSE()
            return
        }
        onMessage?(message)
    }

    // MARK: - Send (HTTP API Calls)

    /// Translate a message to the appropriate HTTP API call.
    /// Domain dispatchers are tried in registration order; the first match wins.
    /// If no dispatcher handles the message, it falls through to a default log.
    func send<T: Encodable>(_ message: T) throws {
        // Try registered domain dispatchers first
        for dispatcher in domainDispatchers {
            if dispatcher(message) {
                return
            }
        }

        // No dispatcher handled the message
        log.debug("HTTPTransport: unhandled send message type \(String(describing: type(of: message)))")
    }

    // MARK: - HTTP Endpoints

    private enum AttachmentUploadResult {
        case success(id: String)
        case transientFailure
        case terminalAuthFailure
    }

    /// Upload a single attachment and return its server-assigned ID.
    private func uploadAttachment(_ attachment: UserMessageAttachment, isRetry: Bool = false) async -> AttachmentUploadResult {
        guard let url = buildURL(for: .uploadAttachment) else { return .transientFailure }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "filename": attachment.filename,
            "mimeType": attachment.mimeType,
            "data": attachment.data
        ]
        if let filePath = attachment.filePath {
            body["filePath"] = filePath
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .transientFailure }

            if http.statusCode == 200 || http.statusCode == 201 {
                let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                if let id = json?["id"] as? String {
                    return .success(id: id)
                }
                return .transientFailure
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                switch refreshResult {
                case .success:
                    return await uploadAttachment(attachment, isRetry: true)
                case .terminalFailure:
                    // handleAuthenticationFailureAsync already emitted .authenticationRequired
                    return .terminalAuthFailure
                case .transientFailure:
                    return .transientFailure
                }
            } else {
                log.error("Attachment upload failed (\(http.statusCode))")
                return .transientFailure
            }
        } catch {
            log.error("Attachment upload error: \(error.localizedDescription)")
            return .transientFailure
        }
    }

    func sendMessage(content: String?, conversationId: String, attachments: [UserMessageAttachment]? = nil, uploadedAttachmentIds: [String]? = nil, automated: Bool? = nil, isRetry: Bool = false) async {
        locallyOwnedConversationIds.insert(conversationId)

        // On retry, reuse already-uploaded attachment IDs to avoid duplicates
        var attachmentIds: [String] = uploadedAttachmentIds ?? []

        if attachmentIds.isEmpty, let attachments, !attachments.isEmpty {
            for attachment in attachments {
                switch await uploadAttachment(attachment) {
                case .success(let id):
                    attachmentIds.append(id)
                case .terminalAuthFailure:
                    // .authenticationRequired already emitted — don't overwrite with a generic error
                    return
                case .transientFailure:
                    log.error("Failed to upload attachment: \(attachment.filename)")
                    let failedCount = attachments.count - attachmentIds.count
                    onMessage?(.conversationError(ConversationErrorMessage(
                        conversationId: conversationId,
                        code: .providerApi,
                        userMessage: "Failed to upload \(failedCount) attachment\(failedCount == 1 ? "" : "s"). Please try again.",
                        retryable: true,
                        failedMessageContent: content
                    )))
                    return
                }
            }
        }

        guard let url = buildURL(for: .sendMessage) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "conversationKey": conversationId,
            "sourceChannel": sourceChannel,
            "interface": Self.defaultInterface
        ]
        if let content, !content.isEmpty {
            body["content"] = content
        }
        if !attachmentIds.isEmpty {
            body["attachmentIds"] = attachmentIds
        }
        if privateConversationIds.contains(conversationId) {
            body["conversationType"] = "private"
        }
        if automated == true {
            body["automated"] = true
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 202 || http.statusCode == 200 {
                log.info("Message sent successfully")
                // Learn the server's conversationId for this conversation's conversationKey.
                // For new conversations, the conversationId (used as conversationKey) differs from
                // the server's internal conversationId. Store the mapping so parseSSEData
                // can remap incoming events to the client's local conversation ID.
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let serverConvId = json["conversationId"] as? String,
                   serverConvId != conversationId {
                    self.serverToLocalConversationMap[serverConvId] = conversationId
                    // Evict arbitrary entries when over cap to prevent unbounded growth.
                    // Lost mappings are benign — unmapped events are filtered by belongsToConversation.
                    while self.serverToLocalConversationMap.count > self.serverToLocalConversationMapCap {
                        if let key = self.serverToLocalConversationMap.keys.first {
                            self.serverToLocalConversationMap.removeValue(forKey: key)
                        }
                    }
                    log.info("Mapped server conversation \(serverConvId, privacy: .public) → local conversation \(conversationId, privacy: .public)")
                }
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                switch refreshResult {
                case .success:
                    // Reuse already-uploaded IDs to avoid duplicate uploads
                    await sendMessage(content: content, conversationId: conversationId, uploadedAttachmentIds: attachmentIds, automated: automated, isRetry: true)
                case .terminalFailure:
                    // performRefresh() already emitted .authenticationRequired — don't overwrite it
                    break
                case .transientFailure:
                    onMessage?(.conversationError(ConversationErrorMessage(
                        conversationId: conversationId,
                        code: .providerApi,
                        userMessage: "Failed to send message — authentication error. Please try again.",
                        retryable: true,
                        failedMessageContent: content
                    )))
                }
            } else if http.statusCode == 422,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let errorCategory = json["error"] as? String,
                      errorCategory == "secret_blocked" {
                // HTTP mode cannot handle secret-blocked retries (no bypassSecretCheck
                // support), so surface as a non-retryable conversation error instead
                // of routing through .error(category: "secret_blocked") which would
                // activate ChatViewModel's "Send Anyway" UI and create an unrecoverable loop.
                let message = (json["message"] as? String) ?? "Message blocked — contains secrets"
                log.warning("Message blocked by secret-ingress check")
                onMessage?(.conversationError(ConversationErrorMessage(
                    conversationId: conversationId,
                    code: .providerApi,
                    userMessage: message,
                    retryable: false,
                    failedMessageContent: content
                )))
            } else {
                let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
                log.error("Send message failed (\(http.statusCode)): \(errorBody)")
                onMessage?(.conversationError(ConversationErrorMessage(
                    conversationId: conversationId,
                    code: .providerApi,
                    userMessage: "Failed to send message (HTTP \(http.statusCode))",
                    retryable: true,
                    failedMessageContent: content
                )))
            }
        } catch {
            log.error("Send message error: \(error.localizedDescription)")
            onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: conversationId,
                code: .providerApi,
                userMessage: error.localizedDescription,
                retryable: true,
                failedMessageContent: content
            )))
        }
    }

    /// Send a /btw side-chain question and stream the response text.
    /// Returns an AsyncThrowingStream that yields text deltas from SSE `btw_text_delta` events.
    /// Throws on `btw_error` events and handles 401 authentication retry.
    func sendBtwMessage(content: String, conversationKey: String, isRetry: Bool = false) -> AsyncThrowingStream<String, Error> {
        return AsyncThrowingStream { continuation in
            let task = Task { @MainActor [weak self] in
                guard let self else {
                    continuation.finish()
                    return
                }

                guard let url = self.buildURL(for: .btw) else {
                    continuation.finish(throwing: URLError(.badURL))
                    return
                }

                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                request.timeoutInterval = 120
                self.applyAuth(&request)

                let body: [String: Any] = [
                    "conversationKey": conversationKey,
                    "content": content,
                ]

                do {
                    request.httpBody = try JSONSerialization.data(withJSONObject: body)

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)

                    guard let http = response as? HTTPURLResponse else {
                        throw URLError(.badServerResponse)
                    }

                    if http.statusCode == 401 && !isRetry {
                        // Collect response body for auth refresh
                        var bodyChunks: [UInt8] = []
                        for try await byte in bytes {
                            bodyChunks.append(byte)
                        }
                        let responseData = Data(bodyChunks)
                        let refreshResult = await self.handleAuthenticationFailureAsync(responseData: responseData)
                        switch refreshResult {
                        case .success:
                            // Retry with refreshed auth — pipe the retry stream into this continuation
                            let retryStream = self.sendBtwMessage(content: content, conversationKey: conversationKey, isRetry: true)
                            do {
                                for try await text in retryStream {
                                    if Task.isCancelled { break }
                                    continuation.yield(text)
                                }
                                continuation.finish()
                            } catch {
                                continuation.finish(throwing: error)
                            }
                            return
                        case .terminalFailure:
                            continuation.finish()
                            return
                        case .transientFailure:
                            throw URLError(.userAuthenticationRequired, userInfo: [
                                NSLocalizedDescriptionKey: "Authentication failed — please try again."
                            ])
                        }
                    }

                    guard http.statusCode == 200 else {
                        throw URLError(.badServerResponse, userInfo: [
                            NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"
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
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func sendDecision(requestId: String, decision: String, selectedPattern: String? = nil, selectedScope: String? = nil, isRetry: Bool = false) async {
        guard let url = buildURL(for: .confirm) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "requestId": requestId,
            "decision": decision,
        ]
        if let selectedPattern {
            body["selectedPattern"] = selectedPattern
        }
        if let selectedScope {
            body["selectedScope"] = selectedScope
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    switch refreshResult {
                    case .success:
                        await sendDecision(requestId: requestId, decision: decision, selectedPattern: selectedPattern, selectedScope: selectedScope, isRetry: true)
                    case .terminalFailure:
                        break
                    case .transientFailure:
                        log.error("Decision response failed: authentication error after 401 refresh")
                    }
                } else if http.statusCode != 200 {
                    log.error("Decision response failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Decision response error: \(error.localizedDescription)")
        }
    }

    func sendSecret(requestId: String, value: String?, delivery: String? = nil, isRetry: Bool = false) async {
        guard let url = buildURL(for: .secret) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "requestId": requestId,
            "value": value ?? "",
        ]
        if let delivery {
            body["delivery"] = delivery
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    switch refreshResult {
                    case .success:
                        await sendSecret(requestId: requestId, value: value, delivery: delivery, isRetry: true)
                    case .terminalFailure:
                        break
                    case .transientFailure:
                        log.error("Secret response failed: authentication error after 401 refresh")
                    }
                } else if http.statusCode != 200 {
                    log.error("Secret response failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Secret response error: \(error.localizedDescription)")
        }
    }

    /// JSONSerialization cannot encode AnyCodable wrappers directly, so unwrap
    /// them before inserting arbitrary payloads into request bodies.
    func jsonCompatibleDictionary(_ values: [String: AnyCodable]) -> [String: Any] {
        var jsonCompatible: [String: Any] = [:]
        for (key, value) in values {
            jsonCompatible[key] = value.value
        }
        return jsonCompatible
    }

    func sendConversationSeen(_ signal: ConversationSeenSignal, isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationsSeen) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "conversationId": signal.conversationId,
            "sourceChannel": signal.sourceChannel,
            "signalType": signal.signalType,
            "confidence": signal.confidence,
            "source": signal.source
        ]
        if let evidenceText = signal.evidenceText {
            body["evidenceText"] = evidenceText
        }
        if let observedAt = signal.observedAt {
            body["observedAt"] = observedAt
        }
        if let metadata = signal.metadata {
            body["metadata"] = jsonCompatibleDictionary(metadata)
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await sendConversationSeen(signal, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("Conversation seen signal failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Conversation seen signal error: \(error.localizedDescription)")
        }
    }

    func sendConversationUnread(_ signal: ConversationUnreadSignal, isRetry: Bool = false) async throws {
        guard let url = buildURL(for: .conversationsUnread) else {
            throw HTTPTransportError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "conversationId": signal.conversationId,
            "sourceChannel": signal.sourceChannel,
            "signalType": signal.signalType,
            "confidence": signal.confidence,
            "source": signal.source
        ]
        if let evidenceText = signal.evidenceText {
            body["evidenceText"] = evidenceText
        }
        if let observedAt = signal.observedAt {
            body["observedAt"] = observedAt
        }
        if let metadata = signal.metadata {
            body["metadata"] = jsonCompatibleDictionary(metadata)
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else {
                throw HTTPTransportError.healthCheckFailed
            }

            if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                switch refreshResult {
                case .success:
                    try await sendConversationUnread(signal, isRetry: true)
                    return
                case .transientFailure:
                    throw HTTPTransportError.authenticationFailed(
                        message: decodeHTTPErrorMessage(from: data) ?? "Authentication refresh failed"
                    )
                case .terminalFailure:
                    throw HTTPTransportError.authenticationFailed(
                        message: decodeHTTPErrorMessage(from: data) ?? "Authentication failed"
                    )
                }
            }

            guard http.statusCode == 200 else {
                throw HTTPTransportError.requestFailed(
                    statusCode: http.statusCode,
                    message: decodeHTTPErrorMessage(from: data)
                )
            }
        } catch {
            throw error
        }
    }

    private func decodeHTTPErrorMessage(from data: Data) -> String? {
        if let envelope = try? decoder.decode(HTTPErrorEnvelope.self, from: data) {
            return envelope.error.message
        }
        guard let body = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !body.isEmpty else { return nil }
        return body
    }

    // MARK: - Surface Actions

    func sendSurfaceAction(_ action: UiSurfaceActionMessage, isRetry: Bool = false) async {
        guard let url = buildURL(for: .surfaceAction) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "surfaceId": action.surfaceId,
            "actionId": action.actionId,
        ]
        // Omit conversationId — the server resolves the conversation via
        // findSessionBySurfaceId(surfaceId), which is reliable regardless
        // of conversationKey vs conversationId differences.
        if let data = action.data {
            body["data"] = jsonCompatibleDictionary(data)
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync()
                    if case .success = refreshResult {
                        await sendSurfaceAction(action, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("HTTPTransport: surface action failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("HTTPTransport: surface action error: \(error.localizedDescription)")
        }
    }

    func fetchConversationList(offset: Int = 0, limit: Int = 50, isRetry: Bool = false, authRetryCount: Int = 0) async {
        guard let url = buildURL(for: .conversations(limit: limit, offset: offset)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                if statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await fetchConversationList(offset: offset, limit: limit, isRetry: true)
                        return
                    }
                }
                // 403 during assistant switch: the actor token hasn't been
                // bootstrapped yet. Retry a few times with a delay to let
                // ensureActorCredentials() finish.
                if statusCode == 403 && authRetryCount < 6 {
                    log.info("Conversation list fetch got 403 — waiting for actor token (attempt \(authRetryCount + 1)/6)")
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    await fetchConversationList(offset: offset, limit: limit, isRetry: isRetry, authRetryCount: authRetryCount + 1)
                    return
                }
                log.error("Fetch conversation list failed (HTTP \(statusCode))")
                onMessage?(.conversationListResponse(ConversationListResponseMessage(type: "conversation_list_response", conversations: [], hasMore: nil)))
                return
            }

            do {
                let decoded = try decoder.decode(ConversationsListResponse.self, from: data)
                let conversations = decoded.conversations.map {
                    ConversationListResponseItem(id: $0.id, title: $0.title, createdAt: $0.createdAt ?? $0.updatedAt, updatedAt: $0.updatedAt, conversationType: $0.conversationType, source: $0.source, scheduleJobId: $0.scheduleJobId, channelBinding: $0.channelBinding, conversationOriginChannel: $0.conversationOriginChannel, conversationOriginInterface: $0.conversationOriginInterface, assistantAttention: $0.assistantAttention, displayOrder: $0.displayOrder, isPinned: $0.isPinned)
                }
                onMessage?(.conversationListResponse(ConversationListResponseMessage(type: "conversation_list_response", conversations: conversations, hasMore: decoded.hasMore)))
            } catch {
                log.error("Failed to decode conversation list response: \(error)")
                onMessage?(.conversationListResponse(ConversationListResponseMessage(type: "conversation_list_response", conversations: [], hasMore: nil)))
            }
        } catch {
            log.error("Fetch conversation list error: \(error.localizedDescription)")
            onMessage?(.conversationListResponse(ConversationListResponseMessage(type: "conversation_list_response", conversations: [], hasMore: nil)))
        }
    }

    func fetchHistory(conversationId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .getMessages(conversationId: conversationId)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                if statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await fetchHistory(conversationId: conversationId, isRetry: true)
                        return
                    }
                }
                log.error("Fetch history failed (HTTP \(statusCode))")
                return
            }

            // The runtime's /v1/messages endpoint returns messages with `content`
            // (string) and `timestamp` (ISO 8601 string), but HistoryResponseMessage
            // expects `text` and `timestamp` as a Double (ms since epoch). Transform
            // the response to match the expected message format.
            //
            // The HTTP API also omits the `data` field from attachments when content
            // was not requested (returning only metadata like `sizeBytes`), but
            // UserMessageAttachment.data is non-optional. We backfill missing fields
            // to avoid decode failures.
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let messages = json["messages"] as? [[String: Any]] {

                    let isoFormatter = ISO8601DateFormatter()
                    isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                    let fallbackFormatter = ISO8601DateFormatter()

                    let transformed: [[String: Any]] = messages.compactMap { msg in
                        var m = msg
                        // Rename `content` → `text`, defaulting to empty string if absent/null.
                        let content = m.removeValue(forKey: "content")
                        if let content, !(content is NSNull) {
                            m["text"] = content
                        } else {
                            m["text"] = ""
                        }
                        // Convert ISO 8601 timestamp string → Double (ms since epoch)
                        if let tsString = m["timestamp"] as? String {
                            if let date = isoFormatter.date(from: tsString) {
                                m["timestamp"] = date.timeIntervalSince1970 * 1000.0
                            } else if let date = fallbackFormatter.date(from: tsString) {
                                m["timestamp"] = date.timeIntervalSince1970 * 1000.0
                            } else {
                                log.warning("Unparseable timestamp in history message, using epoch: \(tsString, privacy: .public)")
                                m["timestamp"] = 0.0
                            }
                        } else if m["timestamp"] == nil || m["timestamp"] is NSNull {
                            m["timestamp"] = 0.0
                        }
                        // Normalize attachments: the HTTP API omits `data` for large
                        // attachments (returns sizeBytes instead), but
                        // UserMessageAttachment.data is non-optional String.
                        if var attachments = m["attachments"] as? [[String: Any]] {
                            for i in attachments.indices {
                                if attachments[i]["data"] == nil || attachments[i]["data"] is NSNull {
                                    attachments[i]["data"] = ""
                                }
                            }
                            m["attachments"] = attachments
                        }
                        return m
                    }

                    let historyPayload: [String: Any] = [
                        "type": "history_response",
                        "conversationId": conversationId,
                        "messages": transformed,
                        "hasMore": false
                    ]

                    let historyData = try JSONSerialization.data(withJSONObject: historyPayload)
                    let historyResponse = try decoder.decode(ServerMessage.self, from: historyData)
                    onMessage?(historyResponse)
                }
            } catch {
                log.error("Failed to deserialize history response for conversation \(conversationId, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        } catch {
            log.error("Fetch history error: \(error.localizedDescription)")
        }
    }

    // MARK: - Conversation Management HTTP Handlers

    func switchConversation(conversationId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationsSwitch) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["conversationId": conversationId]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                // Successful switch — conversation_info will arrive via SSE
                log.info("Conversation switch to \(conversationId) succeeded")
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await switchConversation(conversationId: conversationId, isRetry: true)
                }
            } else {
                log.error("Conversation switch failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Conversation switch error: \(error.localizedDescription)")
        }
    }

    func renameConversation(conversationId: String, name: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationRename(id: conversationId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["name": name]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                // Emit conversation_title_updated so the UI refreshes
                onMessage?(.conversationTitleUpdated(ConversationTitleUpdatedMessage(
                    type: "conversation_title_updated",
                    conversationId: conversationId,
                    title: name
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await renameConversation(conversationId: conversationId, name: name, isRetry: true)
                }
            } else {
                log.error("Conversation rename failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Conversation rename error: \(error.localizedDescription)")
        }
    }

    func clearAllConversations(isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationsClear) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 204 || http.statusCode == 200 {
                onMessage?(.conversationListResponse(ConversationListResponseMessage(
                    type: "conversation_list_response",
                    conversations: [],
                    hasMore: nil
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await clearAllConversations(isRetry: true)
                }
            } else {
                log.error("Clear conversations failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Clear conversations error: \(error.localizedDescription)")
        }
    }

    func cancelGeneration(conversationId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationCancel(id: conversationId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 202 || http.statusCode == 200 {
                log.info("Cancel generation succeeded for \(conversationId)")
                // generation_cancelled will arrive via SSE
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await cancelGeneration(conversationId: conversationId, isRetry: true)
                }
            } else {
                log.error("Cancel generation failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Cancel generation error: \(error.localizedDescription)")
        }
    }

    func undoLastMessage(conversationId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationUndo(id: conversationId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let removedCount = json["removedCount"] as? Int {
                    onMessage?(.undoComplete(UndoCompleteMessage(
                        type: "undo_complete",
                        removedCount: removedCount,
                        conversationId: conversationId
                    )))
                }
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await undoLastMessage(conversationId: conversationId, isRetry: true)
                }
            } else {
                log.error("Undo failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Undo error: \(error.localizedDescription)")
        }
    }

    func regenerateLastResponse(conversationId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationRegenerate(id: conversationId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 202 || http.statusCode == 200 {
                log.info("Regenerate succeeded for \(conversationId)")
                // Response messages will arrive via SSE
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await regenerateLastResponse(conversationId: conversationId, isRetry: true)
                }
            } else {
                log.error("Regenerate failed (HTTP \(http.statusCode))")
                let body = String(data: data, encoding: .utf8) ?? "(non-UTF8 body)"
                onMessage?(.conversationError(ConversationErrorMessage(
                    conversationId: conversationId,
                    code: .regenerateFailed,
                    userMessage: "Unable to regenerate response. Try sending your message again.",
                    retryable: true,
                    debugDetails: "HTTP \(http.statusCode): \(body)"
                )))
            }
        } catch {
            log.error("Regenerate error: \(error.localizedDescription)")
            onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: conversationId,
                code: .regenerateFailed,
                userMessage: "Unable to regenerate response. Try sending your message again.",
                retryable: true,
                debugDetails: error.localizedDescription
            )))
        }
    }

    func searchConversations(query: String, limit: Int?, maxMessagesPerConversation: Int?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationSearch(query: query, limit: limit, maxMessagesPerConversation: maxMessagesPerConversation)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                let patched = injectType("conversation_search_response", into: data)
                let decoded = try decoder.decode(ConversationSearchResponse.self, from: patched)
                onMessage?(.conversationSearchResponse(decoded))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await searchConversations(query: query, limit: limit, maxMessagesPerConversation: maxMessagesPerConversation, isRetry: true)
                }
            } else {
                log.error("Conversation search failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Conversation search error: \(error.localizedDescription)")
        }
    }

    func fetchMessageContent(conversationId: String, messageId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .messageContent(id: messageId, conversationId: conversationId)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                let patched = injectType("message_content_response", into: data)
                let decoded = try decoder.decode(MessageContentResponse.self, from: patched)
                onMessage?(.messageContentResponse(decoded))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await fetchMessageContent(conversationId: conversationId, messageId: messageId, isRetry: true)
                }
            } else {
                log.error("Message content fetch failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Message content fetch error: \(error.localizedDescription)")
        }
    }

    func deleteQueuedMessage(conversationId: String, requestId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .deleteQueuedMessage(id: requestId, conversationId: conversationId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                onMessage?(.messageQueuedDeleted(MessageQueuedDeletedMessage(
                    conversationId: conversationId,
                    requestId: requestId
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await deleteQueuedMessage(conversationId: conversationId, requestId: requestId, isRetry: true)
                }
            } else {
                log.error("Delete queued message failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Delete queued message error: \(error.localizedDescription)")
        }
    }

    func reorderConversations(updates: [ReorderConversationsRequestUpdate], isRetry: Bool = false) async {
        guard let url = buildURL(for: .conversationsReorder) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = [
            "updates": updates.map { u in
                var entry: [String: Any] = [
                    "conversationId": u.conversationId,
                    "isPinned": u.isPinned
                ]
                if let order = u.displayOrder {
                    entry["displayOrder"] = order
                }
                return entry
            }
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                // Success — no response event needed
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await reorderConversations(updates: updates, isRetry: true)
                }
            } else {
                log.error("Reorder conversations failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Reorder conversations error: \(error.localizedDescription)")
        }
    }

    /// Extract an error message from an HTTP error response body.
    private func extractErrorMessage(from data: Data) -> String {
        if let envelope = try? decoder.decode(HTTPErrorEnvelope.self, from: data) {
            return envelope.error.message
        }
        return "Unknown error"
    }

    /// Inject a `"type"` field into a JSON response before decoding.
    /// HTTP endpoints return raw payloads without the `type` discriminator.
    /// This helper patches the JSON so existing Codable types (which expect
    /// `type`) can decode unchanged.
    private func injectType(_ typeValue: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = typeValue
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }

    // MARK: - Disconnect

    func disconnect() {
        shouldReconnect = false
        healthCheckTask?.cancel()
        healthCheckTask = nil
        sseReconnectTask?.cancel()
        sseReconnectTask = nil
        sseTask?.cancel()
        sseTask = nil
        setConnected(false)
        setSSEConnected(false)
    }

    // MARK: - SSE Reconnect

    private func handleSSEDisconnect() {
        setSSEConnected(false)
        guard shouldReconnect, sseTask != nil else { return }
        scheduleSSEReconnect()
    }

    private func scheduleSSEReconnect() {
        sseReconnectTask?.cancel()

        let delay = sseReconnectDelay
        log.info("HTTP transport: scheduling SSE reconnect in \(delay)s")

        sseReconnectTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }

            guard let self, self.shouldReconnect else { return }
            self.sseReconnectDelay = min(self.sseReconnectDelay * 2, self.maxReconnectDelay)

            self.startSSEStream()
        }
    }

    // MARK: - 401 Recovery

    /// Fire-and-forget token refresh for non-async callers (health check, SSE).
    /// Async callers that need retry-or-skip semantics should use
    /// handleAuthenticationFailureAsync() directly.
    private func handleAuthenticationFailure(responseData: Data? = nil) {
        // Managed mode uses session tokens — the bearer refresh flow does not apply.
        // Signal session expiry and disconnect to stop SSE/health-check loops
        // from re-hitting the 401 and re-emitting the error indefinitely.
        if isManagedMode {
            log.warning("401 in managed mode — session token may be expired")
            onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: "",
                code: .authenticationRequired,
                userMessage: "Session expired. Please sign in again.",
                retryable: false
            )))
            disconnect()
            return
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            _ = await self.handleAuthenticationFailureAsync(responseData: responseData)
        }
    }

    /// Async variant of handleAuthenticationFailure that returns the refresh outcome.
    /// On `.success`, callers should retry the original request.
    /// On `.terminalFailure`, callers must NOT emit their own error — `performRefresh()`
    /// already emitted `.authenticationRequired` which is the correct final user-facing state.
    /// On `.transientFailure`, callers may emit a generic error (refresh will retry on next 401).
    ///
    /// When the server returns 401, the client attempts a credential refresh and
    /// retries once. Only explicitly terminal codes (e.g. `credentials_revoked`)
    /// skip refresh and force re-pairing. All other 401 codes — including
    /// `refresh_required`, `UNAUTHORIZED` (expired JWT), and unknown codes —
    /// are treated as refreshable.
    func handleAuthenticationFailureAsync(responseData: Data? = nil) async -> AuthRefreshResult {
        // Managed mode: no bearer refresh — emit session-expired, disconnect to
        // stop loops, and return terminal so callers don't retry.
        if isManagedMode {
            log.warning("401 in managed mode — session token may be expired")
            onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: "",
                code: .authenticationRequired,
                userMessage: "Session expired. Please sign in again.",
                retryable: false
            )))
            disconnect()
            return .terminalFailure
        }

        // Parse the 401 body to check for terminal (non-refreshable) error codes.
        // The server's auth middleware returns errors in a standard envelope:
        //   { "error": { "code": "...", "message": "..." } }
        let terminalCodes: Set<String> = ["credentials_revoked"]
        if let data = responseData,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let code = (json["error"] as? [String: Any])?["code"] as? String
            if let code, terminalCodes.contains(code) {
                // Explicitly terminal — no refresh possible
                log.error("Terminal 401 code: \(code) — re-auth required")
                self.onMessage?(.conversationError(ConversationErrorMessage(
                    conversationId: "",
                    code: .authenticationRequired,
                    userMessage: "Session expired. Please re-pair your device.",
                    retryable: false
                )))
                return .terminalFailure
            }
        }
        // If a refresh is already in flight, wait for its outcome instead of
        // returning false (which would drop the caller's user action).
        if let existing = refreshTask {
            return await existing.value
        }

        let task = Task<AuthRefreshResult, Never> { @MainActor [weak self] in
            guard let self else { return .transientFailure }
            defer { self.refreshTask = nil }
            return await self.performRefresh()
        }
        refreshTask = task
        return await task.value
    }

    /// Performs the actual credential refresh. Split out so handleAuthenticationFailureAsync
    /// can manage the coalescing task lifecycle separately.
    private func performRefresh() async -> AuthRefreshResult {
        #if os(macOS)
        let refreshPlatform = "macos"
        // macOS uses SHA-256 of IOPlatformUUID as device ID (matches PairingQRCodeSheet.computeHostId())
        let refreshDeviceId = Self.computeMacOSDeviceId()
        #else
        let refreshPlatform = "ios"
        // iOS uses Keychain-stored device ID (matches AppDelegate.getOrCreateDeviceId())
        let refreshDeviceId = APIKeyManager.shared.getAPIKey(provider: "pairing-device-id") ?? ""
        #endif

        let result = await ActorCredentialRefresher.refresh(
            baseURL: self.baseURL,
            bearerToken: self.bearerToken,
            platform: refreshPlatform,
            deviceId: refreshDeviceId
        )

        switch result {
        case .success:
            log.info("Token refresh succeeded — reconnecting SSE")
            // Reconnect SSE with new credentials
            self.stopSSE()
            self.startSSE()
            return .success

        case .terminalError(let reason):
            log.error("Token refresh failed terminally: \(reason) — re-pair required")
            self.onMessage?(.conversationError(ConversationErrorMessage(
                conversationId: "",
                code: .authenticationRequired,
                userMessage: "Session expired. Please re-pair your device.",
                retryable: false
            )))
            return .terminalFailure

        case .transientError:
            log.warning("Token refresh encountered transient error — will retry on next 401")
            return .transientFailure
        }
    }

    // MARK: - macOS Device ID

    #if os(macOS)
    /// Compute a stable device ID matching PairingQRCodeSheet.computeHostId().
    /// SHA-256 of the IOPlatformUUID + an app-specific salt.
    private static func computeMacOSDeviceId() -> String {
        let platformUUID = getMacOSPlatformUUID() ?? UUID().uuidString
        let salt = "vellum-assistant-host-id"
        let input = Data((platformUUID + salt).utf8)
        let hash = SHA256.hash(data: input)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }

    /// Read the IOPlatformUUID from the IORegistry (macOS hardware identifier).
    private static func getMacOSPlatformUUID() -> String? {
        let service = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPlatformExpertDevice")
        )
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }

        let key = kIOPlatformUUIDKey as CFString
        guard let uuid = IORegistryEntryCreateCFProperty(service, key, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? String else {
            return nil
        }
        return uuid
    }
    #endif

    // MARK: - Helpers

    func applyAuth(_ request: inout URLRequest) {
        switch transportMetadata.authMode {
        case .bearerToken:
            // The JWT access token is the sole auth credential — it serves as
            // both authentication and identity.
            if let accessToken = ActorTokenManager.getToken(), !accessToken.isEmpty {
                request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            } else if let token = bearerToken {
                // Fallback to legacy bearer token for initial bootstrap before
                // the first JWT is issued.
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
        case .sessionToken:
            if let token = SessionTokenManager.getToken() {
                request.setValue(token, forHTTPHeaderField: "X-Session-Token")
            }
            if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
                request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
            }
        }
    }

    /// Whether this transport is operating in managed mode.
    var isManagedMode: Bool {
        transportMetadata.routeMode == .platformAssistantProxy
    }

    private func setConnected(_ connected: Bool) {
        guard isConnected != connected else { return }
        isConnected = connected
        onConnectionStateChanged?(connected)
    }

    private func setSSEConnected(_ connected: Bool) {
        guard isSSEConnected != connected else { return }
        isSSEConnected = connected
        sseReconnectDelay = connected ? 1.0 : sseReconnectDelay
    }

    // MARK: - Errors

    enum HTTPTransportError: Error, LocalizedError {
        case healthCheckFailed
        case invalidURL
        case requestFailed(statusCode: Int, message: String?)
        case authenticationFailed(message: String)

        var errorDescription: String? {
            switch self {
            case .healthCheckFailed:
                return "Remote assistant health check failed"
            case .invalidURL:
                return "Invalid remote assistant URL"
            case .requestFailed(let statusCode, let message):
                return message ?? "HTTP request failed (\(statusCode))"
            case .authenticationFailed(let message):
                return message
            }
        }
    }
}
