import Foundation

// MARK: - Manual Type Allowlist
//
// Most message types are auto-generated from the TS contract into
// GeneratedAPITypes.swift and referenced here via typealiases.
// The following structs are **intentionally** hand-maintained because
// the code generator cannot express their requirements:
//
// ┌─────────────────────────────────┬──────────────────────────────────────────┐
// │ Type                            │ Reason                                   │
// ├─────────────────────────────────┼──────────────────────────────────────────┤
// │ AnyCodable                      │ Infrastructure — not a message type      │
// │ UiSurfaceShowMessage            │ Uses AnyCodable for `data` field and     │
// │                                 │ custom SurfaceActionData array; the      │
// │                                 │ contract type is skipped (SKIP_TYPES)    │
// │ UiSurfaceUpdateMessage          │ Uses AnyCodable for `data` field;        │
// │                                 │ contract type is skipped (SKIP_TYPES)    │
// │ GenerationCancelledMessage      │ Swift adds `sessionId` for session       │
// │                                 │ filtering not present in the contract    │
// │ ClawhubSkillItem                │ Decoded from nested `data` field of      │
// │                                 │ skills_operation_response, not a direct  │
// │                                 │ wire message                             │
// │ ClawhubSearchData               │ Wrapper for ClawhubSkillItem array,      │
// │                                 │ not a direct wire message                │
// │ SkillsOperationResponseMessage  │ Uses typed ClawhubSearchData? for `data` │
// │                                 │ instead of generated AnyCodable?         │
// │ TraceEventMessage               │ References hand-maintained TraceEventKind│
// │                                 │ via string `kind`; contract type skipped │
// │ SessionErrorMessage             │ References hand-maintained               │
// │                                 │ SessionErrorCode enum                    │
// │ SessionErrorCode (enum)         │ String enum with fallback decoding;      │
// │                                 │ code generator cannot emit Swift enums   │
// │ ServerMessage (enum)            │ Discriminated union with custom          │
// │                                 │ Decodable init; always hand-maintained   │
// │ UiSurfaceCompleteMessage        │ Uses AnyCodable for `submittedData`;     │
// │                                 │ contract type is skipped (SKIP_TYPES)    │
// │ UiLayoutConfigMessage           │ Temporary; canonical home is             │
// │                                 │ LayoutConfig.swift (M1 / #2973)         │
// │ SlotConfigWire                  │ Temporary; canonical home is             │
// │                                 │ LayoutConfig.swift (M1 / #2973)         │
// │ SlotContentWire                 │ Temporary; canonical home is             │
// │                                 │ LayoutConfig.swift (M1 / #2973)         │
// │                                 │ surface frame updates; not yet in       │
// │                                 │ generated contract                      │
// │ SubagentEventMessage            │ Contains recursive ServerMessage ref;   │
// │                                 │ codegen skips ServerMessage              │
// │ HostCuRequest                   │ Uses AnyCodable for `input` field;      │
// │                                 │ code generator cannot express it        │
// │ HostCuResultPayload             │ Posted back to daemon; hand-maintained  │
// │                                 │ alongside HostCuRequest                 │
// └─────────────────────────────────┴──────────────────────────────────────────┘
//
// **Do not add new manual structs** without documenting the reason here.
// If the code generator gains support for a case above, migrate the type
// to a typealias and remove it from this list.

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
/// Backed by generated `UserMessageAttachment`.
public typealias Attachment = UserMessageAttachment

extension UserMessageAttachment {
    public init(filename: String, mimeType: String, data: String, extractedText: String?) {
        self.init(id: nil, filename: filename, mimeType: mimeType, data: data, extractedText: extractedText, sizeBytes: nil, thumbnailData: nil)
    }
}

/// Sent by the watch agent with OCR text from periodic screen captures.
/// Backed by generated `WatchObservation`.
public typealias WatchObservationMessage = WatchObservation

extension WatchObservation {
    public init(watchId: String, sessionId: String, ocrText: String, appName: String?, windowTitle: String?, bundleIdentifier: String?, timestamp: Double, captureIndex: Int, totalExpected: Int) {
        self.init(type: "watch_observation", watchId: watchId, sessionId: sessionId, ocrText: ocrText, appName: appName, windowTitle: windowTitle, bundleIdentifier: bundleIdentifier, timestamp: timestamp, captureIndex: captureIndex, totalExpected: totalExpected)
    }
}

/// Sent to create a new Q&A session.
/// Backed by generated `SessionCreateRequest`.
public typealias SessionCreateMessage = SessionCreateRequest

private func buildSessionTransportMetadata(
    channelId: String?,
    interfaceId: String?,
    hints: [String]?,
    uxBrief: String?
) -> SessionTransportMetadata? {
    guard let channelId, !channelId.isEmpty else { return nil }

    var payload: [String: Any] = ["channelId": channelId]
    if let interfaceId, !interfaceId.isEmpty {
        payload["interfaceId"] = interfaceId
    }
    if let hints {
        payload["hints"] = hints
    }
    if let uxBrief {
        payload["uxBrief"] = uxBrief
    }

    guard JSONSerialization.isValidJSONObject(payload) else { return nil }
    do {
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(SessionTransportMetadata.self, from: data)
    } catch {
        return nil
    }
}

extension SessionCreateRequest {
    private static var defaultTransportInterface: String {
        #if os(macOS)
        return "macos"
        #elseif os(iOS)
        return "ios"
        #else
        return "vellum"
        #endif
    }

    public init(title: String?, systemPromptOverride: String? = nil, maxResponseTokens: Int? = nil, correlationId: String? = nil, transport: SessionTransportMetadata? = nil, threadType: String? = nil, preactivatedSkillIds: [String]? = nil, initialMessage: String? = nil) {
        self.init(type: "session_create", title: title, systemPromptOverride: systemPromptOverride, maxResponseTokens: maxResponseTokens, correlationId: correlationId, transport: transport, threadType: threadType, preactivatedSkillIds: preactivatedSkillIds, initialMessage: initialMessage)
    }

    public init(
        title: String?,
        systemPromptOverride: String? = nil,
        maxResponseTokens: Int? = nil,
        correlationId: String? = nil,
        transportChannelId: String?,
        transportInterfaceId: String? = nil,
        transportHints: [String]? = nil,
        transportUxBrief: String? = nil
    ) {
        self.init(
            type: "session_create",
            title: title,
            systemPromptOverride: systemPromptOverride,
            maxResponseTokens: maxResponseTokens,
            correlationId: correlationId,
            transport: buildSessionTransportMetadata(
                channelId: transportChannelId,
                interfaceId: transportInterfaceId ?? Self.defaultTransportInterface,
                hints: transportHints,
                uxBrief: transportUxBrief
            ),
            threadType: nil,
            preactivatedSkillIds: nil,
            initialMessage: nil
        )
    }
}

/// Sent to add a user message to an existing Q&A session.
/// Backed by generated `UserMessage`.
public typealias UserMessageMessage = UserMessage

extension UserMessage {
    /// Platform-derived default channel identifier.
    private static var defaultChannel: String {
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

    public init(sessionId: String, content: String, attachments: [Attachment]?, activeSurfaceId: String? = nil, currentPage: String? = nil, bypassSecretCheck: Bool? = nil, channel: String? = nil, interface: String? = nil, pttActivationKey: String? = nil, microphonePermissionGranted: Bool? = nil) {
        self.init(type: "user_message", sessionId: sessionId, content: content, attachments: attachments, activeSurfaceId: activeSurfaceId, currentPage: currentPage, bypassSecretCheck: bypassSecretCheck, channel: channel ?? Self.defaultChannel, interface: interface ?? Self.defaultInterface, pttActivationKey: pttActivationKey, microphonePermissionGranted: microphonePermissionGranted)
    }
}

/// Sent to cancel the active generation.
/// Backed by generated `CancelRequest`.
public typealias CancelMessage = CancelRequest

extension CancelRequest {
    public init(sessionId: String) {
        self.init(type: "cancel", sessionId: sessionId)
    }
}

extension AuthMessage {
    public init(token: String) {
        self.init(type: "auth", token: token)
    }
}


extension PingMessage {
    public init() {
        self.init(type: "ping")
    }
}

/// Sent when user interacts with a surface.
/// Hand-written to allow optional `sessionId` (the generated `UiSurfaceAction` requires non-nil).
public struct UiSurfaceActionMessage: Codable, Sendable {
    public let type: String
    public let sessionId: String?
    public let surfaceId: String
    public let actionId: String
    public let data: [String: AnyCodable]?

