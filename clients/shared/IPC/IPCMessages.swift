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
// │ AnyCodable                      │ Infrastructure — not an IPC message type │
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
/// Backed by generated `IPCUserMessageAttachment`.
public typealias IPCAttachment = IPCUserMessageAttachment

extension IPCUserMessageAttachment {
    public init(filename: String, mimeType: String, data: String, extractedText: String?) {
        self.init(id: nil, filename: filename, mimeType: mimeType, data: data, extractedText: extractedText, sizeBytes: nil, thumbnailData: nil)
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
    public init(
        sessionId: String,
        axTree: String?,
        axDiff: String?,
        secondaryWindows: String?,
        screenshot: String?,
        screenshotWidthPx: Double? = nil,
        screenshotHeightPx: Double? = nil,
        screenWidthPt: Double? = nil,
        screenHeightPt: Double? = nil,
        coordinateOrigin: String? = nil,
        captureDisplayId: Double? = nil,
        executionResult: String?,
        executionError: String?,
        axTreeBlob: IPCIpcBlobRef? = nil,
        screenshotBlob: IPCIpcBlobRef? = nil,
        userGuidance: String? = nil
    ) {
        self.init(
            type: "cu_observation",
            sessionId: sessionId,
            axTree: axTree,
            axDiff: axDiff,
            secondaryWindows: secondaryWindows,
            screenshot: screenshot,
            screenshotWidthPx: screenshotWidthPx,
            screenshotHeightPx: screenshotHeightPx,
            screenWidthPt: screenWidthPt,
            screenHeightPt: screenHeightPt,
            coordinateOrigin: coordinateOrigin,
            captureDisplayId: captureDisplayId,
            executionResult: executionResult,
            executionError: executionError,
            axTreeBlob: axTreeBlob,
            screenshotBlob: screenshotBlob,
            userGuidance: userGuidance
        )
    }
}

/// Sent to start a ride shotgun observation session.
/// Backed by generated `IPCRideShotgunStart`.
public typealias RideShotgunStartMessage = IPCRideShotgunStart

extension IPCRideShotgunStart {
    public init(durationSeconds: Double, intervalSeconds: Double, mode: String? = nil, targetDomain: String? = nil, navigateDomain: String? = nil, autoNavigate: Bool? = nil) {
        self.init(type: "ride_shotgun_start", durationSeconds: durationSeconds, intervalSeconds: intervalSeconds, mode: mode, targetDomain: targetDomain, navigateDomain: navigateDomain, autoNavigate: autoNavigate)
    }
}

/// Sent to stop a ride shotgun session early (with recording finalization).
/// Backed by generated `IPCRideShotgunStop`.
public typealias RideShotgunStopMessage = IPCRideShotgunStop

extension IPCRideShotgunStop {
    public init(watchId: String) {
        self.init(type: "ride_shotgun_stop", watchId: watchId)
    }
}

/// Sent by the watch agent with OCR text from periodic screen captures.
/// Backed by generated `IPCWatchObservation`.
public typealias WatchObservationMessage = IPCWatchObservation

extension IPCWatchObservation {
    public init(watchId: String, sessionId: String, ocrText: String, appName: String?, windowTitle: String?, bundleIdentifier: String?, timestamp: Double, captureIndex: Int, totalExpected: Int) {
        self.init(type: "watch_observation", watchId: watchId, sessionId: sessionId, ocrText: ocrText, appName: appName, windowTitle: windowTitle, bundleIdentifier: bundleIdentifier, timestamp: timestamp, captureIndex: captureIndex, totalExpected: totalExpected)
    }
}

/// Sent to create a new Q&A session.
/// Backed by generated `IPCSessionCreateRequest`.
public typealias SessionCreateMessage = IPCSessionCreateRequest

private func buildSessionTransportMetadata(
    channelId: String?,
    interfaceId: String?,
    hints: [String]?,
    uxBrief: String?
) -> IPCSessionTransportMetadata? {
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
        return try JSONDecoder().decode(IPCSessionTransportMetadata.self, from: data)
    } catch {
        return nil
    }
}

extension IPCSessionCreateRequest {
    private static var defaultTransportInterface: String {
        #if os(macOS)
        return "macos"
        #elseif os(iOS)
        return "ios"
        #else
        return "vellum"
        #endif
    }

