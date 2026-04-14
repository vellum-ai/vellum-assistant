// Originally auto-generated from message contract types. Now maintained manually.
//
// This file contains Swift Codable DTOs derived from the message-types contract.
// The discriminated union enums (ClientMessage/ServerMessage) remain
// in the hand-written MessageTypes.swift since they require custom
// Decodable init logic that code generators cannot express cleanly.

import Foundation

// MARK: - Generated message types

public struct AcceptStarterBundle: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct AcceptStarterBundleResponse: Codable, Sendable {
    public let type: String
    public let accepted: Bool
    public let rulesAdded: Double
    public let alreadyAccepted: Bool

    public init(type: String, accepted: Bool, rulesAdded: Double, alreadyAccepted: Bool) {
        self.type = type
        self.accepted = accepted
        self.rulesAdded = rulesAdded
        self.alreadyAccepted = alreadyAccepted
    }
}

public struct AddTrustRule: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let pattern: String
    public let scope: String
    public let decision: String
    /// When true, the rule also covers high-risk invocations.
    public let allowHighRisk: Bool?
    /// Execution target override for this rule.
    public let executionTarget: String?

    public init(type: String, toolName: String, pattern: String, scope: String, decision: String, allowHighRisk: Bool? = nil, executionTarget: String? = nil) {
        self.type = type
        self.toolName = toolName
        self.pattern = pattern
        self.scope = scope
        self.decision = decision
        self.allowHighRisk = allowHighRisk
        self.executionTarget = executionTarget
    }
}

public struct AppDataRequest: Codable, Sendable {
    public let type: String
    public let surfaceId: String
    public let callId: String
    public let method: String
    public let appId: String
    public let recordId: String?
    public let data: [String: AnyCodable]?

    public init(type: String, surfaceId: String, callId: String, method: String, appId: String, recordId: String? = nil, data: [String: AnyCodable]? = nil) {
        self.type = type
        self.surfaceId = surfaceId
        self.callId = callId
        self.method = method
        self.appId = appId
        self.recordId = recordId
        self.data = data
    }
}

public struct AppDataResponse: Codable, Sendable {
    public let type: String
    public let surfaceId: String
    public let callId: String
    public let success: Bool
    public let result: AnyCodable?
    public let error: String?

    public init(type: String, surfaceId: String, callId: String, success: Bool, result: AnyCodable? = nil, error: String? = nil) {
        self.type = type
        self.surfaceId = surfaceId
        self.callId = callId
        self.success = success
        self.result = result
        self.error = error
    }
}

public struct AppDeleteRequest: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct AppDeleteResponse: Codable, Sendable {
    public let type: String
    public let success: Bool

    public init(type: String, success: Bool) {
        self.type = type
        self.success = success
    }
}

public struct AppDiffRequest: Codable, Sendable {
    public let type: String
    public let appId: String
    public let fromCommit: String
    public let toCommit: String?

    public init(type: String, appId: String, fromCommit: String, toCommit: String? = nil) {
        self.type = type
        self.appId = appId
        self.fromCommit = fromCommit
        self.toCommit = toCommit
    }
}

public struct AppDiffResponse: Codable, Sendable {
    public let type: String
    public let appId: String
    public let diff: String

    public init(type: String, appId: String, diff: String) {
        self.type = type
        self.appId = appId
        self.diff = diff
    }
}

public struct AppFileAtVersionRequest: Codable, Sendable {
    public let type: String
    public let appId: String
    public let path: String
    public let commitHash: String

    public init(type: String, appId: String, path: String, commitHash: String) {
        self.type = type
        self.appId = appId
        self.path = path
        self.commitHash = commitHash
    }
}

public struct AppFileAtVersionResponse: Codable, Sendable {
    public let type: String
    public let appId: String
    public let path: String
    public let content: String

    public init(type: String, appId: String, path: String, content: String) {
        self.type = type
        self.appId = appId
        self.path = path
        self.content = content
    }
}

public struct AppFilesChanged: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct AppHistoryRequest: Codable, Sendable {
    public let type: String
    public let appId: String
    public let limit: Double?

    public init(type: String, appId: String, limit: Double? = nil) {
        self.type = type
        self.appId = appId
        self.limit = limit
    }
}

public struct AppHistoryResponse: Codable, Sendable {
    public let type: String
    public let appId: String
    public let versions: [AppHistoryResponseVersion]

    public init(type: String, appId: String, versions: [AppHistoryResponseVersion]) {
        self.type = type
        self.appId = appId
        self.versions = versions
    }
}

public struct AppHistoryResponseVersion: Codable, Sendable {
    public let commitHash: String
    public let message: String
    public let timestamp: Double

    public init(commitHash: String, message: String, timestamp: Double) {
        self.commitHash = commitHash
        self.message = message
        self.timestamp = timestamp
    }
}

public struct AppOpenRequest: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct AppPreviewRequest: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct AppPreviewResponse: Codable, Sendable {
    public let type: String
    public let appId: String
    public let preview: String?

    public init(type: String, appId: String, preview: String? = nil) {
        self.type = type
        self.appId = appId
        self.preview = preview
    }
}

public struct AppRestoreRequest: Codable, Sendable {
    public let type: String
    public let appId: String
    public let commitHash: String

    public init(type: String, appId: String, commitHash: String) {
        self.type = type
        self.appId = appId
        self.commitHash = commitHash
    }
}

public struct AppRestoreResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?

    public init(type: String, success: Bool, error: String? = nil) {
        self.type = type
        self.success = success
        self.error = error
    }
}

public struct ApprovedDeviceRemove: Codable, Sendable {
    public let type: String
    public let hashedDeviceId: String

    public init(type: String, hashedDeviceId: String) {
        self.type = type
        self.hashedDeviceId = hashedDeviceId
    }
}

public struct ApprovedDeviceRemoveResponse: Codable, Sendable {
    public let type: String
    public let success: Bool

    public init(type: String, success: Bool) {
        self.type = type
        self.success = success
    }
}

public struct ApprovedDevicesClear: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct ApprovedDevicesList: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct ApprovedDevicesListResponse: Codable, Sendable {
    public let type: String
    public let devices: [ApprovedDevicesListResponseDevice]

    public init(type: String, devices: [ApprovedDevicesListResponseDevice]) {
        self.type = type
        self.devices = devices
    }
}

public struct ApprovedDevicesListResponseDevice: Codable, Sendable {
    public let hashedDeviceId: String
    public let deviceName: String
    public let lastPairedAt: Int

    public init(hashedDeviceId: String, deviceName: String, lastPairedAt: Int) {
        self.hashedDeviceId = hashedDeviceId
        self.deviceName = deviceName
        self.lastPairedAt = lastPairedAt
    }
}

public struct AppsListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct AppsListResponse: Codable, Sendable {
    public let type: String
    public let apps: [AppsListResponseApp]
    /// Whether the response came from a successful fetch (true) or an error fallback (false).
    public let success: Bool

    public init(type: String, apps: [AppsListResponseApp], success: Bool = true) {
        self.type = type
        self.apps = apps
        self.success = success
    }
}

public struct AppsListResponseApp: Codable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let icon: String?
    public let preview: String?
    public let createdAt: Int
    public let version: String?
    public let contentId: String?

    public init(id: String, name: String, description: String? = nil, icon: String? = nil, preview: String? = nil, createdAt: Int, version: String? = nil, contentId: String? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.icon = icon
        self.preview = preview
        self.createdAt = createdAt
        self.version = version
        self.contentId = contentId
    }
}

public struct AppUpdatePreviewRequest: Codable, Sendable {
    public let type: String
    public let appId: String
    /// Base64-encoded PNG screenshot thumbnail.
    public let preview: String

    public init(type: String, appId: String, preview: String) {
        self.type = type
        self.appId = appId
        self.preview = preview
    }
}

public struct AppUpdatePreviewResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let appId: String

    public init(type: String, success: Bool, appId: String) {
        self.type = type
        self.success = success
        self.appId = appId
    }
}

/// Server-side assistant activity lifecycle for thinking indicator placement.
/// 
/// `activityVersion` is monotonically increasing per conversation. Clients must
/// ignore events with a version older than their current known version.
public struct AssistantActivityState: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let activityVersion: Int
    public let phase: String
    public let anchor: String
    /// Active user request when available.
    public let requestId: String?
    public let reason: String
    /// Human-readable description of what the assistant is currently doing.
    public let statusText: String?

    public init(type: String, conversationId: String, activityVersion: Int, phase: String, anchor: String, requestId: String? = nil, reason: String, statusText: String? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.activityVersion = activityVersion
        self.phase = phase
        self.anchor = anchor
        self.requestId = requestId
        self.reason = reason
        self.statusText = statusText
    }
}

/// Attention state metadata for a conversation's latest assistant message.
public struct AssistantAttention: Codable, Sendable {
    public let hasUnseenLatestAssistantMessage: Bool
    public let latestAssistantMessageAt: Int?
    public let lastSeenAssistantMessageAt: Int?
    public let lastSeenConfidence: String?
    public let lastSeenSignalType: String?

    public init(hasUnseenLatestAssistantMessage: Bool, latestAssistantMessageAt: Int? = nil, lastSeenAssistantMessageAt: Int? = nil, lastSeenConfidence: String? = nil, lastSeenSignalType: String? = nil) {
        self.hasUnseenLatestAssistantMessage = hasUnseenLatestAssistantMessage
        self.latestAssistantMessageAt = latestAssistantMessageAt
        self.lastSeenAssistantMessageAt = lastSeenAssistantMessageAt
        self.lastSeenConfidence = lastSeenConfidence
        self.lastSeenSignalType = lastSeenSignalType
    }
}

public struct AssistantInboxEscalationRequest: Codable, Sendable {
    public let type: String
    public let action: String
    /// Filter by assistant ID (list only).
    public let assistantId: String?
    /// Filter by status (list only).
    public let status: String?
    /// Approval request ID (required for decide).
    public let approvalRequestId: String?
    /// Decision (required for decide).
    public let decision: String?
    /// Reason for the decision (decide only).
    public let reason: String?

    public init(type: String, action: String, assistantId: String? = nil, status: String? = nil, approvalRequestId: String? = nil, decision: String? = nil, reason: String? = nil) {
        self.type = type
        self.action = action
        self.assistantId = assistantId
        self.status = status
        self.approvalRequestId = approvalRequestId
        self.decision = decision
        self.reason = reason
    }
}

public struct AssistantInboxEscalationResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?
    /// List of escalations (returned on list).
    public let escalations: [AssistantInboxEscalationResponseEscalation]?
    /// Decision result (returned on decide).
    public let decision: AssistantInboxEscalationResponseDecision?

    public init(type: String, success: Bool, error: String? = nil, escalations: [AssistantInboxEscalationResponseEscalation]? = nil, decision: AssistantInboxEscalationResponseDecision? = nil) {
        self.type = type
        self.success = success
        self.error = error
        self.escalations = escalations
        self.decision = decision
    }
}

public struct AssistantInboxEscalationResponseDecision: Codable, Sendable {
    public let id: String
    public let status: String
    public let decidedAt: Int

    public init(id: String, status: String, decidedAt: Int) {
        self.id = id
        self.status = status
        self.decidedAt = decidedAt
    }
}

public struct AssistantInboxEscalationResponseEscalation: Codable, Sendable {
    public let id: String
    public let runId: String
    public let conversationId: String
    public let channel: String
    public let requesterExternalUserId: String
    public let requesterChatId: String
    public let status: String
    public let requestSummary: String?
    public let createdAt: Int

    public init(id: String, runId: String, conversationId: String, channel: String, requesterExternalUserId: String, requesterChatId: String, status: String, requestSummary: String? = nil, createdAt: Int) {
        self.id = id
        self.runId = runId
        self.conversationId = conversationId
        self.channel = channel
        self.requesterExternalUserId = requesterExternalUserId
        self.requesterChatId = requesterChatId
        self.status = status
        self.requestSummary = requestSummary
        self.createdAt = createdAt
    }
}

public struct AssistantTextDelta: Codable, Sendable {
    public let type: String
    public let text: String
    public let conversationId: String?

    public init(type: String, text: String, conversationId: String? = nil) {
        self.type = type
        self.text = text
        self.conversationId = conversationId
    }
}

public struct AssistantThinkingDelta: Codable, Sendable {
    public let type: String
    public let thinking: String
    public let conversationId: String?

    public init(type: String, thinking: String, conversationId: String? = nil) {
        self.type = type
        self.thinking = thinking
        self.conversationId = conversationId
    }
}

public struct AuthMessage: Codable, Sendable {
    public let type: String
    public let token: String

    public init(type: String, token: String) {
        self.type = type
        self.token = token
    }
}

public struct AuthResult: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let message: String?

    public init(type: String, success: Bool, message: String? = nil) {
        self.type = type
        self.success = success
        self.message = message
    }
}

/// Sent by the daemon after the avatar image has been regenerated and saved to disk.
public struct AvatarUpdated: Codable, Sendable {
    public let type: String
    /// Absolute path to the updated avatar image file.
    public let avatarPath: String

    public init(type: String, avatarPath: String) {
        self.type = type
        self.avatarPath = avatarPath
    }
}

public struct BundleAppRequest: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct BundleAppResponse: Codable, Sendable {
    public let type: String
    public let bundlePath: String
    /// Base64-encoded PNG of the generated app icon, if available.
    public let iconImageBase64: String?
    public let manifest: BundleAppResponseManifest

    public init(type: String, bundlePath: String, iconImageBase64: String? = nil, manifest: BundleAppResponseManifest) {
        self.type = type
        self.bundlePath = bundlePath
        self.iconImageBase64 = iconImageBase64
        self.manifest = manifest
    }
}

public struct BundleAppResponseManifest: Codable, Sendable {
    public let format_version: Int
    public let name: String
    public let description: String?
    public let icon: String?
    public let created_at: String
    public let created_by: String
    public let entry: String
    public let capabilities: [String]
    public let version: String?
    public let content_id: String?

    public init(format_version: Int, name: String, description: String? = nil, icon: String? = nil, created_at: String, created_by: String, entry: String, capabilities: [String], version: String? = nil, content_id: String? = nil) {
        self.format_version = format_version
        self.name = name
        self.description = description
        self.icon = icon
        self.created_at = created_at
        self.created_by = created_by
        self.entry = entry
        self.capabilities = capabilities
        self.version = version
        self.content_id = content_id
    }
}

public struct CancelRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String?

    public init(type: String, conversationId: String? = nil) {
        self.type = type
        self.conversationId = conversationId
    }
}

/// Channel binding metadata exposed in conversation list APIs.
public struct ChannelBinding: Codable, Sendable {
    public let sourceChannel: String
    public let externalChatId: String
    public let externalUserId: String?
    public let displayName: String?
    public let username: String?

    public init(sourceChannel: String, externalChatId: String, externalUserId: String? = nil, displayName: String? = nil, username: String? = nil) {
        self.sourceChannel = sourceChannel
        self.externalChatId = externalChatId
        self.externalUserId = externalUserId
        self.displayName = displayName
        self.username = username
    }
}

public struct ChannelVerificationSessionRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let channel: String?
    public let conversationId: String?
    public let rebind: Bool?
    /// E.164 phone number for phone, Telegram handle/chat-id. Used by outbound actions.
    public let destination: String?
    /// Origin conversation ID so completion/failure pointers can route back.
    public let originConversationId: String?
    /// Distinguishes guardian vs trusted-contact verification flows in the unified create endpoint.
    public let purpose: String?
    /// Contact-channel ID for the absorbed contact-channel verify flow.
    public let contactChannelId: String?

    public init(type: String, action: String, channel: String? = nil, conversationId: String? = nil, rebind: Bool? = nil, destination: String? = nil, originConversationId: String? = nil, purpose: String? = nil, contactChannelId: String? = nil) {
        self.type = type
        self.action = action
        self.channel = channel
        self.conversationId = conversationId
        self.rebind = rebind
        self.destination = destination
        self.originConversationId = originConversationId
        self.purpose = purpose
        self.contactChannelId = contactChannelId
    }
}

public struct ChannelVerificationSessionResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let secret: String?
    public let instruction: String?
    /// Present when action is 'status'.
    public let bound: Bool?
    public let guardianExternalUserId: String?
    /// The channel this status pertains to (e.g. "telegram", "phone"). Present when action is 'status'.
    public let channel: String?
    /// The assistant ID scoped to this status. Present when action is 'status'.
    public let assistantId: String?
    /// The delivery chat ID for the guardian (e.g. Telegram chat ID). Present when action is 'status' and bound is true.
    public let guardianDeliveryChatId: String?
    /// Optional channel username/handle for the bound guardian (for UI display).
    public let guardianUsername: String?
    /// Optional display name for the bound guardian (for UI display).
    public let guardianDisplayName: String?
    /// Whether a pending verification challenge exists for this (assistantId, channel). Used by relay setup to detect active voice verification sessions.
    public let hasPendingChallenge: Bool?
    public let error: String?
    /// Human-readable error detail (e.g. for already_bound failures).
    public let message: String?
    /// Session ID for outbound verification flows.
    public let verificationSessionId: String?
    /// Epoch ms when the verification session expires.
    public let expiresAt: Int?
    /// Epoch ms after which a resend is allowed.
    public let nextResendAt: Int?
    /// Number of sends for this session.
    public let sendCount: Int?
    /// Telegram deep-link URL for bootstrap (M3 placeholder).
    public let telegramBootstrapUrl: String?
    /// True when the outbound session is still in pending_bootstrap state (Telegram handle flow). Prevents the client from clearing the bootstrap URL during status polling.
    public let pendingBootstrap: Bool?

    public init(type: String, success: Bool, secret: String? = nil, instruction: String? = nil, bound: Bool? = nil, guardianExternalUserId: String? = nil, channel: String? = nil, assistantId: String? = nil, guardianDeliveryChatId: String? = nil, guardianUsername: String? = nil, guardianDisplayName: String? = nil, hasPendingChallenge: Bool? = nil, error: String? = nil, message: String? = nil, verificationSessionId: String? = nil, expiresAt: Int? = nil, nextResendAt: Int? = nil, sendCount: Int? = nil, telegramBootstrapUrl: String? = nil, pendingBootstrap: Bool? = nil) {
        self.type = type
        self.success = success
        self.secret = secret
        self.instruction = instruction
        self.bound = bound
        self.guardianExternalUserId = guardianExternalUserId
        self.channel = channel
        self.assistantId = assistantId
        self.guardianDeliveryChatId = guardianDeliveryChatId
        self.guardianUsername = guardianUsername
        self.guardianDisplayName = guardianDisplayName
        self.hasPendingChallenge = hasPendingChallenge
        self.error = error
        self.message = message
        self.verificationSessionId = verificationSessionId
        self.expiresAt = expiresAt
        self.nextResendAt = nextResendAt
        self.sendCount = sendCount
        self.telegramBootstrapUrl = telegramBootstrapUrl
        self.pendingBootstrap = pendingBootstrap
    }
}

