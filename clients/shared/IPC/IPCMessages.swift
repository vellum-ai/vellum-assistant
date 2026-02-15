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

/// Attachment payload sent inline as base64.
/// Backed by generated `IPCUserMessageAttachment`.
public typealias IPCAttachment = IPCUserMessageAttachment

extension IPCUserMessageAttachment {
    public init(filename: String, mimeType: String, data: String, extractedText: String?) {
        self.init(id: nil, filename: filename, mimeType: mimeType, data: data, extractedText: extractedText)
    }
}

/// Sent to create a new computer-use session.
/// Backed by generated `IPCCuSessionCreate`.
public typealias CuSessionCreateMessage = IPCCuSessionCreate

extension IPCCuSessionCreate {
    public init(sessionId: String, task: String, screenWidth: Int, screenHeight: Int, attachments: [IPCAttachment]?, interactionType: String?) {
        self.init(type: "cu_session_create", sessionId: sessionId, task: task, screenWidth: screenWidth, screenHeight: screenHeight, attachments: attachments, interactionType: interactionType)
    }
}

/// Sent after each perceive step with AX tree, screenshot, and execution results.
/// Backed by generated `IPCCuObservation`.
public typealias CuObservationMessage = IPCCuObservation

extension IPCCuObservation {
    public init(sessionId: String, axTree: String?, axDiff: String?, secondaryWindows: String?, screenshot: String?, executionResult: String?, executionError: String?) {
        self.init(type: "cu_observation", sessionId: sessionId, axTree: axTree, axDiff: axDiff, secondaryWindows: secondaryWindows, screenshot: screenshot, executionResult: executionResult, executionError: executionError)
    }
}

/// Sent by the ambient agent with OCR text from periodic screen captures.
/// Backed by generated `IPCAmbientObservation`.
public typealias AmbientObservationMessage = IPCAmbientObservation

extension IPCAmbientObservation {
    public init(requestId: String, ocrText: String, appName: String?, windowTitle: String?, timestamp: Double) {
        self.init(type: "ambient_observation", requestId: requestId, ocrText: ocrText, appName: appName, windowTitle: windowTitle, timestamp: timestamp)
    }
}

/// Sent to create a new Q&A session.
/// Backed by generated `IPCSessionCreateRequest`.
public typealias SessionCreateMessage = IPCSessionCreateRequest

extension IPCSessionCreateRequest {
    public init(title: String?, systemPromptOverride: String? = nil, maxResponseTokens: Int? = nil, correlationId: String? = nil) {
        self.init(type: "session_create", title: title, systemPromptOverride: systemPromptOverride, maxResponseTokens: maxResponseTokens, correlationId: correlationId)
    }
}

/// Sent to add a user message to an existing Q&A session.
/// Backed by generated `IPCUserMessage`.
public typealias UserMessageMessage = IPCUserMessage

extension IPCUserMessage {
    public init(sessionId: String, content: String, attachments: [IPCAttachment]?) {
        self.init(type: "user_message", sessionId: sessionId, content: content, attachments: attachments)
    }
}

/// Sent to request daemon-side classification and session creation.
/// Backed by generated `IPCTaskSubmit`.
public typealias TaskSubmitMessage = IPCTaskSubmit

extension IPCTaskSubmit {
    public init(task: String, screenWidth: Int, screenHeight: Int, attachments: [IPCAttachment]?, source: String?) {
        self.init(type: "task_submit", task: task, screenWidth: screenWidth, screenHeight: screenHeight, attachments: attachments, source: source)
    }
}

/// Sent to cancel the active generation.
/// Backed by generated `IPCCancelRequest`.
public typealias CancelMessage = IPCCancelRequest

extension IPCCancelRequest {
    public init(sessionId: String) {
        self.init(type: "cancel", sessionId: sessionId)
    }
}

/// Sent to abort a running computer-use session.
/// Backed by generated `IPCCuSessionAbort`.
public typealias CuSessionAbortMessage = IPCCuSessionAbort

extension IPCCuSessionAbort {
    public init(sessionId: String) {
        self.init(type: "cu_session_abort", sessionId: sessionId)
    }
}

/// Keepalive ping.
/// Backed by generated `IPCPingMessage`.
public typealias PingMessage = IPCPingMessage

extension IPCPingMessage {
    public init() {
        self.init(type: "ping")
    }
}

/// Sent when user interacts with a surface.
/// Backed by generated `IPCUiSurfaceAction`.
public typealias UiSurfaceActionMessage = IPCUiSurfaceAction