    public init(sessionId: String?, surfaceId: String, actionId: String, data: [String: AnyCodable]?) {
        self.type = "ui_surface_action"
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.actionId = actionId
        self.data = data
    }
}

/// Sent when user requests undo on a workspace surface.
/// Backed by generated `UiSurfaceUndoRequest`.
public typealias UiSurfaceUndoMessage = UiSurfaceUndoRequest

extension UiSurfaceUndoRequest {
    public init(sessionId: String, surfaceId: String) {
        self.init(type: "ui_surface_undo", sessionId: sessionId, surfaceId: surfaceId)
    }
}

/// Result of a surface undo operation.
/// Backed by generated `UiSurfaceUndoResult`.
public typealias UiSurfaceUndoResultMessage = UiSurfaceUndoResult

/// Sent when a persistent app's JS makes a data request via the RPC bridge.
/// Backed by generated `AppDataRequest`.
public typealias AppDataRequestMessage = AppDataRequest

extension AppDataRequest {
    public init(surfaceId: String, callId: String, method: String, appId: String, recordId: String?, data: [String: AnyCodable]?) {
        self.init(type: "app_data_request", surfaceId: surfaceId, callId: callId, method: method, appId: appId, recordId: recordId, data: data)
    }
}

/// Sent to request opening a URL in the user's browser.
/// Backed by generated `LinkOpenRequest`.
public typealias LinkOpenRequestMessage = LinkOpenRequest

extension LinkOpenRequest {
    public init(url: String, metadata: [String: AnyCodable]?) {
        self.init(type: "link_open_request", url: url, metadata: metadata)
    }
}

/// Sent to request opening an app by ID.
/// Backed by generated `AppOpenRequest`.
public typealias AppOpenRequestMessage = AppOpenRequest

extension AppOpenRequest {
    public init(appId: String) {
        self.init(type: "app_open_request", appId: appId)
    }
}

/// Sent to update an app's preview screenshot.
/// Backed by generated `AppUpdatePreviewRequest`.
public typealias AppUpdatePreviewRequestMessage = AppUpdatePreviewRequest

extension AppUpdatePreviewRequest {
    public init(appId: String, preview: String) {
        self.init(type: "app_update_preview", appId: appId, preview: preview)
    }
}

/// Response from updating an app's preview screenshot.
/// Backed by generated `AppUpdatePreviewResponse`.
public typealias AppUpdatePreviewResponseMessage = AppUpdatePreviewResponse

/// Sent to request a single app's preview screenshot.
/// Backed by generated `AppPreviewRequest`.
public typealias AppPreviewRequestMessage = AppPreviewRequest

/// Response with a single app's preview screenshot.
/// Backed by generated `AppPreviewResponse`.
public typealias AppPreviewResponseMessage = AppPreviewResponse

/// Sent to request the list of all apps.
/// Backed by generated `AppsListRequest`.
public typealias AppsListRequestMessage = AppsListRequest

extension AppsListRequest {
    public init() {
        self.init(type: "apps_list")
    }
}

/// Sent to request the list of shared/received apps.
/// Backed by generated `SharedAppsListRequest`.
public typealias SharedAppsListRequestMessage = SharedAppsListRequest

extension SharedAppsListRequest {
    public init() {
        self.init(type: "shared_apps_list")
    }
}

/// Sent to delete a persistent user-created app by ID.
/// Backed by generated `AppDeleteRequest`.
public typealias AppDeleteRequestMessage = AppDeleteRequest

extension AppDeleteRequest {
    public init(appId: String) {
        self.init(type: "app_delete", appId: appId)
    }
}

/// Sent to delete a shared app by UUID.
/// Backed by generated `SharedAppDeleteRequest`.
public typealias SharedAppDeleteRequestMessage = SharedAppDeleteRequest

extension SharedAppDeleteRequest {
    public init(uuid: String) {
        self.init(type: "shared_app_delete", uuid: uuid)
    }
}

/// Sent to fork (create a local copy of) a shared app by UUID.
public struct ForkSharedAppRequestMessage: Encodable, Sendable {
    public let type: String = "fork_shared_app"
    public let uuid: String
}

/// Response from forking a shared app.
public struct ForkSharedAppResponseMessage: Decodable, Sendable {
    public let success: Bool
    public let appId: String?
    public let name: String?
    public let error: String?
}

/// Sent to request bundling an app for sharing.
/// Backed by generated `BundleAppRequest`.
public typealias BundleAppRequestMessage = BundleAppRequest

extension BundleAppRequest {
    public init(appId: String) {
        self.init(type: "bundle_app", appId: appId)
    }
}

/// Sent to open and scan a .vellum bundle.
/// Backed by generated `OpenBundleRequest`.
public typealias OpenBundleMessage = OpenBundleRequest

extension OpenBundleRequest {
    public init(filePath: String) {
        self.init(type: "open_bundle", filePath: filePath)
    }
}

/// Sent to request the list of all past sessions/conversations.
/// Backed by generated `SessionListRequest`.
public typealias SessionListRequestMessage = SessionListRequest

extension SessionListRequest {
    public init(offset: Int? = nil, limit: Int? = nil) {
        self.init(type: "session_list", offset: offset.map(Double.init), limit: limit.map(Double.init))
    }
}

/// Sent to regenerate the last assistant response.
/// Backed by generated `RegenerateRequest`.
public typealias RegenerateMessage = RegenerateRequest

extension RegenerateRequest {
    public init(sessionId: String) {
        self.init(type: "regenerate", sessionId: sessionId)
    }
}

/// Sent to request message history for a specific session.
/// Backed by generated `HistoryRequest`.
public typealias HistoryRequestMessage = HistoryRequest

extension HistoryRequest {
    public init(sessionId: String, limit: Int? = nil, beforeTimestamp: Double? = nil, mode: String? = nil, maxTextChars: Int? = nil, maxToolResultChars: Int? = nil) {
        self.init(
            type: "history_request",
            sessionId: sessionId,
            limit: limit.map { Double($0) },
            beforeTimestamp: beforeTimestamp,
            mode: mode,
            maxTextChars: maxTextChars.map { Double($0) },
            maxToolResultChars: maxToolResultChars.map { Double($0) }
        )
    }
}

/// Sent to request the list of available skills.
/// Backed by generated `SkillsListRequest`.
public typealias SkillsListRequestMessage = SkillsListRequest

extension SkillsListRequest {
    public init() {
        self.init(type: "skills_list")
    }
}

/// Sent to request the full body of a specific skill.
/// Backed by generated `SkillDetailRequest`.
public typealias SkillDetailRequestMessage = SkillDetailRequest

extension SkillDetailRequest {
    public init(skillId: String) {
        self.init(type: "skill_detail", skillId: skillId)
    }
}

/// Enable a skill.
/// Backed by generated `SkillsEnableRequest`.
public typealias SkillsEnableMessage = SkillsEnableRequest

extension SkillsEnableRequest {
    public init(name: String) {
        self.init(type: "skills_enable", name: name)
    }
}

/// Disable a skill.
/// Backed by generated `SkillsDisableRequest`.
public typealias SkillsDisableMessage = SkillsDisableRequest

extension SkillsDisableRequest {
    public init(name: String) {
        self.init(type: "skills_disable", name: name)
    }
}

/// Configure a skill's env/apiKey/config.
/// Backed by generated `SkillsConfigureRequest`.
public typealias SkillsConfigureMessage = SkillsConfigureRequest

extension SkillsConfigureRequest {
    public init(name: String, env: [String: String]? = nil, apiKey: String? = nil, config: [String: AnyCodable]? = nil) {
        self.init(type: "skills_configure", name: name, env: env, apiKey: apiKey, config: config)
    }
}

/// Install a skill from ClaWHub.
/// Backed by generated `SkillsInstallRequest`.
public typealias SkillsInstallMessage = SkillsInstallRequest

extension SkillsInstallRequest {
    public init(slug: String, version: String? = nil) {
        self.init(type: "skills_install", slug: slug, version: version)
    }
}

/// Uninstall a skill.
/// Backed by generated `SkillsUninstallRequest`.
public typealias SkillsUninstallMessage = SkillsUninstallRequest

extension SkillsUninstallRequest {
    public init(name: String) {
        self.init(type: "skills_uninstall", name: name)
    }
}

/// Update a skill.
/// Backed by generated `SkillsUpdateRequest`.
public typealias SkillsUpdateMessage = SkillsUpdateRequest

extension SkillsUpdateRequest {
    public init(name: String) {
        self.init(type: "skills_update", name: name)
    }
}

/// Check for skill updates.
/// Backed by generated `SkillsCheckUpdatesRequest`.
public typealias SkillsCheckUpdatesMessage = SkillsCheckUpdatesRequest

extension SkillsCheckUpdatesRequest {
    public init() {
        self.init(type: "skills_check_updates")
    }
}

/// Search for skills on ClaWHub.
/// Backed by generated `SkillsSearchRequest`.
public typealias SkillsSearchMessage = SkillsSearchRequest

extension SkillsSearchRequest {
    public init(query: String) {
        self.init(type: "skills_search", query: query)
    }
}

/// Inspect a ClaWHub skill for detailed info.
/// Backed by generated `SkillsInspectRequest`.
public typealias SkillsInspectMessage = SkillsInspectRequest

extension SkillsInspectRequest {
    public init(slug: String) {
        self.init(type: "skills_inspect", slug: slug)
    }
}

/// Draft a skill from source text.
/// Backed by generated `SkillsDraftRequest`.
public typealias SkillsDraftRequestMessage = SkillsDraftRequest

extension SkillsDraftRequest {
    public init(sourceText: String) {
        self.init(type: "skills_draft", sourceText: sourceText)
    }
}

/// Create a managed skill.
/// Backed by generated `SkillsCreateRequest`.
public typealias SkillsCreateMessage = SkillsCreateRequest

extension SkillsCreateRequest {
    public init(skillId: String, name: String, description: String, emoji: String? = nil, bodyMarkdown: String, overwrite: Bool? = nil) {
        self.init(type: "skills_create", skillId: skillId, name: name, description: description, emoji: emoji, bodyMarkdown: bodyMarkdown, overwrite: overwrite)
    }
}

/// Backed by generated `SkillsDraftResponse`.
public typealias SkillsDraftResponseMessage = SkillsDraftResponse

/// Response to a sign_bundle_payload request from the daemon.
/// Backed by generated `SignBundlePayloadResponse`.
public typealias SignBundlePayloadResponseMessage = SignBundlePayloadResponse

extension SignBundlePayloadResponse {
    public init(requestId: String, signature: String, keyId: String, publicKey: String) {
        self.init(type: "sign_bundle_payload_response", requestId: requestId, signature: signature, keyId: keyId, publicKey: publicKey, error: nil)
    }

    public init(requestId: String, error: String) {
        self.init(type: "sign_bundle_payload_response", requestId: requestId, signature: nil, keyId: nil, publicKey: nil, error: error)
    }
}

/// Response to a get_signing_identity request from the daemon.
/// Backed by generated `GetSigningIdentityResponse`.
public typealias GetSigningIdentityResponseMessage = GetSigningIdentityResponse

extension GetSigningIdentityResponse {
    public init(requestId: String, keyId: String, publicKey: String) {
        self.init(type: "get_signing_identity_response", requestId: requestId, keyId: keyId, publicKey: publicKey, error: nil)
    }

    public init(requestId: String, error: String) {
        self.init(type: "get_signing_identity_response", requestId: requestId, keyId: nil, publicKey: nil, error: error)
    }
}

// MARK: - Server → Client Messages (Decodable)
//
// These typealiases point to the auto-generated types in
// GeneratedAPITypes.swift. Convenience inits preserve backward
// compatibility with existing call sites (the generated structs
// include a `type` field that the old hand-maintained types omitted).

/// Echoes a user message back to the client (e.g. relay_prompt from a surface action).
/// Backed by generated `UserMessageEcho`.
public typealias UserMessageEchoMessage = UserMessageEcho

/// Streamed text delta from the assistant's response.
/// Backed by generated `AssistantTextDelta`.
public typealias AssistantTextDeltaMessage = AssistantTextDelta

extension AssistantTextDelta {
    public init(text: String, sessionId: String? = nil) {
        self.init(type: "assistant_text_delta", text: text, sessionId: sessionId)
    }
}

/// Streamed thinking delta from the assistant's reasoning.
public typealias AssistantThinkingDeltaMessage = AssistantThinkingDelta

extension AssistantThinkingDelta {
    public init(thinking: String) {
        self.init(type: "assistant_thinking_delta", thinking: thinking)
    }
}

/// Signals that the assistant's message is complete.
/// Backed by generated `MessageComplete`.
public typealias MessageCompleteMessage = MessageComplete

extension MessageComplete {
    public init(sessionId: String? = nil, attachments: [UserMessageAttachment]? = nil, messageId: String? = nil) {
        self.init(type: "message_complete", sessionId: sessionId, attachments: attachments, messageId: messageId)
    }
}

/// Session metadata from the server (e.g. generated title).
/// Backed by generated `SessionInfo`.
public typealias SessionInfoMessage = SessionInfo

extension SessionInfo {
    public init(sessionId: String, title: String, correlationId: String? = nil, threadType: String? = nil) {
        self.init(type: "session_info", sessionId: sessionId, title: title, correlationId: correlationId, threadType: threadType)
    }
}

/// Session title update push message emitted after first-turn auto-titling.
/// Backed by generated `SessionTitleUpdated`.
public typealias SessionTitleUpdatedMessage = SessionTitleUpdated

extension SessionTitleUpdated {
    public init(sessionId: String, title: String) {
        self.init(type: "session_title_updated", sessionId: sessionId, title: title)
    }
}

/// Memory recall telemetry event.
/// Backed by generated `MemoryRecalled`.
public typealias MemoryRecalledMessage = MemoryRecalled

extension MemoryRecalled {
    public init(
        provider: String,
        model: String,
        semanticHits: Double,
        recencyHits: Double,
        tier1Count: Int? = nil,
        tier2Count: Int? = nil,
        hybridSearchLatencyMs: Double? = nil,
        sparseVectorUsed: Bool? = nil,
        mergedCount: Int,
        selectedCount: Int,
        injectedTokens: Int,
        latencyMs: Double,
        topCandidates: [MemoryRecalledCandidateDebug]
    ) {
        self.init(
            type: "memory_recalled",
            provider: provider,
            model: model,
            semanticHits: semanticHits,
            recencyHits: recencyHits,
            tier1Count: tier1Count,
            tier2Count: tier2Count,
            hybridSearchLatencyMs: hybridSearchLatencyMs,
            sparseVectorUsed: sparseVectorUsed,
            mergedCount: mergedCount,
            selectedCount: selectedCount,
            injectedTokens: injectedTokens,
            latencyMs: latencyMs,
            topCandidates: topCandidates
        )
    }
}

/// Memory availability/degradation status event.
/// Backed by generated `MemoryStatus`.
public typealias MemoryStatusMessage = MemoryStatus

/// Daemon response to a dictation_request with cleaned text and mode classification.
public typealias DictationResponseMessage = DictationResponse

extension DictationContext {
    public static func create(bundleIdentifier: String, appName: String, windowTitle: String, selectedText: String?, cursorInTextField: Bool) -> DictationContext {
        DictationContext(bundleIdentifier: bundleIdentifier, appName: appName, windowTitle: windowTitle, selectedText: selectedText, cursorInTextField: cursorInTextField)
    }
}

extension DictationRequest {
    public init(transcription: String, context: DictationContext, profileId: String? = nil) {
        self.init(type: "dictation_request", transcription: transcription, context: context, profileId: profileId)
    }
}

/// Instructs the client to open a URL in the browser.
/// Backed by generated `OpenUrl`.
public typealias OpenUrlMessage = OpenUrl


/// Surface show command from daemon.
/// Wire type: `"ui_surface_show"`
public struct UiSurfaceShowMessage: Decodable, Sendable {
    public let sessionId: String?
    public let surfaceId: String
    public let surfaceType: String
    public let title: String?
    public let data: AnyCodable
    public let actions: [SurfaceActionData]?
    /// `"inline"` embeds in chat, `"panel"` shows a floating window.
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?