/// Sent by the daemon to update a client-side setting (e.g. activation key).
public struct ClientSettingsUpdate: Codable, Sendable {
    public let type: String
    /// The setting key to update (e.g. "activationKey").
    public let key: String
    /// The new value for the setting.
    public let value: String

    public init(type: String, key: String, value: String) {
        self.type = type
        self.key = key
        self.value = value
    }
}

/// Structured command intent — bypasses text parsing when present.
public struct CommandIntent: Codable, Sendable {
    public let domain: String
    public let action: String

    public init(domain: String, action: String) {
        self.domain = domain
        self.action = action
    }
}

public struct ConfirmationRequest: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let riskLevel: String
    public let executionTarget: String?
    public let allowlistOptions: [ConfirmationRequestAllowlistOption]
    public let scopeOptions: [ConfirmationRequestScopeOption]
    public let diff: ConfirmationRequestDiff?
    public let sandboxed: Bool?
    public let conversationId: String?
    /// When false, the client should hide "always allow" / trust-rule persistence affordances.
    public let persistentDecisionsAllowed: Bool?
    /// Which temporary approval options the client should render (e.g. "Allow for 10 minutes", "Allow for this conversation").
    public let temporaryOptionsAvailable: [String]?
    /// The tool_use block ID for client-side correlation with specific tool calls.
    public let toolUseId: String?

    public init(type: String, requestId: String, toolName: String, input: [String: AnyCodable], riskLevel: String, executionTarget: String? = nil, allowlistOptions: [ConfirmationRequestAllowlistOption], scopeOptions: [ConfirmationRequestScopeOption], diff: ConfirmationRequestDiff? = nil, sandboxed: Bool? = nil, conversationId: String? = nil, persistentDecisionsAllowed: Bool? = nil, temporaryOptionsAvailable: [String]? = nil, toolUseId: String? = nil) {
        self.type = type
        self.requestId = requestId
        self.toolName = toolName
        self.input = input
        self.riskLevel = riskLevel
        self.executionTarget = executionTarget
        self.allowlistOptions = allowlistOptions
        self.scopeOptions = scopeOptions
        self.diff = diff
        self.sandboxed = sandboxed
        self.conversationId = conversationId
        self.persistentDecisionsAllowed = persistentDecisionsAllowed
        self.temporaryOptionsAvailable = temporaryOptionsAvailable
        self.toolUseId = toolUseId
    }
}

public struct ConfirmationRequestAllowlistOption: Codable, Sendable {
    public let label: String
    public let description: String
    public let pattern: String

    public init(label: String, description: String, pattern: String) {
        self.label = label
        self.description = description
        self.pattern = pattern
    }
}

public struct ConfirmationRequestDiff: Codable, Sendable {
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

public struct ConfirmationRequestScopeOption: Codable, Sendable {
    public let label: String
    public let scope: String

    public init(label: String, scope: String) {
        self.label = label
        self.scope = scope
    }
}

public struct ConfirmationResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let decision: String
    public let selectedPattern: String?
    public let selectedScope: String?

    public init(type: String, requestId: String, decision: String, selectedPattern: String? = nil, selectedScope: String? = nil) {
        self.type = type
        self.requestId = requestId
        self.decision = decision
        self.selectedPattern = selectedPattern
        self.selectedScope = selectedScope
    }
}

/// Authoritative per-request confirmation state transition emitted by the daemon.
/// 
/// The client must use this event (not local phrase inference) to update
/// confirmation bubble state.
public struct ConfirmationStateChanged: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let requestId: String
    public let state: String
    public let source: String
    /// requestId of the user message that triggered this transition.
    public let causedByRequestId: String?
    /// Normalized user text for analytics/debug (e.g. "approve", "deny").
    public let decisionText: String?
    /// The tool_use block ID this confirmation applies to, for disambiguating parallel tool calls.
    public let toolUseId: String?

    public init(type: String, conversationId: String, requestId: String, state: String, source: String, causedByRequestId: String? = nil, decisionText: String? = nil, toolUseId: String? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.requestId = requestId
        self.state = state
        self.source = source
        self.causedByRequestId = causedByRequestId
        self.decisionText = decisionText
        self.toolUseId = toolUseId
    }
}

public struct ContactChannelPayload: Codable, Sendable {
    public let id: String
    public let type: String
    public let address: String
    public let isPrimary: Bool
    public let externalUserId: String?
    public let status: String
    public let policy: String
    public let verifiedAt: Int?
    public let verifiedVia: String?
    public let lastSeenAt: Int?
    public let interactionCount: Int?
    public let lastInteraction: Int?
    public let revokedReason: String?
    public let blockedReason: String?

    public init(id: String, type: String, address: String, isPrimary: Bool, externalUserId: String? = nil, status: String, policy: String, verifiedAt: Int? = nil, verifiedVia: String? = nil, lastSeenAt: Int? = nil, interactionCount: Int? = nil, lastInteraction: Int? = nil, revokedReason: String? = nil, blockedReason: String? = nil) {
        self.id = id
        self.type = type
        self.address = address
        self.isPrimary = isPrimary
        self.externalUserId = externalUserId
        self.status = status
        self.policy = policy
        self.verifiedAt = verifiedAt
        self.verifiedVia = verifiedVia
        self.lastSeenAt = lastSeenAt
        self.interactionCount = interactionCount
        self.lastInteraction = lastInteraction
        self.revokedReason = revokedReason
        self.blockedReason = blockedReason
    }
}

public struct ContactPayload: Codable, Sendable {
    public let id: String
    public let displayName: String
    public let role: String
    public let notes: String?
    public let contactType: String?
    public let lastInteraction: Double?
    public let interactionCount: Int
    public let channels: [ContactChannelPayload]

    public init(id: String, displayName: String, role: String, notes: String? = nil, contactType: String? = nil, lastInteraction: Double? = nil, interactionCount: Int, channels: [ContactChannelPayload]) {
        self.id = id
        self.displayName = displayName
        self.role = role
        self.notes = notes
        self.contactType = contactType
        self.lastInteraction = lastInteraction
        self.interactionCount = interactionCount
        self.channels = channels
    }
}

/// Server push — lightweight invalidation signal: the contacts table has been mutated, refetch your list.
public struct ContactsChanged: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct ContactsInviteRequest: Codable, Sendable {
    public let type: String
    public let action: String
    /// Source channel for the invite (required for create and redeem).
    public let sourceChannel: String?
    /// Optional note describing the invite (create only).
    public let note: String?
    /// Maximum number of times the invite can be redeemed (create only).
    public let maxUses: Double?
    /// Expiration time in milliseconds from now (create only).
    public let expiresInMs: Double?
    /// Invite ID to revoke (revoke only).
    public let inviteId: String?
    /// Invite token to redeem (redeem only).
    public let token: String?
    /// External user ID of the redeemer (redeem only).
    public let externalUserId: String?
    /// External chat ID of the redeemer (redeem only).
    public let externalChatId: String?
    /// Filter by status (list only).
    public let status: String?
    /// Invitee's first name (voice invite create only).
    public let friendName: String?
    /// Contact display name for personalizing invite instructions (create only).
    public let contactName: String?
    /// Guardian's first name (voice invite create only).
    public let guardianName: String?

    public init(type: String, action: String, sourceChannel: String? = nil, note: String? = nil, maxUses: Double? = nil, expiresInMs: Double? = nil, inviteId: String? = nil, token: String? = nil, externalUserId: String? = nil, externalChatId: String? = nil, status: String? = nil, friendName: String? = nil, contactName: String? = nil, guardianName: String? = nil) {
        self.type = type
        self.action = action
        self.sourceChannel = sourceChannel
        self.note = note
        self.maxUses = maxUses
        self.expiresInMs = expiresInMs
        self.inviteId = inviteId
        self.token = token
        self.externalUserId = externalUserId
        self.externalChatId = externalChatId
        self.status = status
        self.friendName = friendName
        self.contactName = contactName
        self.guardianName = guardianName
    }
}

public struct ContactsInviteResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?
    /// Single invite (returned on create/revoke). Token field is only present on create.
    public let invite: ContactsInviteResponseInvite?
    /// List of invites (returned on list).
    public let invites: [ContactsInviteResponseInvite]?

    public init(type: String, success: Bool, error: String? = nil, invite: ContactsInviteResponseInvite? = nil, invites: [ContactsInviteResponseInvite]? = nil) {
        self.type = type
        self.success = success
        self.error = error
        self.invite = invite
        self.invites = invites
    }
}

public struct ContactsInviteResponseInvite: Codable, Sendable {
    public let id: String
    public let sourceChannel: String
    public let token: String?
    public let tokenHash: String
    public let maxUses: Double
    public let useCount: Int
    public let expiresAt: Int?
    public let status: String
    public let note: String?
    public let createdAt: Int

    public init(id: String, sourceChannel: String, token: String? = nil, tokenHash: String, maxUses: Double, useCount: Int, expiresAt: Int?, status: String, note: String? = nil, createdAt: Int) {
        self.id = id
        self.sourceChannel = sourceChannel
        self.token = token
        self.tokenHash = tokenHash
        self.maxUses = maxUses
        self.useCount = useCount
        self.expiresAt = expiresAt
        self.status = status
        self.note = note
        self.createdAt = createdAt
    }
}

public struct ContactsRequest: Codable, Sendable {
    public let type: String
    public let action: String
    /// Contact ID (get and delete).
    public let contactId: String?
    /// Channel ID (update_channel only).
    public let channelId: String?
    /// New status for channel (update_channel only).
    public let status: String?
    /// New policy for channel (update_channel only).
    public let policy: String?
    /// Reason for status change (update_channel only).
    public let reason: String?
    /// Filter by role (list only).
    public let role: String?
    /// Limit (list only).
    public let limit: Double?

    public init(type: String, action: String, contactId: String? = nil, channelId: String? = nil, status: String? = nil, policy: String? = nil, reason: String? = nil, role: String? = nil, limit: Double? = nil) {
        self.type = type
        self.action = action
        self.contactId = contactId
        self.channelId = channelId
        self.status = status
        self.policy = policy
        self.reason = reason
        self.role = role
        self.limit = limit
    }
}

public struct ContactsResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?
    public let contact: ContactPayload?
    public let contacts: [ContactPayload]?

    public init(type: String, success: Bool, error: String? = nil, contact: ContactPayload? = nil, contacts: [ContactPayload]? = nil) {
        self.type = type
        self.success = success
        self.error = error
        self.contact = contact
        self.contacts = contacts
    }
}

public struct ContextCompacted: Codable, Sendable {
    public let type: String
    public let previousEstimatedInputTokens: Int
    public let estimatedInputTokens: Int
    public let maxInputTokens: Int
    public let thresholdTokens: Int
    public let compactedMessages: Int
    public let summaryCalls: Int
    public let summaryInputTokens: Int
    public let summaryOutputTokens: Int
    public let summaryModel: String

    public init(type: String, previousEstimatedInputTokens: Int, estimatedInputTokens: Int, maxInputTokens: Int, thresholdTokens: Int, compactedMessages: Int, summaryCalls: Int, summaryInputTokens: Int, summaryOutputTokens: Int, summaryModel: String) {
        self.type = type
        self.previousEstimatedInputTokens = previousEstimatedInputTokens
        self.estimatedInputTokens = estimatedInputTokens
        self.maxInputTokens = maxInputTokens
        self.thresholdTokens = thresholdTokens
        self.compactedMessages = compactedMessages
        self.summaryCalls = summaryCalls
        self.summaryInputTokens = summaryInputTokens
        self.summaryOutputTokens = summaryOutputTokens
        self.summaryModel = summaryModel
    }
}

public struct ConversationSearchMatchingMessage: Codable, Sendable {
    public let messageId: String
    public let role: String
    /// Plain-text excerpt around the match, truncated to ~200 chars.
    public let excerpt: String
    public let createdAt: Int

    public init(messageId: String, role: String, excerpt: String, createdAt: Int) {
        self.messageId = messageId
        self.role = role
        self.excerpt = excerpt
        self.createdAt = createdAt
    }
}

public struct ConversationSearchRequest: Codable, Sendable {
    public let type: String
    /// The search query string.
    public let query: String
    /// Maximum number of conversations to return. Defaults to 20.
    public let limit: Double?
    /// Maximum number of matching messages to return per conversation. Defaults to 3.
    public let maxMessagesPerConversation: Double?

    public init(type: String, query: String, limit: Double? = nil, maxMessagesPerConversation: Double? = nil) {
        self.type = type
        self.query = query
        self.limit = limit
        self.maxMessagesPerConversation = maxMessagesPerConversation
    }
}

public struct ConversationSearchResponse: Codable, Sendable {
    public let type: String
    public let query: String
    public let results: [ConversationSearchResultItem]

    public init(type: String, query: String, results: [ConversationSearchResultItem]) {
        self.type = type
        self.query = query
        self.results = results
    }
}

public struct ConversationSearchResultItem: Codable, Sendable {
    public let conversationId: String
    public let conversationTitle: String?
    public let conversationUpdatedAt: Int
    public let matchingMessages: [ConversationSearchMatchingMessage]

    public init(conversationId: String, conversationTitle: String?, conversationUpdatedAt: Int, matchingMessages: [ConversationSearchMatchingMessage]) {
        self.conversationId = conversationId
        self.conversationTitle = conversationTitle
        self.conversationUpdatedAt = conversationUpdatedAt
        self.matchingMessages = matchingMessages
    }
}

/// Client signal indicating the user has seen a conversation (e.g. opened it or clicked a notification).
public struct ConversationSeenSignal: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let sourceChannel: String
    public let signalType: String
    public let confidence: String
    public let source: String
    public let evidenceText: String?
    public let observedAt: Int?
    public let metadata: [String: AnyCodable]?

    public init(type: String, conversationId: String, sourceChannel: String, signalType: String, confidence: String, source: String, evidenceText: String? = nil, observedAt: Int? = nil, metadata: [String: AnyCodable]? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.sourceChannel = sourceChannel
        self.signalType = signalType
        self.confidence = confidence
        self.source = source
        self.evidenceText = evidenceText
        self.observedAt = observedAt
        self.metadata = metadata
    }
}

/// Client signal indicating the user wants a conversation marked unread again.
public struct ConversationUnreadSignal: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let sourceChannel: String
    public let signalType: String
    public let confidence: String
    public let source: String
    public let evidenceText: String?
    public let observedAt: Int?
    public let metadata: [String: AnyCodable]?

    public init(type: String, conversationId: String, sourceChannel: String, signalType: String, confidence: String, source: String, evidenceText: String? = nil, observedAt: Int? = nil, metadata: [String: AnyCodable]? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.sourceChannel = sourceChannel
        self.signalType = signalType
        self.confidence = confidence
        self.source = source
        self.evidenceText = evidenceText
        self.observedAt = observedAt
        self.metadata = metadata
    }
}

public struct CuAction: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let reasoning: String?
    public let stepNumber: Int

    public init(type: String, conversationId: String, toolName: String, input: [String: AnyCodable], reasoning: String? = nil, stepNumber: Int) {
        self.type = type
        self.conversationId = conversationId
        self.toolName = toolName
        self.input = input
        self.reasoning = reasoning
        self.stepNumber = stepNumber
    }
}

public struct CuComplete: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let summary: String
    public let stepCount: Int
    public let isResponse: Bool?

    public init(type: String, conversationId: String, summary: String, stepCount: Int, isResponse: Bool? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.summary = summary
        self.stepCount = stepCount
        self.isResponse = isResponse
    }
}

public struct AssistantStatusMessage: Codable, Sendable {
    public let type: String
    public let version: String?
    public let keyFingerprint: String?

    public init(type: String, version: String? = nil, keyFingerprint: String? = nil) {
        self.type = type
        self.version = version
        self.keyFingerprint = keyFingerprint
    }
}

public struct DeleteQueuedMessage: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let requestId: String

    public init(type: String, conversationId: String, requestId: String) {
        self.type = type
        self.conversationId = conversationId
        self.requestId = requestId
    }
}

public struct DictationContext: Codable, Sendable {
    public let bundleIdentifier: String
    public let appName: String
    public let windowTitle: String
    public let selectedText: String?
    public let cursorInTextField: Bool

    public init(bundleIdentifier: String, appName: String, windowTitle: String, selectedText: String? = nil, cursorInTextField: Bool) {
        self.bundleIdentifier = bundleIdentifier
        self.appName = appName
        self.windowTitle = windowTitle
        self.selectedText = selectedText
        self.cursorInTextField = cursorInTextField
    }
}

public struct DictationRequest: Codable, Sendable {
    public let type: String
    public let transcription: String
    public let context: DictationContext
    public let profileId: String?

    public init(type: String, transcription: String, context: DictationContext, profileId: String? = nil) {
        self.type = type
        self.transcription = transcription
        self.context = context
        self.profileId = profileId
    }
}

public struct DictationResponse: Codable, Sendable {
    public let type: String
    public let text: String
    public let mode: String
    public let actionPlan: String?
    public let resolvedProfileId: String?
    public let profileSource: String?

    public init(type: String, text: String, mode: String, actionPlan: String? = nil, resolvedProfileId: String? = nil, profileSource: String? = nil) {
        self.type = type
        self.text = text
        self.mode = mode
        self.actionPlan = actionPlan
        self.resolvedProfileId = resolvedProfileId
        self.profileSource = profileSource
    }
}

public struct DocumentEditorShow: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let surfaceId: String
    public let title: String
    public let initialContent: String

    public init(type: String, conversationId: String, surfaceId: String, title: String, initialContent: String) {
        self.type = type
        self.conversationId = conversationId
        self.surfaceId = surfaceId
        self.title = title
        self.initialContent = initialContent
    }
}

public struct DocumentEditorUpdate: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let surfaceId: String
    public let markdown: String
    public let mode: String

    public init(type: String, conversationId: String, surfaceId: String, markdown: String, mode: String) {
        self.type = type
        self.conversationId = conversationId
        self.surfaceId = surfaceId
        self.markdown = markdown
        self.mode = mode
    }
}

public struct DocumentListRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String?

    public init(type: String, conversationId: String? = nil) {
        self.type = type
        self.conversationId = conversationId
    }
}