extension IPCUiSurfaceAction {
    public init(sessionId: String, surfaceId: String, actionId: String, data: [String: AnyCodable]?) {
        self.init(type: "ui_surface_action", sessionId: sessionId, surfaceId: surfaceId, actionId: actionId, data: data)
    }
}

/// Sent when a persistent app's JS makes a data request via the RPC bridge.
/// Backed by generated `IPCAppDataRequest`.
public typealias AppDataRequestMessage = IPCAppDataRequest

extension IPCAppDataRequest {
    public init(surfaceId: String, callId: String, method: String, appId: String, recordId: String?, data: [String: AnyCodable]?) {
        self.init(type: "app_data_request", surfaceId: surfaceId, callId: callId, method: method, appId: appId, recordId: recordId, data: data)
    }
}

/// Sent to request opening an app by ID.
/// Backed by generated `IPCAppOpenRequest`.
public typealias AppOpenRequestMessage = IPCAppOpenRequest

extension IPCAppOpenRequest {
    public init(appId: String) {
        self.init(type: "app_open_request", appId: appId)
    }
}

/// Sent to request the list of all apps.
/// Backed by generated `IPCAppsListRequest`.
public typealias AppsListRequestMessage = IPCAppsListRequest

extension IPCAppsListRequest {
    public init() {
        self.init(type: "apps_list")
    }
}

/// Sent to request the list of shared/received apps.
/// Backed by generated `IPCSharedAppsListRequest`.
public typealias SharedAppsListRequestMessage = IPCSharedAppsListRequest

extension IPCSharedAppsListRequest {
    public init() {
        self.init(type: "shared_apps_list")
    }
}

/// Sent to delete a shared app by UUID.
/// Backed by generated `IPCSharedAppDeleteRequest`.
public typealias SharedAppDeleteRequestMessage = IPCSharedAppDeleteRequest

extension IPCSharedAppDeleteRequest {
    public init(uuid: String) {
        self.init(type: "shared_app_delete", uuid: uuid)
    }
}

/// Sent to request bundling an app for sharing.
/// Backed by generated `IPCBundleAppRequest`.
public typealias BundleAppRequestMessage = IPCBundleAppRequest

extension IPCBundleAppRequest {
    public init(appId: String) {
        self.init(type: "bundle_app", appId: appId)
    }
}

/// Sent to open and scan a .vellumapp bundle.
/// Backed by generated `IPCOpenBundleRequest`.
public typealias OpenBundleMessage = IPCOpenBundleRequest

extension IPCOpenBundleRequest {
    public init(filePath: String) {
        self.init(type: "open_bundle", filePath: filePath)
    }
}

/// Sent to request the list of all past sessions/conversations.
/// Backed by generated `IPCSessionListRequest`.
public typealias SessionListRequestMessage = IPCSessionListRequest

extension IPCSessionListRequest {
    public init() {
        self.init(type: "session_list")
    }
}

/// Sent to regenerate the last assistant response.
/// Backed by generated `IPCRegenerateRequest`.
public typealias RegenerateMessage = IPCRegenerateRequest

extension IPCRegenerateRequest {
    public init(sessionId: String) {
        self.init(type: "regenerate", sessionId: sessionId)
    }
}

/// Sent to request message history for a specific session.
/// Backed by generated `IPCHistoryRequest`.
public typealias HistoryRequestMessage = IPCHistoryRequest

extension IPCHistoryRequest {
    public init(sessionId: String) {
        self.init(type: "history_request", sessionId: sessionId)
    }
}

/// Sent to request the list of available skills.
/// Backed by generated `IPCSkillsListRequest`.
public typealias SkillsListRequestMessage = IPCSkillsListRequest

extension IPCSkillsListRequest {
    public init() {
        self.init(type: "skills_list")
    }
}

/// Sent to request the full body of a specific skill.
/// Backed by generated `IPCSkillDetailRequest`.
public typealias SkillDetailRequestMessage = IPCSkillDetailRequest

extension IPCSkillDetailRequest {
    public init(skillId: String) {
        self.init(type: "skill_detail", skillId: skillId)
    }
}

/// Enable a skill.
/// Backed by generated `IPCSkillsEnableRequest`.
public typealias SkillsEnableMessage = IPCSkillsEnableRequest

extension IPCSkillsEnableRequest {
    public init(name: String) {
        self.init(type: "skills_enable", name: name)
    }
}

/// Disable a skill.
/// Backed by generated `IPCSkillsDisableRequest`.
public typealias SkillsDisableMessage = IPCSkillsDisableRequest

