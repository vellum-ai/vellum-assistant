import Foundation

// MARK: - AnyCodable

/// Lightweight wrapper for arbitrary JSON values in tool input dictionaries.
/// Supports String, Int, Double, Bool, null, arrays, and nested objects.
public struct AnyCodable: Codable, Equatable, @unchecked Sendable {
    public let value: Any?

    public init(_ value: Any?) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = nil
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value type")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if value == nil {
            try container.encodeNil()
        } else if let bool = value as? Bool {
            try container.encode(bool)
        } else if let int = value as? Int {
            try container.encode(int)
        } else if let double = value as? Double {
            try container.encode(double)
        } else if let string = value as? String {
            try container.encode(string)
        } else if let array = value as? [Any?] {
            try container.encode(array.map { AnyCodable($0) })
        } else if let dict = value as? [String: Any?] {
            try container.encode(dict.mapValues { AnyCodable($0) })
        } else {
            try container.encodeNil()
        }
    }

    public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        switch (lhs.value, rhs.value) {
        case (nil, nil):
            return true
        case let (l as Bool, r as Bool):
            return l == r
        case let (l as Int, r as Int):
            return l == r
        case let (l as Double, r as Double):
            return l == r
        case let (l as String, r as String):
            return l == r
        case let (l as [Any?], r as [Any?]):
            return l.count == r.count && zip(l, r).allSatisfy { AnyCodable($0) == AnyCodable($1) }
        case let (l as [String: Any?], r as [String: Any?]):
            guard l.count == r.count else { return false }
            return l.allSatisfy { key, lVal in
                guard let rVal = r[key] else { return false }
                return AnyCodable(lVal) == AnyCodable(rVal)
            }
        default:
            return false
        }
    }
}

// MARK: - Client → Server Messages (Encodable)

/// Attachment payload sent inline as base64. Mirrors `UserMessageAttachment` from ipc-protocol.ts.
public struct IPCAttachment: Codable, Sendable {
    public let filename: String
    public let mimeType: String
    public let data: String
    public let extractedText: String?

    public init(filename: String, mimeType: String, data: String, extractedText: String? = nil) {
        self.filename = filename
        self.mimeType = mimeType
        self.data = data
        self.extractedText = extractedText
    }
}

/// Sent to create a new computer-use session.
/// Wire type: `"cu_session_create"`
public struct CuSessionCreateMessage: Encodable, Sendable {
    public let type: String = "cu_session_create"
    public let sessionId: String
    public let task: String
    public let screenWidth: Int
    public let screenHeight: Int
    public let attachments: [IPCAttachment]?
    public let interactionType: String?

    public init(sessionId: String, task: String, screenWidth: Int, screenHeight: Int, attachments: [IPCAttachment]? = nil, interactionType: String? = nil) {
        self.sessionId = sessionId
        self.task = task
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.attachments = attachments
        self.interactionType = interactionType
    }
}

/// Sent after each perceive step with AX tree, screenshot, and execution results.
/// Wire type: `"cu_observation"`
public struct CuObservationMessage: Encodable, Sendable {
    public let type: String = "cu_observation"
    public let sessionId: String
    public let axTree: String?
    public let axDiff: String?
    public let secondaryWindows: String?
    public let screenshot: String?
    public let executionResult: String?
    public let executionError: String?

    public init(sessionId: String, axTree: String? = nil, axDiff: String? = nil, secondaryWindows: String? = nil, screenshot: String? = nil, executionResult: String? = nil, executionError: String? = nil) {
        self.sessionId = sessionId
        self.axTree = axTree
        self.axDiff = axDiff
        self.secondaryWindows = secondaryWindows
        self.screenshot = screenshot
        self.executionResult = executionResult
        self.executionError = executionError
    }
}

/// Sent by the ambient agent with OCR text from periodic screen captures.
/// Wire type: `"ambient_observation"`
public struct AmbientObservationMessage: Encodable, Sendable {
    public let type: String = "ambient_observation"
    public let requestId: String
    public let ocrText: String
    public let appName: String?
    public let windowTitle: String?
    public let timestamp: Double

    public init(requestId: String, ocrText: String, appName: String? = nil, windowTitle: String? = nil, timestamp: Double) {
        self.requestId = requestId
        self.ocrText = ocrText
        self.appName = appName
        self.windowTitle = windowTitle
        self.timestamp = timestamp
    }
}