public struct DocumentListResponse: Codable, Sendable {
    public let type: String
    public let documents: [DocumentListResponseDocument]

    public init(type: String, documents: [DocumentListResponseDocument]) {
        self.type = type
        self.documents = documents
    }
}

public struct DocumentListResponseDocument: Codable, Sendable {
    public let surfaceId: String
    public let conversationId: String
    public let title: String
    public let wordCount: Int
    public let createdAt: Int
    public let updatedAt: Int

    public init(surfaceId: String, conversationId: String, title: String, wordCount: Int, createdAt: Int, updatedAt: Int) {
        self.surfaceId = surfaceId
        self.conversationId = conversationId
        self.title = title
        self.wordCount = wordCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct DocumentLoadRequest: Codable, Sendable {
    public let type: String
    public let surfaceId: String

    public init(type: String, surfaceId: String) {
        self.type = type
        self.surfaceId = surfaceId
    }
}

public struct DocumentLoadResponse: Codable, Sendable {
    public let type: String
    public let surfaceId: String
    public let conversationId: String
    public let title: String
    public let content: String
    public let wordCount: Int
    public let createdAt: Int
    public let updatedAt: Int
    public let success: Bool
    public let error: String?

    public init(type: String, surfaceId: String, conversationId: String, title: String, content: String, wordCount: Int, createdAt: Int, updatedAt: Int, success: Bool, error: String? = nil) {
        self.type = type
        self.surfaceId = surfaceId
        self.conversationId = conversationId
        self.title = title
        self.content = content
        self.wordCount = wordCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.success = success
        self.error = error
    }
}

public struct DocumentSaveRequest: Codable, Sendable {
    public let type: String
    public let surfaceId: String
    public let conversationId: String
    public let title: String
    public let content: String
    public let wordCount: Int

    public init(type: String, surfaceId: String, conversationId: String, title: String, content: String, wordCount: Int) {
        self.type = type
        self.surfaceId = surfaceId
        self.conversationId = conversationId
        self.title = title
        self.content = content
        self.wordCount = wordCount
    }
}

public struct DocumentSaveResponse: Codable, Sendable {
    public let type: String
    public let surfaceId: String
    public let success: Bool
    public let error: String?

    public init(type: String, surfaceId: String, success: Bool, error: String? = nil) {
        self.type = type
        self.surfaceId = surfaceId
        self.success = success
        self.error = error
    }
}

public struct EnvVarsRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct EnvVarsResponse: Codable, Sendable {
    public let type: String
    public let vars: [String: String]

    public init(type: String, vars: [String: String]) {
        self.type = type
        self.vars = vars
    }
}

public struct ErrorMessage: Codable, Sendable {
    public let type: String
    public let message: String
    /// Categorizes the error so the client can offer contextual actions (e.g. "Send Anyway" for secret_blocked).
    public let category: String?

    public init(type: String, message: String, category: String? = nil) {
        self.type = type
        self.message = message
        self.category = category
    }
}

public struct ForkSharedAppRequest: Codable, Sendable {
    public let type: String
    public let uuid: String

    public init(type: String, uuid: String) {
        self.type = type
        self.uuid = uuid
    }
}

public struct ForkSharedAppResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let appId: String?
    public let name: String?
    public let error: String?

    public init(type: String, success: Bool, appId: String? = nil, name: String? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.appId = appId
        self.name = name
        self.error = error
    }
}

public struct GalleryApp: Codable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let icon: String
    public let category: String
    public let version: String
    public let featured: Bool?
    public let schemaJson: String
    public let htmlDefinition: String
    /// 2 = multi-file TSX format with sourceFiles
    public let formatVersion: Int?
    /// Maps relative path to file content, e.g. { "src/main.tsx": "...", "src/index.html": "..." }
    public let sourceFiles: [String: String]?

    public init(id: String, name: String, description: String, icon: String, category: String, version: String, featured: Bool? = nil, schemaJson: String, htmlDefinition: String, formatVersion: Int? = nil, sourceFiles: [String: String]? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.icon = icon
        self.category = category
        self.version = version
        self.featured = featured
        self.schemaJson = schemaJson
        self.htmlDefinition = htmlDefinition
        self.formatVersion = formatVersion
        self.sourceFiles = sourceFiles
    }
}

public struct GalleryCategory: Codable, Sendable {
    public let id: String
    public let name: String
    public let icon: String

    public init(id: String, name: String, icon: String) {
        self.id = id
        self.name = name
        self.icon = icon
    }
}

public struct GalleryInstallRequest: Codable, Sendable {
    public let type: String
    public let galleryAppId: String

    public init(type: String, galleryAppId: String) {
        self.type = type
        self.galleryAppId = galleryAppId
    }
}

public struct GalleryInstallResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let appId: String?
    public let name: String?
    public let error: String?

    public init(type: String, success: Bool, appId: String? = nil, name: String? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.appId = appId
        self.name = name
        self.error = error
    }
}

public struct GalleryListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct GalleryListResponse: Codable, Sendable {
    public let type: String
    public let gallery: GalleryManifest

    public init(type: String, gallery: GalleryManifest) {
        self.type = type
        self.gallery = gallery
    }
}

public struct GalleryManifest: Codable, Sendable {
    public let version: Int
    public let updatedAt: String
    public let categories: [GalleryCategory]
    public let apps: [GalleryApp]

    public init(version: Int, updatedAt: String, categories: [GalleryCategory], apps: [GalleryApp]) {
        self.version = version
        self.updatedAt = updatedAt
        self.categories = categories
        self.apps = apps
    }
}

/// Request from the client to generate a custom avatar via Gemini.
public struct GenerateAvatarRequest: Codable, Sendable {
    public let type: String
    /// Text description of the desired avatar appearance.
    public let description: String

    public init(type: String, description: String) {
        self.type = type
        self.description = description
    }
}

/// Response to a generate_avatar request indicating success or failure.
public struct GenerateAvatarResponse: Codable, Sendable {
    public let type: String
    /// Whether the avatar was generated successfully.
    public let success: Bool
    /// Error message when success is false.
    public let error: String?

    public init(type: String, success: Bool, error: String? = nil) {
        self.type = type
        self.success = success
        self.error = error
    }
}

public struct GenerationCancelled: Codable, Sendable {
    public let type: String
    public let conversationId: String?

    public init(type: String, conversationId: String? = nil) {
        self.type = type
        self.conversationId = conversationId
    }
}

public struct GenerationHandoff: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let requestId: String?
    public let queuedCount: Int
    public let attachments: [UserMessageAttachment]?
    public let attachmentWarnings: [String]?
    public let messageId: String?

    public init(type: String, conversationId: String, requestId: String? = nil, queuedCount: Int, attachments: [UserMessageAttachment]? = nil, attachmentWarnings: [String]? = nil, messageId: String? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.requestId = requestId
        self.queuedCount = queuedCount
        self.attachments = attachments
        self.attachmentWarnings = attachmentWarnings
        self.messageId = messageId
    }
}

public struct GetSigningIdentityRequest: Codable, Sendable {
    public let type: String
    public let requestId: String

    public init(type: String, requestId: String) {
        self.type = type
        self.requestId = requestId
    }
}

public struct GetSigningIdentityResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let keyId: String?
    public let publicKey: String?
    public let error: String?

    public init(type: String, requestId: String, keyId: String? = nil, publicKey: String? = nil, error: String? = nil) {
        self.type = type
        self.requestId = requestId
        self.keyId = keyId
        self.publicKey = publicKey
        self.error = error
    }
}

public struct GuardianActionDecision: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let action: String
    public let conversationId: String?

    public init(type: String, requestId: String, action: String, conversationId: String? = nil) {
        self.type = type
        self.requestId = requestId
        self.action = action
        self.conversationId = conversationId
    }
}

public struct GuardianActionDecisionResponse: Codable, Sendable {
    public let type: String
    public let applied: Bool
    public let reason: String?
    public let resolverFailureReason: String?
    public let requestId: String?
    public let userText: String?

    public init(type: String, applied: Bool, reason: String? = nil, resolverFailureReason: String? = nil, requestId: String? = nil, userText: String? = nil) {
        self.type = type
        self.applied = applied
        self.reason = reason
        self.resolverFailureReason = resolverFailureReason
        self.requestId = requestId
        self.userText = userText
    }
}

public struct GuardianActionsPendingRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String

    public init(type: String, conversationId: String) {
        self.type = type
        self.conversationId = conversationId
    }
}

public struct GuardianActionsPendingResponse: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let prompts: [GuardianActionsPendingResponsePrompt]

    public init(type: String, conversationId: String, prompts: [GuardianActionsPendingResponsePrompt]) {
        self.type = type
        self.conversationId = conversationId
        self.prompts = prompts
    }
}

public struct GuardianActionsPendingResponsePrompt: Codable, Sendable {
    public let requestId: String
    public let requestCode: String
    public let state: String
    public let questionText: String
    public let toolName: String?
    public let actions: [GuardianActionsPendingResponsePromptAction]
    public let expiresAt: Int
    public let conversationId: String
    public let callSessionId: String?
    /// Canonical request kind (e.g. 'tool_approval', 'pending_question').
    /// Present when the prompt originates from the canonical guardian request
    /// store. Absent for legacy-only prompts.
    public let kind: String?

    public init(requestId: String, requestCode: String, state: String, questionText: String, toolName: String?, actions: [GuardianActionsPendingResponsePromptAction], expiresAt: Int, conversationId: String, callSessionId: String?, kind: String? = nil) {
        self.requestId = requestId
        self.requestCode = requestCode
        self.state = state
        self.questionText = questionText
        self.toolName = toolName
        self.actions = actions
        self.expiresAt = expiresAt
        self.conversationId = conversationId
        self.callSessionId = callSessionId
        self.kind = kind
    }
}

public struct GuardianActionsPendingResponsePromptAction: Codable, Sendable {
    public let action: String
    public let label: String

    public init(action: String, label: String) {
        self.action = action
        self.label = label
    }
}

public struct HeartbeatAlert: Codable, Sendable {
    public let type: String
    public let title: String
    public let body: String

    public init(type: String, title: String, body: String) {
        self.type = type
        self.title = title
        self.body = body
    }
}

public struct HeartbeatChecklistRead: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct HeartbeatChecklistResponse: Codable, Sendable {
    public let type: String
    public let content: String
    public let isDefault: Bool

    public init(type: String, content: String, isDefault: Bool) {
        self.type = type
        self.content = content
        self.isDefault = isDefault
    }
}

public struct HeartbeatChecklistWrite: Codable, Sendable {
    public let type: String
    public let content: String

    public init(type: String, content: String) {
        self.type = type
        self.content = content
    }
}

public struct HeartbeatChecklistWriteResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?

    public init(type: String, success: Bool, error: String? = nil) {
        self.type = type
        self.success = success
        self.error = error
    }
}

public struct HeartbeatConfig: Codable, Sendable {
    public let type: String
    public let action: String
    public let enabled: Bool?
    public let intervalMs: Double?
    public let activeHoursStart: Double?
    public let activeHoursEnd: Double?

    public init(type: String, action: String, enabled: Bool? = nil, intervalMs: Double? = nil, activeHoursStart: Double? = nil, activeHoursEnd: Double? = nil) {
        self.type = type
        self.action = action
        self.enabled = enabled
        self.intervalMs = intervalMs
        self.activeHoursStart = activeHoursStart
        self.activeHoursEnd = activeHoursEnd
    }
}

public struct HeartbeatConfigResponse: Codable, Sendable {
    public let type: String
    public let enabled: Bool
    public let intervalMs: Double
    public let activeHoursStart: Double?
    public let activeHoursEnd: Double?
    public let nextRunAt: Int?
    public let lastRunAt: Int?
    public let success: Bool
    public let error: String?

    public init(type: String, enabled: Bool, intervalMs: Double, activeHoursStart: Double?, activeHoursEnd: Double?, nextRunAt: Int?, lastRunAt: Int? = nil, success: Bool, error: String? = nil) {
        self.type = type
        self.enabled = enabled
        self.intervalMs = intervalMs
        self.activeHoursStart = activeHoursStart
        self.activeHoursEnd = activeHoursEnd
        self.nextRunAt = nextRunAt
        self.lastRunAt = lastRunAt
        self.success = success
        self.error = error
    }
}

public struct HeartbeatRunNow: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct HeartbeatRunNowResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?

    public init(type: String, success: Bool, error: String? = nil) {
        self.type = type
        self.success = success
        self.error = error
    }
}

public struct HeartbeatRunsList: Codable, Sendable {
    public let type: String
    public let limit: Double?

    public init(type: String, limit: Double? = nil) {
        self.type = type
        self.limit = limit
    }
}

public struct HeartbeatRunsListResponse: Codable, Sendable {
    public let type: String
    public let runs: [HeartbeatRunsListResponseRun]

    public init(type: String, runs: [HeartbeatRunsListResponseRun]) {
        self.type = type
        self.runs = runs
    }
}

public struct HeartbeatRunsListResponseRun: Codable, Sendable {
    public let id: String
    public let title: String
    public let createdAt: Int
    public let result: String
    public let summary: String?

    public init(id: String, title: String, createdAt: Int, result: String, summary: String? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.result = result
        self.summary = summary
    }
}

public struct HistoryRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String
    /// Max messages to return. When omitted, all messages are returned (unlimited).
    public let limit: Double?
    /// Pagination cursor: return messages with timestamp before this value.
    public let beforeTimestamp: Double?
    /// Pagination cursor tie-breaker: exclude this message ID when beforeTimestamp matches.
    public let beforeMessageId: String?
    /// Include attachment base64 data. Defaults to false in light mode.
    public let includeAttachments: Bool?
    /// Include tool screenshot base64 data. Defaults to false in light mode.
    public let includeToolImages: Bool?
    /// Include surface HTML payloads. Defaults to false in light mode.
    public let includeSurfaceData: Bool?
    /// Shorthand: 'light' = all include flags false (default), 'full' = all include flags true.
    public let mode: String?
    /// Truncate message text fields beyond this character limit. When omitted, full text is returned.
    public let maxTextChars: Double?
    /// Truncate tool result strings beyond this character limit. When omitted, full results are returned.
    public let maxToolResultChars: Double?

    public init(type: String, conversationId: String, limit: Double? = nil, beforeTimestamp: Double? = nil, beforeMessageId: String? = nil, includeAttachments: Bool? = nil, includeToolImages: Bool? = nil, includeSurfaceData: Bool? = nil, mode: String? = nil, maxTextChars: Double? = nil, maxToolResultChars: Double? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.limit = limit
        self.beforeTimestamp = beforeTimestamp
        self.beforeMessageId = beforeMessageId
        self.includeAttachments = includeAttachments
        self.includeToolImages = includeToolImages
        self.includeSurfaceData = includeSurfaceData
        self.mode = mode
        self.maxTextChars = maxTextChars
        self.maxToolResultChars = maxToolResultChars
    }
}

public struct HistoryResponse: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let messages: [HistoryResponseMessage]
    /// Whether older messages exist beyond the returned page.
    public let hasMore: Bool
    /// Timestamp of the oldest message in the response (client uses as next pagination cursor).
    public let oldestTimestamp: Double?
    /// ID of the oldest message in the response (tie-breaker for same-millisecond cursors).
    public let oldestMessageId: String?

    public init(type: String, conversationId: String, messages: [HistoryResponseMessage], hasMore: Bool, oldestTimestamp: Double? = nil, oldestMessageId: String? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.messages = messages
        self.hasMore = hasMore
        self.oldestTimestamp = oldestTimestamp
        self.oldestMessageId = oldestMessageId
    }
}

public struct HistoryResponseMessage: Codable, Sendable {
    public let id: String?
    public let role: String
    public let text: String
    public let timestamp: Double
    public let toolCalls: [HistoryResponseToolCall]?
    /// True when tool_use blocks appeared before any text block in the original content.
    public let toolCallsBeforeText: Bool?
    public let attachments: [UserMessageAttachment]?
    /// Text segments split by tool-call boundaries. Preserves interleaving order.
    public let textSegments: [String]?
    /// Thinking segments from extended thinking / chain-of-thought blocks.
    public let thinkingSegments: [String]?
    /// Content block ordering using "text:N", "tool:N", "surface:N" encoding.
    public let contentOrder: [String]?
    /// UI surfaces (widgets) embedded in the message.
    public let surfaces: [HistoryResponseSurface]?
    /// Present when this message is a subagent lifecycle notification (running/completed/failed/aborted).
    public let subagentNotification: HistoryResponseMessageSubagentNotification?
    /// True when text or tool result content was truncated due to maxTextChars/maxToolResultChars.
    public let wasTruncated: Bool?

    public init(id: String? = nil, role: String, text: String, timestamp: Double, toolCalls: [HistoryResponseToolCall]? = nil, toolCallsBeforeText: Bool? = nil, attachments: [UserMessageAttachment]? = nil, textSegments: [String]? = nil, thinkingSegments: [String]? = nil, contentOrder: [String]? = nil, surfaces: [HistoryResponseSurface]? = nil, subagentNotification: HistoryResponseMessageSubagentNotification? = nil, wasTruncated: Bool? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
        self.toolCalls = toolCalls
        self.toolCallsBeforeText = toolCallsBeforeText
        self.attachments = attachments
        self.textSegments = textSegments
        self.thinkingSegments = thinkingSegments
        self.contentOrder = contentOrder
        self.surfaces = surfaces
        self.subagentNotification = subagentNotification
        self.wasTruncated = wasTruncated
    }
}

public struct HistoryResponseMessageSubagentNotification: Codable, Sendable {
    public let subagentId: String
    public let label: String
    public let status: String
    public let error: String?
    public let conversationId: String?

    public init(subagentId: String, label: String, status: String, error: String? = nil, conversationId: String? = nil) {
        self.subagentId = subagentId
        self.label = label
        self.status = status
        self.error = error
        self.conversationId = conversationId
    }
}

public struct HistoryResponseSurface: Codable, Sendable {
    public let surfaceId: String
    public let surfaceType: String
    public let title: String?
    public let data: [String: AnyCodable]
    public let actions: [HistoryResponseSurfaceAction]?
    public let display: String?
    /// True when the surface was completed (e.g. form submitted).
    public let completed: Bool?
    /// Human-readable summary shown in the completion chip.
    public let completionSummary: String?

    public init(surfaceId: String, surfaceType: String, title: String? = nil, data: [String: AnyCodable], actions: [HistoryResponseSurfaceAction]? = nil, display: String? = nil, completed: Bool? = nil, completionSummary: String? = nil) {
        self.surfaceId = surfaceId
        self.surfaceType = surfaceType
        self.title = title
        self.data = data
        self.actions = actions
        self.display = display
        self.completed = completed
        self.completionSummary = completionSummary
    }
}