extension IPCSkillsDisableRequest {
    public init(name: String) {
        self.init(type: "skills_disable", name: name)
    }
}

/// Configure a skill's env/apiKey/config.
/// Backed by generated `IPCSkillsConfigureRequest`.
public typealias SkillsConfigureMessage = IPCSkillsConfigureRequest

extension IPCSkillsConfigureRequest {
    public init(name: String, env: [String: String]? = nil, apiKey: String? = nil, config: [String: AnyCodable]? = nil) {
        self.init(type: "skills_configure", name: name, env: env, apiKey: apiKey, config: config)
    }
}

/// Install a skill from ClaWHub.
/// Backed by generated `IPCSkillsInstallRequest`.
public typealias SkillsInstallMessage = IPCSkillsInstallRequest

extension IPCSkillsInstallRequest {
    public init(slug: String, version: String? = nil) {
        self.init(type: "skills_install", slug: slug, version: version)
    }
}

/// Uninstall a skill.
/// Backed by generated `IPCSkillsUninstallRequest`.
public typealias SkillsUninstallMessage = IPCSkillsUninstallRequest

extension IPCSkillsUninstallRequest {
    public init(name: String) {
        self.init(type: "skills_uninstall", name: name)
    }
}

/// Update a skill.
/// Backed by generated `IPCSkillsUpdateRequest`.
public typealias SkillsUpdateMessage = IPCSkillsUpdateRequest

extension IPCSkillsUpdateRequest {
    public init(name: String) {
        self.init(type: "skills_update", name: name)
    }
}

/// Check for skill updates.
/// Backed by generated `IPCSkillsCheckUpdatesRequest`.
public typealias SkillsCheckUpdatesMessage = IPCSkillsCheckUpdatesRequest

extension IPCSkillsCheckUpdatesRequest {
    public init() {
        self.init(type: "skills_check_updates")
    }
}

/// Search for skills on ClaWHub.
/// Backed by generated `IPCSkillsSearchRequest`.
public typealias SkillsSearchMessage = IPCSkillsSearchRequest

extension IPCSkillsSearchRequest {
    public init(query: String) {
        self.init(type: "skills_search", query: query)
    }
}

/// Inspect a ClaWHub skill for detailed info.
/// Backed by generated `IPCSkillsInspectRequest`.
public typealias SkillsInspectMessage = IPCSkillsInspectRequest

extension IPCSkillsInspectRequest {
    public init(slug: String) {
        self.init(type: "skills_inspect", slug: slug)
    }
}

/// Response to a sign_bundle_payload request from the daemon.
/// Backed by generated `IPCSignBundlePayloadResponse`.
public typealias SignBundlePayloadResponseMessage = IPCSignBundlePayloadResponse

extension IPCSignBundlePayloadResponse {
    public init(signature: String, keyId: String, publicKey: String) {
        self.init(type: "sign_bundle_payload_response", signature: signature, keyId: keyId, publicKey: publicKey)
    }
}

/// Response to a get_signing_identity request from the daemon.
/// Backed by generated `IPCGetSigningIdentityResponse`.
public typealias GetSigningIdentityResponseMessage = IPCGetSigningIdentityResponse

extension IPCGetSigningIdentityResponse {
    public init(keyId: String, publicKey: String) {
        self.init(type: "get_signing_identity_response", keyId: keyId, publicKey: publicKey)
    }
}

// MARK: - Server → Client Messages (Decodable)
//
// These typealiases point to the auto-generated IPC types in
// IPCContractGenerated.swift. Convenience inits preserve backward
// compatibility with existing call sites (the generated structs
// include a `type` field that the old hand-maintained types omitted).

/// Action to execute from the inference server.
public typealias CuActionMessage = IPCCuAction

extension IPCCuAction {
    public init(sessionId: String, toolName: String, input: [String: AnyCodable], reasoning: String?, stepNumber: Int) {
        self.init(type: "cu_action", sessionId: sessionId, toolName: toolName, input: input, reasoning: reasoning, stepNumber: stepNumber)
    }
}

/// Session completed successfully.
public typealias CuCompleteMessage = IPCCuComplete

extension IPCCuComplete {
    public init(sessionId: String, summary: String, stepCount: Int, isResponse: Bool?) {
        self.init(type: "cu_complete", sessionId: sessionId, summary: summary, stepCount: stepCount, isResponse: isResponse)
    }
}

/// Session-level error from the server.
public typealias CuErrorMessage = IPCCuError

extension IPCCuError {
    public init(sessionId: String, message: String) {
        self.init(type: "cu_error", sessionId: sessionId, message: message)
    }
}