    public init(sessionId: String?, surfaceId: String, surfaceType: String, title: String?, data: AnyCodable, actions: [SurfaceActionData]?, display: String?, messageId: String?) {
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.surfaceType = surfaceType
        self.title = title
        self.data = data
        self.actions = actions
        self.display = display
        self.messageId = messageId
    }
}

/// Surface action button data.
/// Backed by generated `SurfaceAction`.
public typealias SurfaceActionData = SurfaceAction

/// Surface update command from daemon.
/// Wire type: `"ui_surface_update"`
public struct UiSurfaceUpdateMessage: Decodable, Sendable {
    public let sessionId: String?
    public let surfaceId: String
    public let data: AnyCodable
}

/// Surface dismiss command from daemon.
/// Backed by generated `UiSurfaceDismiss`.
public typealias UiSurfaceDismissMessage = UiSurfaceDismiss

/// Surface completion message from daemon, sent when user interaction completes a surface.
public struct UiSurfaceCompleteMessage: Decodable, Sendable {
    public let sessionId: String?
    public let surfaceId: String
    public let summary: String
    public let submittedData: [String: AnyCodable]?
}

/// Document editor messages — backed by generated types from the message contract.
public typealias DocumentEditorShowMessage = DocumentEditorShow
public typealias DocumentEditorUpdateMessage = DocumentEditorUpdate
public typealias DocumentSaveRequestMessage = DocumentSaveRequest
public typealias DocumentSaveResponseMessage = DocumentSaveResponse
public typealias DocumentLoadRequestMessage = DocumentLoadRequest
public typealias DocumentLoadResponseMessage = DocumentLoadResponse
public typealias DocumentListRequestMessage = DocumentListRequest
public typealias DocumentListResponseMessage = DocumentListResponse

/// Confirms undo/regenerate removed messages.
public typealias UndoCompleteMessage = UndoComplete

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
/// Backed by generated `GenerationHandoff`.
public typealias GenerationHandoffMessage = GenerationHandoff

extension GenerationHandoff {
    public init(sessionId: String, requestId: String?, queuedCount: Int, attachments: [UserMessageAttachment]? = nil, messageId: String? = nil) {
        self.init(type: "generation_handoff", sessionId: sessionId, requestId: requestId, queuedCount: queuedCount, attachments: attachments, messageId: messageId)
    }
}

/// Notifies client that a message has been queued for processing.
/// Backed by generated `MessageQueued`.
public typealias MessageQueuedMessage = MessageQueued

extension MessageQueued {
    public init(sessionId: String, requestId: String, position: Int) {
        self.init(type: "message_queued", sessionId: sessionId, requestId: requestId, position: position)
    }
}

/// Notifies client that a queued message has been dequeued and is now being processed.
/// Backed by generated `MessageDequeued`.
public typealias MessageDequeuedMessage = MessageDequeued

extension MessageDequeued {
    public init(sessionId: String, requestId: String) {
        self.init(type: "message_dequeued", sessionId: sessionId, requestId: requestId)
    }
}

/// Request-level terminal signal for a queued/dequeued lifecycle.
/// Does not imply the active assistant turn has completed.
/// Backed by generated `MessageRequestComplete`.
public typealias MessageRequestCompleteMessage = MessageRequestComplete

extension MessageRequestComplete {
    public init(sessionId: String, requestId: String, runStillActive: Bool? = nil) {
        self.init(type: "message_request_complete", sessionId: sessionId, requestId: requestId, runStillActive: runStillActive)
    }
}

/// Notifies client that a queued message was successfully deleted.
/// Backed by generated `MessageQueuedDeleted`.
public typealias MessageQueuedDeletedMessage = MessageQueuedDeleted

extension MessageQueuedDeleted {
    public init(sessionId: String, requestId: String) {
        self.init(type: "message_queued_deleted", sessionId: sessionId, requestId: requestId)
    }
}

/// Client → Server request to delete a specific queued message.
/// Backed by generated `DeleteQueuedMessage`.
public typealias DeleteQueuedMessageMessage = DeleteQueuedMessage

extension DeleteQueuedMessage {
    public init(sessionId: String, requestId: String) {
        self.init(type: "delete_queued_message", sessionId: sessionId, requestId: requestId)
    }
}


extension ErrorMessage {
    public init(message: String, category: String? = nil) {
        self.init(type: "error", message: message, category: category)
    }
}

/// Response from the daemon for a persistent app data request.
/// Backed by generated `AppDataResponse`.
public typealias AppDataResponseMessage = AppDataResponse

/// ClaWHub metadata for a skill.
/// Backed by generated `SkillsListResponseSkillClawhub`.
public typealias ClawhubInfo = SkillsListResponseSkillClawhub

/// Provenance metadata indicating whether a skill is first-party, third-party, or local.
/// Backed by generated `SkillsListResponseSkillProvenance`.
public typealias SkillProvenance = SkillsListResponseSkillProvenance

/// Full skill info from the daemon's resolved skill list.
/// Backed by generated `SkillsListResponseSkill`.
public typealias SkillInfo = SkillsListResponseSkill

extension SkillsListResponseSkill: Identifiable {}

extension SkillsListResponseSkill {
    /// Returns a copy with a different `state`, preserving all other fields including `id`.
    public func withState(_ newState: String) -> Self {
        Self(id: id, name: name, description: description, emoji: emoji, homepage: homepage, source: source, state: newState, installedVersion: installedVersion, latestVersion: latestVersion, updateAvailable: updateAvailable, clawhub: clawhub, provenance: provenance)
    }
}

/// Response containing the list of available skills.
/// Backed by generated `SkillsListResponse`.
public typealias SkillsListResponseMessage = SkillsListResponse

/// Response containing the full body of a specific skill.
/// Backed by generated `SkillDetailResponse`.
public typealias SkillDetailResponseMessage = SkillDetailResponse

// MARK: - Conversation Search

/// Response containing conversation search results.
/// Backed by generated `ConversationSearchResponse`.
public typealias ConversationSearchResponseMessage = ConversationSearchResponse

// MARK: - Workspace Files

/// Request to list workspace files.
public typealias WorkspaceFilesListRequestMessage = WorkspaceFilesListRequest

extension WorkspaceFilesListRequest {
    public init() {
        self.init(type: "workspace_files_list")
    }
}

/// Request to read a workspace file's content.
public typealias WorkspaceFileReadRequestMessage = WorkspaceFileReadRequest

extension WorkspaceFileReadRequest {
    public init(path: String) {
        self.init(type: "workspace_file_read", path: path)
    }
}

/// Response containing the list of workspace files.
public typealias WorkspaceFilesListResponseMessage = WorkspaceFilesListResponse

/// Individual workspace file entry.
public typealias WorkspaceFileInfo = WorkspaceFilesListResponseFile

extension WorkspaceFilesListResponseFile: Identifiable {
    public var id: String { path }
}

/// Response containing a workspace file's content.
public typealias WorkspaceFileReadResponseMessage = WorkspaceFileReadResponse

/// Request to fetch assistant identity info via HTTP.
public typealias IdentityGetRequestMessage = IdentityGetRequest

extension IdentityGetRequest {
    public init() {
        self.init(type: "identity_get")
    }
}

/// Response containing assistant identity info.
public typealias IdentityGetResponseMessage = IdentityGetResponse

/// Request to generate a custom avatar via DALL-E.
public typealias GenerateAvatarRequestMessage = GenerateAvatarRequest

extension GenerateAvatarRequest {
    public init(description: String) {
        self.init(type: "generate_avatar", description: description)
    }
}

/// Response indicating whether avatar generation succeeded.
public typealias GenerateAvatarResponseMessage = GenerateAvatarResponse

/// Push event: skill state changed.
/// Backed by generated `SkillStateChanged`.
public typealias SkillStateChangedMessage = SkillStateChanged

/// A skill returned from a search or explore query.
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
    /// Where this skill comes from: "vellum" (first-party) or "clawhub" (community).
    public let source: String