public struct HistoryResponseSurfaceAction: Codable, Sendable {
    public let id: String
    public let label: String
    public let style: String?
    public let data: [String: AnyCodable]?

    public init(id: String, label: String, style: String? = nil, data: [String: AnyCodable]? = nil) {
        self.id = id
        self.label = label
        self.style = style
        self.data = data
    }
}

public struct HistoryResponseToolCall: Codable, Sendable {
    public let name: String
    public let input: [String: AnyCodable]
    public let result: String?
    public let isError: Bool?
    /// Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot, image generation).
    public let imageDataList: [String]?
    /// Unix ms when the tool started executing.
    public let startedAt: Int?
    /// Unix ms when the tool completed.
    public let completedAt: Int?
    /// Confirmation decision for this tool call: "approved" | "denied" | "timed_out".
    public let confirmationDecision: String?
    /// Friendly label for the confirmation (e.g. "Edit File", "Run Command").
    public let confirmationLabel: String?

    public init(name: String, input: [String: AnyCodable], result: String? = nil, isError: Bool? = nil, imageDataList: [String]? = nil, startedAt: Int? = nil, completedAt: Int? = nil, confirmationDecision: String? = nil, confirmationLabel: String? = nil) {
        self.name = name
        self.input = input
        self.result = result
        self.isError = isError
        self.imageDataList = imageDataList
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.confirmationDecision = confirmationDecision
        self.confirmationLabel = confirmationLabel
    }
}

public struct HomeBaseGetRequest: Codable, Sendable {
    public let type: String
    /// If true, daemon ensures a durable Home Base link exists before responding.
    public let ensureLinked: Bool?

    public init(type: String, ensureLinked: Bool? = nil) {
        self.type = type
        self.ensureLinked = ensureLinked
    }
}

public struct HomeBaseGetResponse: Codable, Sendable {
    public let type: String
    public let homeBase: HomeBaseGetResponseHomeBase?

    public init(type: String, homeBase: HomeBaseGetResponseHomeBase?) {
        self.type = type
        self.homeBase = homeBase
    }
}

public struct HomeBaseGetResponseHomeBase: Codable, Sendable {
    public let appId: String
    public let source: String
    public let starterTasks: [String]
    public let onboardingTasks: [String]
    public let preview: HomeBaseGetResponseHomeBasePreview

    public init(appId: String, source: String, starterTasks: [String], onboardingTasks: [String], preview: HomeBaseGetResponseHomeBasePreview) {
        self.appId = appId
        self.source = source
        self.starterTasks = starterTasks
        self.onboardingTasks = onboardingTasks
        self.preview = preview
    }
}

public struct HomeBaseGetResponseHomeBasePreview: Codable, Sendable {
    public let title: String
    public let subtitle: String
    public let description: String
    public let icon: String
    public let metrics: [HomeBaseGetResponseHomeBasePreviewMetric]

    public init(title: String, subtitle: String, description: String, icon: String, metrics: [HomeBaseGetResponseHomeBasePreviewMetric]) {
        self.title = title
        self.subtitle = subtitle
        self.description = description
        self.icon = icon
        self.metrics = metrics
    }
}

public struct HomeBaseGetResponseHomeBasePreviewMetric: Codable, Sendable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

/// Server push — broadcast when IDENTITY.md changes on disk.
public struct IdentityChanged: Codable, Sendable {
    public let type: String
    public let name: String
    public let role: String
    public let personality: String
    public let emoji: String
    public let home: String

    public init(type: String, name: String, role: String, personality: String, emoji: String, home: String) {
        self.type = type
        self.name = name
        self.role = role
        self.personality = personality
        self.emoji = emoji
        self.home = home
    }
}

public struct IdentityGetRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IdentityGetResponse: Codable, Sendable {
    public let type: String
    /// Whether an IDENTITY.md file was found. When false, all fields are empty defaults.
    public let found: Bool
    public let name: String
    public let role: String
    public let personality: String
    public let emoji: String
    public let home: String
    public let version: String?
    public let assistantId: String?
    public let createdAt: String?
    public let originSystem: String?

    public init(type: String, found: Bool, name: String, role: String, personality: String, emoji: String, home: String, version: String? = nil, assistantId: String? = nil, createdAt: String? = nil, originSystem: String? = nil) {
        self.type = type
        self.found = found
        self.name = name
        self.role = role
        self.personality = personality
        self.emoji = emoji
        self.home = home
        self.version = version
        self.assistantId = assistantId
        self.createdAt = createdAt
        self.originSystem = originSystem
    }
}

public struct ImageGenModelSetRequest: Codable, Sendable {
    public let type: String
    public let model: String

    public init(type: String, model: String) {
        self.type = type
        self.model = model
    }
}

public struct IngressConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let publicBaseUrl: String?
    public let enabled: Bool?

    public init(type: String, action: String, publicBaseUrl: String? = nil, enabled: Bool? = nil) {
        self.type = type
        self.action = action
        self.publicBaseUrl = publicBaseUrl
        self.enabled = enabled
    }
}

public struct IngressConfigResponse: Codable, Sendable {
    public let type: String
    public let enabled: Bool
    public let publicBaseUrl: String
    /// Read-only gateway target computed from GATEWAY_PORT env var (default 7830) + loopback host.
    public let localGatewayTarget: String
    public let success: Bool
    public let error: String?

    public init(type: String, enabled: Bool, publicBaseUrl: String, localGatewayTarget: String, success: Bool, error: String? = nil) {
        self.type = type
        self.enabled = enabled
        self.publicBaseUrl = publicBaseUrl
        self.localGatewayTarget = localGatewayTarget
        self.success = success
        self.error = error
    }
}

public struct IntegrationConnectRequest: Codable, Sendable {
    public let type: String
    public let integrationId: String

    public init(type: String, integrationId: String) {
        self.type = type
        self.integrationId = integrationId
    }
}

public struct IntegrationConnectResult: Codable, Sendable {
    public let type: String
    public let integrationId: String
    public let success: Bool
    public let accountInfo: String?
    public let error: String?
    public let setupRequired: Bool?
    public let setupHint: String?

    public init(type: String, integrationId: String, success: Bool, accountInfo: String? = nil, error: String? = nil, setupRequired: Bool? = nil, setupHint: String? = nil) {
        self.type = type
        self.integrationId = integrationId
        self.success = success
        self.accountInfo = accountInfo
        self.error = error
        self.setupRequired = setupRequired
        self.setupHint = setupHint
    }
}

public struct IntegrationDisconnectRequest: Codable, Sendable {
    public let type: String
    public let integrationId: String

    public init(type: String, integrationId: String) {
        self.type = type
        self.integrationId = integrationId
    }
}

public struct IntegrationListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IntegrationListResponse: Codable, Sendable {
    public let type: String
    public let integrations: [IntegrationListResponseIntegration]

    public init(type: String, integrations: [IntegrationListResponseIntegration]) {
        self.type = type
        self.integrations = integrations
    }
}

public struct IntegrationListResponseIntegration: Codable, Sendable {
    public let id: String
    public let connected: Bool
    public let accountInfo: String?
    public let connectedAt: Int?
    public let lastUsed: Double?
    public let error: String?

    public init(id: String, connected: Bool, accountInfo: String? = nil, connectedAt: Int? = nil, lastUsed: Double? = nil, error: String? = nil) {
        self.id = id
        self.connected = connected
        self.accountInfo = accountInfo
        self.connectedAt = connectedAt
        self.lastUsed = lastUsed
        self.error = error
    }
}

public struct BlobProbe: Codable, Sendable {
    public let type: String
    public let probeId: String
    public let nonceSha256: String

    public init(type: String, probeId: String, nonceSha256: String) {
        self.type = type
        self.probeId = probeId
        self.nonceSha256 = nonceSha256
    }
}

public struct BlobProbeResult: Codable, Sendable {
    public let type: String
    public let probeId: String
    public let ok: Bool
    public let observedNonceSha256: String?
    public let reason: String?

    public init(type: String, probeId: String, ok: Bool, observedNonceSha256: String? = nil, reason: String? = nil) {
        self.type = type
        self.probeId = probeId
        self.ok = ok
        self.observedNonceSha256 = observedNonceSha256
        self.reason = reason
    }
}

public struct BlobRef: Codable, Sendable {
    public let id: String
    public let kind: String
    public let encoding: String
    public let byteLength: Int
    public let sha256: String?

    public init(id: String, kind: String, encoding: String, byteLength: Int, sha256: String? = nil) {
        self.id = id
        self.kind = kind
        self.encoding = encoding
        self.byteLength = byteLength
        self.sha256 = sha256
    }
}

public struct LinkOpenRequest: Codable, Sendable {
    public let type: String
    public let url: String
    public let metadata: [String: AnyCodable]?

    public init(type: String, url: String, metadata: [String: AnyCodable]? = nil) {
        self.type = type
        self.url = url
        self.metadata = metadata
    }
}

public struct ListItem: Codable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String?
    public let icon: String?
    public let selected: Bool?

    public init(id: String, title: String, subtitle: String? = nil, icon: String? = nil, selected: Bool? = nil) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
        self.selected = selected
    }
}

public struct MemoryRecalled: Codable, Sendable {
    public let type: String
    public let provider: String
    public let model: String
    public let degradation: MemoryRecalledDegradation?
    public let semanticHits: Double
    public let tier1Count: Int?
    public let tier2Count: Int?
    public let hybridSearchLatencyMs: Double?
    public let sparseVectorUsed: Bool?
    public let mergedCount: Int
    public let selectedCount: Int
    public let injectedTokens: Int
    public let latencyMs: Double
    public let topCandidates: [MemoryRecalledCandidateDebug]

    public init(type: String, provider: String, model: String, degradation: MemoryRecalledDegradation? = nil, semanticHits: Double, tier1Count: Int? = nil, tier2Count: Int? = nil, hybridSearchLatencyMs: Double? = nil, sparseVectorUsed: Bool? = nil, mergedCount: Int, selectedCount: Int, injectedTokens: Int, latencyMs: Double, topCandidates: [MemoryRecalledCandidateDebug]) {
        self.type = type
        self.provider = provider
        self.model = model
        self.degradation = degradation
        self.semanticHits = semanticHits
        self.tier1Count = tier1Count
        self.tier2Count = tier2Count
        self.hybridSearchLatencyMs = hybridSearchLatencyMs
        self.sparseVectorUsed = sparseVectorUsed
        self.mergedCount = mergedCount
        self.selectedCount = selectedCount
        self.injectedTokens = injectedTokens
        self.latencyMs = latencyMs
        self.topCandidates = topCandidates
    }
}

public struct MemoryRecalledCandidateDebug: Codable, Sendable {
    public let key: String
    public let type: String
    public let kind: String
    public let finalScore: Double
    public let semantic: Double
    public let recency: Double

    public init(key: String, type: String, kind: String, finalScore: Double, semantic: Double, recency: Double) {
        self.key = key
        self.type = type
        self.kind = kind
        self.finalScore = finalScore
        self.semantic = semantic
        self.recency = recency
    }
}

public struct MemoryRecalledDegradation: Codable, Sendable {
    public let semanticUnavailable: Bool
    public let reason: String
    public let fallbackSources: [String]

    public init(semanticUnavailable: Bool, reason: String, fallbackSources: [String]) {
        self.semanticUnavailable = semanticUnavailable
        self.reason = reason
        self.fallbackSources = fallbackSources
    }
}

public struct MemoryStatus: Codable, Sendable {
    public let type: String
    public let enabled: Bool
    public let degraded: Bool
    public let degradation: MemoryRecalledDegradation?
    public let reason: String?
    public let provider: String?
    public let model: String?

    public init(type: String, enabled: Bool, degraded: Bool, degradation: MemoryRecalledDegradation? = nil, reason: String? = nil, provider: String? = nil, model: String? = nil) {
        self.type = type
        self.enabled = enabled
        self.degraded = degraded
        self.degradation = degradation
        self.reason = reason
        self.provider = provider
        self.model = model
    }
}

public struct MessageComplete: Codable, Sendable {
    public let type: String
    public let conversationId: String?
    public let attachments: [UserMessageAttachment]?
    public let attachmentWarnings: [String]?
    public let messageId: String?
    public let source: String?

    public init(type: String, conversationId: String? = nil, attachments: [UserMessageAttachment]? = nil, attachmentWarnings: [String]? = nil, messageId: String? = nil, source: String? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.attachments = attachments
        self.attachmentWarnings = attachmentWarnings
        self.messageId = messageId
        self.source = source
    }
}

public struct MessageContentRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let messageId: String

    public init(type: String, conversationId: String, messageId: String) {
        self.type = type
        self.conversationId = conversationId
        self.messageId = messageId
    }
}

public struct MessageContentResponse: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let messageId: String
    public let text: String?
    public let toolCalls: [MessageContentResponseToolCall]?

    public init(type: String, conversationId: String, messageId: String, text: String? = nil, toolCalls: [MessageContentResponseToolCall]? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.messageId = messageId
        self.text = text
        self.toolCalls = toolCalls
    }
}

public struct MessageContentResponseToolCall: Codable, Sendable {
    public let name: String
    public let result: String?
    public let input: [String: AnyCodable]?

    public init(name: String, result: String? = nil, input: [String: AnyCodable]? = nil) {
        self.name = name
        self.result = result
        self.input = input
    }
}

public struct MessageDequeued: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let requestId: String

    public init(type: String, conversationId: String, requestId: String) {
        self.type = type
        self.conversationId = conversationId
        self.requestId = requestId
    }
}

public struct MessageQueued: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let requestId: String
    public let position: Int

    public init(type: String, conversationId: String, requestId: String, position: Int) {
        self.type = type
        self.conversationId = conversationId
        self.requestId = requestId
        self.position = position
    }
}

public struct MessageQueuedDeleted: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let requestId: String

    public init(type: String, conversationId: String, requestId: String) {
        self.type = type
        self.conversationId = conversationId
        self.requestId = requestId
    }
}

/// Request-level terminal signal for a user message lifecycle.
/// 
/// Unlike `message_complete`, this does not imply the active assistant turn
/// has completed. It is used for paths that consume a request inline while a
/// separate in-flight turn may still be running.
public struct MessageRequestComplete: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let requestId: String
    /// True when an existing turn is still running after this request is finalized.
    public let runStillActive: Bool?

    public init(type: String, conversationId: String, requestId: String, runStillActive: Bool? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.requestId = requestId
        self.runStillActive = runStillActive
    }
}

public struct ModelGetRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct CatalogModel: Codable, Sendable {
    public let id: String
    public let displayName: String

    public init(id: String, displayName: String) {
        self.id = id
        self.displayName = displayName
    }
}

public struct ProviderCatalogEntry: Codable, Sendable {
    public let id: String
    public let displayName: String
    public let models: [CatalogModel]
    public let defaultModel: String
    public let apiKeyUrl: String?
    public let apiKeyPlaceholder: String?

    public init(id: String, displayName: String, models: [CatalogModel], defaultModel: String, apiKeyUrl: String? = nil, apiKeyPlaceholder: String? = nil) {
        self.id = id
        self.displayName = displayName
        self.models = models
        self.defaultModel = defaultModel
        self.apiKeyUrl = apiKeyUrl
        self.apiKeyPlaceholder = apiKeyPlaceholder
    }
}

public struct ModelInfo: Codable, Sendable {
    public let type: String
    public let model: String
    public let provider: String
    public let configuredProviders: [String]?
    public let availableModels: [CatalogModel]?
    public let allProviders: [ProviderCatalogEntry]?

    public init(type: String, model: String, provider: String, configuredProviders: [String]? = nil, availableModels: [CatalogModel]? = nil, allProviders: [ProviderCatalogEntry]? = nil) {
        self.type = type
        self.model = model
        self.provider = provider
        self.configuredProviders = configuredProviders
        self.availableModels = availableModels
        self.allProviders = allProviders
    }
}

public struct ModelSetRequest: Codable, Sendable {
    public let type: String
    public let model: String
    public let provider: String?

    public init(type: String, model: String, provider: String? = nil) {
        self.type = type
        self.model = model
        self.provider = provider
    }
}

public struct NavigateSettings: Codable, Sendable {
    public let type: String
    public let tab: String

    public init(type: String, tab: String) {
        self.type = type
        self.tab = tab
    }
}

public struct ShowPlatformLogin: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct PlatformDisconnected: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

/// Broadcast to connected macOS clients when a notification should be displayed.
public struct NotificationIntent: Codable, Sendable {
    public let type: String
    /// Delivery audit record ID so the client can correlate ack messages.
    public let deliveryId: String?
    public let sourceEventName: String
    public let title: String
    public let body: String
    /// Optional deep-link metadata so the client can navigate to the relevant context.
    public let deepLinkMetadata: [String: AnyCodable]?
    /// When set, this notification is guardian-sensitive and should only be
    /// displayed by clients whose guardian identity matches this principal ID.
    /// Clients not bound to this guardian should ignore the notification.
    public let targetGuardianPrincipalId: String?

    public init(type: String, deliveryId: String? = nil, sourceEventName: String, title: String, body: String, deepLinkMetadata: [String: AnyCodable]? = nil, targetGuardianPrincipalId: String? = nil) {
        self.type = type
        self.deliveryId = deliveryId
        self.sourceEventName = sourceEventName
        self.title = title
        self.body = body
        self.deepLinkMetadata = deepLinkMetadata
        self.targetGuardianPrincipalId = targetGuardianPrincipalId
    }
}

/// Client ack sent after UNUserNotificationCenter.add() completes (or fails).
public struct NotificationIntentResult: Codable, Sendable {
    public let type: String
    public let deliveryId: String
    public let success: Bool
    public let errorMessage: String?
    public let errorCode: String?

    public init(type: String, deliveryId: String, success: Bool, errorMessage: String? = nil, errorCode: String? = nil) {
        self.type = type
        self.deliveryId = deliveryId
        self.success = success
        self.errorMessage = errorMessage
        self.errorCode = errorCode
    }
}

/// Broadcast to connected clients when a service group update is about to begin.
///
/// Wire format uses camelCase keys (matching the daemon TypeScript definition
/// in `assistant/src/daemon/message-types/upgrades.ts`). The `JSONDecoder` in
/// `GatewayConnectionManager` uses default key decoding (no `.convertFromSnakeCase`),
/// so property names here must match the camelCase wire keys exactly.
public struct ServiceGroupUpdateStarting: Codable, Sendable {
    public let type: String
    /// The version being upgraded to.
    public let targetVersion: String
    /// Estimated seconds of downtime.
    public let expectedDowntimeSeconds: Double