/// Streamed text delta from the assistant's response.
/// Backed by generated `IPCAssistantTextDelta`.
public typealias AssistantTextDeltaMessage = IPCAssistantTextDelta

extension IPCAssistantTextDelta {
    public init(text: String, sessionId: String? = nil) {
        self.init(type: "assistant_text_delta", text: text, sessionId: sessionId)
    }
}

/// Streamed thinking delta from the assistant's reasoning.
public typealias AssistantThinkingDeltaMessage = IPCAssistantThinkingDelta

extension IPCAssistantThinkingDelta {
    public init(thinking: String) {
        self.init(type: "assistant_thinking_delta", thinking: thinking)
    }
}

/// Signals that the assistant's message is complete.
/// Backed by generated `IPCMessageComplete`.
public typealias MessageCompleteMessage = IPCMessageComplete

extension IPCMessageComplete {
    public init(sessionId: String? = nil) {
        self.init(type: "message_complete", sessionId: sessionId)
    }
}

/// Session metadata from the server (e.g. generated title).
/// Backed by generated `IPCSessionInfo`.
public typealias SessionInfoMessage = IPCSessionInfo

extension IPCSessionInfo {
    public init(sessionId: String, title: String, correlationId: String? = nil) {
        self.init(type: "session_info", sessionId: sessionId, title: title, correlationId: correlationId)
    }
}

/// Daemon response after classifying and routing a task_submit.
public typealias TaskRoutedMessage = IPCTaskRouted

/// Result from ambient observation analysis.
public typealias AmbientResultMessage = IPCAmbientResult

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

    public init(sessionId: String, surfaceId: String, surfaceType: String, title: String?, data: AnyCodable, actions: [SurfaceActionData]?, display: String?) {
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.surfaceType = surfaceType
        self.title = title
        self.data = data
        self.actions = actions
        self.display = display
    }
}

/// Surface action button data.
/// Backed by generated `IPCSurfaceAction`.
public typealias SurfaceActionData = IPCSurfaceAction

/// Surface update command from daemon.
/// Wire type: `"ui_surface_update"`
public struct UiSurfaceUpdateMessage: Decodable, Sendable {
    public let sessionId: String
    public let surfaceId: String
    public let data: AnyCodable
}

/// Surface dismiss command from daemon.
/// Backed by generated `IPCUiSurfaceDismiss`.
public typealias UiSurfaceDismissMessage = IPCUiSurfaceDismiss

/// Confirms undo/regenerate removed messages.
public typealias UndoCompleteMessage = IPCUndoComplete

/// Confirms generation was cancelled.
/// Kept hand-maintained — the Swift type includes `sessionId` for session
/// filtering, which the TS contract does not define for this message type.
public struct GenerationCancelledMessage: Decodable, Sendable {
    public let sessionId: String?

    public init(sessionId: String?) {
        self.sessionId = sessionId
    }
}

/// Notifies client that active generation yielded to queued work at a checkpoint.
/// Backed by generated `IPCGenerationHandoff`.
public typealias GenerationHandoffMessage = IPCGenerationHandoff

extension IPCGenerationHandoff {
    public init(sessionId: String, requestId: String?, queuedCount: Int) {
        self.init(type: "generation_handoff", sessionId: sessionId, requestId: requestId, queuedCount: queuedCount)
    }
}

/// Notifies client that a message has been queued for processing.
/// Backed by generated `IPCMessageQueued`.
public typealias MessageQueuedMessage = IPCMessageQueued

extension IPCMessageQueued {
    public init(sessionId: String, requestId: String, position: Int) {
        self.init(type: "message_queued", sessionId: sessionId, requestId: requestId, position: position)
    }
}

/// Notifies client that a queued message has been dequeued and is now being processed.
/// Backed by generated `IPCMessageDequeued`.
public typealias MessageDequeuedMessage = IPCMessageDequeued

extension IPCMessageDequeued {
    public init(sessionId: String, requestId: String) {
        self.init(type: "message_dequeued", sessionId: sessionId, requestId: requestId)
    }
}

/// Server-level error message.
/// Backed by generated `IPCErrorMessage`.
public typealias ErrorMessage = IPCErrorMessage

extension IPCErrorMessage {
    public init(message: String) {
        self.init(type: "error", message: message)
    }
}

/// Response from the daemon for a persistent app data request.
/// Backed by generated `IPCAppDataResponse`.
public typealias AppDataResponseMessage = IPCAppDataResponse