    public var isVellum: Bool { source == "vellum" }

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
        source = try container.decodeIfPresent(String.self, forKey: .source) ?? "clawhub"
    }

    private enum CodingKeys: String, CodingKey {
        case name, slug, description, author, stars, installs, version, createdAt, source
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
/// Backed by generated `SkillsInspectResponseDataSkill`.
public typealias ClawhubInspectSkill = SkillsInspectResponseDataSkill

/// Owner info from a ClaWHub inspect response.
/// Backed by generated `SkillsInspectResponseDataOwner`.
public typealias ClawhubInspectOwner = SkillsInspectResponseDataOwner

/// Stats from a ClaWHub inspect response.
/// Backed by generated `SkillsInspectResponseDataStats`.
public typealias ClawhubInspectStats = SkillsInspectResponseDataStats

// The server may omit stats fields for newly created skills,
// so we default missing values to 0 instead of crashing.
extension SkillsInspectResponseDataStats {
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
/// Backed by generated `SkillsInspectResponseDataLatestVersion`.
public typealias ClawhubInspectVersion = SkillsInspectResponseDataLatestVersion

/// File entry from a ClaWHub inspect response.
/// Backed by generated `SkillsInspectResponseDataFile`.
public typealias ClawhubInspectFile = SkillsInspectResponseDataFile

/// Full inspect data for a ClaWHub skill.
/// Backed by generated `SkillsInspectResponseData`.
public typealias ClawhubInspectData = SkillsInspectResponseData

// Backward-compatible typed accessors. The generated struct now uses
// concrete types (Int?, String?) instead of AnyCodable?, so these are
// simple pass-throughs for existing call sites.
extension SkillsInspectResponseData {
    public var createdAtInt: Int? { createdAt }
    public var updatedAtInt: Int? { updatedAt }
    public var skillMdContentString: String? { skillMdContent }
}

/// Response from inspecting a ClaWHub skill.
/// Backed by generated `SkillsInspectResponse`.
public typealias SkillsInspectResponseMessage = SkillsInspectResponse


/// Response containing the list of past sessions.
/// Backed by generated `SessionListResponse`.
public typealias SessionListResponseMessage = SessionListResponse

/// A single scheduled task item returned from the daemon.
/// Backed by generated `SchedulesListResponseSchedule`.
public typealias ScheduleItem = SchedulesListResponseSchedule

extension SchedulesListResponseSchedule: Identifiable {}

/// Response containing all scheduled tasks.
/// Backed by generated `SchedulesListResponse`.
public typealias SchedulesListResponseMessage = SchedulesListResponse

/// Request all schedules from the daemon.
/// Backed by generated `SchedulesList`.
public typealias SchedulesListMessage = SchedulesList

extension SchedulesList {
    public init() {
        self.init(type: "schedules_list")
    }
}

/// Toggle a schedule's enabled state.
/// Backed by generated `ScheduleToggle`.
public typealias ScheduleToggleMessage = ScheduleToggle

extension ScheduleToggle {
    public init(id: String, enabled: Bool) {
        self.init(type: "schedule_toggle", id: id, enabled: enabled)
    }
}

/// Remove a schedule by ID.
/// Backed by generated `ScheduleRemove`.
public typealias ScheduleRemoveMessage = ScheduleRemove

extension ScheduleRemove {
    public init(id: String) {
        self.init(type: "schedule_remove", id: id)
    }
}

/// Cancel a schedule (preserves the record with status 'cancelled').
/// Backed by generated `ScheduleCancel`.
public typealias ScheduleCancelMessage = ScheduleCancel

extension ScheduleCancel {
    public init(id: String) {
        self.init(type: "schedule_cancel", id: id)
    }
}

/// Run a schedule immediately as a one-off.
/// Backed by generated `ScheduleRunNow`.
public typealias ScheduleRunNowMessage = ScheduleRunNow

extension ScheduleRunNow {
    public init(id: String) {
        self.init(type: "schedule_run_now", id: id)
    }
}

/// A single trust rule item returned from the daemon.
/// Backed by generated `TrustRulesListResponseRule`.
public typealias TrustRuleItem = TrustRulesListResponseRule

extension TrustRulesListResponseRule: Identifiable {}

/// Response containing all trust rules.
/// Backed by generated `TrustRulesListResponse`.
public typealias TrustRulesListResponseMessage = TrustRulesListResponse

/// A single app item returned from the daemon.
/// Backed by generated `AppsListResponseApp`.
public typealias AppItem = AppsListResponseApp

extension AppsListResponseApp: Identifiable {}

/// Response containing the list of all apps.
/// Backed by generated `AppsListResponse`.
public typealias AppsListResponseMessage = AppsListResponse

/// A single shared app item returned from the daemon.
/// Backed by generated `SharedAppsListResponseApp`.
public typealias SharedAppItem = SharedAppsListResponseApp

extension SharedAppsListResponseApp: Identifiable {
    public var id: String { uuid }
}

/// Response containing the list of shared apps.
/// Backed by generated `SharedAppsListResponse`.
public typealias SharedAppsListResponseMessage = SharedAppsListResponse

/// Response from deleting a persistent user-created app.
/// Backed by generated `AppDeleteResponse`.
public typealias AppDeleteResponseMessage = AppDeleteResponse

/// Response from deleting a shared app.
/// Backed by generated `SharedAppDeleteResponse`.
public typealias SharedAppDeleteResponseMessage = SharedAppDeleteResponse

/// Response from bundling an app.
/// Backed by generated `BundleAppResponse`.
public typealias BundleAppResponseMessage = BundleAppResponse

/// Request from daemon to sign a bundle payload.
/// Backed by generated `SignBundlePayloadRequest`.
public typealias SignBundlePayloadMessage = SignBundlePayloadRequest

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
    case providerBilling = "PROVIDER_BILLING"
    case providerOrdering = "PROVIDER_ORDERING"
    case providerWebSearch = "PROVIDER_WEB_SEARCH"
    case contextTooLarge = "CONTEXT_TOO_LARGE"
    case sessionAborted = "SESSION_ABORTED"
    case sessionProcessingFailed = "SESSION_PROCESSING_FAILED"
    case regenerateFailed = "REGENERATE_FAILED"
    case authenticationRequired = "AUTHENTICATION_REQUIRED"
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
    /// Machine-readable error category for log report metadata and triage.
    public let errorCategory: String?
    /// Non-nil when the error is a client-side HTTP send failure.
    /// Contains the message content that failed to send, used to mark
    /// the specific user message as `.sendFailed` in the chat.
    public let failedMessageContent: String?

    public init(sessionId: String, code: SessionErrorCode, userMessage: String, retryable: Bool, debugDetails: String? = nil, errorCategory: String? = nil, failedMessageContent: String? = nil) {
        self.sessionId = sessionId
        self.code = code
        self.userMessage = userMessage
        self.retryable = retryable
        self.debugDetails = debugDetails
        self.errorCategory = errorCategory
        self.failedMessageContent = failedMessageContent
    }
}

/// Generic notification intent from daemon.
/// Backed by generated `NotificationIntent`.
public typealias NotificationIntentMessage = NotificationIntent

/// Watch session started notification from daemon.
/// Backed by generated `WatchStarted`.
public typealias WatchStartedMessage = WatchStarted

/// Watch session complete request from daemon.
/// Backed by generated `WatchCompleteRequest`.
public typealias WatchCompleteRequestMessage = WatchCompleteRequest

/// Tool execution started.
/// Backed by generated `ToolUseStart`.
public typealias ToolUseStartMessage = ToolUseStart

/// Tool use preview started (emitted during LLM tool input streaming for immediate UI feedback).
/// Backed by generated `ToolUsePreviewStart`.
public typealias ToolUsePreviewStartMessage = ToolUsePreviewStart

/// Streaming tool input delta (e.g. partial JSON as tool input is generated).
/// Backed by generated `ToolInputDelta`.
public typealias ToolInputDeltaMessage = ToolInputDelta

/// Streaming tool output chunk.
/// Backed by generated `ToolOutputChunk`.
public typealias ToolOutputChunkMessage = ToolOutputChunk

/// Tool execution completed.
/// Backed by generated `ToolResult`.
public typealias ToolResultMessage = ToolResult

/// Follow-up suggestion response from daemon.
/// Backed by generated `SuggestionResponse`.
public typealias SuggestionResponseMessage = SuggestionResponse

/// Secret input request from daemon.
/// Backed by generated `SecretRequest`.
public typealias SecretRequestMessage = SecretRequest

/// Permission confirmation request from daemon.
/// Backed by generated `ConfirmationRequest`.
public typealias ConfirmationRequestMessage = ConfirmationRequest


// Equatable conformance for generated types used in SwiftUI previews and tests.
// Explicit `==` implementations because auto-synthesis requires conformance in the declaring file.
extension ConfirmationRequestAllowlistOption: Equatable {
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.label == rhs.label && lhs.description == rhs.description && lhs.pattern == rhs.pattern
    }
}
extension ConfirmationRequestScopeOption: Equatable {
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.label == rhs.label && lhs.scope == rhs.scope
    }
}
extension ConfirmationRequestDiff: Equatable {
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.filePath == rhs.filePath && lhs.oldContent == rhs.oldContent && lhs.newContent == rhs.newContent && lhs.isNewFile == rhs.isNewFile
    }
}

/// Authoritative confirmation state transition from daemon.
/// Backed by generated `ConfirmationStateChanged`.
public typealias ConfirmationStateChangedMessage = ConfirmationStateChanged

// MARK: - Host Bash Proxy

/// Request from the daemon to execute a bash command on the host machine.
/// The desktop client receives this via SSE, runs the command locally via
/// `Foundation.Process`, and POSTs the result back to `/v1/host-bash-result`.
public struct HostBashRequest: Decodable, Sendable {
    public let type: String
    public let requestId: String
    public let sessionId: String
    public let command: String
    public let workingDir: String?
    public let timeoutSeconds: Double?
    /// Extra environment variables to inject into the subprocess (e.g. VELLUM_UNTRUSTED_SHELL).
    public let env: [String: String]?

    private enum CodingKeys: String, CodingKey {
        case type
        case requestId
        case sessionId
        case command
        case workingDir = "working_dir"
        case timeoutSeconds = "timeout_seconds"
        case env
    }
}

/// Payload posted back to the daemon with the result of a host bash execution.
public struct HostBashResultPayload: Codable, Sendable {
    public let requestId: String
    public let stdout: String
    public let stderr: String
    public let exitCode: Int?
    public let timedOut: Bool

    public init(requestId: String, stdout: String, stderr: String, exitCode: Int?, timedOut: Bool) {
        self.requestId = requestId
        self.stdout = stdout
        self.stderr = stderr
        self.exitCode = exitCode
        self.timedOut = timedOut
    }

    private enum CodingKeys: String, CodingKey {
        case requestId
        case stdout
        case stderr
        case exitCode
        case timedOut
    }
}

// MARK: - Host File Proxy

/// Request from the daemon to execute a file operation on the host machine.
/// The desktop client receives this via SSE, performs the operation locally,
/// and POSTs the result back to `/v1/host-file-result`.
public struct HostFileRequest: Decodable, Sendable {
    public let type: String
    public let requestId: String
    public let sessionId: String
    public let operation: String  // "read", "write", "edit"
    public let path: String
    // Read fields
    public let offset: Int?
    public let limit: Int?
    // Write fields
    public let content: String?
    // Edit fields
    public let oldString: String?
    public let newString: String?
    public let replaceAll: Bool?

    private enum CodingKeys: String, CodingKey {
        case type, requestId, sessionId, operation, path
        case offset, limit, content
        case oldString = "old_string"
        case newString = "new_string"
        case replaceAll = "replace_all"
    }
}

/// Payload posted back to the daemon with the result of a host file operation.
public struct HostFileResultPayload: Codable, Sendable {
    public let requestId: String
    public let content: String
    public let isError: Bool

    public init(requestId: String, content: String, isError: Bool) {
        self.requestId = requestId
        self.content = content
        self.isError = isError
    }
}

// MARK: - Host CU Proxy

/// Request from the daemon to execute a computer-use action on the host machine.
/// The desktop client receives this via SSE, executes the action locally
/// (verify → execute → observe), and POSTs the result back to `/v1/host-cu-result`.
public struct HostCuRequest: Decodable, Sendable {
    public let type: String
    public let requestId: String
    public let sessionId: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let stepNumber: Int
    public let reasoning: String?

    private enum CodingKeys: String, CodingKey {
        case type
        case requestId
        case sessionId
        case toolName
        case input
        case stepNumber
        case reasoning
    }
}

/// Payload posted back to the daemon with the result of a host CU action execution.
public struct HostCuResultPayload: Codable, Sendable {
    public let requestId: String
    public let axTree: String?
    public let axDiff: String?
    public let screenshot: String?
    public let screenshotWidthPx: Int?
    public let screenshotHeightPx: Int?
    public let screenWidthPt: Int?
    public let screenHeightPt: Int?
    public let executionResult: String?
    public let executionError: String?
    public let secondaryWindows: String?
    public let userGuidance: String?

    public init(
        requestId: String,
        axTree: String?,
        axDiff: String?,
        screenshot: String?,
        screenshotWidthPx: Int?,
        screenshotHeightPx: Int?,
        screenWidthPt: Int?,
        screenHeightPt: Int?,
        executionResult: String?,
        executionError: String?,
        secondaryWindows: String?,
        userGuidance: String?
    ) {
        self.requestId = requestId
        self.axTree = axTree
        self.axDiff = axDiff
        self.screenshot = screenshot
        self.screenshotWidthPx = screenshotWidthPx
        self.screenshotHeightPx = screenshotHeightPx
        self.screenWidthPt = screenWidthPt
        self.screenHeightPt = screenHeightPt
        self.executionResult = executionResult
        self.executionError = executionError
        self.secondaryWindows = secondaryWindows
        self.userGuidance = userGuidance
    }

    private enum CodingKeys: String, CodingKey {
        case requestId
        case axTree
        case axDiff
        case screenshot
        case screenshotWidthPx
        case screenshotHeightPx
        case screenWidthPt
        case screenHeightPt
        case executionResult
        case executionError
        case secondaryWindows
        case userGuidance
    }
}

/// Server-side assistant activity lifecycle event.
/// Backed by generated `AssistantActivityState`.
public typealias AssistantActivityStateMessage = AssistantActivityState


/// Request a follow-up suggestion for the current session.
/// Backed by generated `SuggestionRequest`.
public typealias SuggestionRequestMessage = SuggestionRequest

extension SuggestionRequest {
    public init(sessionId: String, requestId: String) {
        self.init(type: "suggestion_request", sessionId: sessionId, requestId: requestId)
    }
}

/// Client response to a permission confirmation request.
/// Backed by generated `ConfirmationResponse`.
public typealias ConfirmationResponseMessage = ConfirmationResponse

extension ConfirmationResponse {
    public init(requestId: String, decision: String, selectedPattern: String? = nil, selectedScope: String? = nil) {
        self.init(type: "confirmation_response", requestId: requestId, decision: decision, selectedPattern: selectedPattern, selectedScope: selectedScope)
    }
}