/// Sent to create a new Q&A session.
/// Wire type: `"session_create"`
public struct SessionCreateMessage: Encodable, Sendable {
    public let type: String = "session_create"
    public let title: String?
    public let systemPromptOverride: String?
    public let maxResponseTokens: Int?
    /// Client-generated nonce echoed back in `session_info` so the caller can
    /// correlate the response to its specific request. Prevents multiple
    /// ChatViewModels sharing one DaemonClient from stealing each other's sessions.
    public let correlationId: String?

    public init(title: String?, systemPromptOverride: String? = nil, maxResponseTokens: Int? = nil, correlationId: String? = nil) {
        self.title = title
        self.systemPromptOverride = systemPromptOverride
        self.maxResponseTokens = maxResponseTokens
        self.correlationId = correlationId
    }
}

/// Sent to add a user message to an existing Q&A session.
/// Wire type: `"user_message"`
public struct UserMessageMessage: Encodable, Sendable {
    public let type: String = "user_message"
    public let sessionId: String
    public let content: String
    public let attachments: [IPCAttachment]?

    public init(sessionId: String, content: String, attachments: [IPCAttachment]? = nil) {
        self.sessionId = sessionId
        self.content = content
        self.attachments = attachments
    }
}

/// Sent to request daemon-side classification and session creation.
/// Wire type: `"task_submit"`
public struct TaskSubmitMessage: Encodable, Sendable {
    public let type: String = "task_submit"
    public let task: String
    public let screenWidth: Int
    public let screenHeight: Int
    public let attachments: [IPCAttachment]?
    public let source: String?

    public init(task: String, screenWidth: Int, screenHeight: Int, attachments: [IPCAttachment]? = nil, source: String? = nil) {
        self.task = task
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.attachments = attachments
        self.source = source
    }
}

/// Sent to cancel the active generation.
/// Wire type: `"cancel"`
public struct CancelMessage: Encodable, Sendable {
    public let type: String = "cancel"
    public let sessionId: String

    public init(sessionId: String) {
        self.sessionId = sessionId
    }
}

/// Sent to abort a running computer-use session.
/// Wire type: `"cu_session_abort"`
public struct CuSessionAbortMessage: Encodable, Sendable {
    public let type: String = "cu_session_abort"
    public let sessionId: String

    public init(sessionId: String) {
        self.sessionId = sessionId
    }
}

/// Keepalive ping.
/// Wire type: `"ping"`
public struct PingMessage: Encodable, Sendable {
    public let type: String = "ping"

    public init() {}
}

/// Sent when user interacts with a surface.
/// Wire type: `"ui_surface_action"`
public struct UiSurfaceActionMessage: Encodable, Sendable {
    public let type: String = "ui_surface_action"
    public let sessionId: String
    public let surfaceId: String
    public let actionId: String
    public let data: [String: AnyCodable]?

    public init(sessionId: String, surfaceId: String, actionId: String, data: [String: AnyCodable]? = nil) {
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.actionId = actionId
        self.data = data
    }
}

/// Sent when a persistent app's JS makes a data request via the RPC bridge.
/// Wire type: `"app_data_request"`
public struct AppDataRequestMessage: Encodable, Sendable {
    public let type: String = "app_data_request"
    public let surfaceId: String
    public let callId: String
    public let method: String
    public let appId: String
    public let recordId: String?
    public let data: [String: AnyCodable]?

    public init(surfaceId: String, callId: String, method: String, appId: String, recordId: String? = nil, data: [String: AnyCodable]? = nil) {
        self.surfaceId = surfaceId
        self.callId = callId
        self.method = method
        self.appId = appId
        self.recordId = recordId
        self.data = data
    }
}

/// Sent to request the list of available skills.
/// Wire type: `"skills_list"`
public struct SkillsListRequestMessage: Encodable, Sendable {
    public let type: String = "skills_list"

    public init() {}
}

/// Sent to request the full body of a specific skill.
/// Wire type: `"skill_detail"`
public struct SkillDetailRequestMessage: Encodable, Sendable {
    public let type: String = "skill_detail"
    public let skillId: String

    public init(skillId: String) {
        self.skillId = skillId
    }
}

/// Enable a skill. Wire type: "skills_enable"
public struct SkillsEnableMessage: Encodable, Sendable {
    public let type: String = "skills_enable"
    public let name: String

    public init(name: String) {
        self.name = name
    }
}