/// ClaWHub metadata for a skill.
/// Backed by generated `IPCSkillsListResponseSkillClawhub`.
public typealias ClawhubInfo = IPCSkillsListResponseSkillClawhub

/// Missing requirements preventing a skill from full operation.
/// Backed by generated `IPCSkillsListResponseSkillMissingRequirements`.
public typealias MissingRequirements = IPCSkillsListResponseSkillMissingRequirements

/// Full skill info from the daemon's resolved skill list.
/// Backed by generated `IPCSkillsListResponseSkill`.
public typealias SkillInfo = IPCSkillsListResponseSkill

extension IPCSkillsListResponseSkill: Identifiable {}

extension IPCSkillsListResponseSkill {
    /// Backward-compatible init that defaults `id` to `name`.
    public init(name: String, description: String, emoji: String?, homepage: String?, source: String, state: String, degraded: Bool, missingRequirements: IPCSkillsListResponseSkillMissingRequirements?, installedVersion: String?, latestVersion: String?, updateAvailable: Bool, userInvocable: Bool, clawhub: IPCSkillsListResponseSkillClawhub?) {
        self.init(id: name, name: name, description: description, emoji: emoji, homepage: homepage, source: source, state: state, degraded: degraded, missingRequirements: missingRequirements, installedVersion: installedVersion, latestVersion: latestVersion, updateAvailable: updateAvailable, userInvocable: userInvocable, clawhub: clawhub)
    }
}

/// Backward-compatible alias for code referencing the old name.
public typealias SkillSummaryItem = SkillInfo

/// Response containing the list of available skills.
/// Backed by generated `IPCSkillsListResponse`.
public typealias SkillsListResponseMessage = IPCSkillsListResponse

/// Response containing the full body of a specific skill.
/// Backed by generated `IPCSkillDetailResponse`.
public typealias SkillDetailResponseMessage = IPCSkillDetailResponse

/// Push event: skill state changed.
/// Backed by generated `IPCSkillStateChanged`.
public typealias SkillStateChangedMessage = IPCSkillStateChanged

/// A ClaWHub skill returned from a search or explore query.
/// Kept hand-maintained — this type is decoded from the `data` field of
/// `skills_operation_response` (which is `AnyCodable` in the contract).
public struct ClawhubSkillItem: Decodable, Sendable, Identifiable, Equatable {
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

/// Generic operation response.
/// Kept hand-maintained — the `data` field is typed as `ClawhubSearchData?`
/// for search results, while the generated type uses `AnyCodable?`.
public struct SkillsOperationResponseMessage: Decodable, Sendable {
    public let operation: String
    public let success: Bool
    public let error: String?
    public let data: ClawhubSearchData?
}

/// Skill info from a ClaWHub inspect response.
/// Backed by generated `IPCSkillsInspectResponseDataSkill`.
public typealias ClawhubInspectSkill = IPCSkillsInspectResponseDataSkill

/// Owner info from a ClaWHub inspect response.
/// Backed by generated `IPCSkillsInspectResponseDataOwner`.
public typealias ClawhubInspectOwner = IPCSkillsInspectResponseDataOwner

/// Stats from a ClaWHub inspect response.
/// Backed by generated `IPCSkillsInspectResponseDataStats`.
public typealias ClawhubInspectStats = IPCSkillsInspectResponseDataStats

// The server may omit stats fields for newly created skills,
// so we default missing values to 0 instead of crashing.
extension IPCSkillsInspectResponseDataStats {
    enum CodingKeys: String, CodingKey {
        case stars, installs, downloads, versions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            stars: try container.decodeIfPresent(Int.self, forKey: .stars) ?? 0,
            installs: try container.decodeIfPresent(Int.self, forKey: .installs) ?? 0,
            downloads: try container.decodeIfPresent(Int.self, forKey: .downloads) ?? 0,
            versions: try container.decodeIfPresent(Int.self, forKey: .versions) ?? 0
        )
    }
}

/// Version info from a ClaWHub inspect response.
/// Backed by generated `IPCSkillsInspectResponseDataLatestVersion`.
public typealias ClawhubInspectVersion = IPCSkillsInspectResponseDataLatestVersion

/// File entry from a ClaWHub inspect response.
/// Backed by generated `IPCSkillsInspectResponseDataFile`.
public typealias ClawhubInspectFile = IPCSkillsInspectResponseDataFile

/// Full inspect data for a ClaWHub skill.
/// Backed by generated `IPCSkillsInspectResponseData`.
public typealias ClawhubInspectData = IPCSkillsInspectResponseData