/// Client response to a secret input request.
/// Backed by generated `SecretResponse`.
public typealias SecretResponseMessage = SecretResponse

extension SecretResponse {
    public init(requestId: String, value: String?, delivery: String? = nil) {
        self.init(type: "secret_response", requestId: requestId, value: value, delivery: delivery)
    }
}

/// Sent to add a trust rule (allowlist/denylist) independently of a confirmation response.
/// Backed by generated `AddTrustRule`.
public typealias AddTrustRuleMessage = AddTrustRule

extension AddTrustRule {
    public init(
        toolName: String,
        pattern: String,
        scope: String,
        decision: String,
        allowHighRisk: Bool? = nil,
        executionTarget: String? = nil
    ) {
        self.init(
            type: "add_trust_rule",
            toolName: toolName,
            pattern: pattern,
            scope: scope,
            decision: decision,
            allowHighRisk: allowHighRisk,
            executionTarget: executionTarget
        )
    }
}

/// Request all trust rules from the daemon.
/// Backed by generated `TrustRulesList`.
public typealias TrustRulesListMessage = TrustRulesList

extension TrustRulesList {
    public init() {
        self.init(type: "trust_rules_list")
    }
}

/// Remove a trust rule by its ID.
/// Backed by generated `RemoveTrustRule`.
public typealias RemoveTrustRuleMessage = RemoveTrustRule

extension RemoveTrustRule {
    public init(id: String) {
        self.init(type: "remove_trust_rule", id: id)
    }
}

/// Update fields on an existing trust rule.
/// Backed by generated `UpdateTrustRule`.
public typealias UpdateTrustRuleMessage = UpdateTrustRule

extension UpdateTrustRule {
    public init(id: String, tool: String? = nil, pattern: String? = nil, scope: String? = nil, decision: String? = nil, priority: Int? = nil) {
        self.init(type: "update_trust_rule", id: id, tool: tool, pattern: pattern, scope: scope, decision: decision, priority: priority)
    }
}

/// Simulate a tool permission check without executing the tool.
/// Backed by generated `ToolPermissionSimulateRequest`.
public typealias ToolPermissionSimulateMessage = ToolPermissionSimulateRequest

extension ToolPermissionSimulateRequest {
    public init(toolName: String, input: [String: AnyCodable], workingDir: String? = nil, isInteractive: Bool? = nil, forcePromptSideEffects: Bool? = nil) {
        self.init(type: "tool_permission_simulate", toolName: toolName, input: input, workingDir: workingDir, isInteractive: isInteractive, forcePromptSideEffects: forcePromptSideEffects)
    }
}

/// Response from a tool permission simulation.
/// Backed by generated `ToolPermissionSimulateResponse`.
public typealias ToolPermissionSimulateResponseMessage = ToolPermissionSimulateResponse

/// Request the list of all registered tool names.
/// Backed by generated `ToolNamesListRequest`.
public typealias ToolNamesListMessage = ToolNamesListRequest

extension ToolNamesListRequest {
    public init() {
        self.init(type: "tool_names_list")
    }
}

/// Response containing all registered tool names.
/// Backed by generated `ToolNamesListResponse`.
public typealias ToolNamesListResponseMessage = ToolNamesListResponse

/// Response from opening and scanning a .vellum bundle.
/// Backed by generated `OpenBundleResponse`.
public typealias OpenBundleResponseMessage = OpenBundleResponse


// MARK: - Publish / Unpublish Page Messages

/// Sent to publish a static page via Vercel.
/// Backed by generated `PublishPageRequest`.
public typealias PublishPageRequestMessage = PublishPageRequest

extension PublishPageRequest {
    public init(html: String, title: String? = nil, appId: String? = nil) {
        self.init(type: "publish_page", html: html, title: title, appId: appId)
    }
}

/// Response from publishing a static page.
/// Backed by generated `PublishPageResponse`.
public typealias PublishPageResponseMessage = PublishPageResponse

/// Sent to unpublish a page and delete its Vercel deployment.
/// Backed by generated `UnpublishPageRequest`.
public typealias UnpublishPageRequestMessage = UnpublishPageRequest

extension UnpublishPageRequest {
    public init(deploymentId: String) {
        self.init(type: "unpublish_page", deploymentId: deploymentId)
    }
}

/// Response from unpublishing a page.
/// Backed by generated `UnpublishPageResponse`.
public typealias UnpublishPageResponseMessage = UnpublishPageResponse

// MARK: - Push Notification Device Token (Manual)

/// Sent to register an APNS device token so the daemon can route push notifications.
/// Kept hand-maintained — not yet part of the generated message contract.
public struct RegisterDeviceTokenMessage: Encodable, Sendable {
    public let type: String = "register_device_token"
    public let token: String
    public let platform: String

    public init(token: String, platform: String) {
        self.token = token
        self.platform = platform
    }
}


// MARK: - Cloud Sharing Messages (Manual)

/// Sent to request sharing an app via a cloud link.
/// Backed by generated `ShareAppCloudRequest`.
public typealias ShareAppCloudRequestMessage = ShareAppCloudRequest

extension ShareAppCloudRequest {
    public init(appId: String) {
        self.init(type: "share_app_cloud", appId: appId)
    }
}

public typealias ShareAppCloudResponseMessage = ShareAppCloudResponse

// MARK: - Slack Webhook Messages (Manual)

public struct SlackWebhookConfigRequestMessage: Encodable, Sendable {
    public let type = "slack_webhook_config"
    public let action: String
    public let webhookUrl: String?

    public init(action: String, webhookUrl: String? = nil) {
        self.action = action
        self.webhookUrl = webhookUrl
    }
}

public struct SlackWebhookConfigResponseMessage: Decodable, Sendable {
    public let type: String
    public let webhookUrl: String?
    public let success: Bool
    public let error: String?
}

// MARK: - Ingress Config Messages

public struct IngressConfigRequestMessage: Encodable, Sendable {
    public let type = "ingress_config"
    public let action: String
    public let publicBaseUrl: String?
    public let enabled: Bool?

    public init(action: String, publicBaseUrl: String? = nil, enabled: Bool? = nil) {
        self.action = action
        self.publicBaseUrl = publicBaseUrl
        self.enabled = enabled
    }
}

public struct IngressConfigResponseMessage: Sendable {
    public let type: String
    public let enabled: Bool
    public let publicBaseUrl: String
    public let localGatewayTarget: String
    public let success: Bool
    public let error: String?
}

extension IngressConfigResponseMessage: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        publicBaseUrl = try container.decode(String.self, forKey: .publicBaseUrl)
        localGatewayTarget = try container.decodeIfPresent(String.self, forKey: .localGatewayTarget) ?? "http://127.0.0.1:7830"
        success = try container.decode(Bool.self, forKey: .success)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }

    private enum CodingKeys: String, CodingKey {
        case type, enabled, publicBaseUrl, localGatewayTarget, success, error
    }
}

// MARK: - Platform Config Messages

public struct PlatformConfigRequestMessage: Encodable, Sendable {
    public let type = "platform_config"
    public let action: String
    public let baseUrl: String?

    public init(action: String, baseUrl: String? = nil) {
        self.action = action
        self.baseUrl = baseUrl
    }
}

public struct PlatformConfigResponseMessage: Sendable {
    public let type: String
    public let baseUrl: String
    public let success: Bool
    public let error: String?
}

extension PlatformConfigResponseMessage: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        baseUrl = try container.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        success = try container.decode(Bool.self, forKey: .success)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }

    private enum CodingKeys: String, CodingKey {
        case type, baseUrl, success, error
    }
}

// MARK: - Model Config Messages

/// Request the current model/provider configuration.
/// Backed by generated `ModelGetRequest`.
public typealias ModelGetRequestMessage = ModelGetRequest

extension ModelGetRequest {
    public init() {
        self.init(type: "model_get")
    }
}

/// Set the active model.
/// Backed by generated `ModelSetRequest`.
public typealias ModelSetRequestMessage = ModelSetRequest

extension ModelSetRequest {
    public init(model: String) {
        self.init(type: "model_set", model: model)
    }
}

/// Set the active image generation model.
/// Backed by generated `ImageGenModelSetRequest`.
public typealias ImageGenModelSetRequestMessage = ImageGenModelSetRequest

extension ImageGenModelSetRequest {
    public init(model: String) {
        self.init(type: "image_gen_model_set", model: model)
    }
}

/// Response containing the current model/provider info.
/// Backed by generated `ModelInfo`.
public typealias ModelInfoMessage = ModelInfo

// MARK: - Vercel API Config Messages

/// Sent to get/set/delete the Vercel API token.
/// Backed by generated `VercelApiConfigRequest`.
public typealias VercelApiConfigRequestMessage = VercelApiConfigRequest

extension VercelApiConfigRequest {
    public init(action: String, apiToken: String? = nil) {
        self.init(type: "vercel_api_config", action: action, apiToken: apiToken)
    }
}

/// Response from Vercel API config operations.
/// Backed by generated `VercelApiConfigResponse`.
public typealias VercelApiConfigResponseMessage = VercelApiConfigResponse

// MARK: - Telegram Config Messages

/// Sent to get/set/clear Telegram bot config.
/// Backed by generated `TelegramConfigRequest`.
public typealias TelegramConfigRequestMessage = TelegramConfigRequest

extension TelegramConfigRequest {
    public init(action: String, botToken: String? = nil, commands: [TelegramConfigRequestCommand]? = nil) {
        self.init(type: "telegram_config", action: action, botToken: botToken, commands: commands)
    }
}

/// Response from Telegram config operations.
/// Backed by generated `TelegramConfigResponse`.
public typealias TelegramConfigResponseMessage = TelegramConfigResponse

// MARK: - Twilio Number Models (standalone, no generated-type dependency)

/// Capabilities of a Twilio phone number.
public struct TwilioNumberCapabilities: Codable, Sendable {
    public let voice: Bool

    public init(voice: Bool) {
        self.voice = voice
    }
}

/// Number entry used by Twilio settings views.
public struct TwilioNumberInfo: Codable, Sendable {
    public let phoneNumber: String
    public let friendlyName: String
    public let capabilities: TwilioNumberCapabilities

    public init(phoneNumber: String, friendlyName: String, capabilities: TwilioNumberCapabilities) {
        self.phoneNumber = phoneNumber
        self.friendlyName = friendlyName
        self.capabilities = capabilities
    }
}

// MARK: - Channel Verification Session Messages

/// Channel verification session request (create_session, status, cancel_session, revoke, resend_session).
/// Backed by generated `ChannelVerificationSessionRequest`.
public typealias ChannelVerificationSessionRequestMessage = ChannelVerificationSessionRequest

extension ChannelVerificationSessionRequest {
    public init(
        action: String,
        channel: String? = nil,
        sessionId: String? = nil,
        rebind: Bool? = nil,
        destination: String? = nil,
        originConversationId: String? = nil,
        purpose: String? = nil,
        contactChannelId: String? = nil
    ) {
        self.init(
            type: "channel_verification_session",
            action: action,
            channel: channel,
            sessionId: sessionId,
            rebind: rebind,
            destination: destination,
            originConversationId: originConversationId,
            purpose: purpose,
            contactChannelId: contactChannelId
        )
    }
}

/// Channel verification session response.
/// Backed by generated `ChannelVerificationSessionResponse`.
public typealias ChannelVerificationSessionResponseMessage = ChannelVerificationSessionResponse

/// Authentication result from the daemon after the client sends an `auth` message.
/// Backed by generated `AuthResult`.
public typealias AuthResultMessage = AuthResult

/// Sent to request a diagnostics export (zip) for a conversation.
/// Wire type: `"diagnostics_export_request"`
public struct DiagnosticsExportRequestMessage: Encodable, Sendable {
    public let type: String = "diagnostics_export_request"
    public let conversationId: String
    public let anchorMessageId: String?

    public init(conversationId: String, anchorMessageId: String? = nil) {
        self.conversationId = conversationId
        self.anchorMessageId = anchorMessageId
    }
}