    public init(type: String, targetVersion: String, expectedDowntimeSeconds: Double) {
        self.type = type
        self.targetVersion = targetVersion
        self.expectedDowntimeSeconds = expectedDowntimeSeconds
    }
}

/// Broadcast to connected clients when a service group update has completed.
///
/// Wire format uses camelCase keys (matching the daemon TypeScript definition
/// in `assistant/src/daemon/message-types/upgrades.ts`). The `JSONDecoder` in
/// `GatewayConnectionManager` uses default key decoding (no `.convertFromSnakeCase`),
/// so property names here must match the camelCase wire keys exactly.
public struct ServiceGroupUpdateComplete: Codable, Sendable {
    public let type: String
    /// The version that was installed (may differ from target if rolled back).
    public let installedVersion: String
    /// Whether the update succeeded or rolled back.
    public let success: Bool
    /// If rolled back, the version reverted to.
    public let rolledBackToVersion: String?

    public init(type: String, installedVersion: String, success: Bool, rolledBackToVersion: String? = nil) {
        self.type = type
        self.installedVersion = installedVersion
        self.success = success
        self.rolledBackToVersion = rolledBackToVersion
    }
}

/// Server push — broadcast when a notification creates a new vellum conversation.
public struct NotificationConversationCreated: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let title: String
    public let sourceEventName: String
    /// When set, this conversation was created for a guardian-sensitive notification
    /// and should only be surfaced by clients bound to this guardian identity.
    public let targetGuardianPrincipalId: String?
    /// Conversation group identifier from the signal producer (e.g. "system:scheduled").
    /// Clients use this to place the conversation in the correct sidebar folder.
    public let groupId: String?
    /// Semantic source of the conversation (e.g. "schedule", "reminder").
    /// Allows clients to override the default "notification" source.
    public let source: String?

    public init(type: String, conversationId: String, title: String, sourceEventName: String, targetGuardianPrincipalId: String? = nil, groupId: String? = nil, source: String? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.title = title
        self.sourceEventName = sourceEventName
        self.targetGuardianPrincipalId = targetGuardianPrincipalId
        self.groupId = groupId
        self.source = source
    }
}

public struct OAuthConnectResultResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let service: String?
    public let grantedScopes: [String]?
    public let accountInfo: String?
    public let error: String?

    public init(type: String, success: Bool, service: String? = nil, grantedScopes: [String]? = nil, accountInfo: String? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.service = service
        self.grantedScopes = grantedScopes
        self.accountInfo = accountInfo
        self.error = error
    }
}

public struct OAuthConnectStartRequest: Codable, Sendable {
    public let type: String
    public let service: String
    public let requestedScopes: [String]?

    public init(type: String, service: String, requestedScopes: [String]? = nil) {
        self.type = type
        self.service = service
        self.requestedScopes = requestedScopes
    }
}

public struct OpenBundleRequest: Codable, Sendable {
    public let type: String
    public let filePath: String

    public init(type: String, filePath: String) {
        self.type = type
        self.filePath = filePath
    }
}

public struct OpenBundleResponse: Codable, Sendable {
    public let type: String
    public let manifest: OpenBundleResponseManifest
    public let scanResult: OpenBundleResponseScanResult
    public let signatureResult: OpenBundleResponseSignatureResult
    public let bundleSizeBytes: Int

    public init(type: String, manifest: OpenBundleResponseManifest, scanResult: OpenBundleResponseScanResult, signatureResult: OpenBundleResponseSignatureResult, bundleSizeBytes: Int) {
        self.type = type
        self.manifest = manifest
        self.scanResult = scanResult
        self.signatureResult = signatureResult
        self.bundleSizeBytes = bundleSizeBytes
    }
}

public struct OpenBundleResponseManifest: Codable, Sendable {
    public let format_version: Int
    public let name: String
    public let description: String?
    public let icon: String?
    public let created_at: String
    public let created_by: String
    public let entry: String
    public let capabilities: [String]

    public init(format_version: Int, name: String, description: String? = nil, icon: String? = nil, created_at: String, created_by: String, entry: String, capabilities: [String]) {
        self.format_version = format_version
        self.name = name
        self.description = description
        self.icon = icon
        self.created_at = created_at
        self.created_by = created_by
        self.entry = entry
        self.capabilities = capabilities
    }
}

public struct OpenBundleResponseScanResult: Codable, Sendable {
    public let passed: Bool
    public let blocked: [String]
    public let warnings: [String]

    public init(passed: Bool, blocked: [String], warnings: [String]) {
        self.passed = passed
        self.blocked = blocked
        self.warnings = warnings
    }
}

public struct OpenBundleResponseSignatureResult: Codable, Sendable {
    public let trustTier: String
    public let signerKeyId: String?
    public let signerDisplayName: String?
    public let signerAccount: String?

    public init(trustTier: String, signerKeyId: String? = nil, signerDisplayName: String? = nil, signerAccount: String? = nil) {
        self.trustTier = trustTier
        self.signerKeyId = signerKeyId
        self.signerDisplayName = signerDisplayName
        self.signerAccount = signerAccount
    }
}

public struct OpenUrl: Codable, Sendable {
    public let type: String
    public let url: String
    public let title: String?

    public init(type: String, url: String, title: String? = nil) {
        self.type = type
        self.url = url
        self.title = title
    }
}

public struct OpenConversation: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let title: String?
    public let anchorMessageId: String?
    public let focus: Bool?

    public init(type: String, conversationId: String, title: String? = nil, anchorMessageId: String? = nil, focus: Bool? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.title = title
        self.anchorMessageId = anchorMessageId
        self.focus = focus
    }
}

public struct PairingApprovalRequest: Codable, Sendable {
    public let type: String
    public let pairingRequestId: String
    public let deviceId: String
    public let deviceName: String

    public init(type: String, pairingRequestId: String, deviceId: String, deviceName: String) {
        self.type = type
        self.pairingRequestId = pairingRequestId
        self.deviceId = deviceId
        self.deviceName = deviceName
    }
}

public struct PairingApprovalResponse: Codable, Sendable {
    public let type: String
    public let pairingRequestId: String
    public let decision: String

    public init(type: String, pairingRequestId: String, decision: String) {
        self.type = type
        self.pairingRequestId = pairingRequestId
        self.decision = decision
    }
}

public struct PingMessage: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct PlatformConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let baseUrl: String?

    public init(type: String, action: String, baseUrl: String? = nil) {
        self.type = type
        self.action = action
        self.baseUrl = baseUrl
    }
}

public struct PlatformConfigResponse: Codable, Sendable {
    public let type: String
    public let baseUrl: String
    public let success: Bool
    public let error: String?

    public init(type: String, baseUrl: String, success: Bool, error: String? = nil) {
        self.type = type
        self.baseUrl = baseUrl
        self.success = success
        self.error = error
    }
}

public struct PongMessage: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct PublishPageRequest: Codable, Sendable {
    public let type: String
    public let html: String
    public let title: String?
    public let appId: String?

    public init(type: String, html: String, title: String? = nil, appId: String? = nil) {
        self.type = type
        self.html = html
        self.title = title
        self.appId = appId
    }
}

public struct PublishPageResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let publicUrl: String?
    public let deploymentId: String?
    public let error: String?
    public let errorCode: String?

    public init(type: String, success: Bool, publicUrl: String? = nil, deploymentId: String? = nil, error: String? = nil, errorCode: String? = nil) {
        self.type = type
        self.success = success
        self.publicUrl = publicUrl
        self.deploymentId = deploymentId
        self.error = error
        self.errorCode = errorCode
    }
}

/// Recording options shared across standalone and CU recording flows.
public struct RecordingOptions: Codable, Sendable {
    public let captureScope: String?
    public let displayId: String?
    public let windowId: Double?
    public let includeAudio: Bool?
    public let includeMicrophone: Bool?
    public let promptForSource: Bool?

    public init(captureScope: String? = nil, displayId: String? = nil, windowId: Double? = nil, includeAudio: Bool? = nil, includeMicrophone: Bool? = nil, promptForSource: Bool? = nil) {
        self.captureScope = captureScope
        self.displayId = displayId
        self.windowId = windowId
        self.includeAudio = includeAudio
        self.includeMicrophone = includeMicrophone
        self.promptForSource = promptForSource
    }
}

/// Server → Client: pause the active recording.
public struct RecordingPause: Codable, Sendable {
    public let type: String
    public let recordingId: String

    public init(type: String, recordingId: String) {
        self.type = type
        self.recordingId = recordingId
    }
}

/// Server → Client: resume a paused recording.
public struct RecordingResume: Codable, Sendable {
    public let type: String
    public let recordingId: String

    public init(type: String, recordingId: String) {
        self.type = type
        self.recordingId = recordingId
    }
}

/// Server → Client: start a recording.
public struct RecordingStart: Codable, Sendable {
    public let type: String
    public let recordingId: String
    public let attachToConversationId: String?
    /// Recording options shared across standalone and CU recording flows.
    public let options: RecordingOptions?
    /// Operation token for restart race hardening — stale completions with mismatched tokens are rejected.
    public let operationToken: String?

    public init(type: String, recordingId: String, attachToConversationId: String? = nil, options: RecordingOptions? = nil, operationToken: String? = nil) {
        self.type = type
        self.recordingId = recordingId
        self.attachToConversationId = attachToConversationId
        self.options = options
        self.operationToken = operationToken
    }
}

/// Client → Server: recording lifecycle status update.
public struct RecordingStatus: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let status: String
    public let filePath: String?
    public let durationMs: Double?
    public let error: String?
    public let attachToConversationId: String?
    /// Operation token for restart race hardening — matches the token from RecordingStart.
    public let operationToken: String?

    public init(type: String, conversationId: String, status: String, filePath: String? = nil, durationMs: Double? = nil, error: String? = nil, attachToConversationId: String? = nil, operationToken: String? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.status = status
        self.filePath = filePath
        self.durationMs = durationMs
        self.error = error
        self.attachToConversationId = attachToConversationId
        self.operationToken = operationToken
    }
}

/// Server → Client: stop a recording.
public struct RecordingStop: Codable, Sendable {
    public let type: String
    public let recordingId: String

    public init(type: String, recordingId: String) {
        self.type = type
        self.recordingId = recordingId
    }
}

public struct RegenerateRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String

    public init(type: String, conversationId: String) {
        self.type = type
        self.conversationId = conversationId
    }
}

public struct RemoveTrustRule: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct ReorderConversationsRequest: Codable, Sendable {
    public let type: String
    public let updates: [ReorderConversationsRequestUpdate]

    public init(type: String, updates: [ReorderConversationsRequestUpdate]) {
        self.type = type
        self.updates = updates
    }
}

public struct ReorderConversationsRequestUpdate: Codable, Sendable {
    public let conversationId: String
    public let displayOrder: Double?
    public let isPinned: Bool
    public let groupId: String?

    public init(conversationId: String, displayOrder: Double?, isPinned: Bool, groupId: String? = nil) {
        self.conversationId = conversationId
        self.displayOrder = displayOrder
        self.isPinned = isPinned
        self.groupId = groupId
    }
}

public struct ScheduleRemove: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct ScheduleCancel: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct ScheduleRunNow: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct SchedulesList: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct SchedulesListResponse: Codable, Sendable {
    public let type: String
    public let schedules: [SchedulesListResponseSchedule]

    public init(type: String, schedules: [SchedulesListResponseSchedule]) {
        self.type = type
        self.schedules = schedules
    }
}

public struct SchedulesListResponseSchedule: Codable, Sendable {
    public let id: String
    public let name: String
    public let enabled: Bool
    public let syntax: String
    public let expression: String?
    public let cronExpression: String?
    public let timezone: String?
    public let message: String
    public let nextRunAt: Int
    public let lastRunAt: Int?
    public let lastStatus: String?
    public let description: String
    public let mode: String
    public let status: String
    public let routingIntent: String
    public let isOneShot: Bool

    public init(id: String, name: String, enabled: Bool, syntax: String, expression: String?, cronExpression: String?, timezone: String?, message: String, nextRunAt: Int, lastRunAt: Int?, lastStatus: String?, description: String, mode: String, status: String, routingIntent: String, isOneShot: Bool) {
        self.id = id
        self.name = name
        self.enabled = enabled
        self.syntax = syntax
        self.expression = expression
        self.cronExpression = cronExpression
        self.timezone = timezone
        self.message = message
        self.nextRunAt = nextRunAt
        self.lastRunAt = lastRunAt
        self.lastStatus = lastStatus
        self.description = description
        self.mode = mode
        self.status = status
        self.routingIntent = routingIntent
        self.isOneShot = isOneShot
    }
}

/// Server push — broadcast when a heartbeat creates a conversation, so the client can show it in the sidebar.
public struct HeartbeatConversationCreated: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let title: String

    public init(type: String, conversationId: String, title: String) {
        self.type = type
        self.conversationId = conversationId
        self.title = title
    }
}

/// Server push — broadcast when a schedule creates a conversation, so the client can show it as a chat conversation.
public struct ScheduleConversationCreated: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let scheduleJobId: String
    public let title: String

    public init(type: String, conversationId: String, scheduleJobId: String, title: String) {
        self.type = type
        self.conversationId = conversationId
        self.scheduleJobId = scheduleJobId
        self.title = title
    }
}

public struct ScheduleToggle: Codable, Sendable {
    public let type: String
    public let id: String
    public let enabled: Bool

    public init(type: String, id: String, enabled: Bool) {
        self.type = type
        self.id = id
        self.enabled = enabled
    }
}

public struct SecretDetected: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let matches: [SecretDetectedMatch]
    public let action: String

    public init(type: String, toolName: String, matches: [SecretDetectedMatch], action: String) {
        self.type = type
        self.toolName = toolName
        self.matches = matches
        self.action = action
    }
}

public struct SecretDetectedMatch: Codable, Sendable {
    public let type: String
    public let redactedValue: String

    public init(type: String, redactedValue: String) {
        self.type = type
        self.redactedValue = redactedValue
    }
}

public struct SecretRequest: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let service: String
    public let field: String
    public let label: String
    public let description: String?
    public let placeholder: String?
    public let conversationId: String?
    /// Intended purpose of the credential (displayed to user).
    public let purpose: String?
    /// Tools allowed to use this credential.
    public let allowedTools: [String]?
    /// Domains where this credential may be used.
    public let allowedDomains: [String]?
    /// Whether one-time send override is available.
    public let allowOneTimeSend: Bool?

    public init(type: String, requestId: String, service: String, field: String, label: String, description: String? = nil, placeholder: String? = nil, conversationId: String? = nil, purpose: String? = nil, allowedTools: [String]? = nil, allowedDomains: [String]? = nil, allowOneTimeSend: Bool? = nil) {
        self.type = type
        self.requestId = requestId
        self.service = service
        self.field = field
        self.label = label
        self.description = description
        self.placeholder = placeholder
        self.conversationId = conversationId
        self.purpose = purpose
        self.allowedTools = allowedTools
        self.allowedDomains = allowedDomains
        self.allowOneTimeSend = allowOneTimeSend
    }
}

public struct SecretResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let value: String?
    /// How the secret should be delivered: 'store' persists to keychain (default), 'transient_send' for one-time use without persisting.
    public let delivery: String?

    public init(type: String, requestId: String, value: String? = nil, delivery: String? = nil) {
        self.type = type
        self.requestId = requestId
        self.value = value
        self.delivery = delivery
    }
}

public struct ConversationCreateRequest: Codable, Sendable {
    public let type: String
    public let title: String?
    public let systemPromptOverride: String?
    public let maxResponseTokens: Int?
    public let correlationId: String?
    /// Lightweight conversation transport metadata for channel identity and natural-language guidance.
    public let transport: ConversationTransportMetadata?
    public let conversationType: String?
    /// Skill IDs to pre-activate in the new conversation (loaded before the first message).
    public let preactivatedSkillIds: [String]?
    /// If provided, automatically sent as the first user message after conversation creation.
    public let initialMessage: String?

    public init(type: String, title: String? = nil, systemPromptOverride: String? = nil, maxResponseTokens: Int? = nil, correlationId: String? = nil, transport: ConversationTransportMetadata? = nil, conversationType: String? = nil, preactivatedSkillIds: [String]? = nil, initialMessage: String? = nil) {
        self.type = type
        self.title = title
        self.systemPromptOverride = systemPromptOverride
        self.maxResponseTokens = maxResponseTokens
        self.correlationId = correlationId
        self.transport = transport
        self.conversationType = conversationType
        self.preactivatedSkillIds = preactivatedSkillIds
        self.initialMessage = initialMessage
    }
}

public struct ConversationInfo: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let title: String
    public let correlationId: String?
    public let conversationType: String?
    public let hostAccess: Bool?

    public init(type: String, conversationId: String, title: String, correlationId: String? = nil, conversationType: String? = nil, hostAccess: Bool? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.title = title
        self.correlationId = correlationId
        self.conversationType = conversationType
        self.hostAccess = hostAccess
    }
}

public struct ConversationForkParent: Codable, Sendable {
    public let conversationId: String
    public let messageId: String
    public let title: String

    public init(conversationId: String, messageId: String, title: String) {
        self.conversationId = conversationId
        self.messageId = messageId
        self.title = title
    }
}

public struct ConversationListRequest: Codable, Sendable {
    public let type: String
    /// Number of conversations to skip (for pagination). Defaults to 0.
    public let offset: Double?
    /// Maximum number of conversations to return. Defaults to 50.
    public let limit: Double?

    public init(type: String, offset: Double? = nil, limit: Double? = nil) {
        self.type = type
        self.offset = offset
        self.limit = limit
    }
}

public struct ConversationListResponse: Codable, Sendable {
    public let type: String
    public let conversations: [ConversationListResponseItem]
    /// Whether more conversations exist beyond the returned page.
    public let hasMore: Bool?
    /// The offset to use for the next page request. Based on DB-level
    /// pagination so injected pinned conversations don't inflate the value.
    public let nextOffset: Int?
    /// Available conversation groups. Sent with the first page only.
    public let groups: [ConversationGroupResponse]?

    public init(type: String, conversations: [ConversationListResponseItem], hasMore: Bool? = nil, nextOffset: Int? = nil, groups: [ConversationGroupResponse]? = nil) {
        self.type = type
        self.conversations = conversations
        self.hasMore = hasMore
        self.nextOffset = nextOffset
        self.groups = groups
    }
}

