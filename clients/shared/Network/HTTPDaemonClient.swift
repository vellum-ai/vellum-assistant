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
        registerSkillRoutes()
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
        case guardianActionsPending(conversationId: String)
        case guardianActionsDecision
        case conversationsSeen
        case conversationsUnread
        case identity
        case featureFlags
        case featureFlagUpdate(key: String)
        case privacyConfig
        case surfaceAction
        case trustRulesManage
        case trustRuleManageById(id: String)
        case pendingInteractions(conversationKey: String?)
        case contactsList(limit: Int, role: String?)
        case contactsGet(id: String)
        case contactsDelete(id: String)
        case contactChannelUpdate(contactChannelId: String)
        case contactsInvitesCall(id: String)
        case channelsReadiness
        // Apps
        case appsList
        case appData(id: String)
        case appOpen(id: String)
        case appDelete(id: String)
        case appPreview(id: String)
        case appHistory(id: String)
        case appDiff(id: String)
        case appRestore(id: String)
        case appBundle(id: String)
        case appsOpenBundle
        case appsShared
        case appsSharedDelete(uuid: String)
        case appsFork
        case appsShareCloud(id: String)
        case appsGallery
        case appsGalleryInstall
        case appsSignBundle
        case appsSigningIdentity
        // Documents
        case documentsList
        case documentLoad(id: String)
        case documentSave
        // Work Items
        case workItemsList
        case workItemGet(id: String)
        case workItemUpdate(id: String)
        case workItemComplete(id: String)
        case workItemDelete(id: String)
        case workItemCancel(id: String)
        case workItemApprovePermissions(id: String)
        case workItemPreflight(id: String)
        case workItemRun(id: String)
        case workItemOutput(id: String)
        // Subagents
        case subagentDetail(id: String)
        case subagentAbort(id: String)
        case subagentMessage(id: String)
        // Conversation management
        case conversationsSwitch
        case conversationRename(id: String)
        case conversationsClear
        case conversationCancel(id: String)
        case conversationUndo(id: String)
        case conversationRegenerate(id: String)
        case model
        case modelImageGen
        case conversationSearch(query: String, limit: Int?, maxMessagesPerConversation: Int?)
        case messageContent(id: String, conversationId: String?)
        case deleteQueuedMessage(id: String, conversationId: String)
        case conversationsReorder
        // Skill management
        case skillsList
        case skillEnable(id: String)
        case skillDisable(id: String)
        case skillConfigure(id: String)
        case skillInstall
        case skillUninstall(id: String)
        case skillUpdate(id: String)
        case skillsCheckUpdates
        case skillsSearch(query: String)
        case skillInspect(id: String)
        case skillsDraft
        case skillsCreate
        case skillDetail(id: String)
        case skillFiles(id: String)

        // Computer Use
        case cuWatch

        // Recordings
        case recordingStatus

        // Settings
        case settingsVoice
        case settingsAvatarGenerate
        case settingsClient

        // Schedules
        case schedules
        case scheduleToggle(id: String)
        case scheduleDelete(id: String)
        case scheduleCancel(id: String)
        case scheduleRunNow(id: String)

        // Diagnostics
        case diagnosticsExport
        case diagnosticsEnvVars
        case dictation

        // Tools
        case tools
        case toolsSimulatePermission

        // Integrations
        case integrationsOAuthStart
        case integrationsSlackConfig
        case integrationsVercelConfig
        case integrationsTelegramConfig
        case integrationsIngressConfig

        // Surface Undo
        case surfaceUndo(surfaceId: String)

        // Suggestion
        case suggestion

        // Heartbeat
        case heartbeatConfig
        case heartbeatRuns
        case heartbeatRunNow
        case heartbeatChecklist
        case heartbeatChecklistWrite

        // Pairing
        case pairingRegister

        // Publishing
        case publishPage
        case unpublishPage

        // Link Open
        case linkOpen

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

        // Telemetry
        case telemetryLifecycle

        // Misc
        case channelVerificationSessions
        case channelVerificationSessionsStatus
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
        case .guardianActionsPending(let conversationId):
            let encoded = conversationId.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? conversationId
            return ("/v1/guardian-actions/pending", "conversationId=\(encoded)")
        case .guardianActionsDecision:
            return ("/v1/guardian-actions/decision", nil)
        case .conversationsSeen:
            return ("/v1/conversations/seen", nil)
        case .conversationsUnread:
            return ("/v1/conversations/unread", nil)
        case .identity:
            return ("/v1/identity", nil)
        case .featureFlags:
            return ("/v1/feature-flags", nil)
        case .featureFlagUpdate(let key):
            let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key
            return ("/v1/feature-flags/\(encoded)", nil)
        case .privacyConfig:
            return ("/v1/config/privacy", nil)
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
        case .contactsList(let limit, let role):
            var q = "limit=\(limit)"
            if let role {
                let encoded = role.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? role
                q += "&role=\(encoded)"
            }
            return ("/v1/contacts", q)
        case .contactsGet(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/contacts/\(encoded)", nil)
        case .contactsDelete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/contacts/\(encoded)", nil)
        case .contactChannelUpdate(let contactChannelId):
            let encoded = contactChannelId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? contactChannelId
            return ("/v1/contact-channels/\(encoded)", nil)
        case .contactsInvitesCall(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/contacts/invites/\(encoded)/call", nil)
        case .channelsReadiness:
            return ("/v1/channels/readiness", nil)
        // Apps
        case .appsList:
            return ("/v1/apps", nil)
        case .appData(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/apps/\(encoded)/data", nil)
        case .appOpen(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/apps/\(encoded)/open", nil)
        case .appDelete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/apps/\(encoded)/delete", nil)
        case .appPreview(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/apps/\(encoded)/preview", nil)
        case .appHistory(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/apps/\(encoded)/history", nil)
        case .appDiff(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/apps/\(encoded)/diff", nil)
        case .appRestore(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/apps/\(encoded)/restore", nil)
        case .appBundle(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/apps/\(encoded)/bundle", nil)
        case .appsOpenBundle:
            return ("/v1/apps/open-bundle", nil)
        case .appsShared:
            return ("/v1/apps/shared", nil)
        case .appsSharedDelete(let uuid):
            let encoded = uuid.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? uuid
            return ("/v1/apps/shared/\(encoded)", nil)
        case .appsFork:
            return ("/v1/apps/fork", nil)
        case .appsShareCloud(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/apps/\(encoded)/share-cloud", nil)
        case .appsGallery:
            return ("/v1/apps/gallery", nil)
        case .appsGalleryInstall:
            return ("/v1/apps/gallery/install", nil)
        case .appsSignBundle:
            return ("/v1/apps/sign-bundle", nil)
        case .appsSigningIdentity:
            return ("/v1/apps/signing-identity", nil)
        // Documents
        case .documentsList:
            return ("/v1/documents", nil)
        case .documentLoad(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/documents/\(encoded)", nil)
        case .documentSave:
            return ("/v1/documents", nil)
        // Work Items
        case .workItemsList:
            return ("/v1/work-items", nil)
        case .workItemGet(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/work-items/\(encoded)", nil)
        case .workItemUpdate(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/work-items/\(encoded)", nil)
        case .workItemComplete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/work-items/\(encoded)/complete", nil)
        case .workItemDelete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/work-items/\(encoded)", nil)
        case .workItemCancel(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/work-items/\(encoded)/cancel", nil)
        case .workItemApprovePermissions(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/work-items/\(encoded)/approve-permissions", nil)
        case .workItemPreflight(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/work-items/\(encoded)/preflight", nil)
        case .workItemRun(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/work-items/\(encoded)/run", nil)
        case .workItemOutput(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/work-items/\(encoded)/output", nil)
        // Subagents
        case .subagentDetail(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/subagents/\(encoded)", nil)
        case .subagentAbort(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/subagents/\(encoded)/abort", nil)
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
        case .modelImageGen:
            return ("/v1/model/image-gen", nil)
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
        // Skill management
        case .skillsList:
            return ("/v1/skills", nil)
        case .skillEnable(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("/v1/skills/\(encoded)/enable", nil)
        case .skillDisable(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("/v1/skills/\(encoded)/disable", nil)
        case .skillConfigure(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("/v1/skills/\(encoded)/config", nil)
        case .skillInstall:
            return ("/v1/skills/install", nil)
        case .skillUninstall(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("/v1/skills/\(encoded)", nil)
        case .skillUpdate(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("/v1/skills/\(encoded)/update", nil)
        case .skillsCheckUpdates:
            return ("/v1/skills/check-updates", nil)
        case .skillsSearch(let query):
            let encoded = query.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? query
            return ("/v1/skills/search", "q=\(encoded)")
        case .skillInspect(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("/v1/skills/\(encoded)/inspect", nil)
        case .skillsDraft:
            return ("/v1/skills/draft", nil)
        case .skillsCreate:
            return ("/v1/skills", nil)
        case .skillDetail(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("/v1/skills/\(encoded)", nil)
        case .skillFiles(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("/v1/skills/\(encoded)/files", nil)
        // Computer Use
        case .cuWatch:
            return ("/v1/computer-use/watch", nil)
        // Recordings
        case .recordingStatus:
            return ("/v1/recordings/status", nil)
        // Settings
        case .settingsVoice:
            return ("/v1/settings/voice", nil)
        case .settingsAvatarGenerate:
            return ("/v1/settings/avatar/generate", nil)
        case .settingsClient:
            return ("/v1/settings/client", nil)
        // Schedules
        case .schedules:
            return ("/v1/schedules", nil)
        case .scheduleToggle(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/schedules/\(encoded)/toggle", nil)
        case .scheduleDelete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/schedules/\(encoded)", nil)
        case .scheduleCancel(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/schedules/\(encoded)/cancel", nil)
        case .scheduleRunNow(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("/v1/schedules/\(encoded)/run", nil)
        // Diagnostics
        case .diagnosticsExport:
            return ("/v1/diagnostics/export", nil)
        case .diagnosticsEnvVars:
            return ("/v1/diagnostics/env-vars", nil)
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
        case .integrationsSlackConfig:
            return ("/v1/integrations/slack/config", nil)
        case .integrationsVercelConfig:
            return ("/v1/integrations/vercel/config", nil)
        case .integrationsTelegramConfig:
            return ("/v1/integrations/telegram/config", nil)
        case .integrationsIngressConfig:
            return ("/v1/integrations/ingress/config", nil)
        // Surface Undo
        case .surfaceUndo(let surfaceId):
            let encoded = surfaceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? surfaceId
            return ("/v1/surfaces/\(encoded)/undo", nil)
        // Suggestion
        case .suggestion:
            return ("/v1/suggestion", nil)
        // Heartbeat
        case .heartbeatConfig:
            return ("/v1/heartbeat/config", nil)
        case .heartbeatRuns:
            return ("/v1/heartbeat/runs", nil)
        case .heartbeatRunNow:
            return ("/v1/heartbeat/run-now", nil)
        case .heartbeatChecklist:
            return ("/v1/heartbeat/checklist", nil)
        case .heartbeatChecklistWrite:
            return ("/v1/heartbeat/checklist", nil)
        // Pairing
        case .pairingRegister:
            return ("/v1/pairing/register", nil)
        // Publishing
        case .publishPage:
            return ("/v1/publish", nil)
        case .unpublishPage:
            return ("/v1/unpublish", nil)
        // Link Open
        case .linkOpen:
            return ("/v1/link/open", nil)
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
        case .channelVerificationSessionsStatus:
            return ("/v1/channel-verification-sessions/status", nil)
        case .channelVerificationSessionsResend:
            return ("/v1/channel-verification-sessions/resend", nil)
        case .channelVerificationSessionsRevoke:
            return ("/v1/channel-verification-sessions/revoke", nil)
        case .registerDeviceToken:
            return ("/v1/device-token", nil)
        case .telemetryLifecycle:
            return ("/v1/telemetry/lifecycle", nil)
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
        case .guardianActionsPending(let conversationId):
            let encoded = conversationId.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? conversationId
            return ("\(prefix)/guardian-actions/pending/", "conversationId=\(encoded)")
        case .guardianActionsDecision:
            return ("\(prefix)/guardian-actions/decision/", nil)
        case .conversationsSeen:
            return ("\(prefix)/conversations/seen/", nil)
        case .conversationsUnread:
            return ("\(prefix)/conversations/unread/", nil)
        case .identity:
            return ("\(prefix)/identity/", nil)
        case .featureFlags:
            return ("\(prefix)/feature-flags/", nil)
        case .featureFlagUpdate(let key):
            let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key
            return ("\(prefix)/feature-flags/\(encoded)/", nil)
        case .privacyConfig:
            return ("\(prefix)/config/privacy/", nil)
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
        case .contactsList(let limit, let role):
            var q = "limit=\(limit)"
            if let role {
                let encoded = role.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? role
                q += "&role=\(encoded)"
            }
            return ("\(prefix)/contacts/", q)
        case .contactsGet(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/contacts/\(encoded)/", nil)
        case .contactsDelete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/contacts/\(encoded)/", nil)
        case .contactChannelUpdate(let contactChannelId):
            let encoded = contactChannelId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? contactChannelId
            return ("\(prefix)/contact-channels/\(encoded)/", nil)
        case .contactsInvitesCall(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/contacts/invites/\(encoded)/call/", nil)
        case .channelsReadiness:
            return ("\(prefix)/channels/readiness/", nil)
        // Apps
        case .appsList:
            return ("\(prefix)/apps/", nil)
        case .appData(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/apps/\(encoded)/data/", nil)
        case .appOpen(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/apps/\(encoded)/open/", nil)
        case .appDelete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/apps/\(encoded)/delete/", nil)
        case .appPreview(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/apps/\(encoded)/preview/", nil)
        case .appHistory(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/apps/\(encoded)/history/", nil)
        case .appDiff(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/apps/\(encoded)/diff/", nil)
        case .appRestore(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/apps/\(encoded)/restore/", nil)
        case .appBundle(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/apps/\(encoded)/bundle/", nil)
        case .appsOpenBundle:
            return ("\(prefix)/apps/open-bundle/", nil)
        case .appsShared:
            return ("\(prefix)/apps/shared/", nil)
        case .appsSharedDelete(let uuid):
            let encoded = uuid.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? uuid
            return ("\(prefix)/apps/shared/\(encoded)/", nil)
        case .appsFork:
            return ("\(prefix)/apps/fork/", nil)
        case .appsShareCloud(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/apps/\(encoded)/share-cloud/", nil)
        case .appsGallery:
            return ("\(prefix)/apps/gallery/", nil)
        case .appsGalleryInstall:
            return ("\(prefix)/apps/gallery/install/", nil)
        case .appsSignBundle:
            return ("\(prefix)/apps/sign-bundle/", nil)
        case .appsSigningIdentity:
            return ("\(prefix)/apps/signing-identity/", nil)
        // Documents
        case .documentsList:
            return ("\(prefix)/documents/", nil)
        case .documentLoad(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/documents/\(encoded)/", nil)
        case .documentSave:
            return ("\(prefix)/documents/", nil)
        // Work Items
        case .workItemsList:
            return ("\(prefix)/work-items/", nil)
        case .workItemGet(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/work-items/\(encoded)/", nil)
        case .workItemUpdate(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/work-items/\(encoded)/", nil)
        case .workItemComplete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/work-items/\(encoded)/complete/", nil)
        case .workItemDelete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/work-items/\(encoded)/", nil)
        case .workItemCancel(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/work-items/\(encoded)/cancel/", nil)
        case .workItemApprovePermissions(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/work-items/\(encoded)/approve-permissions/", nil)
        case .workItemPreflight(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/work-items/\(encoded)/preflight/", nil)
        case .workItemRun(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/work-items/\(encoded)/run/", nil)
        case .workItemOutput(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/work-items/\(encoded)/output/", nil)
        // Subagents
        case .subagentDetail(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/subagents/\(encoded)/", nil)
        case .subagentAbort(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/subagents/\(encoded)/abort/", nil)
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
        case .modelImageGen:
            return ("\(prefix)/model/image-gen/", nil)
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
        // Skill management
        case .skillsList:
            return ("\(prefix)/skills/", nil)
        case .skillEnable(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("\(prefix)/skills/\(encoded)/enable/", nil)
        case .skillDisable(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("\(prefix)/skills/\(encoded)/disable/", nil)
        case .skillConfigure(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("\(prefix)/skills/\(encoded)/config/", nil)
        case .skillInstall:
            return ("\(prefix)/skills/install/", nil)
        case .skillUninstall(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("\(prefix)/skills/\(encoded)/", nil)
        case .skillUpdate(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("\(prefix)/skills/\(encoded)/update/", nil)
        case .skillsCheckUpdates:
            return ("\(prefix)/skills/check-updates/", nil)
        case .skillsSearch(let query):
            let encoded = query.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? query
            return ("\(prefix)/skills/search/", "q=\(encoded)")
        case .skillInspect(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("\(prefix)/skills/\(encoded)/inspect/", nil)
        case .skillsDraft:
            return ("\(prefix)/skills/draft/", nil)
        case .skillsCreate:
            return ("\(prefix)/skills/", nil)
        case .skillDetail(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("\(prefix)/skills/\(encoded)/", nil)
        case .skillFiles(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.pathComponentAllowed) ?? id
            return ("\(prefix)/skills/\(encoded)/files/", nil)
        // Computer Use
        case .cuWatch:
            return ("\(prefix)/computer-use/watch/", nil)
        // Recordings
        case .recordingStatus:
            return ("\(prefix)/recordings/status/", nil)
        // Settings
        case .settingsVoice:
            return ("\(prefix)/settings/voice/", nil)
        case .settingsAvatarGenerate:
            return ("\(prefix)/settings/avatar/generate/", nil)
        case .settingsClient:
            return ("\(prefix)/settings/client/", nil)
        // Schedules
        case .schedules:
            return ("\(prefix)/schedules/", nil)
        case .scheduleToggle(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/schedules/\(encoded)/toggle/", nil)
        case .scheduleDelete(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/schedules/\(encoded)/", nil)
        case .scheduleCancel(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/schedules/\(encoded)/cancel/", nil)
        case .scheduleRunNow(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return ("\(prefix)/schedules/\(encoded)/run/", nil)
        // Diagnostics
        case .diagnosticsExport:
            return ("\(prefix)/diagnostics/export/", nil)
        case .diagnosticsEnvVars:
            return ("\(prefix)/diagnostics/env-vars/", nil)
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
        case .integrationsSlackConfig:
            return ("\(prefix)/integrations/slack/config/", nil)
        case .integrationsVercelConfig:
            return ("\(prefix)/integrations/vercel/config/", nil)
        case .integrationsTelegramConfig:
            return ("\(prefix)/integrations/telegram/config/", nil)
        case .integrationsIngressConfig:
            return ("\(prefix)/integrations/ingress/config/", nil)
        // Surface Undo
        case .surfaceUndo(let surfaceId):
            let encoded = surfaceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? surfaceId
            return ("\(prefix)/surfaces/\(encoded)/undo/", nil)
        // Suggestion
        case .suggestion:
            return ("\(prefix)/suggestion/", nil)
        // Heartbeat
        case .heartbeatConfig:
            return ("\(prefix)/heartbeat/config/", nil)
        case .heartbeatRuns:
            return ("\(prefix)/heartbeat/runs/", nil)
        case .heartbeatRunNow:
            return ("\(prefix)/heartbeat/run-now/", nil)
        case .heartbeatChecklist:
            return ("\(prefix)/heartbeat/checklist/", nil)
        case .heartbeatChecklistWrite:
            return ("\(prefix)/heartbeat/checklist/", nil)
        // Pairing
        case .pairingRegister:
            return ("\(prefix)/pairing/register/", nil)
        // Publishing
        case .publishPage:
            return ("\(prefix)/publish/", nil)
        case .unpublishPage:
            return ("\(prefix)/unpublish/", nil)
        // Link Open
        case .linkOpen:
            return ("\(prefix)/link/open/", nil)
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
        case .channelVerificationSessionsStatus:
            return ("\(prefix)/channel-verification-sessions/status/", nil)
        case .channelVerificationSessionsResend:
            return ("\(prefix)/channel-verification-sessions/resend/", nil)
        case .channelVerificationSessionsRevoke:
            return ("\(prefix)/channel-verification-sessions/revoke/", nil)
        case .registerDeviceToken:
            return ("\(prefix)/device-token/", nil)
        case .telemetryLifecycle:
            return ("\(prefix)/telemetry/lifecycle/", nil)
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

        let body: [String: Any] = [
            "filename": attachment.filename,
            "mimeType": attachment.mimeType,
            "data": attachment.data
        ]

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

    func fetchGuardianActionsPending(conversationId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .guardianActionsPending(conversationId: conversationId)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    switch refreshResult {
                    case .success:
                        await fetchGuardianActionsPending(conversationId: conversationId, isRetry: true)
                    case .terminalFailure:
                        break
                    case .transientFailure:
                        log.error("Fetch guardian actions pending failed: authentication error after 401 refresh")
                    }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch guardian actions pending failed (\(http.statusCode))")
                    return
                }
            }

            do {
                let decoded = try JSONDecoder().decode(GuardianActionsPendingHTTPResponse.self, from: data)
                onMessage?(.guardianActionsPendingResponse(GuardianActionsPendingResponseMessage(conversationId: decoded.conversationId, prompts: decoded.prompts)))
            } catch {
                log.error("Failed to decode guardian actions pending response: \(error)")
            }
        } catch {
            log.error("Fetch guardian actions pending error: \(error.localizedDescription)")
        }
    }

    func submitGuardianActionDecision(requestId: String, action: String, conversationId: String?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .guardianActionsDecision) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "requestId": requestId,
            "action": action
        ]
        if let conversationId {
            body["conversationId"] = conversationId
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    switch refreshResult {
                    case .success:
                        await submitGuardianActionDecision(requestId: requestId, action: action, conversationId: conversationId, isRetry: true)
                        return
                    case .terminalFailure:
                        break
                    case .transientFailure:
                        break
                    }
                    onMessage?(.guardianActionDecisionResponse(GuardianActionDecisionResponseMessage(
                        applied: false,
                        reason: "authentication_failed",
                        resolverFailureReason: nil,
                        requestId: requestId,
                        userText: nil
                    )))
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Guardian action decision failed (\(http.statusCode))")
                    // Emit a synthetic failure response so the UI clears isSubmitting state
                    onMessage?(.guardianActionDecisionResponse(GuardianActionDecisionResponseMessage(
                        applied: false,
                        reason: "HTTP \(http.statusCode)",
                        resolverFailureReason: nil,
                        requestId: requestId,
                        userText: nil
                    )))
                    return
                }
            }

            do {
                let decoded = try JSONDecoder().decode(GuardianActionDecisionResponseMessage.self, from: data)
                onMessage?(.guardianActionDecisionResponse(decoded))
            } catch {
                log.error("Failed to decode guardian action decision response: \(error)")
            }
        } catch {
            log.error("Guardian action decision error: \(error.localizedDescription)")
            // Emit a synthetic failure response so the UI clears isSubmitting state
            onMessage?(.guardianActionDecisionResponse(GuardianActionDecisionResponseMessage(
                applied: false,
                reason: error.localizedDescription,
                resolverFailureReason: nil,
                requestId: requestId,
                userText: nil
            )))
        }
    }

    /// Response wrapper for the HTTP guardian actions pending endpoint.
    private struct GuardianActionsPendingHTTPResponse: Decodable {
        let conversationId: String?
        let prompts: [GuardianDecisionPromptWire]
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

    /// Record a lifecycle telemetry event (e.g. app_open, hatch).
    /// Fire-and-forget — failures are logged but do not propagate.
    public func recordLifecycleEvent(_ eventName: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .telemetryLifecycle) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["event_name": eventName]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await recordLifecycleEvent(eventName, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.warning("Lifecycle event '\(eventName)' recording failed (\(http.statusCode))")
                }
            }
        } catch {
            log.warning("Lifecycle event '\(eventName)' recording error: \(error.localizedDescription)")
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

    // MARK: - Contacts

    /// Route a `ContactsRequestMessage` to the appropriate HTTP endpoint based on its action.
    func handleContactsRequest(_ msg: ContactsRequestMessage) async {
        switch msg.action {
        case "list":
            await fetchContactsList(limit: Int(msg.limit ?? 50), role: msg.role)
        case "get":
            guard let contactId = msg.contactId else {
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "contactId is required for get")))
                return
            }
            await fetchContact(contactId: contactId)
        case "update_channel":
            guard let channelId = msg.channelId else {
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "channelId is required for update_channel")))
                return
            }
            await updateContactChannel(channelId: channelId, status: msg.status, policy: msg.policy, reason: msg.reason)
        case "delete":
            guard let contactId = msg.contactId else {
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "contactId is required for delete")))
                return
            }
            await deleteContact(contactId: contactId)
        default:
            onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "Unknown action: \(msg.action)")))
        }
    }

    private func fetchContactsList(limit: Int, role: String?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .contactsList(limit: limit, role: role)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await fetchContactsList(limit: limit, role: role, isRetry: true)
                    }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("HTTPTransport: fetch contacts list failed (\(http.statusCode))")
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "HTTP \(http.statusCode)")))
                    return
                }
            }

            do {
                let decoded = try decoder.decode(HTTPContactsListResponse.self, from: data)
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: true, contacts: decoded.contacts)))
            } catch {
                log.error("HTTPTransport: failed to decode contacts list response: \(error)")
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
            }
        } catch {
            log.error("HTTPTransport: fetch contacts list error: \(error.localizedDescription)")
            onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
        }
    }

    private func fetchContact(contactId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .contactsGet(id: contactId)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await fetchContact(contactId: contactId, isRetry: true)
                    }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("HTTPTransport: fetch contact failed (\(http.statusCode))")
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "HTTP \(http.statusCode)")))
                    return
                }
            }

            do {
                let decoded = try decoder.decode(HTTPContactResponse.self, from: data)
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: true, contact: decoded.contact)))
            } catch {
                log.error("HTTPTransport: failed to decode contact response: \(error)")
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
            }
        } catch {
            log.error("HTTPTransport: fetch contact error: \(error.localizedDescription)")
            onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
        }
    }

    private func deleteContact(contactId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .contactsDelete(id: contactId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await deleteContact(contactId: contactId, isRetry: true)
                    }
                    return
                }
                if http.statusCode == 204 {
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: true)))
                    return
                }
                if http.statusCode == 404 {
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "Contact not found")))
                    return
                }
                if http.statusCode == 403 {
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "Permission denied")))
                    return
                }
                log.error("HTTPTransport: delete contact failed (\(http.statusCode))")
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "HTTP \(http.statusCode)")))
            }
        } catch {
            log.error("HTTPTransport: delete contact error: \(error.localizedDescription)")
            onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
        }
    }

    private func updateContactChannel(channelId: String, status: String?, policy: String?, reason: String?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .contactChannelUpdate(contactChannelId: channelId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [:]
        if let status { body["status"] = status }
        if let policy { body["policy"] = policy }
        if let reason { body["reason"] = reason }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        await updateContactChannel(channelId: channelId, status: status, policy: policy, reason: reason, isRetry: true)
                    }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("HTTPTransport: update contact channel failed (\(http.statusCode))")
                    onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: "HTTP \(http.statusCode)")))
                    return
                }
            }

            do {
                let decoded = try decoder.decode(HTTPContactResponse.self, from: data)
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: true, contact: decoded.contact)))
            } catch {
                log.error("HTTPTransport: failed to decode update channel response: \(error)")
                onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
            }
        } catch {
            log.error("HTTPTransport: update contact channel error: \(error.localizedDescription)")
            onMessage?(.contactsResponse(ContactsResponseMessage(type: "contacts_response", success: false, error: error.localizedDescription)))
        }
    }

    /// Response wrapper for `GET /v1/contacts` (list).
    private struct HTTPContactsListResponse: Decodable {
        let ok: Bool
        let contacts: [ContactPayload]
    }

    /// Response wrapper for `GET /v1/contacts/:id` and `PATCH /v1/contact-channels/:contactChannelId`.
    private struct HTTPContactResponse: Decodable {
        let ok: Bool
        let contact: ContactPayload?
    }

    /// Response wrapper for `GET /v1/channels/readiness`.
    private struct HTTPChannelReadinessResponse: Decodable {
        let success: Bool
        let snapshots: [ChannelReadinessSnapshot]

        struct ChannelReadinessSnapshot: Decodable {
            let channel: String
            let ready: Bool
            let setupStatus: String?
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

    // MARK: - Invite Call

    func triggerInviteCall(inviteId: String, isRetry: Bool = false) async throws -> Bool {
        guard let url = buildURL(for: .contactsInvitesCall(id: inviteId)) else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: [:] as [String: Any])
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult { return try await triggerInviteCall(inviteId: inviteId, isRetry: true) }
                return false
            }
            guard (200...201).contains(http.statusCode) else { return false }
        }
        return true
    }

    // MARK: - Channel Readiness

    /// Fetch per-channel readiness from `GET /v1/channels/readiness`.
    /// Returns a dictionary mapping channel type strings to their readiness state.
    func fetchChannelReadiness(isRetry: Bool = false) async throws -> [String: DaemonClient.ChannelReadinessInfo] {
        guard let url = buildURL(for: .channelsReadiness) else { return [:] }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        applyAuth(&request)

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    return try await fetchChannelReadiness(isRetry: true)
                }
                return [:]
            }
            guard (200...299).contains(http.statusCode) else { return [:] }
        }

        let decoded = try decoder.decode(HTTPChannelReadinessResponse.self, from: data)
        var result: [String: DaemonClient.ChannelReadinessInfo] = [:]
        for snapshot in decoded.snapshots {
            let checks = ((snapshot.localChecks ?? []) + (snapshot.remoteChecks ?? []))
                .map { DaemonClient.ReadinessCheck(name: $0.name, passed: $0.passed, message: $0.message) }
            result[snapshot.channel] = DaemonClient.ChannelReadinessInfo(
                ready: snapshot.ready,
                setupStatus: snapshot.setupStatus,
                channelHandle: snapshot.channelHandle,
                checks: checks
            )
        }
        return result
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

    // MARK: - Trust Rule Management

    func sendAddTrustRule(_ rule: AddTrustRuleMessage, isRetry: Bool = false) async {
        guard let url = buildURL(for: .trustRulesManage) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "toolName": rule.toolName,
            "pattern": rule.pattern,
            "scope": rule.scope,
            "decision": rule.decision,
        ]
        if let allowHighRisk = rule.allowHighRisk {
            body["allowHighRisk"] = allowHighRisk
        }
        if let executionTarget = rule.executionTarget {
            body["executionTarget"] = executionTarget
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync()
                    if case .success = refreshResult {
                        await sendAddTrustRule(rule, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("HTTPTransport: add trust rule failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("HTTPTransport: add trust rule error: \(error.localizedDescription)")
        }
    }

    func fetchTrustRules(isRetry: Bool = false) async {
        guard let url = buildURL(for: .trustRulesManage) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync()
                    if case .success = refreshResult {
                        await fetchTrustRules(isRetry: true)
                    }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("HTTPTransport: fetch trust rules failed (\(http.statusCode))")
                    return
                }
            }

            do {
                let decoded = try decoder.decode(TrustRulesListResponse.self, from: data)
                onMessage?(.trustRulesListResponse(decoded))
            } catch {
                log.error("HTTPTransport: failed to decode trust rules response: \(error)")
            }
        } catch {
            log.error("HTTPTransport: fetch trust rules error: \(error.localizedDescription)")
        }
    }

    func sendRemoveTrustRule(_ rule: RemoveTrustRuleMessage, isRetry: Bool = false) async {
        guard let url = buildURL(for: .trustRuleManageById(id: rule.id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuth(&request)

        do {
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync()
                    if case .success = refreshResult {
                        await sendRemoveTrustRule(rule, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("HTTPTransport: remove trust rule failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("HTTPTransport: remove trust rule error: \(error.localizedDescription)")
        }
    }

    func sendUpdateTrustRule(_ rule: UpdateTrustRuleMessage, isRetry: Bool = false) async {
        guard let url = buildURL(for: .trustRuleManageById(id: rule.id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [:]
        if let tool = rule.tool {
            body["tool"] = tool
        }
        if let pattern = rule.pattern {
            body["pattern"] = pattern
        }
        if let scope = rule.scope {
            body["scope"] = scope
        }
        if let decision = rule.decision {
            body["decision"] = decision
        }
        if let priority = rule.priority {
            body["priority"] = priority
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync()
                    if case .success = refreshResult {
                        await sendUpdateTrustRule(rule, isRetry: true)
                    }
                } else if http.statusCode != 200 {
                    log.error("HTTPTransport: update trust rule failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("HTTPTransport: update trust rule error: \(error.localizedDescription)")
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

    // MARK: - Feature Flags

    /// Fetch all feature flags from the gateway's GET /v1/feature-flags endpoint.
    func getFeatureFlags(featureFlagToken: String) async throws -> [DaemonClient.AssistantFeatureFlag] {
        guard let url = buildURL(for: .featureFlags) else {
            throw HTTPTransportError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(featureFlagToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HTTPTransportError.healthCheckFailed
        }

        if http.statusCode == 401 {
            log.error("Feature flags GET failed: authentication error (401)")
            throw HTTPTransportError.healthCheckFailed
        }

        guard (200..<300).contains(http.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
            log.error("Feature flags GET failed (\(http.statusCode)): \(errorBody)")
            throw HTTPTransportError.healthCheckFailed
        }

        struct FlagsResponse: Decodable {
            let flags: [DaemonClient.AssistantFeatureFlag]
        }

        let decoded = try JSONDecoder().decode(FlagsResponse.self, from: data)
        log.info("Fetched \(decoded.flags.count) feature flags")
        return decoded.flags
    }

    /// Toggle a feature flag via the gateway's PATCH endpoint.
    /// Uses the dedicated feature-flag token (not the runtime bearer token) for auth.
    func setFeatureFlag(key: String, enabled: Bool, featureFlagToken: String) async throws {
        guard let url = buildURL(for: .featureFlagUpdate(key: key)) else {
            throw HTTPTransportError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(featureFlagToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let body: [String: Any] = ["enabled": enabled]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HTTPTransportError.healthCheckFailed
        }

        if http.statusCode == 401 {
            log.error("Feature flag PATCH failed: authentication error (401)")
            throw HTTPTransportError.healthCheckFailed
        }

        guard (200..<300).contains(http.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
            log.error("Feature flag PATCH failed (\(http.statusCode)): \(errorBody)")
            throw HTTPTransportError.healthCheckFailed
        }

        log.info("Feature flag '\(key)' set to \(enabled)")
    }

    /// Update the privacy config via the gateway's PATCH /v1/config/privacy endpoint.
    func setPrivacyConfig(collectUsageData: Bool?, sendDiagnostics: Bool?, featureFlagToken: String) async throws {
        guard let url = buildURL(for: .privacyConfig) else {
            throw HTTPTransportError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(featureFlagToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        var body: [String: Any] = [:]
        if let collectUsageData { body["collectUsageData"] = collectUsageData }
        if let sendDiagnostics { body["sendDiagnostics"] = sendDiagnostics }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HTTPTransportError.requestFailed(statusCode: 0, message: nil)
        }

        if http.statusCode == 401 {
            throw HTTPTransportError.authenticationFailed(message: "Privacy config PATCH failed: authentication error (401)")
        }

        guard (200..<300).contains(http.statusCode) else {
            throw HTTPTransportError.requestFailed(statusCode: http.statusCode, message: nil)
        }
    }

    /// Fetch all assistant feature flags from the gateway's `GET /v1/feature-flags` endpoint.
    func fetchAssistantFeatureFlags(featureFlagToken: String) async throws -> [DaemonClient.AssistantFeatureFlagEntry] {
        guard let url = buildURL(for: .featureFlags) else {
            throw HTTPTransportError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(featureFlagToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HTTPTransportError.healthCheckFailed
        }

        if http.statusCode == 401 {
            log.error("Feature flags GET failed: authentication error (401)")
            throw HTTPTransportError.healthCheckFailed
        }

        guard (200..<300).contains(http.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
            log.error("Feature flags GET failed (\(http.statusCode)): \(errorBody)")
            throw HTTPTransportError.healthCheckFailed
        }

        struct FlagsResponse: Decodable {
            let flags: [DaemonClient.AssistantFeatureFlagEntry]
        }

        let decoded = try JSONDecoder().decode(FlagsResponse.self, from: data)
        return decoded.flags
    }

    // MARK: - Remote Identity

    /// Fetch identity info from the remote daemon's `GET /v1/identity` endpoint.
    func fetchRemoteIdentity() async -> RemoteIdentityInfo? {
        guard let url = buildURL(for: .identity) else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            do {
                return try JSONDecoder().decode(RemoteIdentityInfo.self, from: data)
            } catch {
                log.error("Failed to decode remote identity response: \(error)")
                return nil
            }
        } catch {
            log.error("fetchRemoteIdentity failed: \(error.localizedDescription)")
            return nil
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

    func fetchModelInfo(isRetry: Bool = false) async {
        guard let url = buildURL(for: .model) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                let patched = injectType("model_info", into: data)
                let decoded = try decoder.decode(ModelInfoMessage.self, from: patched)
                onMessage?(.modelInfo(decoded))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await fetchModelInfo(isRetry: true)
                }
            } else {
                log.error("Model get failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Model get error: \(error.localizedDescription)")
        }
    }

    func setModel(modelId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .model) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["modelId": modelId]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                let patched = injectType("model_info", into: data)
                let decoded = try decoder.decode(ModelInfoMessage.self, from: patched)
                onMessage?(.modelInfo(decoded))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await setModel(modelId: modelId, isRetry: true)
                }
            } else {
                log.error("Model set failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Model set error: \(error.localizedDescription)")
        }
    }

    func setImageGenModel(modelId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .modelImageGen) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["modelId": modelId]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                // model_info will arrive via SSE or the response itself
                let patched = injectType("model_info", into: data)
                if let decoded = try? decoder.decode(ModelInfoMessage.self, from: patched) {
                    onMessage?(.modelInfo(decoded))
                }
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await setImageGenModel(modelId: modelId, isRetry: true)
                }
            } else {
                log.error("Image gen model set failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Image gen model set error: \(error.localizedDescription)")
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

    // MARK: - Skill Management HTTP Handlers

    func fetchSkillsList(isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillsList) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                let patched = injectType("skills_list_response", into: data)
                let decoded = try decoder.decode(SkillsListResponseMessage.self, from: patched)
                onMessage?(.skillsListResponse(decoded))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await fetchSkillsList(isRetry: true)
                }
            } else {
                log.error("Skills list failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Skills list error: \(error.localizedDescription)")
        }
    }

    func enableSkill(name: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillEnable(id: name)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "enable",
                    success: true,
                    error: nil,
                    data: nil
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await enableSkill(name: name, isRetry: true)
                }
            } else {
                let errorMsg = extractErrorMessage(from: data)
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "enable",
                    success: false,
                    error: errorMsg,
                    data: nil
                )))
            }
        } catch {
            log.error("Enable skill error: \(error.localizedDescription)")
            onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                operation: "enable",
                success: false,
                error: error.localizedDescription,
                data: nil
            )))
        }
    }

    func disableSkill(name: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillDisable(id: name)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "disable",
                    success: true,
                    error: nil,
                    data: nil
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await disableSkill(name: name, isRetry: true)
                }
            } else {
                let errorMsg = extractErrorMessage(from: data)
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "disable",
                    success: false,
                    error: errorMsg,
                    data: nil
                )))
            }
        } catch {
            log.error("Disable skill error: \(error.localizedDescription)")
            onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "disable",
                    success: false,
                    error: error.localizedDescription,
                    data: nil
                )))
        }
    }

    func configureSkill(name: String, env: [String: String]?, apiKey: String?, config: [String: AnyCodable]?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillConfigure(id: name)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [:]
        if let env { body["env"] = env }
        if let apiKey { body["apiKey"] = apiKey }
        if let config {
            // Convert AnyCodable values to raw dictionary
            var rawConfig: [String: Any] = [:]
            for (key, value) in config {
                rawConfig[key] = value.value
            }
            body["config"] = rawConfig
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "configure",
                    success: true,
                    error: nil,
                    data: nil
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await configureSkill(name: name, env: env, apiKey: apiKey, config: config, isRetry: true)
                }
            } else {
                let errorMsg = extractErrorMessage(from: data)
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "configure",
                    success: false,
                    error: errorMsg,
                    data: nil
                )))
            }
        } catch {
            log.error("Configure skill error: \(error.localizedDescription)")
            onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "configure",
                    success: false,
                    error: error.localizedDescription,
                    data: nil
                )))
        }
    }

    func installSkill(slug: String, version: String?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillInstall) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = ["slug": slug]
        if let version { body["version"] = version }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "install",
                    success: true,
                    error: nil,
                    data: nil
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await installSkill(slug: slug, version: version, isRetry: true)
                }
            } else {
                let errorMsg = extractErrorMessage(from: data)
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "install",
                    success: false,
                    error: errorMsg,
                    data: nil
                )))
            }
        } catch {
            log.error("Install skill error: \(error.localizedDescription)")
            onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "install",
                    success: false,
                    error: error.localizedDescription,
                    data: nil
                )))
        }
    }

    func uninstallSkill(name: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillUninstall(id: name)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 204 || http.statusCode == 200 {
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "uninstall",
                    success: true,
                    error: nil,
                    data: nil
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await uninstallSkill(name: name, isRetry: true)
                }
            } else {
                let errorMsg = extractErrorMessage(from: data)
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "uninstall",
                    success: false,
                    error: errorMsg,
                    data: nil
                )))
            }
        } catch {
            log.error("Uninstall skill error: \(error.localizedDescription)")
            onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "uninstall",
                    success: false,
                    error: error.localizedDescription,
                    data: nil
                )))
        }
    }

    func updateSkill(name: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillUpdate(id: name)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "update",
                    success: true,
                    error: nil,
                    data: nil
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await updateSkill(name: name, isRetry: true)
                }
            } else {
                let errorMsg = extractErrorMessage(from: data)
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "update",
                    success: false,
                    error: errorMsg,
                    data: nil
                )))
            }
        } catch {
            log.error("Update skill error: \(error.localizedDescription)")
            onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "update",
                    success: false,
                    error: error.localizedDescription,
                    data: nil
                )))
        }
    }

    func checkSkillUpdates(isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillsCheckUpdates) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                // The check-updates endpoint returns {data: ...}
                // Emit as a skills_operation_response with success
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "check_updates",
                    success: true,
                    error: nil,
                    data: nil
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await checkSkillUpdates(isRetry: true)
                }
            } else {
                let errorMsg = extractErrorMessage(from: data)
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "check_updates",
                    success: false,
                    error: errorMsg,
                    data: nil
                )))
            }
        } catch {
            log.error("Check skill updates error: \(error.localizedDescription)")
            onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "check_updates",
                    success: false,
                    error: error.localizedDescription,
                    data: nil
                )))
        }
    }

    func searchSkills(query: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillsSearch(query: query)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                // The HTTP route returns { data: ... }. The handler emits
                // skills_operation_response with operation: "search".
                // Try to decode the `data` field as ClawhubSearchData.
                var searchData: ClawhubSearchData?
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let dataObj = json["data"],
                   let dataBytes = try? JSONSerialization.data(withJSONObject: dataObj) {
                    searchData = try? decoder.decode(ClawhubSearchData.self, from: dataBytes)
                }
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "search",
                    success: true,
                    error: nil,
                    data: searchData
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await searchSkills(query: query, isRetry: true)
                }
            } else {
                let errorMsg = extractErrorMessage(from: data)
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "search",
                    success: false,
                    error: errorMsg,
                    data: nil
                )))
            }
        } catch {
            log.error("Skills search error: \(error.localizedDescription)")
            onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "search",
                    success: false,
                    error: error.localizedDescription,
                    data: nil
                )))
        }
    }

    func inspectSkill(slug: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillInspect(id: slug)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                let patched = injectType("skills_inspect_response", into: data)
                // The HTTP response may not contain "slug", inject it
                var json = (try? JSONSerialization.jsonObject(with: patched) as? [String: Any]) ?? [:]
                if json["slug"] == nil { json["slug"] = slug }
                json["type"] = "skills_inspect_response"
                let enriched = (try? JSONSerialization.data(withJSONObject: json)) ?? patched
                let decoded = try decoder.decode(SkillsInspectResponseMessage.self, from: enriched)
                onMessage?(.skillsInspectResponse(decoded))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await inspectSkill(slug: slug, isRetry: true)
                }
            } else {
                log.error("Skill inspect failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Skill inspect error: \(error.localizedDescription)")
        }
    }

    func draftSkill(sourceText: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillsDraft) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["sourceText": sourceText]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                let patched = injectType("skills_draft_response", into: data)
                let decoded = try decoder.decode(SkillsDraftResponseMessage.self, from: patched)
                onMessage?(.skillsDraftResponse(decoded))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await draftSkill(sourceText: sourceText, isRetry: true)
                }
            } else {
                log.error("Skill draft failed (HTTP \(http.statusCode))")
            }
        } catch {
            log.error("Skill draft error: \(error.localizedDescription)")
        }
    }

    func createSkill(skillId: String, name: String, description: String, emoji: String?, bodyMarkdown: String, overwrite: Bool?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .skillsCreate) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "skillId": skillId,
            "name": name,
            "description": description,
            "bodyMarkdown": bodyMarkdown
        ]
        if let emoji { body["emoji"] = emoji }
        if let overwrite { body["overwrite"] = overwrite }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 201 || http.statusCode == 200 {
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "create",
                    success: true,
                    error: nil,
                    data: nil
                )))
            } else if http.statusCode == 401 && !isRetry {
                let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                if case .success = refreshResult {
                    await createSkill(skillId: skillId, name: name, description: description, emoji: emoji, bodyMarkdown: bodyMarkdown, overwrite: overwrite, isRetry: true)
                }
            } else {
                let errorMsg = extractErrorMessage(from: data)
                onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "create",
                    success: false,
                    error: errorMsg,
                    data: nil
                )))
            }
        } catch {
            log.error("Create skill error: \(error.localizedDescription)")
            onMessage?(.skillsOperationResponse(SkillsOperationResponseMessage(
                    operation: "create",
                    success: false,
                    error: error.localizedDescription,
                    data: nil
                )))
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