/// Response from a diagnostics export request.
/// Wire type: `"diagnostics_export_response"`
public struct DiagnosticsExportResponseMessage: Decodable, Sendable {
    public let success: Bool
    public let filePath: String?
    public let error: String?

    public init(success: Bool, filePath: String?, error: String?) {
        self.success = success
        self.filePath = filePath
        self.error = error
    }
}

/// Request daemon environment variables (debug only).
/// Backed by generated `EnvVarsRequest`.
public typealias EnvVarsRequestMessage = EnvVarsRequest

extension EnvVarsRequest {
    public init() {
        self.init(type: "env_vars_request")
    }
}

/// Response containing daemon environment variables (debug only).
/// Backed by generated `EnvVarsResponse`.
public typealias EnvVarsResponseMessage = EnvVarsResponse

extension SessionSwitchRequest {
    public init(sessionId: String) {
        self.init(type: "session_switch", sessionId: sessionId)
    }
}

extension ConversationSeenSignal {
    public init(
        conversationId: String,
        sourceChannel: String,
        signalType: String,
        confidence: String,
        source: String,
        evidenceText: String? = nil,
        observedAt: Int? = nil,
        metadata: [String: AnyCodable]? = nil
    ) {
        self.init(
            type: "conversation_seen_signal",
            conversationId: conversationId,
            sourceChannel: sourceChannel,
            signalType: signalType,
            confidence: confidence,
            source: source,
            evidenceText: evidenceText,
            observedAt: observedAt,
            metadata: metadata
        )
    }
}

extension ConversationUnreadSignal {
    public init(
        conversationId: String,
        sourceChannel: String,
        signalType: String,
        confidence: String,
        source: String,
        evidenceText: String? = nil,
        observedAt: Int? = nil,
        metadata: [String: AnyCodable]? = nil
    ) {
        self.init(
            type: "conversation_unread_signal",
            conversationId: conversationId,
            sourceChannel: sourceChannel,
            signalType: signalType,
            confidence: confidence,
            source: source,
            evidenceText: evidenceText,
            observedAt: observedAt,
            metadata: metadata
        )
    }
}

/// Sent by the client to request subagent detail (events) for a completed subagent.
public struct SubagentDetailRequestMessage: Encodable, Sendable {
    public let type: String = "subagent_detail_request"
    public let subagentId: String
    public let conversationId: String

    public init(subagentId: String, conversationId: String) {
        self.subagentId = subagentId
        self.conversationId = conversationId
    }
}

/// Sent by the client to abort a running subagent.
public struct SubagentAbortMessage: Encodable, Sendable {
    public let type: String = "subagent_abort"
    public let subagentId: String
    public let sessionId: String?

    public init(subagentId: String, sessionId: String? = nil) {
        self.subagentId = subagentId
        self.sessionId = sessionId
    }
}

/// Wraps any ServerMessage emitted by a subagent session for routing to the client.
/// Hand-maintained because `event` is a recursive `ServerMessage` reference (codegen skips ServerMessage).
/// Wire type: `"subagent_event"`
public struct SubagentEventMessage: Decodable, Sendable {
    public let subagentId: String
    public let event: ServerMessage
}