// Backward-compatible typed accessors. The generated struct now uses
// concrete types (Int?, String?) instead of AnyCodable?, so these are
// simple pass-throughs for existing call sites.
extension IPCSkillsInspectResponseData {
    public var createdAtInt: Int? { createdAt }
    public var updatedAtInt: Int? { updatedAt }
    public var skillMdContentString: String? { skillMdContent }
}

/// Response from inspecting a ClaWHub skill.
/// Backed by generated `IPCSkillsInspectResponse`.
public typealias SkillsInspectResponseMessage = IPCSkillsInspectResponse

/// Response containing the list of past sessions.
/// Backed by generated `IPCSessionListResponse`.
public typealias SessionListResponseMessage = IPCSessionListResponse

/// Response containing message history for a session.
/// Backed by generated `IPCHistoryResponse`.
public typealias HistoryResponseMessage = IPCHistoryResponse

extension IPCHistoryResponse {
    /// Backward-compatible alias for the nested message item type.
    public typealias HistoryMessageItem = IPCHistoryResponseMessage
    /// Backward-compatible alias for the nested tool call type.
    public typealias HistoryToolCallItem = IPCHistoryResponseToolCall
}

/// A single trust rule item returned from the daemon.
/// Backed by generated `IPCTrustRulesListResponseRule`.
public typealias TrustRuleItem = IPCTrustRulesListResponseRule

extension IPCTrustRulesListResponseRule: Identifiable {}

/// Response containing all trust rules.
/// Backed by generated `IPCTrustRulesListResponse`.
public typealias TrustRulesListResponseMessage = IPCTrustRulesListResponse

/// A single app item returned from the daemon.
/// Backed by generated `IPCAppsListResponseApp`.
public typealias AppItem = IPCAppsListResponseApp

extension IPCAppsListResponseApp: Identifiable {}

/// Response containing the list of all apps.
/// Backed by generated `IPCAppsListResponse`.
public typealias AppsListResponseMessage = IPCAppsListResponse

/// A single shared app item returned from the daemon.
/// Backed by generated `IPCSharedAppsListResponseApp`.
public typealias SharedAppItem = IPCSharedAppsListResponseApp

extension IPCSharedAppsListResponseApp: Identifiable {
    public var id: String { uuid }
}

/// Response containing the list of shared apps.
/// Backed by generated `IPCSharedAppsListResponse`.
public typealias SharedAppsListResponseMessage = IPCSharedAppsListResponse

/// Response from deleting a shared app.
/// Backed by generated `IPCSharedAppDeleteResponse`.
public typealias SharedAppDeleteResponseMessage = IPCSharedAppDeleteResponse

/// Response from bundling an app.
/// Backed by generated `IPCBundleAppResponse`.
public typealias BundleAppResponseMessage = IPCBundleAppResponse

/// Request from daemon to sign a bundle payload.
/// Backed by generated `IPCSignBundlePayloadRequest`.
public typealias SignBundlePayloadMessage = IPCSignBundlePayloadRequest

/// Real-time execution trace event from the daemon.
/// Wire type: `"trace_event"`
public struct TraceEventMessage: Decodable, Sendable {
    public let eventId: String
    public let sessionId: String
    public let requestId: String?
    public let timestampMs: Double
    public let sequence: Int
    public let kind: String
    public let status: String?
    public let summary: String
    public let attributes: [String: AnyCodable]?
}

/// Structured error codes for session-level errors.
public enum SessionErrorCode: String, CaseIterable, Codable, Sendable {
    case providerNetwork = "PROVIDER_NETWORK"
    case providerRateLimit = "PROVIDER_RATE_LIMIT"
    case providerApi = "PROVIDER_API"
    case queueFull = "QUEUE_FULL"
    case sessionAborted = "SESSION_ABORTED"
    case sessionProcessingFailed = "SESSION_PROCESSING_FAILED"
    case regenerateFailed = "REGENERATE_FAILED"
    case unknown = "UNKNOWN"

    /// Fall back to `.unknown` for unrecognized codes so that version skew
    /// between daemon and client never silently drops a session_error message.
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = SessionErrorCode(rawValue: rawValue) ?? .unknown
    }
}

/// Structured session-level error from the daemon.
/// Wire type: `"session_error"`
public struct SessionErrorMessage: Decodable, Sendable {
    public let sessionId: String
    public let code: SessionErrorCode
    public let userMessage: String
    public let retryable: Bool
    public let debugDetails: String?

    public init(sessionId: String, code: SessionErrorCode, userMessage: String, retryable: Bool, debugDetails: String? = nil) {
        self.sessionId = sessionId
        self.code = code
        self.userMessage = userMessage
        self.retryable = retryable
        self.debugDetails = debugDetails
    }
}