/// Disable a skill. Wire type: "skills_disable"
public struct SkillsDisableMessage: Encodable, Sendable {
    public let type: String = "skills_disable"
    public let name: String

    public init(name: String) {
        self.name = name
    }
}

/// Configure a skill's env/apiKey/config. Wire type: "skills_configure"
public struct SkillsConfigureMessage: Encodable, Sendable {
    public let type: String = "skills_configure"
    public let name: String
    public let env: [String: String]?
    public let apiKey: String?
    public let config: [String: AnyCodable]?

    public init(name: String, env: [String: String]? = nil, apiKey: String? = nil, config: [String: AnyCodable]? = nil) {
        self.name = name
        self.env = env
        self.apiKey = apiKey
        self.config = config
    }
}

/// Install a skill from ClaWHub. Wire type: "skills_install"
public struct SkillsInstallMessage: Encodable, Sendable {
    public let type: String = "skills_install"
    public let slug: String
    public let version: String?

    public init(slug: String, version: String? = nil) {
        self.slug = slug
        self.version = version
    }
}

/// Uninstall a skill. Wire type: "skills_uninstall"
public struct SkillsUninstallMessage: Encodable, Sendable {
    public let type: String = "skills_uninstall"
    public let name: String

    public init(name: String) {
        self.name = name
    }
}

/// Update a skill. Wire type: "skills_update"
public struct SkillsUpdateMessage: Encodable, Sendable {
    public let type: String = "skills_update"
    public let name: String

    public init(name: String) {
        self.name = name
    }
}

/// Check for skill updates. Wire type: "skills_check_updates"
public struct SkillsCheckUpdatesMessage: Encodable, Sendable {
    public let type: String = "skills_check_updates"

    public init() {}
}

/// Search for skills on ClaWHub. Wire type: "skills_search"
public struct SkillsSearchMessage: Encodable, Sendable {
    public let type: String = "skills_search"
    public let query: String

    public init(query: String) {
        self.query = query
    }
}

/// Inspect a ClaWHub skill for detailed info. Wire type: "skills_inspect"
public struct SkillsInspectMessage: Encodable, Sendable {
    public let type: String = "skills_inspect"
    public let slug: String

    public init(slug: String) {
        self.slug = slug
    }
}

// MARK: - Server → Client Messages (Decodable)

/// Action to execute from the inference server.
public struct CuActionMessage: Decodable, Sendable {
    public let sessionId: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let reasoning: String?
    public let stepNumber: Int

    public init(sessionId: String, toolName: String, input: [String: AnyCodable], reasoning: String? = nil, stepNumber: Int) {
        self.sessionId = sessionId
        self.toolName = toolName
        self.input = input
        self.reasoning = reasoning
        self.stepNumber = stepNumber
    }
}

/// Session completed successfully.
public struct CuCompleteMessage: Decodable, Sendable {
    public let sessionId: String
    public let summary: String
    public let stepCount: Int
    public let isResponse: Bool?

    public init(sessionId: String, summary: String, stepCount: Int, isResponse: Bool? = nil) {
        self.sessionId = sessionId
        self.summary = summary
        self.stepCount = stepCount
        self.isResponse = isResponse
    }
}

/// Session-level error from the server.
public struct CuErrorMessage: Decodable, Sendable {
    public let sessionId: String
    public let message: String

    public init(sessionId: String, message: String) {
        self.sessionId = sessionId
        self.message = message
    }
}

/// Streamed text delta from the assistant's response.
public struct AssistantTextDeltaMessage: Decodable, Sendable {
    public let text: String
    public let sessionId: String?

    public init(text: String, sessionId: String? = nil) {
        self.text = text
        self.sessionId = sessionId
    }
}

/// Streamed thinking delta from the assistant's reasoning.
public struct AssistantThinkingDeltaMessage: Decodable, Sendable {
    public let thinking: String

    public init(thinking: String) {
        self.thinking = thinking
    }
}

/// Signals that the assistant's message is complete.
public struct MessageCompleteMessage: Decodable, Sendable {
    public let sessionId: String?

    public init(sessionId: String? = nil) {
        self.sessionId = sessionId
    }
}

/// Session metadata from the server (e.g. generated title).
public struct SessionInfoMessage: Decodable, Sendable {
    public let sessionId: String
    public let title: String
    /// Echoed from the `session_create` request so the caller can match
    /// this response to its specific request.
    public let correlationId: String?