/// Discriminated union of all server → client message types relevant to the macOS client.
/// Decodes via the `"type"` field in the JSON payload.
public enum ServerMessage: Decodable, Sendable {
    case authResult(AuthResultMessage)
    case sessionError(SessionErrorMessage)
    case userMessageEcho(UserMessageEchoMessage)
    case assistantTextDelta(AssistantTextDeltaMessage)
    case assistantActivityState(AssistantActivityStateMessage)
    case assistantThinkingDelta(AssistantThinkingDeltaMessage)
    case messageComplete(MessageCompleteMessage)
    case sessionInfo(SessionInfoMessage)
    case sessionTitleUpdated(SessionTitleUpdatedMessage)
    case sessionListResponse(SessionListResponseMessage)
    case historyResponse(HistoryResponse)
    case memoryStatus(MemoryStatusMessage)
    case dictationResponse(DictationResponseMessage)
    case error(ErrorMessage)
    case uiSurfaceShow(UiSurfaceShowMessage)
    case uiSurfaceUpdate(UiSurfaceUpdateMessage)
    case uiSurfaceDismiss(UiSurfaceDismissMessage)
    case uiSurfaceComplete(UiSurfaceCompleteMessage)
    case uiLayoutConfig(UiLayoutConfigMessage)
    case undoComplete(UndoCompleteMessage)
    case generationCancelled(GenerationCancelledMessage)
    case generationHandoff(GenerationHandoffMessage)
    case confirmationRequest(ConfirmationRequestMessage)
    case confirmationStateChanged(ConfirmationStateChangedMessage)
    case secretRequest(SecretRequestMessage)
    case appDataResponse(AppDataResponseMessage)
    case messageQueued(MessageQueuedMessage)
    case messageDequeued(MessageDequeuedMessage)
    case messageRequestComplete(MessageRequestCompleteMessage)
    case messageQueuedDeleted(MessageQueuedDeletedMessage)
    case skillsListResponse(SkillsListResponseMessage)
    case skillDetailResponse(SkillDetailResponseMessage)
    case skillStateChanged(SkillStateChangedMessage)
    case skillsOperationResponse(SkillsOperationResponseMessage)
    case skillsInspectResponse(SkillsInspectResponseMessage)
    case skillsDraftResponse(SkillsDraftResponseMessage)
    case suggestionResponse(SuggestionResponseMessage)
    case toolUseStart(ToolUseStartMessage)
    case toolUsePreviewStart(ToolUsePreviewStartMessage)
    case toolInputDelta(ToolInputDeltaMessage)
    case toolOutputChunk(ToolOutputChunkMessage)
    case toolResult(ToolResultMessage)
    case notificationIntent(NotificationIntentMessage)
    case notificationConversationCreated(NotificationConversationCreated)
    case watchStarted(WatchStartedMessage)
    case watchCompleteRequest(WatchCompleteRequestMessage)
    case traceEvent(TraceEventMessage)
    case trustRulesListResponse(TrustRulesListResponseMessage)
    case toolPermissionSimulateResponse(ToolPermissionSimulateResponseMessage)
    case toolNamesListResponse(ToolNamesListResponseMessage)
    case acceptStarterBundleResponse(AcceptStarterBundleResponse)
    case schedulesListResponse(SchedulesListResponseMessage)
    case appsListResponse(AppsListResponseMessage)
    case appUpdatePreviewResponse(AppUpdatePreviewResponseMessage)
    case appPreviewResponse(AppPreviewResponseMessage)
    case appDiffResponse(AppDiffResponse)
    case appFileAtVersionResponse(AppFileAtVersionResponse)
    case appHistoryResponse(AppHistoryResponse)
    case appRestoreResponse(AppRestoreResponse)
    case sharedAppsListResponse(SharedAppsListResponseMessage)
    case appDeleteResponse(AppDeleteResponseMessage)
    case sharedAppDeleteResponse(SharedAppDeleteResponseMessage)
    case forkSharedAppResponse(ForkSharedAppResponseMessage)
    case bundleAppResponse(BundleAppResponseMessage)
    case openBundleResponse(OpenBundleResponseMessage)
    case signBundlePayload(SignBundlePayloadMessage)
    case shareAppCloudResponse(ShareAppCloudResponseMessage)
    case slackWebhookConfigResponse(SlackWebhookConfigResponseMessage)
    case ingressConfigResponse(IngressConfigResponseMessage)
    case platformConfigResponse(PlatformConfigResponseMessage)
    case vercelApiConfigResponse(VercelApiConfigResponseMessage)
    case channelVerificationSessionResponse(ChannelVerificationSessionResponseMessage)
    case telegramConfigResponse(TelegramConfigResponseMessage)
    case modelInfo(ModelInfoMessage)
    case publishPageResponse(PublishPageResponseMessage)
    case unpublishPageResponse(UnpublishPageResponseMessage)
    case uiSurfaceUndoResult(UiSurfaceUndoResultMessage)
    case documentEditorShow(DocumentEditorShowMessage)
    case documentEditorUpdate(DocumentEditorUpdateMessage)
    case documentSaveResponse(DocumentSaveResponseMessage)
    case documentLoadResponse(DocumentLoadResponseMessage)
    case documentListResponse(DocumentListResponseMessage)
    case daemonStatus(DaemonStatusMessage)
    case openUrl(OpenUrlMessage)
    case navigateSettings(NavigateSettings)
    case integrationListResponse(IntegrationListResponse)
    case integrationConnectResult(IntegrationConnectResult)
    case oauthConnectResult(OAuthConnectResultResponse)
    case appFilesChanged(AppFilesChangedMessage)
    case getSigningIdentity(GetSigningIdentityRequest)
    case diagnosticsExportResponse(DiagnosticsExportResponseMessage)
    case envVarsResponse(EnvVarsResponseMessage)
    case workItemsListResponse(WorkItemsListResponse)
    case workItemStatusChanged(WorkItemStatusChanged)
    case tasksChanged(TasksChanged)
    case contactsChanged(ContactsChanged)
    case workItemDeleteResponse(WorkItemDeleteResponse)
    case workItemRunTaskResponse(WorkItemRunTaskResponse)
    case workItemOutputResponse(WorkItemOutputResponse)
    case workItemUpdateResponse(WorkItemUpdateResponse)
    case workItemPreflightResponse(WorkItemPreflightResponse)
    case workItemApprovePermissionsResponse(WorkItemApprovePermissionsResponse)
    case workItemCancelResponse(WorkItemCancelResponse)
    case taskRunConversationCreated(TaskRunConversationCreated)
    case scheduleConversationCreated(ScheduleConversationCreated)
    case subagentSpawned(SubagentSpawned)
    case subagentStatusChanged(SubagentStatusChanged)
    indirect case subagentEvent(SubagentEventMessage)
    case subagentDetailResponse(SubagentDetailResponse)
    case workspaceFilesListResponse(WorkspaceFilesListResponseMessage)
    case workspaceFileReadResponse(WorkspaceFileReadResponseMessage)
    case identityGetResponse(IdentityGetResponseMessage)
    case conversationSearchResponse(ConversationSearchResponseMessage)
    case pairingApprovalRequest(PairingApprovalRequestMessage)
    case approvedDevicesListResponse(ApprovedDevicesListResponseMessage)
    case approvedDeviceRemoveResponse(ApprovedDeviceRemoveResponseMessage)
    case guardianActionsPendingResponse(GuardianActionsPendingResponseMessage)
    case guardianActionDecisionResponse(GuardianActionDecisionResponseMessage)
    case recordingPause(RecordingPause)
    case recordingResume(RecordingResume)
    case recordingStart(RecordingStart)
    case recordingStop(RecordingStop)
    case clientSettingsUpdate(ClientSettingsUpdate)
    case avatarUpdated(AvatarUpdated)
    case generateAvatarResponse(GenerateAvatarResponse)
    case heartbeatConfigResponse(HeartbeatConfigResponse)
    case heartbeatRunsListResponse(HeartbeatRunsListResponse)
    case heartbeatRunNowResponse(HeartbeatRunNowResponse)
    case heartbeatChecklistResponse(HeartbeatChecklistResponse)
    case heartbeatChecklistWriteResponse(HeartbeatChecklistWriteResponse)
    case messageContentResponse(MessageContentResponse)
    case contactsResponse(ContactsResponseMessage)
    case tokenRotated(TokenRotatedMessage)
    case identityChanged(IdentityChanged)
    case hostBashRequest(HostBashRequest)
    case hostFileRequest(HostFileRequest)
    case hostCuRequest(HostCuRequest)
    case pong
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case type
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "auth_result":
            let message = try AuthResultMessage(from: decoder)
            self = .authResult(message)
        case "session_error":
            let message = try SessionErrorMessage(from: decoder)
            self = .sessionError(message)
        case "user_message_echo":
            let message = try UserMessageEchoMessage(from: decoder)
            self = .userMessageEcho(message)
        case "assistant_text_delta":
            let message = try AssistantTextDeltaMessage(from: decoder)
            self = .assistantTextDelta(message)
        case "assistant_activity_state":
            let message = try AssistantActivityStateMessage(from: decoder)
            self = .assistantActivityState(message)
        case "assistant_thinking_delta":
            let message = try AssistantThinkingDeltaMessage(from: decoder)
            self = .assistantThinkingDelta(message)
        case "message_complete":
            let message = try MessageCompleteMessage(from: decoder)
            self = .messageComplete(message)
        case "session_info":
            let message = try SessionInfoMessage(from: decoder)
            self = .sessionInfo(message)
        case "session_title_updated":
            let message = try SessionTitleUpdatedMessage(from: decoder)
            self = .sessionTitleUpdated(message)
        case "session_list_response":
            let message = try SessionListResponseMessage(from: decoder)
            self = .sessionListResponse(message)
        case "history_response":
            let message = try HistoryResponse(from: decoder)
            self = .historyResponse(message)
        case "memory_status":
            let message = try MemoryStatusMessage(from: decoder)
            self = .memoryStatus(message)
        case "dictation_response":
            let message = try DictationResponseMessage(from: decoder)
            self = .dictationResponse(message)
        case "error":
            let message = try ErrorMessage(from: decoder)
            self = .error(message)
        case "ui_surface_show":
            let message = try UiSurfaceShowMessage(from: decoder)
            self = .uiSurfaceShow(message)
        case "ui_surface_update":
            let message = try UiSurfaceUpdateMessage(from: decoder)
            self = .uiSurfaceUpdate(message)
        case "ui_surface_dismiss":
            let message = try UiSurfaceDismissMessage(from: decoder)
            self = .uiSurfaceDismiss(message)
        case "ui_surface_complete":
            let message = try UiSurfaceCompleteMessage(from: decoder)
            self = .uiSurfaceComplete(message)
        case "document_editor_show":
            let message = try DocumentEditorShowMessage(from: decoder)
            self = .documentEditorShow(message)
        case "document_editor_update":
            let message = try DocumentEditorUpdateMessage(from: decoder)
            self = .documentEditorUpdate(message)
        case "document_save_response":
            let message = try DocumentSaveResponseMessage(from: decoder)
            self = .documentSaveResponse(message)
        case "document_load_response":
            let message = try DocumentLoadResponseMessage(from: decoder)
            self = .documentLoadResponse(message)
        case "document_list_response":
            let message = try DocumentListResponseMessage(from: decoder)
            self = .documentListResponse(message)
        case "ui_layout_config":
            let message = try UiLayoutConfigMessage(from: decoder)
            self = .uiLayoutConfig(message)
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
        case "confirmation_state_changed":
            let message = try ConfirmationStateChangedMessage(from: decoder)
            self = .confirmationStateChanged(message)
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
        case "message_request_complete":
            let message = try MessageRequestCompleteMessage(from: decoder)
            self = .messageRequestComplete(message)
        case "message_queued_deleted":
            let message = try MessageQueuedDeletedMessage(from: decoder)
            self = .messageQueuedDeleted(message)
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
        case "skills_draft_response":
            let message = try SkillsDraftResponseMessage(from: decoder)
            self = .skillsDraftResponse(message)
        case "suggestion_response":
            let message = try SuggestionResponseMessage(from: decoder)
            self = .suggestionResponse(message)
        case "tool_use_start":
            let message = try ToolUseStartMessage(from: decoder)
            self = .toolUseStart(message)
        case "tool_use_preview_start":
            let message = try ToolUsePreviewStartMessage(from: decoder)
            self = .toolUsePreviewStart(message)
        case "tool_input_delta":
            let message = try ToolInputDeltaMessage(from: decoder)
            self = .toolInputDelta(message)
        case "tool_output_chunk":
            let message = try ToolOutputChunkMessage(from: decoder)
            self = .toolOutputChunk(message)
        case "tool_result":
            let message = try ToolResultMessage(from: decoder)
            self = .toolResult(message)
        case "notification_intent":
            let message = try NotificationIntentMessage(from: decoder)
            self = .notificationIntent(message)
        case "notification_conversation_created":
            let message = try NotificationConversationCreated(from: decoder)
            self = .notificationConversationCreated(message)
        case "watch_started":
            let message = try WatchStartedMessage(from: decoder)
            self = .watchStarted(message)
        case "watch_complete_request":
            let message = try WatchCompleteRequestMessage(from: decoder)
            self = .watchCompleteRequest(message)
        case "trust_rules_list_response":
            let message = try TrustRulesListResponseMessage(from: decoder)
            self = .trustRulesListResponse(message)
        case "tool_permission_simulate_response":
            let message = try ToolPermissionSimulateResponseMessage(from: decoder)
            self = .toolPermissionSimulateResponse(message)
        case "tool_names_list_response":
            let message = try ToolNamesListResponseMessage(from: decoder)
            self = .toolNamesListResponse(message)
        case "accept_starter_bundle_response":
            let message = try AcceptStarterBundleResponse(from: decoder)
            self = .acceptStarterBundleResponse(message)
        case "schedules_list_response":
            let message = try SchedulesListResponseMessage(from: decoder)
            self = .schedulesListResponse(message)
        case "apps_list_response":
            let message = try AppsListResponseMessage(from: decoder)
            self = .appsListResponse(message)
        case "app_update_preview_response":
            let message = try AppUpdatePreviewResponseMessage(from: decoder)
            self = .appUpdatePreviewResponse(message)
        case "app_preview_response":
            let message = try AppPreviewResponseMessage(from: decoder)
            self = .appPreviewResponse(message)
        case "app_diff_response":
            let message = try AppDiffResponse(from: decoder)
            self = .appDiffResponse(message)
        case "app_file_at_version_response":
            let message = try AppFileAtVersionResponse(from: decoder)
            self = .appFileAtVersionResponse(message)
        case "app_history_response":
            let message = try AppHistoryResponse(from: decoder)
            self = .appHistoryResponse(message)
        case "app_restore_response":
            let message = try AppRestoreResponse(from: decoder)
            self = .appRestoreResponse(message)
        case "shared_apps_list_response":
            let message = try SharedAppsListResponseMessage(from: decoder)
            self = .sharedAppsListResponse(message)
        case "app_delete_response":
            let message = try AppDeleteResponseMessage(from: decoder)
            self = .appDeleteResponse(message)
        case "shared_app_delete_response":
            let message = try SharedAppDeleteResponseMessage(from: decoder)
            self = .sharedAppDeleteResponse(message)
        case "fork_shared_app_response":
            let message = try ForkSharedAppResponseMessage(from: decoder)
            self = .forkSharedAppResponse(message)
        case "bundle_app_response":
            let message = try BundleAppResponseMessage(from: decoder)
            self = .bundleAppResponse(message)
        case "open_bundle_response":
            let message = try OpenBundleResponseMessage(from: decoder)
            self = .openBundleResponse(message)
        case "trace_event":
            let message = try TraceEventMessage(from: decoder)
            self = .traceEvent(message)
        case "share_app_cloud_response":
            let message = try ShareAppCloudResponseMessage(from: decoder)
            self = .shareAppCloudResponse(message)
        case "slack_webhook_config_response":
            let message = try SlackWebhookConfigResponseMessage(from: decoder)
            self = .slackWebhookConfigResponse(message)
        case "ingress_config_response":
            let message = try IngressConfigResponseMessage(from: decoder)
            self = .ingressConfigResponse(message)
        case "platform_config_response":
            let message = try PlatformConfigResponseMessage(from: decoder)
            self = .platformConfigResponse(message)
        case "vercel_api_config_response":
            let message = try VercelApiConfigResponseMessage(from: decoder)
            self = .vercelApiConfigResponse(message)
        case "channel_verification_session_response":
            let message = try ChannelVerificationSessionResponseMessage(from: decoder)
            self = .channelVerificationSessionResponse(message)
        case "telegram_config_response":
            let message = try TelegramConfigResponseMessage(from: decoder)
            self = .telegramConfigResponse(message)
        case "model_info":
            let message = try ModelInfoMessage(from: decoder)
            self = .modelInfo(message)
        case "sign_bundle_payload":
            let message = try SignBundlePayloadMessage(from: decoder)
            self = .signBundlePayload(message)
        case "ui_surface_undo_result":
            let message = try UiSurfaceUndoResultMessage(from: decoder)
            self = .uiSurfaceUndoResult(message)
        case "open_url":
            let message = try OpenUrlMessage(from: decoder)
            self = .openUrl(message)
        case "navigate_settings":
            let message = try NavigateSettings(from: decoder)
            self = .navigateSettings(message)
        case "get_signing_identity":
            let message = try GetSigningIdentityRequest(from: decoder)
            self = .getSigningIdentity(message)
        case "daemon_status":
            let message = try DaemonStatusMessage(from: decoder)
            self = .daemonStatus(message)
        case "publish_page_response":
            let message = try PublishPageResponseMessage(from: decoder)
            self = .publishPageResponse(message)
        case "unpublish_page_response":
            let message = try UnpublishPageResponseMessage(from: decoder)
            self = .unpublishPageResponse(message)
        case "integration_list_response":
            let message = try IntegrationListResponse(from: decoder)
            self = .integrationListResponse(message)
        case "integration_connect_result":
            let message = try IntegrationConnectResult(from: decoder)
            self = .integrationConnectResult(message)
        case "oauth_connect_result":
            let message = try OAuthConnectResultResponse(from: decoder)
            self = .oauthConnectResult(message)
        case "app_files_changed":
            let message = try AppFilesChangedMessage(from: decoder)
            self = .appFilesChanged(message)
        case "diagnostics_export_response":
            let message = try DiagnosticsExportResponseMessage(from: decoder)
            self = .diagnosticsExportResponse(message)
        case "env_vars_response":
            let message = try EnvVarsResponseMessage(from: decoder)
            self = .envVarsResponse(message)
        case "work_items_list_response":
            let message = try WorkItemsListResponse(from: decoder)
            self = .workItemsListResponse(message)
        case "work_item_status_changed":
            let message = try WorkItemStatusChanged(from: decoder)
            self = .workItemStatusChanged(message)
        case "tasks_changed":
            let message = try TasksChanged(from: decoder)
            self = .tasksChanged(message)
        case "contacts_changed":
            let message = try ContactsChanged(from: decoder)
            self = .contactsChanged(message)
        case "work_item_delete_response":
            let message = try WorkItemDeleteResponse(from: decoder)
            self = .workItemDeleteResponse(message)
        case "work_item_run_task_response":
            let message = try WorkItemRunTaskResponse(from: decoder)
            self = .workItemRunTaskResponse(message)
        case "work_item_output_response":
            let message = try WorkItemOutputResponse(from: decoder)
            self = .workItemOutputResponse(message)
        case "work_item_update_response":
            let message = try WorkItemUpdateResponse(from: decoder)
            self = .workItemUpdateResponse(message)
        case "work_item_preflight_response":
            let message = try WorkItemPreflightResponse(from: decoder)
            self = .workItemPreflightResponse(message)
        case "work_item_approve_permissions_response":
            let message = try WorkItemApprovePermissionsResponse(from: decoder)
            self = .workItemApprovePermissionsResponse(message)
        case "work_item_cancel_response":
            let message = try WorkItemCancelResponse(from: decoder)
            self = .workItemCancelResponse(message)
        case "task_run_conversation_created":
            let message = try TaskRunConversationCreated(from: decoder)
            self = .taskRunConversationCreated(message)
        case "schedule_conversation_created":
            let message = try ScheduleConversationCreated(from: decoder)
            self = .scheduleConversationCreated(message)
        case "subagent_spawned":
            let message = try SubagentSpawned(from: decoder)
            self = .subagentSpawned(message)
        case "subagent_status_changed":
            let message = try SubagentStatusChanged(from: decoder)
            self = .subagentStatusChanged(message)
        case "subagent_event":
            let message = try SubagentEventMessage(from: decoder)
            self = .subagentEvent(message)
        case "subagent_detail_response":
            let message = try SubagentDetailResponse(from: decoder)
            self = .subagentDetailResponse(message)
        case "workspace_files_list_response":
            let message = try WorkspaceFilesListResponseMessage(from: decoder)
            self = .workspaceFilesListResponse(message)
        case "workspace_file_read_response":
            let message = try WorkspaceFileReadResponseMessage(from: decoder)
            self = .workspaceFileReadResponse(message)
        case "identity_get_response":
            let message = try IdentityGetResponseMessage(from: decoder)
            self = .identityGetResponse(message)
        case "conversation_search_response":
            let message = try ConversationSearchResponseMessage(from: decoder)
            self = .conversationSearchResponse(message)
        case "pairing_approval_request":
            let message = try PairingApprovalRequestMessage(from: decoder)
            self = .pairingApprovalRequest(message)
        case "approved_devices_list_response":
            let message = try ApprovedDevicesListResponseMessage(from: decoder)
            self = .approvedDevicesListResponse(message)
        case "approved_device_remove_response":
            let message = try ApprovedDeviceRemoveResponseMessage(from: decoder)
            self = .approvedDeviceRemoveResponse(message)
        case "guardian_actions_pending_response":
            let message = try GuardianActionsPendingResponseMessage(from: decoder)
            self = .guardianActionsPendingResponse(message)
        case "guardian_action_decision_response":
            let message = try GuardianActionDecisionResponseMessage(from: decoder)
            self = .guardianActionDecisionResponse(message)
        case "recording_pause":
            let message = try RecordingPause(from: decoder)
            self = .recordingPause(message)
        case "recording_resume":
            let message = try RecordingResume(from: decoder)
            self = .recordingResume(message)
        case "recording_start":
            let message = try RecordingStart(from: decoder)
            self = .recordingStart(message)
        case "recording_stop":
            let message = try RecordingStop(from: decoder)
            self = .recordingStop(message)
        case "client_settings_update":
            let message = try ClientSettingsUpdate(from: decoder)
            self = .clientSettingsUpdate(message)
        case "avatar_updated":
            let message = try AvatarUpdated(from: decoder)
            self = .avatarUpdated(message)
        case "generate_avatar_response":
            let message = try GenerateAvatarResponse(from: decoder)
            self = .generateAvatarResponse(message)
        case "heartbeat_config_response":
            let message = try HeartbeatConfigResponse(from: decoder)
            self = .heartbeatConfigResponse(message)
        case "heartbeat_runs_list_response":
            let message = try HeartbeatRunsListResponse(from: decoder)
            self = .heartbeatRunsListResponse(message)
        case "heartbeat_run_now_response":
            let message = try HeartbeatRunNowResponse(from: decoder)
            self = .heartbeatRunNowResponse(message)
        case "heartbeat_checklist_response":
            let message = try HeartbeatChecklistResponse(from: decoder)
            self = .heartbeatChecklistResponse(message)
        case "heartbeat_checklist_write_response":
            let message = try HeartbeatChecklistWriteResponse(from: decoder)
            self = .heartbeatChecklistWriteResponse(message)
        case "message_content_response":
            let message = try MessageContentResponse(from: decoder)
            self = .messageContentResponse(message)
        case "contacts_response":
            let message = try ContactsResponseMessage(from: decoder)
            self = .contactsResponse(message)
        case "token_rotated":
            let message = try TokenRotatedMessage(from: decoder)
            self = .tokenRotated(message)
        case "identity_changed":
            let message = try IdentityChanged(from: decoder)
            self = .identityChanged(message)
        case "host_bash_request":
            let message = try HostBashRequest(from: decoder)
            self = .hostBashRequest(message)
        case "host_file_request":
            let message = try HostFileRequest(from: decoder)
            self = .hostFileRequest(message)
        case "host_cu_request":
            let message = try HostCuRequest(from: decoder)
            self = .hostCuRequest(message)
        case "pong":
            self = .pong
        default:
            self = .unknown(type)
        }
    }
}