/// Timer completed notification from daemon.
/// Backed by generated `IPCTimerCompleted`.
public typealias TimerCompletedMessage = IPCTimerCompleted

/// Tool execution started.
/// Backed by generated `IPCToolUseStart`.
public typealias ToolUseStartMessage = IPCToolUseStart

/// Streaming tool output chunk.
/// Backed by generated `IPCToolOutputChunk`.
public typealias ToolOutputChunkMessage = IPCToolOutputChunk

/// Tool execution completed.
/// Backed by generated `IPCToolResult`.
public typealias ToolResultMessage = IPCToolResult

/// Follow-up suggestion response from daemon.
/// Backed by generated `IPCSuggestionResponse`.
public typealias SuggestionResponseMessage = IPCSuggestionResponse

/// Secret input request from daemon.
/// Backed by generated `IPCSecretRequest`.
public typealias SecretRequestMessage = IPCSecretRequest

/// Permission confirmation request from daemon.
/// Backed by generated `IPCConfirmationRequest`.
public typealias ConfirmationRequestMessage = IPCConfirmationRequest

// Backward-compatible nested type aliases so call sites like
// `ConfirmationRequestMessage.ConfirmationAllowlistOption` keep compiling.
extension IPCConfirmationRequest {
    public typealias ConfirmationAllowlistOption = IPCConfirmationRequestAllowlistOption
    public typealias ConfirmationScopeOption = IPCConfirmationRequestScopeOption
    public typealias ConfirmationDiffInfo = IPCConfirmationRequestDiff
}

// Equatable conformance for generated types used in SwiftUI previews and tests.
// Explicit `==` implementations because auto-synthesis requires conformance in the declaring file.
extension IPCConfirmationRequestAllowlistOption: Equatable {
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.label == rhs.label && lhs.description == rhs.description && lhs.pattern == rhs.pattern
    }
}
extension IPCConfirmationRequestScopeOption: Equatable {
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.label == rhs.label && lhs.scope == rhs.scope
    }
}
extension IPCConfirmationRequestDiff: Equatable {
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.filePath == rhs.filePath && lhs.oldContent == rhs.oldContent && lhs.newContent == rhs.newContent && lhs.isNewFile == rhs.isNewFile
    }
}


/// Request a follow-up suggestion for the current session.
/// Backed by generated `IPCSuggestionRequest`.
public typealias SuggestionRequestMessage = IPCSuggestionRequest

extension IPCSuggestionRequest {
    public init(sessionId: String, requestId: String) {
        self.init(type: "suggestion_request", sessionId: sessionId, requestId: requestId)
    }
}

/// Client response to a permission confirmation request.
/// Backed by generated `IPCConfirmationResponse`.
public typealias ConfirmationResponseMessage = IPCConfirmationResponse

extension IPCConfirmationResponse {
    public init(requestId: String, decision: String, selectedPattern: String? = nil, selectedScope: String? = nil) {
        self.init(type: "confirmation_response", requestId: requestId, decision: decision, selectedPattern: selectedPattern, selectedScope: selectedScope)
    }
}

/// Client response to a secret input request.
/// Backed by generated `IPCSecretResponse`.
public typealias SecretResponseMessage = IPCSecretResponse

extension IPCSecretResponse {
    public init(requestId: String, value: String?) {
        self.init(type: "secret_response", requestId: requestId, value: value)
    }
}

/// Sent to add a trust rule (allowlist/denylist) independently of a confirmation response.
/// Backed by generated `IPCAddTrustRule`.
public typealias AddTrustRuleMessage = IPCAddTrustRule

extension IPCAddTrustRule {
    public init(toolName: String, pattern: String, scope: String, decision: String) {
        self.init(type: "add_trust_rule", toolName: toolName, pattern: pattern, scope: scope, decision: decision)
    }
}

/// Request all trust rules from the daemon.
/// Backed by generated `IPCTrustRulesList`.
public typealias TrustRulesListMessage = IPCTrustRulesList

extension IPCTrustRulesList {
    public init() {
        self.init(type: "trust_rules_list")
    }
}

/// Remove a trust rule by its ID.
/// Backed by generated `IPCRemoveTrustRule`.
public typealias RemoveTrustRuleMessage = IPCRemoveTrustRule

extension IPCRemoveTrustRule {
    public init(id: String) {
        self.init(type: "remove_trust_rule", id: id)
    }
}