    public init(sessionId: String, title: String, correlationId: String? = nil) {
        self.sessionId = sessionId
        self.title = title
        self.correlationId = correlationId
    }
}

/// Daemon response after classifying and routing a task_submit.
public struct TaskRoutedMessage: Decodable, Sendable {
    public let sessionId: String
    public let interactionType: String
    /// The task text passed to the escalated session.
    public let task: String?
    /// Set when a text_qa session escalates to computer_use via request_computer_control.
    public let escalatedFrom: String?
}

/// Result from ambient observation analysis.
public struct AmbientResultMessage: Decodable, Sendable {
    public let requestId: String
    public let decision: String
    public let summary: String?
    public let suggestion: String?
}

/// Surface show command from daemon.
/// Wire type: `"ui_surface_show"`
public struct UiSurfaceShowMessage: Decodable, Sendable {
    public let sessionId: String
    public let surfaceId: String
    public let surfaceType: String
    public let title: String?
    public let data: AnyCodable
    public let actions: [SurfaceActionData]?
    /// `"inline"` embeds in chat, `"panel"` shows a floating window.
    public let display: String?
}

public struct SurfaceActionData: Decodable, Sendable {
    public let id: String
    public let label: String
    public let style: String?
}

/// Surface update command from daemon.
/// Wire type: `"ui_surface_update"`
public struct UiSurfaceUpdateMessage: Decodable, Sendable {
    public let sessionId: String
    public let surfaceId: String
    public let data: AnyCodable
}

/// Surface dismiss command from daemon.
/// Wire type: `"ui_surface_dismiss"`
public struct UiSurfaceDismissMessage: Decodable, Sendable {
    public let sessionId: String
    public let surfaceId: String
}

/// Confirms generation was cancelled.
public struct GenerationCancelledMessage: Decodable, Sendable {
    public let sessionId: String?

    public init(sessionId: String? = nil) {
        self.sessionId = sessionId
    }
}

/// Notifies client that active generation yielded to queued work at a checkpoint.
/// Wire type: `"generation_handoff"`
public struct GenerationHandoffMessage: Decodable, Sendable {
    public let sessionId: String
    public let requestId: String?
    public let queuedCount: Int

    public init(sessionId: String, requestId: String? = nil, queuedCount: Int) {
        self.sessionId = sessionId
        self.requestId = requestId
        self.queuedCount = queuedCount
    }
}

/// Notifies client that a message has been queued for processing.
/// Wire type: `"message_queued"`
public struct MessageQueuedMessage: Decodable, Sendable {
    public let sessionId: String
    public let requestId: String
    public let position: Int

    public init(sessionId: String, requestId: String, position: Int) {
        self.sessionId = sessionId
        self.requestId = requestId
        self.position = position
    }
}

/// Notifies client that a queued message has been dequeued and is now being processed.
/// Wire type: `"message_dequeued"`
public struct MessageDequeuedMessage: Decodable, Sendable {
    public let sessionId: String
    public let requestId: String

    public init(sessionId: String, requestId: String) {
        self.sessionId = sessionId
        self.requestId = requestId
    }
}

/// Server-level error message.
public struct ErrorMessage: Decodable, Sendable {
    public let message: String

    public init(message: String) {
        self.message = message
    }
}

/// Response from the daemon for a persistent app data request.
/// Wire type: `"app_data_response"`
public struct AppDataResponseMessage: Decodable, Sendable {
    public let surfaceId: String
    public let callId: String
    public let success: Bool
    public let result: AnyCodable?
    public let error: String?
}

/// ClaWHub metadata for a skill.
public struct ClawhubInfo: Codable, Sendable {
    public let author: String
    public let stars: Int
    public let installs: Int
    public let reports: Int
    public let publishedAt: String

    public init(author: String, stars: Int, installs: Int, reports: Int, publishedAt: String) {
        self.author = author
        self.stars = stars
        self.installs = installs
        self.reports = reports
        self.publishedAt = publishedAt
    }
}

/// Missing requirements preventing a skill from full operation.
public struct MissingRequirements: Codable, Sendable {
    public let bins: [String]?
    public let env: [String]?
    public let permissions: [String]?