// MARK: - Token Rotation

/// Received when the daemon rotates its bearer token.
public struct TokenRotatedMessage: Decodable, Sendable {
    public let newToken: String
    public let expiresOldAt: Double
}

// MARK: - App Files Changed

public typealias AppFilesChangedMessage = AppFilesChanged

// MARK: - Layout Config Wire Types
// Defined here temporarily; canonical home is LayoutConfig.swift (M1 / #2973)

public struct UiLayoutConfigMessage: Decodable, Sendable {
    public let left: SlotConfigWire?
    public let center: SlotConfigWire?
    public let right: SlotConfigWire?
}

public struct SlotConfigWire: Decodable, Sendable {
    public let content: SlotContentWire?
    /// Tri-state width: `.none` = field missing (preserve base), `.some(nil)` = explicit null (reset to nil), `.some(value)` = new value.
    public let width: Optional<Double>?
    public let visible: Bool?

    private enum CodingKeys: String, CodingKey {
        case content, width, visible
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        content = try container.decodeIfPresent(SlotContentWire.self, forKey: .content)
        visible = try container.decodeIfPresent(Bool.self, forKey: .visible)

        if container.contains(.width) {
            // Field is present in JSON — decode as .some(Double) or .some(nil) for explicit null
            width = .some(try container.decodeIfPresent(Double.self, forKey: .width))
        } else {
            // Field is missing from JSON — outer nil signals "no change"
            width = .none
        }
    }
}

public struct SlotContentWire: Decodable, Sendable {
    public let type: String
    public let panel: String?
    public let surfaceId: String?
}

// MARK: - Pairing Messages

/// Server → Client: daemon asks macOS to show a pairing approval prompt.
public struct PairingApprovalRequestMessage: Decodable, Sendable {
    public let pairingRequestId: String
    public let deviceId: String
    public let deviceName: String
}

/// Server → Client: list of always-allowed devices.
public struct ApprovedDevicesListResponseMessage: Decodable, Sendable {
    public struct Device: Decodable, Sendable {
        public let hashedDeviceId: String
        public let deviceName: String
        public let lastPairedAt: Int
    }
    public let devices: [Device]
}

/// Server → Client: confirmation of device removal.
public struct ApprovedDeviceRemoveResponseMessage: Decodable, Sendable {
    public let success: Bool
}

/// Client → Server: Mac user's decision on a pairing request.
public struct PairingApprovalResponseMessage: Encodable, Sendable {
    public let type: String = "pairing_approval_response"
    public let pairingRequestId: String
    public let decision: String

    public init(pairingRequestId: String, decision: String) {
        self.pairingRequestId = pairingRequestId
        self.decision = decision
    }
}

/// Client → Server: request list of always-allowed devices.
public struct ApprovedDevicesListMessage: Encodable, Sendable {
    public let type: String = "approved_devices_list"

    public init() {}
}

/// Client → Server: revoke a device's always-allow status.
public struct ApprovedDeviceRemoveMessage: Encodable, Sendable {
    public let type: String = "approved_device_remove"
    public let hashedDeviceId: String

    public init(hashedDeviceId: String) {
        self.hashedDeviceId = hashedDeviceId
    }
}

/// Client → Server: clear all approved devices.
public struct ApprovedDevicesClearMessage: Encodable, Sendable {
    public let type: String = "approved_devices_clear"

    public init() {}
}

// MARK: - Guardian Action Messages

/// A single action button a guardian can press.
public struct GuardianActionOption: Decodable, Sendable, Equatable {
    public let action: String
    public let label: String

    public init(action: String, label: String) {
        self.action = action
        self.label = label
    }
}

/// A pending guardian decision prompt.
public struct GuardianDecisionPromptWire: Decodable, Sendable {
    public let requestId: String
    public let requestCode: String
    public let state: String
    public let questionText: String
    public let toolName: String?
    public let actions: [GuardianActionOption]
    public let expiresAt: Int
    public let conversationId: String
    public let callSessionId: String?
    /// Canonical request kind (e.g. "tool_approval", "pending_question").
    /// Present when the prompt originates from the canonical guardian request store.
    public let kind: String?
}

/// Server -> Client: list of pending guardian decision prompts.
public struct GuardianActionsPendingResponseMessage: Decodable, Sendable {
    public let conversationId: String?
    public let prompts: [GuardianDecisionPromptWire]
}

/// Server -> Client: result of a guardian action decision.
public struct GuardianActionDecisionResponseMessage: Decodable, Sendable {
    public let applied: Bool
    public let reason: String?
    public let resolverFailureReason: String?
    public let requestId: String?
    public let userText: String?
}

/// Client -> Server: request pending guardian actions for a conversation.
public struct GuardianActionsPendingRequestMessage: Encodable, Sendable {
    public let type: String = "guardian_actions_pending_request"
    public let conversationId: String

    public init(conversationId: String) {
        self.conversationId = conversationId
    }
}

/// Client -> Server: submit a guardian action decision.
public struct GuardianActionDecisionMessage: Encodable, Sendable {
    public let type: String = "guardian_action_decision"
    public let requestId: String
    public let action: String
    public let conversationId: String?

    public init(requestId: String, action: String, conversationId: String? = nil) {
        self.requestId = requestId
        self.action = action
        self.conversationId = conversationId
    }
}

// MARK: - Contacts

/// Client → Server: contacts management request.
/// Backed by generated `ContactsRequest`.
public typealias ContactsRequestMessage = ContactsRequest

extension ContactsRequest {
    public init(action: String, contactId: String? = nil, channelId: String? = nil, status: String? = nil, policy: String? = nil, reason: String? = nil, role: String? = nil, limit: Int? = nil) {
        self.init(type: "contacts", action: action, contactId: contactId, channelId: channelId, status: status, policy: policy, reason: reason, role: role, limit: limit.map(Double.init))
    }
}

/// Server → Client: contacts response.
/// Backed by generated `ContactsResponse`.
public typealias ContactsResponseMessage = ContactsResponse


extension ContactPayload: Identifiable {}


extension ContactChannelPayload: Identifiable {}

extension ContactChannelPayload: Equatable {
    public static func == (lhs: ContactChannelPayload, rhs: ContactChannelPayload) -> Bool {
        lhs.id == rhs.id &&
        lhs.type == rhs.type &&
        lhs.address == rhs.address &&
        lhs.isPrimary == rhs.isPrimary &&
        lhs.externalUserId == rhs.externalUserId &&
        lhs.status == rhs.status &&
        lhs.policy == rhs.policy &&
        lhs.verifiedAt == rhs.verifiedAt &&
        lhs.verifiedVia == rhs.verifiedVia &&
        lhs.lastSeenAt == rhs.lastSeenAt &&
        lhs.interactionCount == rhs.interactionCount &&
        lhs.lastInteraction == rhs.lastInteraction &&
        lhs.revokedReason == rhs.revokedReason &&
        lhs.blockedReason == rhs.blockedReason
    }
}

extension ContactPayload: Equatable {
    public static func == (lhs: ContactPayload, rhs: ContactPayload) -> Bool {
        lhs.id == rhs.id &&
        lhs.displayName == rhs.displayName &&
        lhs.role == rhs.role &&
        lhs.notes == rhs.notes &&
        lhs.contactType == rhs.contactType &&
        lhs.lastInteraction == rhs.lastInteraction &&
        lhs.interactionCount == rhs.interactionCount &&
        lhs.channels == rhs.channels
    }
}

// MARK: - Work Item Helpers

extension WorkItemsListResponseItem {
    /// Returns a copy with a different `priorityTier`, preserving all other fields.
    public func withPriorityTier(_ newTier: Double) -> Self {
        Self(id: id, taskId: taskId, title: title, notes: notes, status: status, priorityTier: newTier, sortIndex: sortIndex, lastRunId: lastRunId, lastRunConversationId: lastRunConversationId, lastRunStatus: lastRunStatus, sourceType: sourceType, sourceId: sourceId, createdAt: createdAt, updatedAt: updatedAt)
    }
}
