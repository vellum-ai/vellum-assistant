import Foundation

// MARK: - AnyCodable

/// Lightweight wrapper for arbitrary JSON values in tool input dictionaries.
/// Supports String, Int, Double, Bool, null, arrays, and nested objects.
struct AnyCodable: Codable, Equatable, @unchecked Sendable {
    let value: Any?

    init(_ value: Any?) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
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

    func encode(to encoder: Encoder) throws {
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

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
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
struct IPCAttachment: Codable, Sendable {
    let filename: String
    let mimeType: String
    let data: String
    let extractedText: String?
}

/// Sent to create a new computer-use session.
/// Wire type: `"cu_session_create"`
struct CuSessionCreateMessage: Encodable, Sendable {
    let type: String = "cu_session_create"
    let sessionId: String
    let task: String
    let screenWidth: Int
    let screenHeight: Int
    let attachments: [IPCAttachment]?
    let interactionType: String?
}

/// Sent after each perceive step with AX tree, screenshot, and execution results.
/// Wire type: `"cu_observation"`
struct CuObservationMessage: Encodable, Sendable {
    let type: String = "cu_observation"
    let sessionId: String
    let axTree: String?
    let axDiff: String?
    let secondaryWindows: String?
    let screenshot: String?
    let executionResult: String?
    let executionError: String?
}

/// Sent by the ambient agent with OCR text from periodic screen captures.
/// Wire type: `"ambient_observation"`
struct AmbientObservationMessage: Encodable, Sendable {
    let type: String = "ambient_observation"
    let requestId: String
    let ocrText: String
    let appName: String?
    let windowTitle: String?
    let timestamp: Double
}

/// Sent to create a new Q&A session.
/// Wire type: `"session_create"`
struct SessionCreateMessage: Encodable, Sendable {
    let type: String = "session_create"
    let title: String?
    let systemPromptOverride: String?
    let maxResponseTokens: Int?
    /// Client-generated nonce echoed back in `session_info` so the caller can
    /// correlate the response to its specific request. Prevents multiple
    /// ChatViewModels sharing one DaemonClient from stealing each other's sessions.
    let correlationId: String?

    init(title: String?, systemPromptOverride: String? = nil, maxResponseTokens: Int? = nil, correlationId: String? = nil) {
        self.title = title
        self.systemPromptOverride = systemPromptOverride
        self.maxResponseTokens = maxResponseTokens
        self.correlationId = correlationId
    }
}

/// Sent to add a user message to an existing Q&A session.
/// Wire type: `"user_message"`
struct UserMessageMessage: Encodable, Sendable {
    let type: String = "user_message"
    let sessionId: String
    let content: String
    let attachments: [IPCAttachment]?
}

/// Sent to request daemon-side classification and session creation.
/// Wire type: `"task_submit"`
struct TaskSubmitMessage: Encodable, Sendable {
    let type: String = "task_submit"
    let task: String
    let screenWidth: Int
    let screenHeight: Int
    let attachments: [IPCAttachment]?
    let source: String?
}

/// Sent to cancel the active generation.
/// Wire type: `"cancel"`
struct CancelMessage: Encodable, Sendable {
    let type: String = "cancel"
    let sessionId: String
}

/// Sent to abort a running computer-use session.
/// Wire type: `"cu_session_abort"`
struct CuSessionAbortMessage: Encodable, Sendable {
    let type: String = "cu_session_abort"
    let sessionId: String
}

/// Keepalive ping.
/// Wire type: `"ping"`
struct PingMessage: Encodable, Sendable {
    let type: String = "ping"
}

/// Sent when user interacts with a surface.
/// Wire type: `"ui_surface_action"`
struct UiSurfaceActionMessage: Encodable, Sendable {
    let type: String = "ui_surface_action"
    let sessionId: String
    let surfaceId: String
    let actionId: String
    let data: [String: AnyCodable]?
}

/// Sent when a persistent app's JS makes a data request via the RPC bridge.
/// Wire type: `"app_data_request"`
struct AppDataRequestMessage: Encodable, Sendable {
    let type: String = "app_data_request"
    let surfaceId: String
    let callId: String
    let method: String
    let appId: String
    let recordId: String?
    let data: [String: AnyCodable]?
}

/// Sent to request the list of all apps.
/// Wire type: `"apps_list"`
struct AppsListRequestMessage: Encodable, Sendable {
    let type: String = "apps_list"
}

/// Sent to request the list of shared/received apps.
/// Wire type: `"shared_apps_list"`
struct SharedAppsListRequestMessage: Encodable, Sendable {
    let type: String = "shared_apps_list"
}

/// Sent to delete a shared app by UUID.
/// Wire type: `"shared_app_delete"`
struct SharedAppDeleteRequestMessage: Encodable, Sendable {
    let type: String = "shared_app_delete"
    let uuid: String
}

/// Sent to request bundling an app for sharing.
/// Wire type: `"bundle_app"`
struct BundleAppRequestMessage: Encodable, Sendable {
    let type: String = "bundle_app"
    let appId: String
}

/// Sent to open and scan a .vellumapp bundle.
/// Wire type: `"open_bundle"`
struct OpenBundleMessage: Encodable, Sendable {
    let type: String = "open_bundle"
    let filePath: String
}

/// Sent to request the list of available skills.
/// Wire type: `"skills_list"`
struct SkillsListRequestMessage: Encodable, Sendable {
    let type: String = "skills_list"
}

/// Sent to request the full body of a specific skill.
/// Wire type: `"skill_detail"`
struct SkillDetailRequestMessage: Encodable, Sendable {
    let type: String = "skill_detail"
    let skillId: String
}

/// Enable a skill. Wire type: "skills_enable"
struct SkillsEnableMessage: Encodable, Sendable {
    let type: String = "skills_enable"
    let name: String
}

/// Disable a skill. Wire type: "skills_disable"
struct SkillsDisableMessage: Encodable, Sendable {
    let type: String = "skills_disable"
    let name: String
}

/// Configure a skill's env/apiKey/config. Wire type: "skills_configure"
struct SkillsConfigureMessage: Encodable, Sendable {
    let type: String = "skills_configure"
    let name: String
    let env: [String: String]?
    let apiKey: String?
    let config: [String: AnyCodable]?
}

/// Install a skill from ClaWHub. Wire type: "skills_install"
struct SkillsInstallMessage: Encodable, Sendable {
    let type: String = "skills_install"
    let slug: String
    let version: String?
}

/// Uninstall a skill. Wire type: "skills_uninstall"
struct SkillsUninstallMessage: Encodable, Sendable {
    let type: String = "skills_uninstall"
    let name: String
}

/// Update a skill. Wire type: "skills_update"
struct SkillsUpdateMessage: Encodable, Sendable {
    let type: String = "skills_update"
    let name: String
}

/// Check for skill updates. Wire type: "skills_check_updates"
struct SkillsCheckUpdatesMessage: Encodable, Sendable {
    let type: String = "skills_check_updates"
}

/// Search for skills on ClaWHub. Wire type: "skills_search"
struct SkillsSearchMessage: Encodable, Sendable {
    let type: String = "skills_search"
    let query: String
}

/// Inspect a ClaWHub skill for detailed info. Wire type: "skills_inspect"
struct SkillsInspectMessage: Encodable, Sendable {
    let type: String = "skills_inspect"
    let slug: String
}

/// Response to a sign_bundle_payload request from the daemon.
/// Wire type: `"sign_bundle_payload_response"`
struct SignBundlePayloadResponseMessage: Encodable, Sendable {
    let type: String = "sign_bundle_payload_response"
    let signature: String
    let keyId: String
    let publicKey: String
}

/// Response to a get_signing_identity request from the daemon.
/// Wire type: `"get_signing_identity_response"`
struct GetSigningIdentityResponseMessage: Encodable, Sendable {
    let type: String = "get_signing_identity_response"
    let keyId: String
    let publicKey: String
}

// MARK: - Server → Client Messages (Decodable)

/// Action to execute from the inference server.
struct CuActionMessage: Decodable, Sendable {
    let sessionId: String
    let toolName: String
    let input: [String: AnyCodable]
    let reasoning: String?
    let stepNumber: Int
}

/// Session completed successfully.
struct CuCompleteMessage: Decodable, Sendable {
    let sessionId: String
    let summary: String
    let stepCount: Int
    let isResponse: Bool?
}

/// Session-level error from the server.
struct CuErrorMessage: Decodable, Sendable {
    let sessionId: String
    let message: String
}

/// Streamed text delta from the assistant's response.
struct AssistantTextDeltaMessage: Decodable, Sendable {
    let text: String
    let sessionId: String?

    init(text: String, sessionId: String? = nil) {
        self.text = text
        self.sessionId = sessionId
    }
}

/// Streamed thinking delta from the assistant's reasoning.
struct AssistantThinkingDeltaMessage: Decodable, Sendable {
    let thinking: String
}

/// Signals that the assistant's message is complete.
struct MessageCompleteMessage: Decodable, Sendable {
    let sessionId: String?

    init(sessionId: String? = nil) {
        self.sessionId = sessionId
    }
}

/// Session metadata from the server (e.g. generated title).
struct SessionInfoMessage: Decodable, Sendable {
    let sessionId: String
    let title: String
    /// Echoed from the `session_create` request so the caller can match
    /// this response to its specific request.
    let correlationId: String?

    init(sessionId: String, title: String, correlationId: String? = nil) {
        self.sessionId = sessionId
        self.title = title
        self.correlationId = correlationId
    }
}

/// Daemon response after classifying and routing a task_submit.
struct TaskRoutedMessage: Decodable, Sendable {
    let sessionId: String
    let interactionType: String
    /// The task text passed to the escalated session.
    let task: String?
    /// Set when a text_qa session escalates to computer_use via request_computer_control.
    let escalatedFrom: String?
}

/// Result from ambient observation analysis.
struct AmbientResultMessage: Decodable, Sendable {
    let requestId: String
    let decision: String
    let summary: String?
    let suggestion: String?
}

/// Surface show command from daemon.
/// Wire type: `"ui_surface_show"`
struct UiSurfaceShowMessage: Decodable, Sendable {
    let sessionId: String
    let surfaceId: String
    let surfaceType: String
    let title: String?
    let data: AnyCodable
    let actions: [SurfaceActionData]?
    /// `"inline"` embeds in chat, `"panel"` shows a floating window.
    let display: String?
}

struct SurfaceActionData: Decodable, Sendable {
    let id: String
    let label: String
    let style: String?
}

/// Surface update command from daemon.
/// Wire type: `"ui_surface_update"`
struct UiSurfaceUpdateMessage: Decodable, Sendable {
    let sessionId: String
    let surfaceId: String
    let data: AnyCodable
}

/// Surface dismiss command from daemon.
/// Wire type: `"ui_surface_dismiss"`
struct UiSurfaceDismissMessage: Decodable, Sendable {
    let sessionId: String
    let surfaceId: String
}

/// Confirms generation was cancelled.
struct GenerationCancelledMessage: Decodable, Sendable {
    let sessionId: String?
}

/// Notifies client that active generation yielded to queued work at a checkpoint.
/// Wire type: `"generation_handoff"`
struct GenerationHandoffMessage: Decodable, Sendable {
    let sessionId: String
    let requestId: String?
    let queuedCount: Int
}

/// Notifies client that a message has been queued for processing.
/// Wire type: `"message_queued"`
struct MessageQueuedMessage: Decodable, Sendable {
    let sessionId: String
    let requestId: String
    let position: Int
}

/// Notifies client that a queued message has been dequeued and is now being processed.
/// Wire type: `"message_dequeued"`
struct MessageDequeuedMessage: Decodable, Sendable {
    let sessionId: String
    let requestId: String
}

/// Server-level error message.
struct ErrorMessage: Decodable, Sendable {
    let message: String
}

/// Response from the daemon for a persistent app data request.
/// Wire type: `"app_data_response"`
struct AppDataResponseMessage: Decodable, Sendable {
    let surfaceId: String
    let callId: String
    let success: Bool
    let result: AnyCodable?
    let error: String?
}

/// ClaWHub metadata for a skill.
struct ClawhubInfo: Codable, Sendable {
    let author: String
    let stars: Int
    let installs: Int
    let reports: Int
    let publishedAt: String
}

/// Missing requirements preventing a skill from full operation.
struct MissingRequirements: Codable, Sendable {
    let bins: [String]?
    let env: [String]?
    let permissions: [String]?
}

/// Full skill info from the daemon's resolved skill list.
struct SkillInfo: Codable, Sendable, Identifiable {
    var id: String { name }
    let name: String
    let description: String
    let emoji: String?
    let homepage: String?
    let source: String  // "bundled" | "managed" | "workspace" | "clawhub"
    let state: String   // "enabled" | "disabled" | "available"
    let degraded: Bool
    let missingRequirements: MissingRequirements?
    let installedVersion: String?
    let latestVersion: String?
    let updateAvailable: Bool
    let userInvocable: Bool
    let clawhub: ClawhubInfo?
}

/// Backward-compatible alias for code referencing the old name.
typealias SkillSummaryItem = SkillInfo

/// Response containing the list of available skills.
/// Wire type: `"skills_list_response"`
struct SkillsListResponseMessage: Decodable, Sendable {
    let skills: [SkillInfo]
}

/// Response containing the full body of a specific skill.
/// Wire type: `"skill_detail_response"`
struct SkillDetailResponseMessage: Decodable, Sendable {
    let skillId: String
    let body: String
    let error: String?
}

/// Push event: skill state changed. Wire type: "skills_state_changed"
struct SkillStateChangedMessage: Decodable, Sendable {
    let name: String
    let state: String  // "enabled" | "disabled" | "installed" | "uninstalled"
}

/// Push event: updates available. Wire type: "skills_updates_available"
struct SkillsUpdatesAvailableMessage: Decodable, Sendable {
    struct UpdateInfo: Decodable, Sendable {
        let name: String
        let installedVersion: String
        let latestVersion: String
    }
    let skills: [UpdateInfo]
}

/// A ClaWHub skill returned from a search or explore query.
struct ClawhubSkillItem: Decodable, Sendable, Identifiable {
    var id: String { slug }
    let name: String
    let slug: String
    let description: String
    let author: String
    let stars: Int
    let installs: Int
    let version: String
    /// Epoch milliseconds when the skill was first published.
    let createdAt: Int

    init(from decoder: Decoder) throws {
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
struct ClawhubSearchData: Decodable, Sendable {
    let skills: [ClawhubSkillItem]
}

/// Generic operation response. Wire type: "skills_operation_response"
struct SkillsOperationResponseMessage: Decodable, Sendable {
    let operation: String
    let success: Bool
    let error: String?
    let data: ClawhubSearchData?
}

/// Skill info from a ClaWHub inspect response.
struct ClawhubInspectSkill: Decodable, Sendable {
    let slug: String
    let displayName: String
    let summary: String
}

/// Owner info from a ClaWHub inspect response.
struct ClawhubInspectOwner: Decodable, Sendable {
    let handle: String
    let displayName: String
    let image: String?
}

/// Stats from a ClaWHub inspect response.
struct ClawhubInspectStats: Decodable, Sendable {
    let stars: Int
    let installs: Int
    let downloads: Int
    let versions: Int

    init(from decoder: Decoder) throws {
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
struct ClawhubInspectVersion: Decodable, Sendable {
    let version: String
    let changelog: String?
}

/// File entry from a ClaWHub inspect response.
struct ClawhubInspectFile: Decodable, Sendable {
    let path: String
    let size: Int
    let contentType: String?
}

/// Full inspect data for a ClaWHub skill.
struct ClawhubInspectData: Decodable, Sendable {
    let skill: ClawhubInspectSkill
    let owner: ClawhubInspectOwner?
    let stats: ClawhubInspectStats?
    let createdAt: Int?
    let updatedAt: Int?
    let latestVersion: ClawhubInspectVersion?
    let files: [ClawhubInspectFile]?
    let skillMdContent: String?
}

/// Response from inspecting a ClaWHub skill.
/// Wire type: "skills_inspect_response"
struct SkillsInspectResponseMessage: Decodable, Sendable {
    let slug: String
    let data: ClawhubInspectData?
    let error: String?
}

/// A single trust rule item returned from the daemon.
struct TrustRuleItem: Decodable, Sendable, Identifiable {
    let id: String
    let tool: String
    let pattern: String
    let scope: String
    let decision: String
    let priority: Int
    let createdAt: Double
}

/// Response containing all trust rules.
/// Wire type: `"trust_rules_list_response"`
struct TrustRulesListResponseMessage: Decodable, Sendable {
    let rules: [TrustRuleItem]
}

/// A single app item returned from the daemon.
struct AppItem: Decodable, Sendable, Identifiable {
    let id: String
    let name: String
    let description: String?
    let icon: String?
    let createdAt: Int
}

/// Response containing the list of all apps.
/// Wire type: `"apps_list_response"`
struct AppsListResponseMessage: Decodable, Sendable {
    let apps: [AppItem]
}

/// A single shared app item returned from the daemon.
struct SharedAppItem: Decodable, Sendable, Identifiable {
    var id: String { uuid }
    let uuid: String
    let name: String
    let description: String?
    let icon: String?
    let entry: String
    let trustTier: String
    let signerDisplayName: String?
    let bundleSizeBytes: Int
    let installedAt: String
}

/// Response containing the list of shared apps.
/// Wire type: `"shared_apps_list_response"`
struct SharedAppsListResponseMessage: Decodable, Sendable {
    let apps: [SharedAppItem]
}

/// Response from deleting a shared app.
/// Wire type: `"shared_app_delete_response"`
struct SharedAppDeleteResponseMessage: Decodable, Sendable {
    let success: Bool
}

/// Response from bundling an app.
/// Wire type: `"bundle_app_response"`
struct BundleAppResponseMessage: Decodable, Sendable {
    let bundlePath: String
}

/// Request from daemon to sign a bundle payload.
/// Wire type: `"sign_bundle_payload"`
struct SignBundlePayloadMessage: Decodable, Sendable {
    let payload: String
}

/// Timer completed notification from daemon.
/// Wire type: `"timer_completed"`
struct TimerCompletedMessage: Decodable, Sendable {
    let sessionId: String
    let timerId: String
    let label: String
    let durationMinutes: Double
}

/// Tool execution started.
/// Wire type: `"tool_use_start"`
struct ToolUseStartMessage: Decodable, Sendable {
    let toolName: String
    let input: [String: AnyCodable]
    let sessionId: String?
}

/// Streaming tool output chunk.
/// Wire type: `"tool_output_chunk"`
struct ToolOutputChunkMessage: Decodable, Sendable {
    let chunk: String
}

/// Tool execution completed.
/// Wire type: `"tool_result"`
struct ToolResultMessage: Decodable, Sendable {
    let toolName: String
    let result: String
    let isError: Bool?
    let diff: ConfirmationRequestMessage.ConfirmationDiffInfo?
    let status: String?
    let sessionId: String?
}

/// Follow-up suggestion response from daemon.
/// Wire type: `"suggestion_response"`
struct SuggestionResponseMessage: Decodable, Sendable {
    let requestId: String
    let suggestion: String?
    let source: String
}

/// Permission confirmation request from daemon.
/// Wire type: `"confirmation_request"`
struct ConfirmationRequestMessage: Decodable, Sendable {
    let requestId: String
    let toolName: String
    let input: [String: AnyCodable]
    let riskLevel: String
    let allowlistOptions: [ConfirmationAllowlistOption]
    let scopeOptions: [ConfirmationScopeOption]
    let diff: ConfirmationDiffInfo?
    let sandboxed: Bool?
    let sessionId: String?

    struct ConfirmationAllowlistOption: Decodable, Sendable, Equatable {
        let label: String
        let description: String?
        let pattern: String
    }
    struct ConfirmationScopeOption: Decodable, Sendable, Equatable {
        let label: String
        let scope: String
    }
    struct ConfirmationDiffInfo: Decodable, Sendable, Equatable {
        let filePath: String
        let oldContent: String
        let newContent: String
        let isNewFile: Bool
    }
}

/// Request a follow-up suggestion for the current session.
/// Wire type: `"suggestion_request"`
struct SuggestionRequestMessage: Encodable, Sendable {
    let type: String = "suggestion_request"
    let sessionId: String
    let requestId: String
}

/// Client response to a permission confirmation request.
/// Wire type: `"confirmation_response"`
struct ConfirmationResponseMessage: Encodable, Sendable {
    let type: String = "confirmation_response"
    let requestId: String
    let decision: String
    let selectedPattern: String?
    let selectedScope: String?
}

/// Sent to add a trust rule (allowlist/denylist) independently of a confirmation response.
/// Wire type: `"add_trust_rule"`
struct AddTrustRuleMessage: Encodable, Sendable {
    let type: String = "add_trust_rule"
    let toolName: String
    let pattern: String
    let scope: String
    let decision: String
}

/// Request all trust rules from the daemon.
/// Wire type: `"trust_rules_list"`
struct TrustRulesListMessage: Encodable, Sendable {
    let type: String = "trust_rules_list"
}

/// Remove a trust rule by its ID.
/// Wire type: `"remove_trust_rule"`
struct RemoveTrustRuleMessage: Encodable, Sendable {
    let type: String = "remove_trust_rule"
    let id: String
}

/// Update fields on an existing trust rule.
/// Wire type: `"update_trust_rule"`
struct UpdateTrustRuleMessage: Encodable, Sendable {
    let type: String = "update_trust_rule"
    let id: String
    let tool: String?
    let pattern: String?
    let scope: String?
    let decision: String?
    let priority: Int?
}

/// Response from opening and scanning a .vellumapp bundle.
/// Wire type: `"open_bundle_response"`
struct OpenBundleResponseMessage: Decodable, Sendable {
    struct Manifest: Decodable, Sendable {
        let formatVersion: Int
        let name: String
        let description: String?
        let icon: String?
        let createdAt: String
        let createdBy: String
        let entry: String
        let capabilities: [String]

        private enum CodingKeys: String, CodingKey {
            case formatVersion = "format_version"
            case name, description, icon
            case createdAt = "created_at"
            case createdBy = "created_by"
            case entry, capabilities
        }
    }
    struct ScanResult: Decodable, Sendable {
        let passed: Bool
        let blocked: [String]
        let warnings: [String]
    }
    struct SignatureResult: Decodable, Sendable {
        let trustTier: String
        let signerKeyId: String?
        let signerDisplayName: String?
        let signerAccount: String?
    }
    let manifest: Manifest
    let scanResult: ScanResult
    let signatureResult: SignatureResult
    let bundleSizeBytes: Int
}

/// Discriminated union of all server → client message types relevant to the macOS client.
/// Decodes via the `"type"` field in the JSON payload.
enum ServerMessage: Decodable, Sendable {
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
    case appsListResponse(AppsListResponseMessage)
    case sharedAppsListResponse(SharedAppsListResponseMessage)
    case sharedAppDeleteResponse(SharedAppDeleteResponseMessage)
    case bundleAppResponse(BundleAppResponseMessage)
    case openBundleResponse(OpenBundleResponseMessage)
    case signBundlePayload(SignBundlePayloadMessage)
    case getSigningIdentity
    case pong
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
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
        case "apps_list_response":
            let message = try AppsListResponseMessage(from: decoder)
            self = .appsListResponse(message)
        case "shared_apps_list_response":
            let message = try SharedAppsListResponseMessage(from: decoder)
            self = .sharedAppsListResponse(message)
        case "shared_app_delete_response":
            let message = try SharedAppDeleteResponseMessage(from: decoder)
            self = .sharedAppDeleteResponse(message)
        case "bundle_app_response":
            let message = try BundleAppResponseMessage(from: decoder)
            self = .bundleAppResponse(message)
        case "open_bundle_response":
            let message = try OpenBundleResponseMessage(from: decoder)
            self = .openBundleResponse(message)
        case "sign_bundle_payload":
            let message = try SignBundlePayloadMessage(from: decoder)
            self = .signBundlePayload(message)
        case "get_signing_identity":
            self = .getSigningIdentity
        case "pong":
            self = .pong
        default:
            self = .unknown(type)
        }
    }
}