    public init(bins: [String]? = nil, env: [String]? = nil, permissions: [String]? = nil) {
        self.bins = bins
        self.env = env
        self.permissions = permissions
    }
}
/// Full skill info from the daemon's resolved skill list.
public struct SkillInfo: Codable, Sendable, Identifiable {
    public var id: String { name }
    public let name: String
    public let description: String
    public let emoji: String?
    public let homepage: String?
    public let source: String  // "bundled" | "managed" | "workspace" | "clawhub"
    public let state: String   // "enabled" | "disabled" | "available"
    public let degraded: Bool
    public let missingRequirements: MissingRequirements?
    public let installedVersion: String?
    public let latestVersion: String?
    public let updateAvailable: Bool
    public let userInvocable: Bool
    public let clawhub: ClawhubInfo?

    public init(name: String, description: String, emoji: String? = nil, homepage: String? = nil, source: String, state: String, degraded: Bool, missingRequirements: MissingRequirements? = nil, installedVersion: String? = nil, latestVersion: String? = nil, updateAvailable: Bool, userInvocable: Bool, clawhub: ClawhubInfo? = nil) {
        self.name = name
        self.description = description
        self.emoji = emoji
        self.homepage = homepage
        self.source = source
        self.state = state
        self.degraded = degraded
        self.missingRequirements = missingRequirements
        self.installedVersion = installedVersion
        self.latestVersion = latestVersion
        self.updateAvailable = updateAvailable
        self.userInvocable = userInvocable
        self.clawhub = clawhub
    }
}

/// Backward-compatible alias for code referencing the old name.
typealias SkillSummaryItem = SkillInfo

/// Response containing the list of available skills.
/// Wire type: `"skills_list_response"`
public struct SkillsListResponseMessage: Decodable, Sendable {
    public let skills: [SkillInfo]
}

/// Response containing the full body of a specific skill.
/// Wire type: `"skill_detail_response"`
public struct SkillDetailResponseMessage: Decodable, Sendable {
    public let skillId: String
    public let body: String
    public let error: String?
}

/// Push event: skill state changed. Wire type: "skills_state_changed"
public struct SkillStateChangedMessage: Decodable, Sendable {
    public let name: String
    public let state: String  // "enabled" | "disabled" | "installed" | "uninstalled"
}

/// Push event: updates available. Wire type: "skills_updates_available"
public struct SkillsUpdatesAvailableMessage: Decodable, Sendable {
    public struct UpdateInfo: Decodable, Sendable {
        public let name: String
        public let installedVersion: String
        public let latestVersion: String
        
        public init(name: String, installedVersion: String, latestVersion: String) {
            self.name = name
            self.installedVersion = installedVersion
            self.latestVersion = latestVersion
        }
    }
    public let skills: [UpdateInfo]
}

/// A ClaWHub skill returned from a search or explore query.
public struct ClawhubSkillItem: Decodable, Sendable, Identifiable {
    public var id: String { slug }
    public let name: String
    public let slug: String
    public let description: String
    public let author: String
    public let stars: Int
    public let installs: Int
    public let version: String
    /// Epoch milliseconds when the skill was first published.
    public let createdAt: Int

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        slug = try container.decode(String.self, forKey: .slug)
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
        author = try container.decodeIfPresent(String.self, forKey: .author) ?? ""
        stars = try container.decodeIfPresent(Int.self, forKey: .stars) ?? 0
        installs = try container.decodeIfPresent(Int.self, forKey: .installs) ?? 0
        version = try container.decodeIfPresent(String.self, forKey: .version) ?? ""
        createdAt = try container.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case name, slug, description, author, stars, installs, version, createdAt
    }
}

/// Wrapper for ClaWHub search results embedded in `skills_operation_response.data`.
public struct ClawhubSearchData: Decodable, Sendable {
    public let skills: [ClawhubSkillItem]
}

/// Generic operation response. Wire type: "skills_operation_response"
public struct SkillsOperationResponseMessage: Decodable, Sendable {
    public let operation: String
    public let success: Bool
    public let error: String?
    public let data: ClawhubSearchData?
}

/// Skill info from a ClaWHub inspect response.
public struct ClawhubInspectSkill: Decodable, Sendable {
    public let slug: String
    public let displayName: String
    public let summary: String
}

/// Owner info from a ClaWHub inspect response.
public struct ClawhubInspectOwner: Decodable, Sendable {
    public let handle: String
    public let displayName: String
    public let image: String?
}