public struct ConversationListResponseItem: Codable, Sendable {
    public let id: String
    public let title: String
    public let createdAt: Int?
    public let updatedAt: Int
    public let lastMessageAt: Int?
    public let conversationType: String?
    public let source: String?
    public let hostAccess: Bool?
    public let scheduleJobId: String?
    /// Channel binding metadata exposed in conversation list APIs.
    public let channelBinding: ChannelBinding?
    public let conversationOriginChannel: String?
    public let conversationOriginInterface: String?
    /// Attention state metadata for a conversation's latest assistant message.
    public let assistantAttention: AssistantAttention?
    public let displayOrder: Double?
    public let isPinned: Bool?
    public let groupId: String?
    public let forkParent: ConversationForkParent?

    public init(id: String, title: String, createdAt: Int? = nil, updatedAt: Int, lastMessageAt: Int? = nil, conversationType: String? = nil, source: String? = nil, hostAccess: Bool? = nil, scheduleJobId: String? = nil, channelBinding: ChannelBinding? = nil, conversationOriginChannel: String? = nil, conversationOriginInterface: String? = nil, assistantAttention: AssistantAttention? = nil, displayOrder: Double? = nil, isPinned: Bool? = nil, groupId: String? = nil, forkParent: ConversationForkParent? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastMessageAt = lastMessageAt
        self.conversationType = conversationType
        self.source = source
        self.hostAccess = hostAccess
        self.scheduleJobId = scheduleJobId
        self.channelBinding = channelBinding
        self.conversationOriginChannel = conversationOriginChannel
        self.conversationOriginInterface = conversationOriginInterface
        self.assistantAttention = assistantAttention
        self.displayOrder = displayOrder
        self.isPinned = isPinned
        self.groupId = groupId
        self.forkParent = forkParent
    }
}

public struct ConversationGroupResponse: Codable, Sendable {
    public let id: String
    public let name: String
    public let sortPosition: Double
    public let isSystemGroup: Bool

    public init(id: String, name: String, sortPosition: Double, isSystemGroup: Bool) {
        self.id = id
        self.name = name
        self.sortPosition = sortPosition
        self.isSystemGroup = isSystemGroup
    }
}

public struct ConversationRenameRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let title: String

    public init(type: String, conversationId: String, title: String) {
        self.type = type
        self.conversationId = conversationId
        self.title = title
    }
}

public struct ConversationsClearRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct ConversationsClearResponse: Codable, Sendable {
    public let type: String
    public let cleared: Int

    public init(type: String, cleared: Int) {
        self.type = type
        self.cleared = cleared
    }
}

public struct ConversationSwitchRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String

    public init(type: String, conversationId: String) {
        self.type = type
        self.conversationId = conversationId
    }
}

public struct ConversationTitleUpdated: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let title: String

    public init(type: String, conversationId: String, title: String) {
        self.type = type
        self.conversationId = conversationId
        self.title = title
    }
}

/// Lightweight conversation transport metadata for channel identity and natural-language guidance.
public struct ConversationTransportMetadata: Codable, Sendable {
    /// Logical channel identifier (e.g. "desktop", "telegram", "mobile").
    public let channelId: String
    /// Interface identifier for this transport (e.g. "macos", "ios", "cli").
    public let interfaceId: String?
    /// Optional natural-language hints for channel-specific UX behavior.
    public let hints: [String]?
    /// Optional concise UX brief for this channel.
    public let uxBrief: String?
    /// Home directory of the host macOS user. Only populated when interfaceId == "macos".
    public let hostHomeDir: String?
    /// Username of the host macOS user. Only populated when interfaceId == "macos".
    public let hostUsername: String?

    public init(channelId: String, interfaceId: String? = nil, hints: [String]? = nil, uxBrief: String? = nil, hostHomeDir: String? = nil, hostUsername: String? = nil) {
        self.channelId = channelId
        self.interfaceId = interfaceId
        self.hints = hints
        self.uxBrief = uxBrief
        self.hostHomeDir = hostHomeDir
        self.hostUsername = hostUsername
    }
}

public struct ShareAppCloudRequest: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct ShareAppCloudResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let shareToken: String?
    public let shareUrl: String?
    public let error: String?

    public init(type: String, success: Bool, shareToken: String? = nil, shareUrl: String? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.shareToken = shareToken
        self.shareUrl = shareUrl
        self.error = error
    }
}

public struct SharedAppDeleteRequest: Codable, Sendable {
    public let type: String
    public let uuid: String

    public init(type: String, uuid: String) {
        self.type = type
        self.uuid = uuid
    }
}

public struct SharedAppDeleteResponse: Codable, Sendable {
    public let type: String
    public let success: Bool

    public init(type: String, success: Bool) {
        self.type = type
        self.success = success
    }
}

public struct SharedAppsListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct SharedAppsListResponse: Codable, Sendable {
    public let type: String
    public let apps: [SharedAppsListResponseApp]

    public init(type: String, apps: [SharedAppsListResponseApp]) {
        self.type = type
        self.apps = apps
    }
}

public struct SharedAppsListResponseApp: Codable, Sendable {
    public let uuid: String
    public let name: String
    public let description: String?
    public let icon: String?
    public let preview: String?
    public let entry: String
    public let trustTier: String
    public let signerDisplayName: String?
    public let bundleSizeBytes: Int
    public let installedAt: String
    public let version: String?
    public let contentId: String?
    public let updateAvailable: Bool?

    public init(uuid: String, name: String, description: String? = nil, icon: String? = nil, preview: String? = nil, entry: String, trustTier: String, signerDisplayName: String? = nil, bundleSizeBytes: Int, installedAt: String, version: String? = nil, contentId: String? = nil, updateAvailable: Bool? = nil) {
        self.uuid = uuid
        self.name = name
        self.description = description
        self.icon = icon
        self.preview = preview
        self.entry = entry
        self.trustTier = trustTier
        self.signerDisplayName = signerDisplayName
        self.bundleSizeBytes = bundleSizeBytes
        self.installedAt = installedAt
        self.version = version
        self.contentId = contentId
        self.updateAvailable = updateAvailable
    }
}

public struct SignBundlePayloadRequest: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let payload: String

    public init(type: String, requestId: String, payload: String) {
        self.type = type
        self.requestId = requestId
        self.payload = payload
    }
}

public struct SignBundlePayloadResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let signature: String?
    public let keyId: String?
    public let publicKey: String?
    public let error: String?

    public init(type: String, requestId: String, signature: String? = nil, keyId: String? = nil, publicKey: String? = nil, error: String? = nil) {
        self.type = type
        self.requestId = requestId
        self.signature = signature
        self.keyId = keyId
        self.publicKey = publicKey
        self.error = error
    }
}

/// Sent by the daemon when workspace config.json changes on disk.
public struct ConfigChanged: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

/// Sent by the daemon when sounds config or sound files change on disk.
public struct SoundsConfigUpdated: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

/// Sent by the daemon when feature flag files change on disk.
public struct FeatureFlagsChanged: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct SkillDetailRequest: Codable, Sendable {
    public let type: String
    public let skillId: String

    public init(type: String, skillId: String) {
        self.type = type
        self.skillId = skillId
    }
}

public struct SkillDetailResponse: Codable, Sendable {
    public let type: String
    public let skillId: String
    public let body: String
    public let icon: String?
    public let error: String?

    public init(type: String, skillId: String, body: String, icon: String? = nil, error: String? = nil) {
        self.type = type
        self.skillId = skillId
        self.body = body
        self.icon = icon
        self.error = error
    }
}

public struct SkillsCheckUpdatesRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct SkillsConfigureRequest: Codable, Sendable {
    public let type: String
    public let name: String
    public let env: [String: String]?
    public let apiKey: String?
    public let config: [String: AnyCodable]?

    public init(type: String, name: String, env: [String: String]? = nil, apiKey: String? = nil, config: [String: AnyCodable]? = nil) {
        self.type = type
        self.name = name
        self.env = env
        self.apiKey = apiKey
        self.config = config
    }
}

public struct SkillsCreateRequest: Codable, Sendable {
    public let type: String
    public let skillId: String
    public let name: String
    public let description: String
    public let emoji: String?
    public let bodyMarkdown: String
    public let overwrite: Bool?

    public init(type: String, skillId: String, name: String, description: String, emoji: String? = nil, bodyMarkdown: String, overwrite: Bool? = nil) {
        self.type = type
        self.skillId = skillId
        self.name = name
        self.description = description
        self.emoji = emoji
        self.bodyMarkdown = bodyMarkdown
        self.overwrite = overwrite
    }
}

public struct SkillsDisableRequest: Codable, Sendable {
    public let type: String
    public let name: String

    public init(type: String, name: String) {
        self.type = type
        self.name = name
    }
}

public struct SkillsDraftRequest: Codable, Sendable {
    public let type: String
    public let sourceText: String

    public init(type: String, sourceText: String) {
        self.type = type
        self.sourceText = sourceText
    }
}

public struct SkillsDraftResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let draft: SkillsDraftResponseDraft?
    public let warnings: [String]?
    public let error: String?

    public init(type: String, success: Bool, draft: SkillsDraftResponseDraft? = nil, warnings: [String]? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.draft = draft
        self.warnings = warnings
        self.error = error
    }
}

public struct SkillsDraftResponseDraft: Codable, Sendable {
    public let skillId: String
    public let name: String
    public let description: String
    public let emoji: String?
    public let bodyMarkdown: String

    public init(skillId: String, name: String, description: String, emoji: String? = nil, bodyMarkdown: String) {
        self.skillId = skillId
        self.name = name
        self.description = description
        self.emoji = emoji
        self.bodyMarkdown = bodyMarkdown
    }
}

public struct SkillsEnableRequest: Codable, Sendable {
    public let type: String
    public let name: String

    public init(type: String, name: String) {
        self.type = type
        self.name = name
    }
}

public struct SkillsInspectRequest: Codable, Sendable {
    public let type: String
    public let slug: String

    public init(type: String, slug: String) {
        self.type = type
        self.slug = slug
    }
}

public struct SkillsInspectResponse: Codable, Sendable {
    public let type: String
    public let slug: String
    public let data: SkillsInspectResponseData?
    public let error: String?

    public init(type: String, slug: String, data: SkillsInspectResponseData? = nil, error: String? = nil) {
        self.type = type
        self.slug = slug
        self.data = data
        self.error = error
    }
}

public struct SkillsInspectResponseData: Codable, Sendable {
    public let skill: SkillsInspectResponseDataSkill
    public let owner: SkillsInspectResponseDataOwner?
    public let stats: SkillsInspectResponseDataStats?
    public let createdAt: Int?
    public let updatedAt: Int?
    public let latestVersion: SkillsInspectResponseDataLatestVersion?
    public let files: [SkillsInspectResponseDataFile]?
    public let skillMdContent: String?

    public init(skill: SkillsInspectResponseDataSkill, owner: SkillsInspectResponseDataOwner? = nil, stats: SkillsInspectResponseDataStats? = nil, createdAt: Int? = nil, updatedAt: Int? = nil, latestVersion: SkillsInspectResponseDataLatestVersion? = nil, files: [SkillsInspectResponseDataFile]? = nil, skillMdContent: String? = nil) {
        self.skill = skill
        self.owner = owner
        self.stats = stats
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.latestVersion = latestVersion
        self.files = files
        self.skillMdContent = skillMdContent
    }
}

public struct SkillsInspectResponseDataFile: Codable, Sendable {
    public let path: String
    public let size: Int
    public let contentType: String?

    public init(path: String, size: Int, contentType: String? = nil) {
        self.path = path
        self.size = size
        self.contentType = contentType
    }
}

public struct SkillsInspectResponseDataLatestVersion: Codable, Sendable {
    public let version: String
    public let changelog: String?

    public init(version: String, changelog: String? = nil) {
        self.version = version
        self.changelog = changelog
    }
}

public struct SkillsInspectResponseDataOwner: Codable, Sendable {
    public let handle: String
    public let displayName: String
    public let image: String?

    public init(handle: String, displayName: String, image: String? = nil) {
        self.handle = handle
        self.displayName = displayName
        self.image = image
    }
}

public struct SkillsInspectResponseDataSkill: Codable, Sendable {
    public let slug: String
    public let displayName: String
    public let summary: String

    public init(slug: String, displayName: String, summary: String) {
        self.slug = slug
        self.displayName = displayName
        self.summary = summary
    }
}

public struct SkillsInspectResponseDataStats: Codable, Sendable {
    public let stars: Int
    public let installs: Int
    public let downloads: Int
    public let versions: Int

    public init(stars: Int, installs: Int, downloads: Int, versions: Int) {
        self.stars = stars
        self.installs = installs
        self.downloads = downloads
        self.versions = versions
    }
}

public struct SkillsInstallRequest: Codable, Sendable {
    public let type: String
    public let slug: String
    public let version: String?

    public init(type: String, slug: String, version: String? = nil) {
        self.type = type
        self.slug = slug
        self.version = version
    }
}

public struct SkillsListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct SkillsListResponse: Codable, Sendable {
    public let type: String
    public let skills: [SkillsListResponseSkill]

    public init(type: String, skills: [SkillsListResponseSkill]) {
        self.type = type
        self.skills = skills
    }
}

/// Security audit result from a partner analysis provider.
public struct PartnerAudit: Codable, Sendable, Equatable {
    public let risk: String
    public let alerts: Int?
    public let score: Double?
    public let analyzedAt: String

    public init(risk: String, alerts: Int? = nil, score: Double? = nil, analyzedAt: String) {
        self.risk = risk
        self.alerts = alerts
        self.score = score
        self.analyzedAt = analyzedAt
    }
}

public struct SkillsListResponseSkill: Codable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let emoji: String?
    public let kind: String
    public let origin: String
    public let status: String
    // Clawhub + Skillssh shared:
    public let slug: String?
    public let installs: Int?
    // Clawhub-only:
    public let author: String?
    public let stars: Int?
    public let reports: Int?
    public let publishedAt: String?
    public let version: String?
    // Skillssh-only:
    public let sourceRepo: String?
    public let audit: [String: PartnerAudit]?

    public init(id: String, name: String, description: String, emoji: String? = nil, kind: String, origin: String, status: String, slug: String? = nil, installs: Int? = nil, author: String? = nil, stars: Int? = nil, reports: Int? = nil, publishedAt: String? = nil, version: String? = nil, sourceRepo: String? = nil, audit: [String: PartnerAudit]? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.emoji = emoji
        self.kind = kind
        self.origin = origin
        self.status = status
        self.slug = slug
        self.installs = installs
        self.author = author
        self.stars = stars
        self.reports = reports
        self.publishedAt = publishedAt
        self.version = version
        self.sourceRepo = sourceRepo
        self.audit = audit
    }
}

// MARK: - Skill Detail Response (GET /v1/skills/:id)

public struct ClawhubDetailOwner: Codable, Sendable {
    public let handle: String
    public let displayName: String
    public let image: String?

    public init(handle: String, displayName: String, image: String? = nil) {
        self.handle = handle
        self.displayName = displayName
        self.image = image
    }
}

public struct ClawhubDetailStats: Codable, Sendable {
    public let stars: Int
    public let installs: Int
    public let downloads: Int
    public let versions: Int

    public init(stars: Int, installs: Int, downloads: Int, versions: Int) {
        self.stars = stars
        self.installs = installs
        self.downloads = downloads
        self.versions = versions
    }
}

public struct ClawhubDetailVersion: Codable, Sendable {
    public let version: String
    public let changelog: String?

    public init(version: String, changelog: String? = nil) {
        self.version = version
        self.changelog = changelog
    }
}

public struct SkillDetailHTTPResponse: Codable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let emoji: String?
    public let kind: String
    public let origin: String
    public let status: String
    // Clawhub + Skillssh shared:
    public let slug: String?
    public let installs: Int?
    // Clawhub-only:
    public let author: String?
    public let stars: Int?
    public let reports: Int?
    public let publishedAt: String?
    // Skillssh-only:
    public let sourceRepo: String?
    public let audit: [String: PartnerAudit]?
    // Clawhub detail enrichment fields:
    public let owner: ClawhubDetailOwner?
    public let stats: ClawhubDetailStats?
    public let latestVersion: ClawhubDetailVersion?
    public let createdAt: Int?
    public let updatedAt: Int?

    public init(id: String, name: String, description: String, emoji: String? = nil, kind: String, origin: String, status: String, slug: String? = nil, installs: Int? = nil, author: String? = nil, stars: Int? = nil, reports: Int? = nil, publishedAt: String? = nil, sourceRepo: String? = nil, audit: [String: PartnerAudit]? = nil, owner: ClawhubDetailOwner? = nil, stats: ClawhubDetailStats? = nil, latestVersion: ClawhubDetailVersion? = nil, createdAt: Int? = nil, updatedAt: Int? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.emoji = emoji
        self.kind = kind
        self.origin = origin
        self.status = status
        self.slug = slug
        self.installs = installs
        self.author = author
        self.stars = stars
        self.reports = reports
        self.publishedAt = publishedAt
        self.sourceRepo = sourceRepo
        self.audit = audit
        self.owner = owner
        self.stats = stats
        self.latestVersion = latestVersion
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

// MARK: - Skill Detail Files Response (GET /v1/skills/:id/files)

public struct SkillDetailFilesHTTPResponse: Codable, Sendable {
    public let skill: SkillsListResponseSkill
    public let files: [SkillFileEntry]

    public init(skill: SkillsListResponseSkill, files: [SkillFileEntry]) {
        self.skill = skill
        self.files = files
    }
}

public struct SkillFileEntry: Codable, Sendable {
    public let path: String
    public let name: String
    public let size: Int
    public let mimeType: String
    public let isBinary: Bool
    public let content: String?

    public init(path: String, name: String, size: Int, mimeType: String, isBinary: Bool, content: String? = nil) {
        self.path = path
        self.name = name
        self.size = size
        self.mimeType = mimeType
        self.isBinary = isBinary
        self.content = content
    }
}

// MARK: - Skill File Content Response (GET /v1/skills/:id/files/content)

public struct SkillFileContentResponse: Codable, Sendable {
    public let path: String
    public let name: String
    public let size: Int
    public let mimeType: String
    public let isBinary: Bool
    public let content: String?

    public init(path: String, name: String, size: Int, mimeType: String, isBinary: Bool, content: String? = nil) {
        self.path = path
        self.name = name
        self.size = size
        self.mimeType = mimeType
        self.isBinary = isBinary
        self.content = content
    }
}

public struct SkillsOperationResponse: Codable, Sendable {
    public let type: String
    public let operation: String
    public let success: Bool
    public let error: String?
    public let data: AnyCodable?

    public init(type: String, operation: String, success: Bool, error: String? = nil, data: AnyCodable? = nil) {
        self.type = type
        self.operation = operation
        self.success = success
        self.error = error
        self.data = data
    }
}

public struct SkillsSearchRequest: Codable, Sendable {
    public let type: String
    public let query: String

    public init(type: String, query: String) {
        self.type = type
        self.query = query
    }
}

public struct SkillStateChanged: Codable, Sendable {
    public let type: String
    public let name: String
    public let state: String

    public init(type: String, name: String, state: String) {
        self.type = type
        self.name = name
        self.state = state
    }
}

public struct SkillsUninstallRequest: Codable, Sendable {
    public let type: String
    public let name: String

    public init(type: String, name: String) {
        self.type = type
        self.name = name
    }
}

public struct SkillsUpdateRequest: Codable, Sendable {
    public let type: String
    public let name: String

    public init(type: String, name: String) {
        self.type = type
        self.name = name
    }
}

public struct SlackWebhookConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let webhookUrl: String?

    public init(type: String, action: String, webhookUrl: String? = nil) {
        self.type = type
        self.action = action
        self.webhookUrl = webhookUrl
    }
}