/// Update fields on an existing trust rule.
/// Backed by generated `IPCUpdateTrustRule`.
public typealias UpdateTrustRuleMessage = IPCUpdateTrustRule

extension IPCUpdateTrustRule {
    public init(id: String, tool: String? = nil, pattern: String? = nil, scope: String? = nil, decision: String? = nil, priority: Int? = nil) {
        self.init(type: "update_trust_rule", id: id, tool: tool, pattern: pattern, scope: scope, decision: decision, priority: priority)
    }
}

/// Response from opening and scanning a .vellumapp bundle.
/// Backed by generated `IPCOpenBundleResponse`.
public typealias OpenBundleResponseMessage = IPCOpenBundleResponse

// Backward-compatible nested type aliases so call sites like
// `OpenBundleResponseMessage.Manifest` keep compiling.
extension IPCOpenBundleResponse {
    public typealias Manifest = IPCOpenBundleResponseManifest
    public typealias ScanResult = IPCOpenBundleResponseScanResult
    public typealias SignatureResult = IPCOpenBundleResponseSignatureResult
}

// camelCase computed properties on the generated Manifest type so existing
// call sites (e.g. `manifest.formatVersion`, `manifest.createdAt`) keep working.
// The generated struct uses snake_case property names that match the wire format.
extension IPCOpenBundleResponseManifest {
    public var formatVersion: Int { format_version }
    public var createdAt: String { created_at }
    public var createdBy: String { created_by }
}


/// Discriminated union of all server → client message types relevant to the macOS client.
/// Decodes via the `"type"` field in the JSON payload.
public enum ServerMessage: Decodable, Sendable {
    case cuAction(CuActionMessage)
    case cuComplete(CuCompleteMessage)
    case cuError(CuErrorMessage)
    case sessionError(SessionErrorMessage)
    case assistantTextDelta(AssistantTextDeltaMessage)
    case assistantThinkingDelta(AssistantThinkingDeltaMessage)
    case messageComplete(MessageCompleteMessage)
    case sessionInfo(SessionInfoMessage)
    case sessionListResponse(SessionListResponseMessage)
    case historyResponse(HistoryResponseMessage)
    case taskRouted(TaskRoutedMessage)
    case error(ErrorMessage)
    case ambientResult(AmbientResultMessage)
    case uiSurfaceShow(UiSurfaceShowMessage)
    case uiSurfaceUpdate(UiSurfaceUpdateMessage)
    case uiSurfaceDismiss(UiSurfaceDismissMessage)
    case undoComplete(UndoCompleteMessage)
    case generationCancelled(GenerationCancelledMessage)
    case generationHandoff(GenerationHandoffMessage)
    case confirmationRequest(ConfirmationRequestMessage)
    case secretRequest(SecretRequestMessage)
    case appDataResponse(AppDataResponseMessage)
    case messageQueued(MessageQueuedMessage)
    case messageDequeued(MessageDequeuedMessage)
    case skillsListResponse(SkillsListResponseMessage)
    case skillDetailResponse(SkillDetailResponseMessage)
    case skillStateChanged(SkillStateChangedMessage)
    case skillsOperationResponse(SkillsOperationResponseMessage)
    case skillsInspectResponse(SkillsInspectResponseMessage)
    case suggestionResponse(SuggestionResponseMessage)
    case toolUseStart(ToolUseStartMessage)
    case toolOutputChunk(ToolOutputChunkMessage)
    case toolResult(ToolResultMessage)
    case timerCompleted(TimerCompletedMessage)
    case traceEvent(TraceEventMessage)
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
        case "session_error":
            let message = try SessionErrorMessage(from: decoder)
            self = .sessionError(message)
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
        case "session_list_response":
            let message = try SessionListResponseMessage(from: decoder)
            self = .sessionListResponse(message)
        case "history_response":
            let message = try HistoryResponseMessage(from: decoder)
            self = .historyResponse(message)
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
        case "undo_complete":
            let message = try UndoCompleteMessage(from: decoder)
            self = .undoComplete(message)
        case "generation_cancelled":
            let message = try GenerationCancelledMessage(from: decoder)
            self = .generationCancelled(message)
        case "generation_handoff":
            let message = try GenerationHandoffMessage(from: decoder)
            self = .generationHandoff(message)
        case "confirmation_request":
            let message = try ConfirmationRequestMessage(from: decoder)
            self = .confirmationRequest(message)
        case "secret_request":
            let message = try SecretRequestMessage(from: decoder)
            self = .secretRequest(message)
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
        case "trace_event":
            let message = try TraceEventMessage(from: decoder)
            self = .traceEvent(message)
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