/// Stats from a ClaWHub inspect response.
public struct ClawhubInspectStats: Decodable, Sendable {
    public let stars: Int
    public let installs: Int
    public let downloads: Int
    public let versions: Int

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        stars = try container.decodeIfPresent(Int.self, forKey: .stars) ?? 0
        installs = try container.decodeIfPresent(Int.self, forKey: .installs) ?? 0
        downloads = try container.decodeIfPresent(Int.self, forKey: .downloads) ?? 0
        versions = try container.decodeIfPresent(Int.self, forKey: .versions) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case stars, installs, downloads, versions
    }
}

/// Version info from a ClaWHub inspect response.
public struct ClawhubInspectVersion: Decodable, Sendable {
    public let version: String
    public let changelog: String?
}

/// File entry from a ClaWHub inspect response.
public struct ClawhubInspectFile: Decodable, Sendable {
    public let path: String
    public let size: Int
    public let contentType: String?
}

/// Full inspect data for a ClaWHub skill.
public struct ClawhubInspectData: Decodable, Sendable {
    public let skill: ClawhubInspectSkill
    public let owner: ClawhubInspectOwner?
    public let stats: ClawhubInspectStats?
    public let createdAt: Int?
    public let updatedAt: Int?
    public let latestVersion: ClawhubInspectVersion?
    public let files: [ClawhubInspectFile]?
    public let skillMdContent: String?
}

/// Response from inspecting a ClaWHub skill.
/// Wire type: "skills_inspect_response"
public struct SkillsInspectResponseMessage: Decodable, Sendable {
    public let slug: String
    public let data: ClawhubInspectData?
    public let error: String?
}

/// A single trust rule item returned from the daemon.
public struct TrustRuleItem: Decodable, Sendable, Identifiable {
    public let id: String
    public let tool: String
    public let pattern: String
    public let scope: String
    public let decision: String
    public let priority: Int
    public let createdAt: Double
}

/// Response containing all trust rules.
/// Wire type: `"trust_rules_list_response"`
public struct TrustRulesListResponseMessage: Decodable, Sendable {
    public let rules: [TrustRuleItem]
}

/// Timer completed notification from daemon.
/// Wire type: `"timer_completed"`
public struct TimerCompletedMessage: Decodable, Sendable {
    public let sessionId: String
    public let timerId: String
    public let label: String
    public let durationMinutes: Double
}

/// Tool execution started.
/// Wire type: `"tool_use_start"`
public struct ToolUseStartMessage: Decodable, Sendable {
    public let toolName: String
    public let input: [String: AnyCodable]
    public let sessionId: String?
}

/// Streaming tool output chunk.
/// Wire type: `"tool_output_chunk"`
public struct ToolOutputChunkMessage: Decodable, Sendable {
    public let chunk: String
}

/// Tool execution completed.
/// Wire type: `"tool_result"`
public struct ToolResultMessage: Decodable, Sendable {
    public let toolName: String
    public let result: String
    public let isError: Bool?
    public let diff: ConfirmationRequestMessage.ConfirmationDiffInfo?
    public let status: String?
    public let sessionId: String?
}

/// Follow-up suggestion response from daemon.
/// Wire type: `"suggestion_response"`
public struct SuggestionResponseMessage: Decodable, Sendable {
    public let requestId: String
    public let suggestion: String?
    public let source: String
}

/// Permission confirmation request from daemon.
/// Wire type: `"confirmation_request"`
public struct ConfirmationRequestMessage: Decodable, Sendable {
    public let requestId: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let riskLevel: String
    public let allowlistOptions: [ConfirmationAllowlistOption]
    public let scopeOptions: [ConfirmationScopeOption]
    public let diff: ConfirmationDiffInfo?
    public let sandboxed: Bool?
    public let sessionId: String?

    public struct ConfirmationAllowlistOption: Decodable, Sendable, Equatable {
        public let label: String
        public let description: String?
        public let pattern: String
        
        public init(label: String, description: String? = nil, pattern: String) {
            self.label = label
            self.description = description
            self.pattern = pattern
        }
    }
    public struct ConfirmationScopeOption: Decodable, Sendable, Equatable {
        public let label: String
        public let scope: String
        
        public init(label: String, scope: String) {
            self.label = label
            self.scope = scope
        }
    }
    public struct ConfirmationDiffInfo: Decodable, Sendable, Equatable {
        public let filePath: String
        public let oldContent: String
        public let newContent: String
        public let isNewFile: Bool