public struct SlackWebhookConfigResponse: Codable, Sendable {
    public let type: String
    public let webhookUrl: String?
    public let success: Bool
    public let error: String?

    public init(type: String, webhookUrl: String? = nil, success: Bool, error: String? = nil) {
        self.type = type
        self.webhookUrl = webhookUrl
        self.success = success
        self.error = error
    }
}

public struct SubagentAbortRequest: Codable, Sendable {
    public let type: String
    public let subagentId: String

    public init(type: String, subagentId: String) {
        self.type = type
        self.subagentId = subagentId
    }
}

public struct SubagentDetailRequest: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let conversationId: String

    public init(type: String, subagentId: String, conversationId: String) {
        self.type = type
        self.subagentId = subagentId
        self.conversationId = conversationId
    }
}

public struct SubagentDetailResponse: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let objective: String?
    public let events: [SubagentDetailResponseEvent]

    public init(type: String, subagentId: String, objective: String? = nil, events: [SubagentDetailResponseEvent]) {
        self.type = type
        self.subagentId = subagentId
        self.objective = objective
        self.events = events
    }
}

public struct SubagentDetailResponseEvent: Codable, Sendable {
    public let type: String
    public let content: String
    public let toolName: String?
    public let isError: Bool?
    public let messageId: String?

    public init(type: String, content: String, toolName: String? = nil, isError: Bool? = nil, messageId: String? = nil) {
        self.type = type
        self.content = content
        self.toolName = toolName
        self.isError = isError
        self.messageId = messageId
    }
}

public struct SubagentMessageRequest: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let content: String
    public let conversationId: String?

    public init(type: String, subagentId: String, content: String, conversationId: String? = nil) {
        self.type = type
        self.subagentId = subagentId
        self.content = content
        self.conversationId = conversationId
    }
}

public struct SubagentSpawned: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let parentConversationId: String
    public let label: String
    public let objective: String

    public init(type: String, subagentId: String, parentConversationId: String, label: String, objective: String) {
        self.type = type
        self.subagentId = subagentId
        self.parentConversationId = parentConversationId
        self.label = label
        self.objective = objective
    }
}

public struct SubagentStatusChanged: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let status: String
    public let error: String?
    public let usage: UsageStats?

    public init(type: String, subagentId: String, status: String, error: String? = nil, usage: UsageStats? = nil) {
        self.type = type
        self.subagentId = subagentId
        self.status = status
        self.error = error
        self.usage = usage
    }
}

public struct SubagentStatusRequest: Codable, Sendable {
    public let type: String
    /// If omitted, returns all subagents for the conversation.
    public let subagentId: String?

    public init(type: String, subagentId: String? = nil) {
        self.type = type
        self.subagentId = subagentId
    }
}

public struct SuggestionRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let requestId: String

    public init(type: String, conversationId: String, requestId: String) {
        self.type = type
        self.conversationId = conversationId
        self.requestId = requestId
    }
}

public struct SuggestionResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let suggestion: String?
    public let source: String

    public init(type: String, requestId: String, suggestion: String?, source: String) {
        self.type = type
        self.requestId = requestId
        self.suggestion = suggestion
        self.source = source
    }
}

public struct SurfaceAction: Codable, Sendable {
    public let id: String
    public let label: String
    public let style: String?
    /// Optional data payload returned to the daemon when this action is clicked.
    public let data: [String: AnyCodable]?

    public init(id: String, label: String, style: String? = nil, data: [String: AnyCodable]? = nil) {
        self.id = id
        self.label = label
        self.style = style
        self.data = data
    }
}

/// Server push — broadcast when a task run creates a conversation, so the client can show it as a chat conversation.
public struct TaskRunConversationCreated: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let workItemId: String
    public let title: String

    public init(type: String, conversationId: String, workItemId: String, title: String) {
        self.type = type
        self.conversationId = conversationId
        self.workItemId = workItemId
        self.title = title
    }
}

/// Server push — lightweight invalidation signal: the task queue has been mutated, refetch your list.
public struct TasksChanged: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct TaskSubmit: Codable, Sendable {
    public let type: String
    public let task: String
    public let screenWidth: Int
    public let screenHeight: Int
    public let attachments: [UserMessageAttachment]?
    public let source: String?
    /// Structured command intent — bypasses text parsing when present.
    public let commandIntent: CommandIntent?

    public init(type: String, task: String, screenWidth: Int, screenHeight: Int, attachments: [UserMessageAttachment]? = nil, source: String? = nil, commandIntent: CommandIntent? = nil) {
        self.type = type
        self.task = task
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.attachments = attachments
        self.source = source
        self.commandIntent = commandIntent
    }
}

public struct TelegramConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let botToken: String?
    public let commands: [TelegramConfigRequestCommand]?

    public init(type: String, action: String, botToken: String? = nil, commands: [TelegramConfigRequestCommand]? = nil) {
        self.type = type
        self.action = action
        self.botToken = botToken
        self.commands = commands
    }
}

public struct TelegramConfigRequestCommand: Codable, Sendable {
    public let command: String
    public let description: String

    public init(command: String, description: String) {
        self.command = command
        self.description = description
    }
}

public struct TelegramConfigResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let hasBotToken: Bool
    public let botId: String?
    public let botUsername: String?
    public let connected: Bool
    public let hasWebhookSecret: Bool
    public let lastError: String?
    public let error: String?
    /// Names of bot commands that were registered (present after set_commands or setup).
    public let commandsRegistered: [String]?
    /// Non-fatal warning (e.g. commands registration failed during setup but token was configured).
    public let warning: String?

    public init(type: String, success: Bool, hasBotToken: Bool, botId: String? = nil, botUsername: String? = nil, connected: Bool, hasWebhookSecret: Bool, lastError: String? = nil, error: String? = nil, commandsRegistered: [String]? = nil, warning: String? = nil) {
        self.type = type
        self.success = success
        self.hasBotToken = hasBotToken
        self.botId = botId
        self.botUsername = botUsername
        self.connected = connected
        self.hasWebhookSecret = hasWebhookSecret
        self.lastError = lastError
        self.error = error
        self.commandsRegistered = commandsRegistered
        self.warning = warning
    }
}

public struct ToolInputDelta: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let content: String
    public let conversationId: String?
    /// The tool_use block ID for client-side correlation.
    public let toolUseId: String?

    public init(type: String, toolName: String, content: String, conversationId: String? = nil, toolUseId: String? = nil) {
        self.type = type
        self.toolName = toolName
        self.content = content
        self.conversationId = conversationId
        self.toolUseId = toolUseId
    }
}

public struct ToolInputSchema: Codable, Sendable {
    public let type: String
    public let properties: [String: AnyCodable]?
    public let required: [String]?

    public init(type: String, properties: [String: AnyCodable]? = nil, required: [String]? = nil) {
        self.type = type
        self.properties = properties
        self.required = required
    }
}

public struct ToolNamesListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct ToolNamesListResponse: Codable, Sendable {
    public let type: String
    /// Sorted list of all registered tool names.
    public let names: [String]
    /// Input schemas keyed by tool name.
    public let schemas: [String: AnyCodable]?

    public init(type: String, names: [String], schemas: [String: AnyCodable]? = nil) {
        self.type = type
        self.names = names
        self.schemas = schemas
    }
}

public struct ToolOutputChunk: Codable, Sendable {
    public let type: String
    public let chunk: String
    public let conversationId: String?
    public let toolUseId: String?
    public let subType: String?
    public let subToolName: String?
    public let subToolInput: String?
    public let subToolIsError: Bool?
    public let subToolId: String?

    public init(type: String, chunk: String, conversationId: String? = nil, toolUseId: String? = nil, subType: String? = nil, subToolName: String? = nil, subToolInput: String? = nil, subToolIsError: Bool? = nil, subToolId: String? = nil) {
        self.type = type
        self.chunk = chunk
        self.conversationId = conversationId
        self.toolUseId = toolUseId
        self.subType = subType
        self.subToolName = subToolName
        self.subToolInput = subToolInput
        self.subToolIsError = subToolIsError
        self.subToolId = subToolId
    }
}

public struct ToolPermissionSimulateRequest: Codable, Sendable {
    public let type: String
    /// Tool name to simulate (e.g. 'bash', 'file_write').
    public let toolName: String
    /// Tool input record to simulate.
    public let input: [String: AnyCodable]
    /// Working directory context; defaults to daemon cwd when omitted.
    public let workingDir: String?
    /// Whether the simulated context is interactive (default true).
    public let isInteractive: Bool?
    /// When true, side-effect tools that would normally be auto-allowed get promoted to prompt.
    public let forcePromptSideEffects: Bool?

    public init(type: String, toolName: String, input: [String: AnyCodable], workingDir: String? = nil, isInteractive: Bool? = nil, forcePromptSideEffects: Bool? = nil) {
        self.type = type
        self.toolName = toolName
        self.input = input
        self.workingDir = workingDir
        self.isInteractive = isInteractive
        self.forcePromptSideEffects = forcePromptSideEffects
    }
}

public struct ToolPermissionSimulateResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    /// The simulated permission decision.
    public let decision: String?
    /// Risk level of the simulated tool invocation.
    public let riskLevel: String?
    /// Human-readable reason for the decision.
    public let reason: String?
    /// When decision is 'prompt', the data needed to render a ToolConfirmationBubble.
    public let promptPayload: ToolPermissionSimulateResponsePromptPayload?
    /// Resolved execution target for the tool.
    public let executionTarget: String?
    /// ID of the trust rule that matched (if any).
    public let matchedRuleId: String?
    /// Error message when success is false.
    public let error: String?

    public init(type: String, success: Bool, decision: String? = nil, riskLevel: String? = nil, reason: String? = nil, promptPayload: ToolPermissionSimulateResponsePromptPayload? = nil, executionTarget: String? = nil, matchedRuleId: String? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.decision = decision
        self.riskLevel = riskLevel
        self.reason = reason
        self.promptPayload = promptPayload
        self.executionTarget = executionTarget
        self.matchedRuleId = matchedRuleId
        self.error = error
    }
}

public struct ToolPermissionSimulateResponsePromptPayload: Codable, Sendable {
    public let allowlistOptions: [ToolPermissionSimulateResponsePromptPayloadAllowlistOption]
    public let scopeOptions: [ToolPermissionSimulateResponsePromptPayloadScopeOption]
    public let persistentDecisionsAllowed: Bool

    public init(allowlistOptions: [ToolPermissionSimulateResponsePromptPayloadAllowlistOption], scopeOptions: [ToolPermissionSimulateResponsePromptPayloadScopeOption], persistentDecisionsAllowed: Bool) {
        self.allowlistOptions = allowlistOptions
        self.scopeOptions = scopeOptions
        self.persistentDecisionsAllowed = persistentDecisionsAllowed
    }
}

public struct ToolPermissionSimulateResponsePromptPayloadAllowlistOption: Codable, Sendable {
    public let label: String
    public let description: String
    public let pattern: String

    public init(label: String, description: String, pattern: String) {
        self.label = label
        self.description = description
        self.pattern = pattern
    }
}

public struct ToolPermissionSimulateResponsePromptPayloadScopeOption: Codable, Sendable {
    public let label: String
    public let scope: String

    public init(label: String, scope: String) {
        self.label = label
        self.scope = scope
    }
}

public struct ToolResult: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let result: String
    public let isError: Bool?
    public let diff: ToolResultDiff?
    public let status: String?
    public let conversationId: String?
    /// Base64-encoded image data extracted from contentBlocks (e.g. browser_screenshot, image generation).
    public let imageDataList: [String]?
    /// The tool_use block ID for client-side correlation.
    public let toolUseId: String?

    public init(type: String, toolName: String, result: String, isError: Bool? = nil, diff: ToolResultDiff? = nil, status: String? = nil, conversationId: String? = nil, imageDataList: [String]? = nil, toolUseId: String? = nil) {
        self.type = type
        self.toolName = toolName
        self.result = result
        self.isError = isError
        self.diff = diff
        self.status = status
        self.conversationId = conversationId
        self.imageDataList = imageDataList
        self.toolUseId = toolUseId
    }
}

public struct ToolResultDiff: Codable, Sendable {
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

public struct ToolUsePreviewStart: Codable, Sendable {
    public let type: String
    public let toolUseId: String
    public let toolName: String
    public let conversationId: String?

    public init(type: String, toolUseId: String, toolName: String, conversationId: String? = nil) {
        self.type = type
        self.toolUseId = toolUseId
        self.toolName = toolName
        self.conversationId = conversationId
    }
}

public struct ToolUseStart: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let conversationId: String?
    /// The tool_use block ID for client-side correlation.
    public let toolUseId: String?

    public init(type: String, toolName: String, input: [String: AnyCodable], conversationId: String? = nil, toolUseId: String? = nil) {
        self.type = type
        self.toolName = toolName
        self.input = input
        self.conversationId = conversationId
        self.toolUseId = toolUseId
    }
}

public struct TrustRulesList: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct TrustRulesListResponse: Codable, Sendable {
    public let type: String
    public let rules: [TrustRulesListResponseRule]

    public init(type: String, rules: [TrustRulesListResponseRule]) {
        self.type = type
        self.rules = rules
    }
}

public struct TrustRulesListResponseRule: Codable, Sendable {
    public let id: String
    public let tool: String
    public let pattern: String
    public let scope: String
    public let decision: String
    public let priority: Int
    public let createdAt: Int

    public init(id: String, tool: String, pattern: String, scope: String, decision: String, priority: Int, createdAt: Int) {
        self.id = id
        self.tool = tool
        self.pattern = pattern
        self.scope = scope
        self.decision = decision
        self.priority = priority
        self.createdAt = createdAt
    }
}

public struct UiSurfaceAction: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let surfaceId: String
    public let actionId: String
    public let data: [String: AnyCodable]?

    public init(type: String, conversationId: String, surfaceId: String, actionId: String, data: [String: AnyCodable]? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.surfaceId = surfaceId
        self.actionId = actionId
        self.data = data
    }
}

public struct UiSurfaceComplete: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let surfaceId: String
    public let summary: String
    public let submittedData: [String: AnyCodable]?

    public init(type: String, conversationId: String, surfaceId: String, summary: String, submittedData: [String: AnyCodable]? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.surfaceId = surfaceId
        self.summary = summary
        self.submittedData = submittedData
    }
}

public struct UiSurfaceDismiss: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let surfaceId: String

    public init(type: String, conversationId: String, surfaceId: String) {
        self.type = type
        self.conversationId = conversationId
        self.surfaceId = surfaceId
    }
}

public struct UiSurfaceShow: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let surfaceId: String
    public let surfaceType: String
    public let title: String?
    public let data: [String: AnyCodable]
    public let actions: [SurfaceAction]?
    /// `"inline"` embeds in chat, `"panel"` shows a floating window.
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?
    /// When `true`, clicking an action does not dismiss the surface — the client keeps the card visible and only marks the clicked `actionId` as spent so siblings remain clickable.
    public let persistent: Bool?

    public init(type: String, conversationId: String, surfaceId: String, surfaceType: String, title: String? = nil, data: [String: AnyCodable], actions: [SurfaceAction]? = nil, display: String? = nil, messageId: String? = nil, persistent: Bool? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.surfaceId = surfaceId
        self.surfaceType = surfaceType
        self.title = title
        self.data = data
        self.actions = actions
        self.display = display
        self.messageId = messageId
        self.persistent = persistent
    }
}

public struct UiSurfaceUndoRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let surfaceId: String

    public init(type: String, conversationId: String, surfaceId: String) {
        self.type = type
        self.conversationId = conversationId
        self.surfaceId = surfaceId
    }
}

public struct UiSurfaceUndoResult: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let surfaceId: String
    public let success: Bool
    /// Number of remaining undo entries after this undo.
    public let remainingUndos: Int

    public init(type: String, conversationId: String, surfaceId: String, success: Bool, remainingUndos: Int) {
        self.type = type
        self.conversationId = conversationId
        self.surfaceId = surfaceId
        self.success = success
        self.remainingUndos = remainingUndos
    }
}

public struct UiSurfaceUpdate: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let surfaceId: String
    public let data: [String: AnyCodable]

    public init(type: String, conversationId: String, surfaceId: String, data: [String: AnyCodable]) {
        self.type = type
        self.conversationId = conversationId
        self.surfaceId = surfaceId
        self.data = data
    }
}

public struct UndoComplete: Codable, Sendable {
    public let type: String
    public let removedCount: Int
    public let conversationId: String?

    public init(type: String, removedCount: Int, conversationId: String? = nil) {
        self.type = type
        self.removedCount = removedCount
        self.conversationId = conversationId
    }
}

public struct UndoRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String

    public init(type: String, conversationId: String) {
        self.type = type
        self.conversationId = conversationId
    }
}

public struct UnpublishPageRequest: Codable, Sendable {
    public let type: String
    public let deploymentId: String

    public init(type: String, deploymentId: String) {
        self.type = type
        self.deploymentId = deploymentId
    }
}

public struct UnpublishPageResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?

    public init(type: String, success: Bool, error: String? = nil) {
        self.type = type
        self.success = success
        self.error = error
    }
}

public struct UpdateTrustRule: Codable, Sendable {
    public let type: String
    public let id: String
    public let tool: String?
    public let pattern: String?
    public let scope: String?
    public let decision: String?
    public let priority: Int?