    public init(title: String?, systemPromptOverride: String? = nil, maxResponseTokens: Int? = nil, correlationId: String? = nil, transport: IPCSessionTransportMetadata? = nil, threadType: String? = nil, preactivatedSkillIds: [String]? = nil, initialMessage: String? = nil) {
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
/// Backed by generated `IPCUserMessage`.
public typealias UserMessageMessage = IPCUserMessage

extension IPCUserMessage {
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

    public init(sessionId: String, content: String, attachments: [IPCAttachment]?, activeSurfaceId: String? = nil, currentPage: String? = nil, bypassSecretCheck: Bool? = nil, channel: String? = nil, interface: String? = nil, pttActivationKey: String? = nil, microphonePermissionGranted: Bool? = nil) {
        self.init(type: "user_message", sessionId: sessionId, content: content, attachments: attachments, activeSurfaceId: activeSurfaceId, currentPage: currentPage, bypassSecretCheck: bypassSecretCheck, channel: channel ?? Self.defaultChannel, interface: interface ?? Self.defaultInterface, pttActivationKey: pttActivationKey, microphonePermissionGranted: microphonePermissionGranted)
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

/// Authenticate to the daemon on initial socket connect.
/// Backed by generated `IPCAuthMessage`.
public typealias AuthMessage = IPCAuthMessage

extension IPCAuthMessage {
    public init(token: String) {
        self.init(type: "auth", token: token)
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
/// Hand-written to allow optional `sessionId` (the generated `IPCUiSurfaceAction` requires non-nil).
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
/// Backed by generated `IPCUiSurfaceUndoRequest`.
public typealias UiSurfaceUndoMessage = IPCUiSurfaceUndoRequest

extension IPCUiSurfaceUndoRequest {
    public init(sessionId: String, surfaceId: String) {
        self.init(type: "ui_surface_undo", sessionId: sessionId, surfaceId: surfaceId)
    }
}

/// Result of a surface undo operation.
/// Backed by generated `IPCUiSurfaceUndoResult`.
public typealias UiSurfaceUndoResultMessage = IPCUiSurfaceUndoResult

/// Sent when a persistent app's JS makes a data request via the RPC bridge.
/// Backed by generated `IPCAppDataRequest`.
public typealias AppDataRequestMessage = IPCAppDataRequest

extension IPCAppDataRequest {
    public init(surfaceId: String, callId: String, method: String, appId: String, recordId: String?, data: [String: AnyCodable]?) {
        self.init(type: "app_data_request", surfaceId: surfaceId, callId: callId, method: method, appId: appId, recordId: recordId, data: data)
    }
}

/// Sent to request opening a URL in the user's browser.
/// Backed by generated `IPCLinkOpenRequest`.
public typealias LinkOpenRequestMessage = IPCLinkOpenRequest

extension IPCLinkOpenRequest {
    public init(url: String, metadata: [String: AnyCodable]?) {
        self.init(type: "link_open_request", url: url, metadata: metadata)
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

/// Sent to update an app's preview screenshot.
/// Backed by generated `IPCAppUpdatePreviewRequest`.
public typealias AppUpdatePreviewRequestMessage = IPCAppUpdatePreviewRequest

extension IPCAppUpdatePreviewRequest {
    public init(appId: String, preview: String) {
        self.init(type: "app_update_preview", appId: appId, preview: preview)
    }
}

/// Response from updating an app's preview screenshot.
/// Backed by generated `IPCAppUpdatePreviewResponse`.
public typealias AppUpdatePreviewResponseMessage = IPCAppUpdatePreviewResponse

/// Sent to request a single app's preview screenshot.
/// Backed by generated `IPCAppPreviewRequest`.
public typealias AppPreviewRequestMessage = IPCAppPreviewRequest

/// Response with a single app's preview screenshot.
/// Backed by generated `IPCAppPreviewResponse`.
public typealias AppPreviewResponseMessage = IPCAppPreviewResponse

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

/// Sent to delete a persistent user-created app by ID.
/// Backed by generated `IPCAppDeleteRequest`.
public typealias AppDeleteRequestMessage = IPCAppDeleteRequest

extension IPCAppDeleteRequest {
    public init(appId: String) {
        self.init(type: "app_delete", appId: appId)
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
/// Backed by generated `IPCBundleAppRequest`.
public typealias BundleAppRequestMessage = IPCBundleAppRequest

extension IPCBundleAppRequest {
    public init(appId: String) {
        self.init(type: "bundle_app", appId: appId)
    }
}

/// Sent to open and scan a .vellum bundle.
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
    public init(offset: Int? = nil, limit: Int? = nil) {
        self.init(type: "session_list", offset: offset.map(Double.init), limit: limit.map(Double.init))
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

/// Draft a skill from source text.
/// Backed by generated `IPCSkillsDraftRequest`.
public typealias SkillsDraftRequestMessage = IPCSkillsDraftRequest

extension IPCSkillsDraftRequest {
    public init(sourceText: String) {
        self.init(type: "skills_draft", sourceText: sourceText)
    }
}

/// Create a managed skill.
/// Backed by generated `IPCSkillsCreateRequest`.
public typealias SkillsCreateMessage = IPCSkillsCreateRequest

extension IPCSkillsCreateRequest {
    public init(skillId: String, name: String, description: String, emoji: String? = nil, bodyMarkdown: String, userInvocable: Bool? = nil, disableModelInvocation: Bool? = nil, overwrite: Bool? = nil) {
        self.init(type: "skills_create", skillId: skillId, name: name, description: description, emoji: emoji, bodyMarkdown: bodyMarkdown, userInvocable: userInvocable, disableModelInvocation: disableModelInvocation, overwrite: overwrite)
    }
}

/// Backed by generated `IPCSkillsDraftResponse`.
public typealias SkillsDraftResponseMessage = IPCSkillsDraftResponse

/// Response to a sign_bundle_payload request from the daemon.
/// Backed by generated `IPCSignBundlePayloadResponse`.
public typealias SignBundlePayloadResponseMessage = IPCSignBundlePayloadResponse

extension IPCSignBundlePayloadResponse {
    public init(requestId: String, signature: String, keyId: String, publicKey: String) {
        self.init(type: "sign_bundle_payload_response", requestId: requestId, signature: signature, keyId: keyId, publicKey: publicKey, error: nil)
    }

    public init(requestId: String, error: String) {
        self.init(type: "sign_bundle_payload_response", requestId: requestId, signature: nil, keyId: nil, publicKey: nil, error: error)
    }
}

/// Response to a get_signing_identity request from the daemon.
/// Backed by generated `IPCGetSigningIdentityResponse`.
public typealias GetSigningIdentityResponseMessage = IPCGetSigningIdentityResponse

extension IPCGetSigningIdentityResponse {
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

/// Echoes a user message back to the client (e.g. relay_prompt from a surface action).
/// Backed by generated `IPCUserMessageEcho`.
public typealias UserMessageEchoMessage = IPCUserMessageEcho

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
    public init(sessionId: String? = nil, attachments: [IPCUserMessageAttachment]? = nil) {
        self.init(type: "message_complete", sessionId: sessionId, attachments: attachments)
    }
}

/// Session metadata from the server (e.g. generated title).
/// Backed by generated `IPCSessionInfo`.
public typealias SessionInfoMessage = IPCSessionInfo

extension IPCSessionInfo {
    public init(sessionId: String, title: String, correlationId: String? = nil, threadType: String? = nil) {
        self.init(type: "session_info", sessionId: sessionId, title: title, correlationId: correlationId, threadType: threadType)
    }
}

/// Session title update push message emitted after first-turn auto-titling.
/// Backed by generated `IPCSessionTitleUpdated`.
public typealias SessionTitleUpdatedMessage = IPCSessionTitleUpdated

extension IPCSessionTitleUpdated {
    public init(sessionId: String, title: String) {
        self.init(type: "session_title_updated", sessionId: sessionId, title: title)
    }
}

/// Memory recall telemetry event.
/// Backed by generated `IPCMemoryRecalled`.
public typealias MemoryRecalledMessage = IPCMemoryRecalled

extension IPCMemoryRecalled {
    public init(
        provider: String,
        model: String,
        lexicalHits: Double,
        semanticHits: Double,
        recencyHits: Double,
        entityHits: Double,
        relationSeedEntityCount: Int? = nil,
        relationTraversedEdgeCount: Int? = nil,
        relationNeighborEntityCount: Int? = nil,
        relationExpandedItemCount: Int? = nil,
        earlyTerminated: Bool? = nil,
        mergedCount: Int,
        selectedCount: Int,
        rerankApplied: Bool,
        injectedTokens: Int,
        latencyMs: Double,
        topCandidates: [IPCMemoryRecalledCandidateDebug]
    ) {
        self.init(
            type: "memory_recalled",
            provider: provider,
            model: model,
            lexicalHits: lexicalHits,
            semanticHits: semanticHits,
            recencyHits: recencyHits,
            entityHits: entityHits,
            relationSeedEntityCount: relationSeedEntityCount,
            relationTraversedEdgeCount: relationTraversedEdgeCount,
            relationNeighborEntityCount: relationNeighborEntityCount,
            relationExpandedItemCount: relationExpandedItemCount,
            earlyTerminated: earlyTerminated,
            mergedCount: mergedCount,
            selectedCount: selectedCount,
            rerankApplied: rerankApplied,
            injectedTokens: injectedTokens,
            latencyMs: latencyMs,
            topCandidates: topCandidates
        )
    }
}

/// Memory availability/degradation status event.
/// Backed by generated `IPCMemoryStatus`.
public typealias MemoryStatusMessage = IPCMemoryStatus

/// Daemon response after classifying and routing a task_submit.
public typealias TaskRoutedMessage = IPCTaskRouted

/// Daemon response to a dictation_request with cleaned text and mode classification.
public typealias DictationResponseMessage = IPCDictationResponse

extension IPCDictationContext {
    public static func create(bundleIdentifier: String, appName: String, windowTitle: String, selectedText: String?, cursorInTextField: Bool) -> IPCDictationContext {
        IPCDictationContext(bundleIdentifier: bundleIdentifier, appName: appName, windowTitle: windowTitle, selectedText: selectedText, cursorInTextField: cursorInTextField)
    }
}

extension IPCDictationRequest {
    public init(transcription: String, context: IPCDictationContext, profileId: String? = nil) {
        self.init(type: "dictation_request", transcription: transcription, context: context, profileId: profileId)
    }
}

/// Bootstrap failure during learn-mode recording setup.
public typealias RideShotgunErrorMessage = IPCRideShotgunError

/// Progress update from a ride shotgun auto-navigation session.
public typealias RideShotgunProgressMessage = IPCRideShotgunProgress

/// Result from a ride shotgun observation session.
public typealias RideShotgunResultMessage = IPCRideShotgunResult

/// Instructs the client to open a URL in the browser.
/// Backed by generated `IPCOpenUrl`.
public typealias OpenUrlMessage = IPCOpenUrl

/// Daemon status sent on connect — includes runtime HTTP port when available.
public typealias DaemonStatusMessage = IPCDaemonStatusMessage

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
/// Backed by generated `IPCSurfaceAction`.
public typealias SurfaceActionData = IPCSurfaceAction

/// Surface update command from daemon.
/// Wire type: `"ui_surface_update"`
public struct UiSurfaceUpdateMessage: Decodable, Sendable {
    public let sessionId: String?
    public let surfaceId: String
    public let data: AnyCodable
}

/// Surface dismiss command from daemon.
/// Backed by generated `IPCUiSurfaceDismiss`.
public typealias UiSurfaceDismissMessage = IPCUiSurfaceDismiss

/// Surface completion message from daemon, sent when user interaction completes a surface.
public struct UiSurfaceCompleteMessage: Decodable, Sendable {
    public let sessionId: String?
    public let surfaceId: String
    public let summary: String
    public let submittedData: [String: AnyCodable]?
}

/// Document editor messages — backed by generated types from IPC contract.
public typealias DocumentEditorShowMessage = IPCDocumentEditorShow
public typealias DocumentEditorUpdateMessage = IPCDocumentEditorUpdate
public typealias DocumentSaveRequestMessage = IPCDocumentSaveRequest
public typealias DocumentSaveResponseMessage = IPCDocumentSaveResponse
public typealias DocumentLoadRequestMessage = IPCDocumentLoadRequest
public typealias DocumentLoadResponseMessage = IPCDocumentLoadResponse
public typealias DocumentListRequestMessage = IPCDocumentListRequest
public typealias DocumentListResponseMessage = IPCDocumentListResponse
public typealias DocumentListResponseDocument = IPCDocumentListResponseDocument

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
    public init(sessionId: String, requestId: String?, queuedCount: Int, attachments: [IPCUserMessageAttachment]? = nil) {
        self.init(type: "generation_handoff", sessionId: sessionId, requestId: requestId, queuedCount: queuedCount, attachments: attachments)
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

/// Request-level terminal signal for a queued/dequeued lifecycle.
/// Does not imply the active assistant turn has completed.
/// Backed by generated `IPCMessageRequestComplete`.
public typealias MessageRequestCompleteMessage = IPCMessageRequestComplete

extension IPCMessageRequestComplete {
    public init(sessionId: String, requestId: String, runStillActive: Bool? = nil) {
        self.init(type: "message_request_complete", sessionId: sessionId, requestId: requestId, runStillActive: runStillActive)
    }
}

/// Notifies client that a queued message was successfully deleted.
/// Backed by generated `IPCMessageQueuedDeleted`.
public typealias MessageQueuedDeletedMessage = IPCMessageQueuedDeleted

extension IPCMessageQueuedDeleted {
    public init(sessionId: String, requestId: String) {
        self.init(type: "message_queued_deleted", sessionId: sessionId, requestId: requestId)
    }
}

/// Client → Server request to delete a specific queued message.
/// Backed by generated `IPCDeleteQueuedMessage`.
public typealias DeleteQueuedMessageMessage = IPCDeleteQueuedMessage

extension IPCDeleteQueuedMessage {
    public init(sessionId: String, requestId: String) {
        self.init(type: "delete_queued_message", sessionId: sessionId, requestId: requestId)
    }
}

/// Server-level error message.
/// Backed by generated `IPCErrorMessage`.
public typealias ErrorMessage = IPCErrorMessage

extension IPCErrorMessage {
    public init(message: String, category: String? = nil) {
        self.init(type: "error", message: message, category: category)
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

/// Provenance metadata indicating whether a skill is first-party, third-party, or local.
/// Backed by generated `IPCSkillsListResponseSkillProvenance`.
public typealias SkillProvenance = IPCSkillsListResponseSkillProvenance

/// Full skill info from the daemon's resolved skill list.
/// Backed by generated `IPCSkillsListResponseSkill`.
public typealias SkillInfo = IPCSkillsListResponseSkill

extension IPCSkillsListResponseSkill: Identifiable {}

extension IPCSkillsListResponseSkill {
    /// Returns a copy with a different `state`, preserving all other fields including `id`.
    public func withState(_ newState: String) -> Self {
        Self(id: id, name: name, description: description, emoji: emoji, homepage: homepage, source: source, state: newState, degraded: degraded, missingRequirements: missingRequirements, installedVersion: installedVersion, latestVersion: latestVersion, updateAvailable: updateAvailable, userInvocable: userInvocable, clawhub: clawhub, provenance: provenance)
    }
}

/// Response containing the list of available skills.
/// Backed by generated `IPCSkillsListResponse`.
public typealias SkillsListResponseMessage = IPCSkillsListResponse

/// Response containing the full body of a specific skill.
/// Backed by generated `IPCSkillDetailResponse`.
public typealias SkillDetailResponseMessage = IPCSkillDetailResponse

// MARK: - Conversation Search

/// Response containing conversation search results.
/// Backed by generated `IPCConversationSearchResponse`.
public typealias ConversationSearchResponseMessage = IPCConversationSearchResponse

// MARK: - Workspace Files

/// Request to list workspace files.
public typealias WorkspaceFilesListRequestMessage = IPCWorkspaceFilesListRequest

extension IPCWorkspaceFilesListRequest {
    public init() {
        self.init(type: "workspace_files_list")
    }
}

/// Request to read a workspace file's content.
public typealias WorkspaceFileReadRequestMessage = IPCWorkspaceFileReadRequest

extension IPCWorkspaceFileReadRequest {
    public init(path: String) {
        self.init(type: "workspace_file_read", path: path)
    }
}

/// Response containing the list of workspace files.
public typealias WorkspaceFilesListResponseMessage = IPCWorkspaceFilesListResponse

/// Individual workspace file entry.
public typealias WorkspaceFileInfo = IPCWorkspaceFilesListResponseFile

extension IPCWorkspaceFilesListResponseFile: Identifiable {
    public var id: String { path }
}

/// Response containing a workspace file's content.
public typealias WorkspaceFileReadResponseMessage = IPCWorkspaceFileReadResponse

/// Request to fetch assistant identity info via IPC.
public typealias IdentityGetRequestMessage = IPCIdentityGetRequest

extension IPCIdentityGetRequest {
    public init() {
        self.init(type: "identity_get")
    }
}

/// Response containing assistant identity info.
public typealias IdentityGetResponseMessage = IPCIdentityGetResponse

/// Request to generate a custom avatar via DALL-E.
public typealias GenerateAvatarRequestMessage = IPCGenerateAvatarRequest

extension IPCGenerateAvatarRequest {
    public init(description: String) {
        self.init(type: "generate_avatar", description: description)
    }
}

/// Response indicating whether avatar generation succeeded.
public typealias GenerateAvatarResponseMessage = IPCGenerateAvatarResponse

/// Push event: skill state changed.
/// Backed by generated `IPCSkillStateChanged`.
public typealias SkillStateChangedMessage = IPCSkillStateChanged

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

/// Attention state metadata for a conversation's latest assistant message.
/// Backed by generated `IPCAssistantAttention`.
public typealias AssistantAttention = IPCAssistantAttention

/// Response containing the list of past sessions.
/// Backed by generated `IPCSessionListResponse`.
public typealias SessionListResponseMessage = IPCSessionListResponse

/// Response containing message history for a session.
/// Backed by generated `IPCHistoryResponse`.
public typealias HistoryResponseMessage = IPCHistoryResponse


/// A single scheduled task item returned from the daemon.
/// Backed by generated `IPCSchedulesListResponseSchedule`.
public typealias ScheduleItem = IPCSchedulesListResponseSchedule

extension IPCSchedulesListResponseSchedule: Identifiable {}

/// Response containing all scheduled tasks.
/// Backed by generated `IPCSchedulesListResponse`.
public typealias SchedulesListResponseMessage = IPCSchedulesListResponse

/// A single reminder item returned from the daemon.
/// Backed by generated `IPCRemindersListResponseReminder`.
public typealias ReminderItem = IPCRemindersListResponseReminder

extension IPCRemindersListResponseReminder: Identifiable {}

/// Response containing all reminders.
/// Backed by generated `IPCRemindersListResponse`.
public typealias RemindersListResponseMessage = IPCRemindersListResponse

/// Request all reminders from the daemon.
/// Backed by generated `IPCRemindersList`.
public typealias RemindersListMessage = IPCRemindersList

extension IPCRemindersList {
    public init() {
        self.init(type: "reminders_list")
    }
}

/// Cancel a reminder by ID.
/// Backed by generated `IPCReminderCancel`.
public typealias ReminderCancelMessage = IPCReminderCancel

extension IPCReminderCancel {
    public init(id: String) {
        self.init(type: "reminder_cancel", id: id)
    }
}

/// Request all schedules from the daemon.
/// Backed by generated `IPCSchedulesList`.
public typealias SchedulesListMessage = IPCSchedulesList

extension IPCSchedulesList {
    public init() {
        self.init(type: "schedules_list")
    }
}

/// Toggle a schedule's enabled state.
/// Backed by generated `IPCScheduleToggle`.
public typealias ScheduleToggleMessage = IPCScheduleToggle

extension IPCScheduleToggle {
    public init(id: String, enabled: Bool) {
        self.init(type: "schedule_toggle", id: id, enabled: enabled)
    }
}

/// Remove a schedule by ID.
/// Backed by generated `IPCScheduleRemove`.
public typealias ScheduleRemoveMessage = IPCScheduleRemove

extension IPCScheduleRemove {
    public init(id: String) {
        self.init(type: "schedule_remove", id: id)
    }
}

/// Run a schedule immediately as a one-off.
/// Backed by generated `IPCScheduleRunNow`.
public typealias ScheduleRunNowMessage = IPCScheduleRunNow

extension IPCScheduleRunNow {
    public init(id: String) {
        self.init(type: "schedule_run_now", id: id)
    }
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

/// Response from deleting a persistent user-created app.
/// Backed by generated `IPCAppDeleteResponse`.
public typealias AppDeleteResponseMessage = IPCAppDeleteResponse

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
    case providerBilling = "PROVIDER_BILLING"
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

    public init(sessionId: String, code: SessionErrorCode, userMessage: String, retryable: Bool, debugDetails: String? = nil) {
        self.sessionId = sessionId
        self.code = code
        self.userMessage = userMessage
        self.retryable = retryable
        self.debugDetails = debugDetails
    }
}

/// Generic notification intent from daemon.
/// Backed by generated `IPCNotificationIntent`.
public typealias NotificationIntentMessage = IPCNotificationIntent

/// Watch session started notification from daemon.
/// Backed by generated `IPCWatchStarted`.
public typealias WatchStartedMessage = IPCWatchStarted

/// Watch session complete request from daemon.
/// Backed by generated `IPCWatchCompleteRequest`.
public typealias WatchCompleteRequestMessage = IPCWatchCompleteRequest

/// Tool execution started.
/// Backed by generated `IPCToolUseStart`.
public typealias ToolUseStartMessage = IPCToolUseStart

/// Tool use preview started (emitted during LLM tool input streaming for immediate UI feedback).
/// Backed by generated `IPCToolUsePreviewStart`.
public typealias ToolUsePreviewStartMessage = IPCToolUsePreviewStart

/// Streaming tool input delta (e.g. partial JSON as tool input is generated).
/// Backed by generated `IPCToolInputDelta`.
public typealias ToolInputDeltaMessage = IPCToolInputDelta

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

/// Authoritative confirmation state transition from daemon.
/// Backed by generated `IPCConfirmationStateChanged`.
public typealias ConfirmationStateChangedMessage = IPCConfirmationStateChanged

/// Server-side assistant activity lifecycle event.
/// Backed by generated `IPCAssistantActivityState`.
public typealias AssistantActivityStateMessage = IPCAssistantActivityState


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
    public init(requestId: String, value: String?, delivery: String? = nil) {
        self.init(type: "secret_response", requestId: requestId, value: value, delivery: delivery)
    }
}

/// Sent to add a trust rule (allowlist/denylist) independently of a confirmation response.
/// Backed by generated `IPCAddTrustRule`.
public typealias AddTrustRuleMessage = IPCAddTrustRule

extension IPCAddTrustRule {
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

/// Simulate a tool permission check without executing the tool.
/// Backed by generated `IPCToolPermissionSimulateRequest`.
public typealias ToolPermissionSimulateMessage = IPCToolPermissionSimulateRequest

extension IPCToolPermissionSimulateRequest {
    public init(toolName: String, input: [String: AnyCodable], workingDir: String? = nil, isInteractive: Bool? = nil, forcePromptSideEffects: Bool? = nil) {
        self.init(type: "tool_permission_simulate", toolName: toolName, input: input, workingDir: workingDir, isInteractive: isInteractive, forcePromptSideEffects: forcePromptSideEffects)
    }
}

/// Response from a tool permission simulation.
/// Backed by generated `IPCToolPermissionSimulateResponse`.
public typealias ToolPermissionSimulateResponseMessage = IPCToolPermissionSimulateResponse

/// Request the list of all registered tool names.
/// Backed by generated `IPCToolNamesListRequest`.
public typealias ToolNamesListMessage = IPCToolNamesListRequest

extension IPCToolNamesListRequest {
    public init() {
        self.init(type: "tool_names_list")
    }
}

/// Response containing all registered tool names.
/// Backed by generated `IPCToolNamesListResponse`.
public typealias ToolNamesListResponseMessage = IPCToolNamesListResponse

/// Response from opening and scanning a .vellum bundle.
/// Backed by generated `IPCOpenBundleResponse`.
public typealias OpenBundleResponseMessage = IPCOpenBundleResponse



// MARK: - Publish / Unpublish Page Messages

/// Sent to publish a static page via Vercel.
/// Backed by generated `IPCPublishPageRequest`.
public typealias PublishPageRequestMessage = IPCPublishPageRequest

extension IPCPublishPageRequest {
    public init(html: String, title: String? = nil, appId: String? = nil) {
        self.init(type: "publish_page", html: html, title: title, appId: appId)
    }
}

/// Response from publishing a static page.
/// Backed by generated `IPCPublishPageResponse`.
public typealias PublishPageResponseMessage = IPCPublishPageResponse

/// Sent to unpublish a page and delete its Vercel deployment.
/// Backed by generated `IPCUnpublishPageRequest`.
public typealias UnpublishPageRequestMessage = IPCUnpublishPageRequest

extension IPCUnpublishPageRequest {
    public init(deploymentId: String) {
        self.init(type: "unpublish_page", deploymentId: deploymentId)
    }
}

/// Response from unpublishing a page.
/// Backed by generated `IPCUnpublishPageResponse`.
public typealias UnpublishPageResponseMessage = IPCUnpublishPageResponse

// MARK: - Push Notification Device Token (Manual)

/// Sent to register an APNS device token so the daemon can route push notifications.
/// Kept hand-maintained — not yet part of the generated IPC contract.
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
/// Backed by generated `IPCShareAppCloudRequest`.
public typealias ShareAppCloudRequestMessage = IPCShareAppCloudRequest

extension IPCShareAppCloudRequest {
    public init(appId: String) {
        self.init(type: "share_app_cloud", appId: appId)
    }
}

public typealias ShareAppCloudResponseMessage = IPCShareAppCloudResponse

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
/// Backed by generated `IPCModelGetRequest`.
public typealias ModelGetRequestMessage = IPCModelGetRequest

extension IPCModelGetRequest {
    public init() {
        self.init(type: "model_get")
    }
}

/// Set the active model.
/// Backed by generated `IPCModelSetRequest`.
public typealias ModelSetRequestMessage = IPCModelSetRequest

extension IPCModelSetRequest {
    public init(model: String) {
        self.init(type: "model_set", model: model)
    }
}

/// Set the active image generation model.
/// Backed by generated `IPCImageGenModelSetRequest`.
public typealias ImageGenModelSetRequestMessage = IPCImageGenModelSetRequest

extension IPCImageGenModelSetRequest {
    public init(model: String) {
        self.init(type: "image_gen_model_set", model: model)
    }
}

/// Response containing the current model/provider info.
/// Backed by generated `IPCModelInfo`.
public typealias ModelInfoMessage = IPCModelInfo

// MARK: - Vercel API Config Messages

/// Sent to get/set/delete the Vercel API token.
/// Backed by generated `IPCVercelApiConfigRequest`.
public typealias VercelApiConfigRequestMessage = IPCVercelApiConfigRequest

extension IPCVercelApiConfigRequest {
    public init(action: String, apiToken: String? = nil) {
        self.init(type: "vercel_api_config", action: action, apiToken: apiToken)
    }
}

/// Response from Vercel API config operations.
/// Backed by generated `IPCVercelApiConfigResponse`.
public typealias VercelApiConfigResponseMessage = IPCVercelApiConfigResponse

// MARK: - Telegram Config Messages

/// Sent to get/set/clear Telegram bot config.
/// Backed by generated `IPCTelegramConfigRequest`.
public typealias TelegramConfigRequestMessage = IPCTelegramConfigRequest

extension IPCTelegramConfigRequest {
    public init(action: String, botToken: String? = nil, commands: [IPCTelegramConfigRequestCommand]? = nil) {
        self.init(type: "telegram_config", action: action, botToken: botToken, commands: commands)
    }
}

/// Response from Telegram config operations.
/// Backed by generated `IPCTelegramConfigResponse`.
public typealias TelegramConfigResponseMessage = IPCTelegramConfigResponse

// MARK: - Twilio Number Models (standalone, no IPC dependency)

/// Capabilities of a Twilio phone number.
public struct TwilioNumberCapabilities: Codable, Sendable {
    public let voice: Bool
    public let sms: Bool

    public init(voice: Bool, sms: Bool) {
        self.voice = voice
        self.sms = sms
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
/// Backed by generated `IPCChannelVerificationSessionRequest`.
public typealias ChannelVerificationSessionRequestMessage = IPCChannelVerificationSessionRequest

extension IPCChannelVerificationSessionRequest {
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
/// Backed by generated `IPCChannelVerificationSessionResponse`.
public typealias ChannelVerificationSessionResponseMessage = IPCChannelVerificationSessionResponse

// MARK: - Twitter Integration Config Messages

/// Sent to get/set Twitter integration config.
/// Backed by generated `IPCTwitterIntegrationConfigRequest`.
public typealias TwitterIntegrationConfigRequestMessage = IPCTwitterIntegrationConfigRequest

extension IPCTwitterIntegrationConfigRequest {
    public init(action: String, mode: String? = nil, clientId: String? = nil, clientSecret: String? = nil, strategy: String? = nil) {
        self.init(type: "twitter_integration_config", action: action, mode: mode, clientId: clientId, clientSecret: clientSecret, strategy: strategy)
    }
}

/// Response from Twitter integration config operations.
/// Backed by generated `IPCTwitterIntegrationConfigResponse`.
public typealias TwitterIntegrationConfigResponseMessage = IPCTwitterIntegrationConfigResponse

// MARK: - Twitter Auth Messages

/// Sent to start the Twitter OAuth connect flow.
/// Backed by generated `IPCTwitterAuthStartRequest`.
public typealias TwitterAuthStartMessage = IPCTwitterAuthStartRequest

extension IPCTwitterAuthStartRequest {
    public init() {
        self.init(type: "twitter_auth_start")
    }
}

/// Sent to query Twitter auth status.
/// Backed by generated `IPCTwitterAuthStatusRequest`.
public typealias TwitterAuthStatusRequestMessage = IPCTwitterAuthStatusRequest

extension IPCTwitterAuthStatusRequest {
    public init() {
        self.init(type: "twitter_auth_status")
    }
}

/// Result of a Twitter OAuth connect attempt.
/// Backed by generated `IPCTwitterAuthResult`.
public typealias TwitterAuthResultMessage = IPCTwitterAuthResult

/// Response to a Twitter auth status query.
/// Backed by generated `IPCTwitterAuthStatusResponse`.
public typealias TwitterAuthStatusResponseMessage = IPCTwitterAuthStatusResponse

/// Authentication result from the daemon after the client sends an `auth` message.
/// Backed by generated `IPCAuthResult`.
public typealias AuthResultMessage = IPCAuthResult

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
/// Backed by generated `IPCEnvVarsRequest`.
public typealias EnvVarsRequestMessage = IPCEnvVarsRequest

extension IPCEnvVarsRequest {
    public init() {
        self.init(type: "env_vars_request")
    }
}

/// Response containing daemon environment variables (debug only).
/// Backed by generated `IPCEnvVarsResponse`.
public typealias EnvVarsResponseMessage = IPCEnvVarsResponse

extension IPCSessionSwitchRequest {
    public init(sessionId: String) {
        self.init(type: "session_switch", sessionId: sessionId)
    }
}

extension IPCConversationSeenSignal {
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

extension IPCConversationUnreadSignal {
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

    public init(subagentId: String) {
        self.subagentId = subagentId
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
    case cuAction(CuActionMessage)
    case cuComplete(CuCompleteMessage)
    case cuError(CuErrorMessage)
    case sessionError(SessionErrorMessage)
    case userMessageEcho(UserMessageEchoMessage)
    case assistantTextDelta(AssistantTextDeltaMessage)
    case assistantActivityState(AssistantActivityStateMessage)
    case assistantThinkingDelta(AssistantThinkingDeltaMessage)
    case messageComplete(MessageCompleteMessage)
    case sessionInfo(SessionInfoMessage)
    case sessionTitleUpdated(SessionTitleUpdatedMessage)
    case sessionListResponse(SessionListResponseMessage)
    case historyResponse(HistoryResponseMessage)
    case memoryStatus(MemoryStatusMessage)
    case taskRouted(TaskRoutedMessage)
    case dictationResponse(DictationResponseMessage)
    case error(ErrorMessage)
    case rideShotgunError(RideShotgunErrorMessage)
    case rideShotgunProgress(RideShotgunProgressMessage)
    case rideShotgunResult(RideShotgunResultMessage)
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
    case notificationThreadCreated(IPCNotificationThreadCreated)
    case watchStarted(WatchStartedMessage)
    case watchCompleteRequest(WatchCompleteRequestMessage)
    case traceEvent(TraceEventMessage)
    case trustRulesListResponse(TrustRulesListResponseMessage)
    case toolPermissionSimulateResponse(ToolPermissionSimulateResponseMessage)
    case toolNamesListResponse(ToolNamesListResponseMessage)
    case acceptStarterBundleResponse(IPCAcceptStarterBundleResponse)
    case remindersListResponse(RemindersListResponseMessage)
    case schedulesListResponse(SchedulesListResponseMessage)
    case appsListResponse(AppsListResponseMessage)
    case appUpdatePreviewResponse(AppUpdatePreviewResponseMessage)
    case appPreviewResponse(AppPreviewResponseMessage)
    case appDiffResponse(IPCAppDiffResponse)
    case appFileAtVersionResponse(IPCAppFileAtVersionResponse)
    case appHistoryResponse(IPCAppHistoryResponse)
    case appRestoreResponse(IPCAppRestoreResponse)
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
    case twitterIntegrationConfigResponse(TwitterIntegrationConfigResponseMessage)
    case twitterAuthResult(TwitterAuthResultMessage)
    case twitterAuthStatusResponse(TwitterAuthStatusResponseMessage)
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
    case navigateSettings(IPCNavigateSettings)
    case integrationListResponse(IPCIntegrationListResponse)
    case integrationConnectResult(IPCIntegrationConnectResult)
    case oauthConnectResult(IPCOAuthConnectResultResponse)
    case appFilesChanged(AppFilesChangedMessage)
    case getSigningIdentity(IPCGetSigningIdentityRequest)
    case diagnosticsExportResponse(DiagnosticsExportResponseMessage)
    case envVarsResponse(EnvVarsResponseMessage)
    case workItemsListResponse(IPCWorkItemsListResponse)
    case workItemStatusChanged(IPCWorkItemStatusChanged)
    case tasksChanged(IPCTasksChanged)
    case contactsChanged(IPCContactsChanged)
    case workItemDeleteResponse(IPCWorkItemDeleteResponse)
    case workItemRunTaskResponse(IPCWorkItemRunTaskResponse)
    case workItemOutputResponse(IPCWorkItemOutputResponse)
    case workItemUpdateResponse(IPCWorkItemUpdateResponse)
    case workItemPreflightResponse(IPCWorkItemPreflightResponse)
    case workItemApprovePermissionsResponse(IPCWorkItemApprovePermissionsResponse)
    case workItemCancelResponse(IPCWorkItemCancelResponse)
    case taskRunThreadCreated(IPCTaskRunThreadCreated)
    case scheduleThreadCreated(IPCScheduleThreadCreated)
    case subagentSpawned(IPCSubagentSpawned)
    case subagentStatusChanged(IPCSubagentStatusChanged)
    indirect case subagentEvent(SubagentEventMessage)
    case subagentDetailResponse(IPCSubagentDetailResponse)
    case workspaceFilesListResponse(WorkspaceFilesListResponseMessage)
    case workspaceFileReadResponse(WorkspaceFileReadResponseMessage)
    case identityGetResponse(IdentityGetResponseMessage)
    case conversationSearchResponse(ConversationSearchResponseMessage)
    case pairingApprovalRequest(PairingApprovalRequestMessage)
    case approvedDevicesListResponse(ApprovedDevicesListResponseMessage)
    case approvedDeviceRemoveResponse(ApprovedDeviceRemoveResponseMessage)
    case guardianActionsPendingResponse(GuardianActionsPendingResponseMessage)
    case guardianActionDecisionResponse(GuardianActionDecisionResponseMessage)
    case recordingPause(IPCRecordingPause)
    case recordingResume(IPCRecordingResume)
    case recordingStart(IPCRecordingStart)
    case recordingStop(IPCRecordingStop)
    case clientSettingsUpdate(IPCClientSettingsUpdate)
    case avatarUpdated(IPCAvatarUpdated)
    case generateAvatarResponse(IPCGenerateAvatarResponse)
    case heartbeatConfigResponse(IPCHeartbeatConfigResponse)
    case heartbeatRunsListResponse(IPCHeartbeatRunsListResponse)
    case heartbeatRunNowResponse(IPCHeartbeatRunNowResponse)
    case heartbeatChecklistResponse(IPCHeartbeatChecklistResponse)
    case heartbeatChecklistWriteResponse(IPCHeartbeatChecklistWriteResponse)
    case messageContentResponse(IPCMessageContentResponse)
    case contactsResponse(ContactsResponseMessage)
    case tokenRotated(TokenRotatedMessage)
    case identityChanged(IPCIdentityChanged)
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
            let message = try HistoryResponseMessage(from: decoder)
            self = .historyResponse(message)
        case "memory_status":
            let message = try MemoryStatusMessage(from: decoder)
            self = .memoryStatus(message)
        case "task_routed":
            let message = try TaskRoutedMessage(from: decoder)
            self = .taskRouted(message)
        case "dictation_response":
            let message = try DictationResponseMessage(from: decoder)
            self = .dictationResponse(message)
        case "error":
            let message = try ErrorMessage(from: decoder)
            self = .error(message)
        case "ride_shotgun_error":
            let message = try RideShotgunErrorMessage(from: decoder)
            self = .rideShotgunError(message)
        case "ride_shotgun_progress":
            let message = try RideShotgunProgressMessage(from: decoder)
            self = .rideShotgunProgress(message)
        case "ride_shotgun_result":
            let message = try RideShotgunResultMessage(from: decoder)
            self = .rideShotgunResult(message)
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
        case "notification_thread_created":
            let message = try IPCNotificationThreadCreated(from: decoder)
            self = .notificationThreadCreated(message)
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
            let message = try IPCAcceptStarterBundleResponse(from: decoder)
            self = .acceptStarterBundleResponse(message)
        case "reminders_list_response":
            let message = try RemindersListResponseMessage(from: decoder)
            self = .remindersListResponse(message)
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
            let message = try IPCAppDiffResponse(from: decoder)
            self = .appDiffResponse(message)
        case "app_file_at_version_response":
            let message = try IPCAppFileAtVersionResponse(from: decoder)
            self = .appFileAtVersionResponse(message)
        case "app_history_response":
            let message = try IPCAppHistoryResponse(from: decoder)
            self = .appHistoryResponse(message)
        case "app_restore_response":
            let message = try IPCAppRestoreResponse(from: decoder)
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
        case "twitter_integration_config_response":
            let message = try TwitterIntegrationConfigResponseMessage(from: decoder)
            self = .twitterIntegrationConfigResponse(message)
        case "twitter_auth_result":
            let message = try TwitterAuthResultMessage(from: decoder)
            self = .twitterAuthResult(message)
        case "twitter_auth_status_response":
            let message = try TwitterAuthStatusResponseMessage(from: decoder)
            self = .twitterAuthStatusResponse(message)
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
            let message = try IPCNavigateSettings(from: decoder)
            self = .navigateSettings(message)
        case "get_signing_identity":
            let message = try IPCGetSigningIdentityRequest(from: decoder)
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
            let message = try IPCIntegrationListResponse(from: decoder)
            self = .integrationListResponse(message)
        case "integration_connect_result":
            let message = try IPCIntegrationConnectResult(from: decoder)
            self = .integrationConnectResult(message)
        case "oauth_connect_result":
            let message = try IPCOAuthConnectResultResponse(from: decoder)
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
            let message = try IPCWorkItemsListResponse(from: decoder)
            self = .workItemsListResponse(message)
        case "work_item_status_changed":
            let message = try IPCWorkItemStatusChanged(from: decoder)
            self = .workItemStatusChanged(message)
        case "tasks_changed":
            let message = try IPCTasksChanged(from: decoder)
            self = .tasksChanged(message)
        case "contacts_changed":
            let message = try IPCContactsChanged(from: decoder)
            self = .contactsChanged(message)
        case "work_item_delete_response":
            let message = try IPCWorkItemDeleteResponse(from: decoder)
            self = .workItemDeleteResponse(message)
        case "work_item_run_task_response":
            let message = try IPCWorkItemRunTaskResponse(from: decoder)
            self = .workItemRunTaskResponse(message)
        case "work_item_output_response":
            let message = try IPCWorkItemOutputResponse(from: decoder)
            self = .workItemOutputResponse(message)
        case "work_item_update_response":
            let message = try IPCWorkItemUpdateResponse(from: decoder)
            self = .workItemUpdateResponse(message)
        case "work_item_preflight_response":
            let message = try IPCWorkItemPreflightResponse(from: decoder)
            self = .workItemPreflightResponse(message)
        case "work_item_approve_permissions_response":
            let message = try IPCWorkItemApprovePermissionsResponse(from: decoder)
            self = .workItemApprovePermissionsResponse(message)
        case "work_item_cancel_response":
            let message = try IPCWorkItemCancelResponse(from: decoder)
            self = .workItemCancelResponse(message)
        case "task_run_thread_created":
            let message = try IPCTaskRunThreadCreated(from: decoder)
            self = .taskRunThreadCreated(message)
        case "schedule_thread_created":
            let message = try IPCScheduleThreadCreated(from: decoder)
            self = .scheduleThreadCreated(message)
        case "subagent_spawned":
            let message = try IPCSubagentSpawned(from: decoder)
            self = .subagentSpawned(message)
        case "subagent_status_changed":
            let message = try IPCSubagentStatusChanged(from: decoder)
            self = .subagentStatusChanged(message)
        case "subagent_event":
            let message = try SubagentEventMessage(from: decoder)
            self = .subagentEvent(message)
        case "subagent_detail_response":
            let message = try IPCSubagentDetailResponse(from: decoder)
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
            let message = try IPCRecordingPause(from: decoder)
            self = .recordingPause(message)
        case "recording_resume":
            let message = try IPCRecordingResume(from: decoder)
            self = .recordingResume(message)
        case "recording_start":
            let message = try IPCRecordingStart(from: decoder)
            self = .recordingStart(message)
        case "recording_stop":
            let message = try IPCRecordingStop(from: decoder)
            self = .recordingStop(message)
        case "client_settings_update":
            let message = try IPCClientSettingsUpdate(from: decoder)
            self = .clientSettingsUpdate(message)
        case "avatar_updated":
            let message = try IPCAvatarUpdated(from: decoder)
            self = .avatarUpdated(message)
        case "generate_avatar_response":
            let message = try IPCGenerateAvatarResponse(from: decoder)
            self = .generateAvatarResponse(message)
        case "heartbeat_config_response":
            let message = try IPCHeartbeatConfigResponse(from: decoder)
            self = .heartbeatConfigResponse(message)
        case "heartbeat_runs_list_response":
            let message = try IPCHeartbeatRunsListResponse(from: decoder)
            self = .heartbeatRunsListResponse(message)
        case "heartbeat_run_now_response":
            let message = try IPCHeartbeatRunNowResponse(from: decoder)
            self = .heartbeatRunNowResponse(message)
        case "heartbeat_checklist_response":
            let message = try IPCHeartbeatChecklistResponse(from: decoder)
            self = .heartbeatChecklistResponse(message)
        case "heartbeat_checklist_write_response":
            let message = try IPCHeartbeatChecklistWriteResponse(from: decoder)
            self = .heartbeatChecklistWriteResponse(message)
        case "message_content_response":
            let message = try IPCMessageContentResponse(from: decoder)
            self = .messageContentResponse(message)
        case "contacts_response":
            let message = try ContactsResponseMessage(from: decoder)
            self = .contactsResponse(message)
        case "token_rotated":
            let message = try TokenRotatedMessage(from: decoder)
            self = .tokenRotated(message)
        case "identity_changed":
            let message = try IPCIdentityChanged(from: decoder)
            self = .identityChanged(message)
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

public typealias AppFilesChangedMessage = IPCAppFilesChanged

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
/// Backed by generated `IPCContactsRequest`.
public typealias ContactsRequestMessage = IPCContactsRequest

extension IPCContactsRequest {
    public init(action: String, contactId: String? = nil, channelId: String? = nil, status: String? = nil, policy: String? = nil, reason: String? = nil, role: String? = nil, limit: Int? = nil) {
        self.init(type: "contacts", action: action, contactId: contactId, channelId: channelId, status: status, policy: policy, reason: reason, role: role, limit: limit.map(Double.init))
    }
}

/// Server → Client: contacts response.
/// Backed by generated `IPCContactsResponse`.
public typealias ContactsResponseMessage = IPCContactsResponse

/// A single contact payload returned from the daemon.
/// Backed by generated `IPCContactPayload`.
public typealias ContactPayload = IPCContactPayload

extension IPCContactPayload: Identifiable {}

/// A single contact channel payload returned from the daemon.
/// Backed by generated `IPCContactChannelPayload`.
public typealias ContactChannelPayload = IPCContactChannelPayload

extension IPCContactChannelPayload: Identifiable {}

// MARK: - Work Item Helpers

extension IPCWorkItemsListResponseItem {
    /// Returns a copy with a different `priorityTier`, preserving all other fields.
    public func withPriorityTier(_ newTier: Double) -> Self {
        Self(id: id, taskId: taskId, title: title, notes: notes, status: status, priorityTier: newTier, sortIndex: sortIndex, lastRunId: lastRunId, lastRunConversationId: lastRunConversationId, lastRunStatus: lastRunStatus, sourceType: sourceType, sourceId: sourceId, createdAt: createdAt, updatedAt: updatedAt)
    }
}