        public init(filePath: String, oldContent: String, newContent: String, isNewFile: Bool) {
            self.filePath = filePath
            self.oldContent = oldContent
            self.newContent = newContent
            self.isNewFile = isNewFile
        }
    }
}

/// Request a follow-up suggestion for the current session.
/// Wire type: `"suggestion_request"`
public struct SuggestionRequestMessage: Encodable, Sendable {
    public let type: String = "suggestion_request"
    public let sessionId: String
    public let requestId: String

    public init(sessionId: String, requestId: String) {
        self.sessionId = sessionId
        self.requestId = requestId
    }
}

/// Client response to a permission confirmation request.
/// Wire type: `"confirmation_response"`
public struct ConfirmationResponseMessage: Encodable, Sendable {
    public let type: String = "confirmation_response"
    public let requestId: String
    public let decision: String
    public let selectedPattern: String?
    public let selectedScope: String?

    public init(requestId: String, decision: String, selectedPattern: String? = nil, selectedScope: String? = nil) {
        self.requestId = requestId
        self.decision = decision
        self.selectedPattern = selectedPattern
        self.selectedScope = selectedScope
    }
}

/// Sent to add a trust rule (allowlist/denylist) independently of a confirmation response.
/// Wire type: `"add_trust_rule"`
public struct AddTrustRuleMessage: Encodable, Sendable {
    public let type: String = "add_trust_rule"
    public let toolName: String
    public let pattern: String
    public let scope: String
    public let decision: String

    public init(toolName: String, pattern: String, scope: String, decision: String) {
        self.toolName = toolName
        self.pattern = pattern
        self.scope = scope
        self.decision = decision
    }
}

/// Request all trust rules from the daemon.
/// Wire type: `"trust_rules_list"`
public struct TrustRulesListMessage: Encodable, Sendable {
    public let type: String = "trust_rules_list"

    public init() {}
}

/// Remove a trust rule by its ID.
/// Wire type: `"remove_trust_rule"`
public struct RemoveTrustRuleMessage: Encodable, Sendable {
    public let type: String = "remove_trust_rule"
    public let id: String

    public init(id: String) {
        self.id = id
    }
}

/// Update fields on an existing trust rule.
/// Wire type: `"update_trust_rule"`
public struct UpdateTrustRuleMessage: Encodable, Sendable {
    public let type: String = "update_trust_rule"
    public let id: String
    public let tool: String?
    public let pattern: String?
    public let scope: String?
    public let decision: String?
    public let priority: Int?

    public init(id: String, tool: String? = nil, pattern: String? = nil, scope: String? = nil, decision: String? = nil, priority: Int? = nil) {
        self.id = id
        self.tool = tool
        self.pattern = pattern
        self.scope = scope
        self.decision = decision
        self.priority = priority
    }
}