    public init(type: String, id: String, tool: String? = nil, pattern: String? = nil, scope: String? = nil, decision: String? = nil, priority: Int? = nil) {
        self.type = type
        self.id = id
        self.tool = tool
        self.pattern = pattern
        self.scope = scope
        self.decision = decision
        self.priority = priority
    }
}

public struct UsageRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String

    public init(type: String, conversationId: String) {
        self.type = type
        self.conversationId = conversationId
    }
}

public struct UsageResponse: Codable, Sendable {
    public let type: String
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let estimatedCost: Double
    public let model: String

    public init(type: String, totalInputTokens: Int, totalOutputTokens: Int, estimatedCost: Double, model: String) {
        self.type = type
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.estimatedCost = estimatedCost
        self.model = model
    }
}

public struct UsageStats: Codable, Sendable {
    public let inputTokens: Int
    public let outputTokens: Int
    public let estimatedCost: Double

    public init(inputTokens: Int, outputTokens: Int, estimatedCost: Double) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.estimatedCost = estimatedCost
    }
}

public struct UsageUpdate: Codable, Sendable {
    public let type: String
    public let conversationId: String?
    public let inputTokens: Int
    public let outputTokens: Int
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let estimatedCost: Double
    public let model: String
    public let contextWindowTokens: Int?
    public let contextWindowMaxTokens: Int?

    public init(type: String, conversationId: String? = nil, inputTokens: Int, outputTokens: Int,
                totalInputTokens: Int, totalOutputTokens: Int,
                estimatedCost: Double, model: String,
                contextWindowTokens: Int? = nil,
                contextWindowMaxTokens: Int? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.estimatedCost = estimatedCost
        self.model = model
        self.contextWindowTokens = contextWindowTokens
        self.contextWindowMaxTokens = contextWindowMaxTokens
    }
}

public struct UserMessage: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let content: String?
    public let attachments: [UserMessageAttachment]?
    public let activeSurfaceId: String?
    /// The page currently displayed in the WebView (e.g. "settings.html").
    public let currentPage: String?
    /// When true, skip the secret-ingress check. Set by the client when the user clicks "Send Anyway".
    public let bypassSecretCheck: Bool?
    /// Originating channel identifier (e.g. 'vellum'). Defaults to 'vellum' when absent.
    public let channel: String?
    /// Originating interface identifier (e.g. 'macos').
    public let interface: String
    /// Push-to-talk activation key configured on the client (e.g. 'fn', 'ctrl', 'fn_shift', 'none').
    public let pttActivationKey: String?
    /// Whether the client has been granted microphone permission by the OS.
    public let microphonePermissionGranted: Bool?
    /// When true, the message was auto-sent by the client (e.g. wake-up greeting) and should not trigger memory extraction.
    public let automated: Bool?
    /// Structured command intent — bypasses text parsing when present.
    public let commandIntent: CommandIntent?

    public init(type: String, conversationId: String, content: String? = nil, attachments: [UserMessageAttachment]? = nil, activeSurfaceId: String? = nil, currentPage: String? = nil, bypassSecretCheck: Bool? = nil, channel: String? = nil, interface: String, pttActivationKey: String? = nil, microphonePermissionGranted: Bool? = nil, automated: Bool? = nil, commandIntent: CommandIntent? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.content = content
        self.attachments = attachments
        self.activeSurfaceId = activeSurfaceId
        self.currentPage = currentPage
        self.bypassSecretCheck = bypassSecretCheck
        self.channel = channel
        self.interface = interface
        self.pttActivationKey = pttActivationKey
        self.microphonePermissionGranted = microphonePermissionGranted
        self.automated = automated
        self.commandIntent = commandIntent
    }
}

public struct UserMessageAttachment: Codable, Sendable {
    public let id: String?
    public let filename: String
    public let mimeType: String
    public let data: String
    /// Origin of the attachment on the daemon side, when known.
    public let sourceType: String?
    public let extractedText: String?
    /// Original file size in bytes. Present when data was omitted from history_response to reduce payload size.
    public let sizeBytes: Int?
    /// Base64-encoded JPEG thumbnail. Generated server-side for video attachments.
    public let thumbnailData: String?
    /// Absolute path to the local file on disk. Present for file-backed attachments (e.g. recordings).
    public let filePath: String?
    /// True when the attachment is file-backed and clients should hydrate via the /content endpoint.
    public let fileBacked: Bool?
    /// Raw binary data for multipart upload in managed mode. Excluded from
    /// Codable encoding/decoding — only used for in-process transport.
    public let rawData: Data?

    // Exclude rawData from Codable so it doesn't interfere with JSON serialization.
    private enum CodingKeys: String, CodingKey {
        case id, filename, mimeType, data, sourceType, extractedText, sizeBytes, thumbnailData, filePath, fileBacked
    }

    public init(id: String? = nil, filename: String, mimeType: String, data: String, sourceType: String? = nil, extractedText: String? = nil, sizeBytes: Int? = nil, thumbnailData: String? = nil, filePath: String? = nil, fileBacked: Bool? = nil, rawData: Data? = nil) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.data = data
        self.sourceType = sourceType
        self.extractedText = extractedText
        self.sizeBytes = sizeBytes
        self.thumbnailData = thumbnailData
        self.filePath = filePath
        self.fileBacked = fileBacked
        self.rawData = rawData
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id)
        filename = try container.decode(String.self, forKey: .filename)
        mimeType = try container.decode(String.self, forKey: .mimeType)
        data = try container.decode(String.self, forKey: .data)
        sourceType = try container.decodeIfPresent(String.self, forKey: .sourceType)
        extractedText = try container.decodeIfPresent(String.self, forKey: .extractedText)
        sizeBytes = try container.decodeIfPresent(Int.self, forKey: .sizeBytes)
        thumbnailData = try container.decodeIfPresent(String.self, forKey: .thumbnailData)
        filePath = try container.decodeIfPresent(String.self, forKey: .filePath)
        fileBacked = try container.decodeIfPresent(Bool.self, forKey: .fileBacked)
        rawData = nil
    }
}

public struct UserMessageEcho: Codable, Sendable {
    public let type: String
    public let text: String
    public let conversationId: String?
    public let messageId: String?
    public let requestId: String?

    public init(type: String, text: String, conversationId: String? = nil, messageId: String? = nil, requestId: String? = nil) {
        self.type = type
        self.text = text
        self.conversationId = conversationId
        self.messageId = messageId
        self.requestId = requestId
    }
}

public struct VercelApiConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let apiToken: String?

    public init(type: String, action: String, apiToken: String? = nil) {
        self.type = type
        self.action = action
        self.apiToken = apiToken
    }
}

public struct VercelApiConfigResponse: Codable, Sendable {
    public let type: String
    public let hasToken: Bool
    public let success: Bool
    public let error: String?

    public init(type: String, hasToken: Bool, success: Bool, error: String? = nil) {
        self.type = type
        self.hasToken = hasToken
        self.success = success
        self.error = error
    }
}

/// Request from a conversation or client to change the voice activation key.
public struct VoiceConfigUpdateRequest: Codable, Sendable {
    public let type: String
    /// The desired activation key (enum value or natural-language name).
    public let activationKey: String

    public init(type: String, activationKey: String) {
        self.type = type
        self.activationKey = activationKey
    }
}

public struct WatchCompleteRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let watchId: String

    public init(type: String, conversationId: String, watchId: String) {
        self.type = type
        self.conversationId = conversationId
        self.watchId = watchId
    }
}

public struct WatchObservation: Codable, Sendable {
    public let type: String
    public let watchId: String
    public let conversationId: String
    public let ocrText: String
    public let appName: String?
    public let windowTitle: String?
    public let bundleIdentifier: String?
    public let timestamp: Double
    public let captureIndex: Int
    public let totalExpected: Int

    public init(type: String, watchId: String, conversationId: String, ocrText: String, appName: String? = nil, windowTitle: String? = nil, bundleIdentifier: String? = nil, timestamp: Double, captureIndex: Int, totalExpected: Int) {
        self.type = type
        self.watchId = watchId
        self.conversationId = conversationId
        self.ocrText = ocrText
        self.appName = appName
        self.windowTitle = windowTitle
        self.bundleIdentifier = bundleIdentifier
        self.timestamp = timestamp
        self.captureIndex = captureIndex
        self.totalExpected = totalExpected
    }
}

public struct WatchStarted: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let watchId: String
    public let durationSeconds: Double
    public let intervalSeconds: Double

    public init(type: String, conversationId: String, watchId: String, durationSeconds: Double, intervalSeconds: Double) {
        self.type = type
        self.conversationId = conversationId
        self.watchId = watchId
        self.durationSeconds = durationSeconds
        self.intervalSeconds = intervalSeconds
    }
}

public struct WorkItemApprovePermissionsRequest: Codable, Sendable {
    public let type: String
    public let id: String
    public let approvedTools: [String]

    public init(type: String, id: String, approvedTools: [String]) {
        self.type = type
        self.id = id
        self.approvedTools = approvedTools
    }
}

public struct WorkItemApprovePermissionsResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
    public let error: String?

    public init(type: String, id: String, success: Bool, error: String? = nil) {
        self.type = type
        self.id = id
        self.success = success
        self.error = error
    }
}

public struct WorkItemCancelRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct WorkItemCancelResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
    public let error: String?

    public init(type: String, id: String, success: Bool, error: String? = nil) {
        self.type = type
        self.id = id
        self.success = success
        self.error = error
    }
}

public struct WorkItemCompleteRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct WorkItemDeleteRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct WorkItemDeleteResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool

    public init(type: String, id: String, success: Bool) {
        self.type = type
        self.id = id
        self.success = success
    }
}

public struct WorkItemGetRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct WorkItemGetResponse: Codable, Sendable {
    public let type: String
    public let item: WorkItemGetResponseItem?

    public init(type: String, item: WorkItemGetResponseItem?) {
        self.type = type
        self.item = item
    }
}

public struct WorkItemGetResponseItem: Codable, Sendable {
    public let id: String
    public let taskId: String
    public let title: String
    public let notes: String?
    public let status: String
    public let priorityTier: Double
    public let sortIndex: Int?
    public let lastRunId: String?
    public let lastRunConversationId: String?
    public let lastRunStatus: String?
    public let sourceType: String?
    public let sourceId: String?
    public let createdAt: Int
    public let updatedAt: Int

    public init(id: String, taskId: String, title: String, notes: String?, status: String, priorityTier: Double, sortIndex: Int?, lastRunId: String?, lastRunConversationId: String?, lastRunStatus: String?, sourceType: String?, sourceId: String?, createdAt: Int, updatedAt: Int) {
        self.id = id
        self.taskId = taskId
        self.title = title
        self.notes = notes
        self.status = status
        self.priorityTier = priorityTier
        self.sortIndex = sortIndex
        self.lastRunId = lastRunId
        self.lastRunConversationId = lastRunConversationId
        self.lastRunStatus = lastRunStatus
        self.sourceType = sourceType
        self.sourceId = sourceId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct WorkItemOutputRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct WorkItemOutputResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
    public let error: String?
    public let output: WorkItemOutputResponseOutput?

    public init(type: String, id: String, success: Bool, error: String? = nil, output: WorkItemOutputResponseOutput? = nil) {
        self.type = type
        self.id = id
        self.success = success
        self.error = error
        self.output = output
    }
}

public struct WorkItemOutputResponseOutput: Codable, Sendable {
    public let title: String
    public let status: String
    public let runId: String?
    public let conversationId: String?
    public let completedAt: Int?
    public let summary: String
    public let highlights: [String]

    public init(title: String, status: String, runId: String?, conversationId: String?, completedAt: Int?, summary: String, highlights: [String]) {
        self.title = title
        self.status = status
        self.runId = runId
        self.conversationId = conversationId
        self.completedAt = completedAt
        self.summary = summary
        self.highlights = highlights
    }
}

public struct WorkItemPreflightRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct WorkItemPreflightResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
    public let error: String?
    public let permissions: [WorkItemPreflightResponsePermission]?

    public init(type: String, id: String, success: Bool, error: String? = nil, permissions: [WorkItemPreflightResponsePermission]? = nil) {
        self.type = type
        self.id = id
        self.success = success
        self.error = error
        self.permissions = permissions
    }
}

public struct WorkItemPreflightResponsePermission: Codable, Sendable {
    public let tool: String
    public let description: String
    public let riskLevel: String
    public let currentDecision: String

    public init(tool: String, description: String, riskLevel: String, currentDecision: String) {
        self.tool = tool
        self.description = description
        self.riskLevel = riskLevel
        self.currentDecision = currentDecision
    }
}

public struct WorkItemRunTaskRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct WorkItemRunTaskResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let lastRunId: String
    public let success: Bool
    public let error: String?
    /// Structured error code so the client can deterministically re-enable buttons or show contextual UI.
    public let errorCode: String?

    public init(type: String, id: String, lastRunId: String, success: Bool, error: String? = nil, errorCode: String? = nil) {
        self.type = type
        self.id = id
        self.lastRunId = lastRunId
        self.success = success
        self.error = error
        self.errorCode = errorCode
    }
}

public struct WorkItemsListRequest: Codable, Sendable {
    public let type: String
    public let status: String?

    public init(type: String, status: String? = nil) {
        self.type = type
        self.status = status
    }
}

public struct WorkItemsListResponse: Codable, Sendable {
    public let type: String
    public let items: [WorkItemsListResponseItem]

    public init(type: String, items: [WorkItemsListResponseItem]) {
        self.type = type
        self.items = items
    }
}

public struct WorkItemsListResponseItem: Codable, Sendable {
    public let id: String
    public let taskId: String
    public let title: String
    public let notes: String?
    public let status: String
    public let priorityTier: Double
    public let sortIndex: Int?
    public let lastRunId: String?
    public let lastRunConversationId: String?
    public let lastRunStatus: String?
    public let sourceType: String?
    public let sourceId: String?
    public let createdAt: Int
    public let updatedAt: Int

    public init(id: String, taskId: String, title: String, notes: String?, status: String, priorityTier: Double, sortIndex: Int?, lastRunId: String?, lastRunConversationId: String?, lastRunStatus: String?, sourceType: String?, sourceId: String?, createdAt: Int, updatedAt: Int) {
        self.id = id
        self.taskId = taskId
        self.title = title
        self.notes = notes
        self.status = status
        self.priorityTier = priorityTier
        self.sortIndex = sortIndex
        self.lastRunId = lastRunId
        self.lastRunConversationId = lastRunConversationId
        self.lastRunStatus = lastRunStatus
        self.sourceType = sourceType
        self.sourceId = sourceId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// Server push — broadcast when a work item status changes (e.g. running -> awaiting_review).
public struct WorkItemStatusChanged: Codable, Sendable {
    public let type: String
    public let item: WorkItemStatusChangedItem

    public init(type: String, item: WorkItemStatusChangedItem) {
        self.type = type
        self.item = item
    }
}

public struct WorkItemStatusChangedItem: Codable, Sendable {
    public let id: String
    public let taskId: String
    public let title: String
    public let status: String
    public let lastRunId: String?
    public let lastRunConversationId: String?
    public let lastRunStatus: String?
    public let updatedAt: Int

    public init(id: String, taskId: String, title: String, status: String, lastRunId: String?, lastRunConversationId: String?, lastRunStatus: String?, updatedAt: Int) {
        self.id = id
        self.taskId = taskId
        self.title = title
        self.status = status
        self.lastRunId = lastRunId
        self.lastRunConversationId = lastRunConversationId
        self.lastRunStatus = lastRunStatus
        self.updatedAt = updatedAt
    }
}

public struct WorkItemUpdateRequest: Codable, Sendable {
    public let type: String
    public let id: String
    public let title: String?
    public let notes: String?
    public let status: String?
    public let priorityTier: Double?
    public let sortIndex: Int?

    public init(type: String, id: String, title: String? = nil, notes: String? = nil, status: String? = nil, priorityTier: Double? = nil, sortIndex: Int? = nil) {
        self.type = type
        self.id = id
        self.title = title
        self.notes = notes
        self.status = status
        self.priorityTier = priorityTier
        self.sortIndex = sortIndex
    }
}

public struct WorkItemUpdateResponse: Codable, Sendable {
    public let type: String
    public let item: WorkItemUpdateResponseItem?

    public init(type: String, item: WorkItemUpdateResponseItem?) {
        self.type = type
        self.item = item
    }
}

public struct WorkItemUpdateResponseItem: Codable, Sendable {
    public let id: String
    public let taskId: String
    public let title: String
    public let notes: String?
    public let status: String
    public let priorityTier: Double
    public let sortIndex: Int?
    public let lastRunId: String?
    public let lastRunConversationId: String?
    public let lastRunStatus: String?
    public let sourceType: String?
    public let sourceId: String?
    public let createdAt: Int
    public let updatedAt: Int

    public init(id: String, taskId: String, title: String, notes: String?, status: String, priorityTier: Double, sortIndex: Int?, lastRunId: String?, lastRunConversationId: String?, lastRunStatus: String?, sourceType: String?, sourceId: String?, createdAt: Int, updatedAt: Int) {
        self.id = id
        self.taskId = taskId
        self.title = title
        self.notes = notes
        self.status = status
        self.priorityTier = priorityTier
        self.sortIndex = sortIndex
        self.lastRunId = lastRunId
        self.lastRunConversationId = lastRunConversationId
        self.lastRunStatus = lastRunStatus
        self.sourceType = sourceType
        self.sourceId = sourceId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct WorkspaceFileReadRequest: Codable, Sendable {
    public let type: String
    /// Relative path within the workspace directory (e.g. "IDENTITY.md").
    public let path: String

    public init(type: String, path: String) {
        self.type = type
        self.path = path
    }
}

public struct WorkspaceFileReadResponse: Codable, Sendable {
    public let type: String
    public let path: String
    public let content: String?
    public let error: String?

    public init(type: String, path: String, content: String?, error: String? = nil) {
        self.type = type
        self.path = path
        self.content = content
        self.error = error
    }
}

public struct WorkspaceFilesListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct WorkspaceFilesListResponse: Codable, Sendable {
    public let type: String
    public let files: [WorkspaceFilesListResponseFile]

    public init(type: String, files: [WorkspaceFilesListResponseFile]) {
        self.type = type
        self.files = files
    }
}

public struct WorkspaceFilesListResponseFile: Codable, Sendable {
    /// Relative path within the workspace (e.g. "IDENTITY.md", "skills/my-skill").
    public let path: String
    /// Display name (e.g. "IDENTITY.md").
    public let name: String
    /// Whether the file/directory exists.
    public let exists: Bool

    public init(path: String, name: String, exists: Bool) {
        self.path = path
        self.name = name
        self.exists = exists
    }
}