/// Discriminated union of all server → client message types relevant to the macOS client.
/// Decodes via the `"type"` field in the JSON payload.
public enum ServerMessage: Decodable, Sendable {
    case cuAction(CuActionMessage)
    case cuComplete(CuCompleteMessage)
    case cuError(CuErrorMessage)
    case assistantTextDelta(AssistantTextDeltaMessage)
    case assistantThinkingDelta(AssistantThinkingDeltaMessage)
    case messageComplete(MessageCompleteMessage)
    case sessionInfo(SessionInfoMessage)
    case taskRouted(TaskRoutedMessage)
    case error(ErrorMessage)
    case ambientResult(AmbientResultMessage)
    case uiSurfaceShow(UiSurfaceShowMessage)
    case uiSurfaceUpdate(UiSurfaceUpdateMessage)
    case uiSurfaceDismiss(UiSurfaceDismissMessage)
    case generationCancelled(GenerationCancelledMessage)
    case generationHandoff(GenerationHandoffMessage)
    case confirmationRequest(ConfirmationRequestMessage)
    case appDataResponse(AppDataResponseMessage)
    case messageQueued(MessageQueuedMessage)
    case messageDequeued(MessageDequeuedMessage)
    case skillsListResponse(SkillsListResponseMessage)
    case skillDetailResponse(SkillDetailResponseMessage)
    case skillStateChanged(SkillStateChangedMessage)
    case skillsUpdatesAvailable(SkillsUpdatesAvailableMessage)
    case skillsOperationResponse(SkillsOperationResponseMessage)
    case skillsInspectResponse(SkillsInspectResponseMessage)
    case suggestionResponse(SuggestionResponseMessage)
    case toolUseStart(ToolUseStartMessage)
    case toolOutputChunk(ToolOutputChunkMessage)
    case toolResult(ToolResultMessage)
    case timerCompleted(TimerCompletedMessage)
    case trustRulesListResponse(TrustRulesListResponseMessage)
    case pong
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case type
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "cu_action":
            let message = try CuActionMessage(from: decoder)
            self = .cuAction(message)
        case "cu_complete":
            let message = try CuCompleteMessage(from: decoder)
            self = .cuComplete(message)
        case "cu_error":
            let message = try CuErrorMessage(from: decoder)
            self = .cuError(message)
        case "assistant_text_delta":
            let message = try AssistantTextDeltaMessage(from: decoder)
            self = .assistantTextDelta(message)
        case "assistant_thinking_delta":
            let message = try AssistantThinkingDeltaMessage(from: decoder)
            self = .assistantThinkingDelta(message)
        case "message_complete":
            let message = try MessageCompleteMessage(from: decoder)
            self = .messageComplete(message)
        case "session_info":
            let message = try SessionInfoMessage(from: decoder)
            self = .sessionInfo(message)
        case "task_routed":
            let message = try TaskRoutedMessage(from: decoder)
            self = .taskRouted(message)
        case "error":
            let message = try ErrorMessage(from: decoder)
            self = .error(message)
        case "ambient_result":
            let message = try AmbientResultMessage(from: decoder)
            self = .ambientResult(message)
        case "ui_surface_show":
            let message = try UiSurfaceShowMessage(from: decoder)
            self = .uiSurfaceShow(message)
        case "ui_surface_update":
            let message = try UiSurfaceUpdateMessage(from: decoder)
            self = .uiSurfaceUpdate(message)
        case "ui_surface_dismiss":
            let message = try UiSurfaceDismissMessage(from: decoder)
            self = .uiSurfaceDismiss(message)
        case "generation_cancelled":
            let message = try GenerationCancelledMessage(from: decoder)
            self = .generationCancelled(message)
        case "generation_handoff":
            let message = try GenerationHandoffMessage(from: decoder)
            self = .generationHandoff(message)
        case "confirmation_request":
            let message = try ConfirmationRequestMessage(from: decoder)
            self = .confirmationRequest(message)
        case "app_data_response":
            let message = try AppDataResponseMessage(from: decoder)
            self = .appDataResponse(message)
        case "message_queued":
            let message = try MessageQueuedMessage(from: decoder)
            self = .messageQueued(message)
        case "message_dequeued":
            let message = try MessageDequeuedMessage(from: decoder)
            self = .messageDequeued(message)
        case "skills_list_response":
            let message = try SkillsListResponseMessage(from: decoder)
            self = .skillsListResponse(message)
        case "skill_detail_response":
            let message = try SkillDetailResponseMessage(from: decoder)
            self = .skillDetailResponse(message)
        case "skills_state_changed":
            let message = try SkillStateChangedMessage(from: decoder)
            self = .skillStateChanged(message)
        case "skills_updates_available":
            let message = try SkillsUpdatesAvailableMessage(from: decoder)
            self = .skillsUpdatesAvailable(message)
        case "skills_operation_response":
            let message = try SkillsOperationResponseMessage(from: decoder)
            self = .skillsOperationResponse(message)
        case "skills_inspect_response":
            let message = try SkillsInspectResponseMessage(from: decoder)
            self = .skillsInspectResponse(message)
        case "suggestion_response":
            let message = try SuggestionResponseMessage(from: decoder)
            self = .suggestionResponse(message)
        case "tool_use_start":
            let message = try ToolUseStartMessage(from: decoder)
            self = .toolUseStart(message)
        case "tool_output_chunk":
            let message = try ToolOutputChunkMessage(from: decoder)
            self = .toolOutputChunk(message)
        case "tool_result":
            let message = try ToolResultMessage(from: decoder)
            self = .toolResult(message)
        case "timer_completed":
            let message = try TimerCompletedMessage(from: decoder)
            self = .timerCompleted(message)
        case "trust_rules_list_response":
            let message = try TrustRulesListResponseMessage(from: decoder)
            self = .trustRulesListResponse(message)
        case "pong":
            self = .pong
        default:
            self = .unknown(type)
        }
    }
}
