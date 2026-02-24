// AUTO-GENERATED from assistant/src/daemon/ipc-contract.ts — DO NOT EDIT
// Regenerate: cd assistant && bun run generate:ipc
//
// This file contains Swift Codable DTOs derived from the IPC contract.
// The discriminated union enums (ClientMessage/ServerMessage) remain
// in the hand-written IPCMessages.swift since they require custom
// Decodable init logic that code generators cannot express cleanly.

import Foundation

// MARK: - Generated IPC types

public struct IPCAcceptStarterBundle: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCAcceptStarterBundleResponse: Codable, Sendable {
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

public struct IPCAddTrustRule: Codable, Sendable {
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

public struct IPCAgentHeartbeatAlert: Codable, Sendable {
    public let type: String
    public let title: String
    public let body: String

    public init(type: String, title: String, body: String) {
        self.type = type
        self.title = title
        self.body = body
    }
}

public struct IPCAppDataRequest: Codable, Sendable {
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

public struct IPCAppDataResponse: Codable, Sendable {
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

public struct IPCAppDiffRequest: Codable, Sendable {
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

public struct IPCAppDiffResponse: Codable, Sendable {
    public let type: String
    public let appId: String
    public let diff: String

    public init(type: String, appId: String, diff: String) {
        self.type = type
        self.appId = appId
        self.diff = diff
    }
}

public struct IPCAppFileAtVersionRequest: Codable, Sendable {
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

public struct IPCAppFileAtVersionResponse: Codable, Sendable {
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

public struct IPCAppFilesChanged: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct IPCAppHistoryRequest: Codable, Sendable {
    public let type: String
    public let appId: String
    public let limit: Double?

    public init(type: String, appId: String, limit: Double? = nil) {
        self.type = type
        self.appId = appId
        self.limit = limit
    }
}

public struct IPCAppHistoryResponse: Codable, Sendable {
    public let type: String
    public let appId: String
    public let versions: [IPCAppHistoryResponseVersion]

    public init(type: String, appId: String, versions: [IPCAppHistoryResponseVersion]) {
        self.type = type
        self.appId = appId
        self.versions = versions
    }
}

public struct IPCAppHistoryResponseVersion: Codable, Sendable {
    public let commitHash: String
    public let message: String
    public let timestamp: Double

    public init(commitHash: String, message: String, timestamp: Double) {
        self.commitHash = commitHash
        self.message = message
        self.timestamp = timestamp
    }
}

public struct IPCAppOpenRequest: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct IPCAppPreviewRequest: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct IPCAppPreviewResponse: Codable, Sendable {
    public let type: String
    public let appId: String
    public let preview: String?

    public init(type: String, appId: String, preview: String? = nil) {
        self.type = type
        self.appId = appId
        self.preview = preview
    }
}

public struct IPCAppRestoreRequest: Codable, Sendable {
    public let type: String
    public let appId: String
    public let commitHash: String

    public init(type: String, appId: String, commitHash: String) {
        self.type = type
        self.appId = appId
        self.commitHash = commitHash
    }
}

public struct IPCAppRestoreResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?

    public init(type: String, success: Bool, error: String? = nil) {
        self.type = type
        self.success = success
        self.error = error
    }
}

public struct IPCAppsListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCAppsListResponse: Codable, Sendable {
    public let type: String
    public let apps: [IPCAppsListResponseApp]

    public init(type: String, apps: [IPCAppsListResponseApp]) {
        self.type = type
        self.apps = apps
    }
}

public struct IPCAppsListResponseApp: Codable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let icon: String?
    public let preview: String?
    public let createdAt: Int
    public let version: String?
    public let contentId: String?
    public let appType: String?

    public init(id: String, name: String, description: String? = nil, icon: String? = nil, preview: String? = nil, createdAt: Int, version: String? = nil, contentId: String? = nil, appType: String? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.icon = icon
        self.preview = preview
        self.createdAt = createdAt
        self.version = version
        self.contentId = contentId
        self.appType = appType
    }
}

public struct IPCAppUpdatePreviewRequest: Codable, Sendable {
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

public struct IPCAppUpdatePreviewResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let appId: String

    public init(type: String, success: Bool, appId: String) {
        self.type = type
        self.success = success
        self.appId = appId
    }
}

public struct IPCAssistantTextDelta: Codable, Sendable {
    public let type: String
    public let text: String
    public let sessionId: String?

    public init(type: String, text: String, sessionId: String? = nil) {
        self.type = type
        self.text = text
        self.sessionId = sessionId
    }
}

public struct IPCAssistantThinkingDelta: Codable, Sendable {
    public let type: String
    public let thinking: String

    public init(type: String, thinking: String) {
        self.type = type
        self.thinking = thinking
    }
}

public struct IPCAuthMessage: Codable, Sendable {
    public let type: String
    public let token: String

    public init(type: String, token: String) {
        self.type = type
        self.token = token
    }
}

public struct IPCAuthResult: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let message: String?

    public init(type: String, success: Bool, message: String? = nil) {
        self.type = type
        self.success = success
        self.message = message
    }
}

public struct IPCBrowserCDPRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String

    public init(type: String, sessionId: String) {
        self.type = type
        self.sessionId = sessionId
    }
}

public struct IPCBrowserCDPResponse: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let success: Bool
    public let declined: Bool?

    public init(type: String, sessionId: String, success: Bool, declined: Bool? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.success = success
        self.declined = declined
    }
}

public struct IPCBrowserFrame: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let frame: String
    public let metadata: IPCBrowserFrameMetadata?

    public init(type: String, sessionId: String, surfaceId: String, frame: String, metadata: IPCBrowserFrameMetadata? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.frame = frame
        self.metadata = metadata
    }
}

public struct IPCBrowserFrameMetadata: Codable, Sendable {
    public let offsetTop: Double
    public let pageScaleFactor: Double
    public let scrollOffsetX: Double
    public let scrollOffsetY: Double
    public let timestamp: Double

    public init(offsetTop: Double, pageScaleFactor: Double, scrollOffsetX: Double, scrollOffsetY: Double, timestamp: Double) {
        self.offsetTop = offsetTop
        self.pageScaleFactor = pageScaleFactor
        self.scrollOffsetX = scrollOffsetX
        self.scrollOffsetY = scrollOffsetY
        self.timestamp = timestamp
    }
}

public struct IPCBrowserHandoffRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let reason: String
    public let message: String
    public let bringToFront: Bool?

    public init(type: String, sessionId: String, surfaceId: String, reason: String, message: String, bringToFront: Bool? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.reason = reason
        self.message = message
        self.bringToFront = bringToFront
    }
}

public struct IPCBrowserInteractiveMode: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let enabled: Bool

    public init(type: String, sessionId: String, surfaceId: String, enabled: Bool) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.enabled = enabled
    }
}

public struct IPCBrowserInteractiveModeChanged: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let enabled: Bool
    public let reason: String?
    public let message: String?

    public init(type: String, sessionId: String, surfaceId: String, enabled: Bool, reason: String? = nil, message: String? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.enabled = enabled
        self.reason = reason
        self.message = message
    }
}

public struct IPCBrowserUserClick: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let x: Double
    public let y: Double
    public let button: String?
    public let doubleClick: Bool?

    public init(type: String, sessionId: String, surfaceId: String, x: Double, y: Double, button: String? = nil, doubleClick: Bool? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.x = x
        self.y = y
        self.button = button
        self.doubleClick = doubleClick
    }
}

public struct IPCBrowserUserKeypress: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let key: String
    public let modifiers: [String]?

    public init(type: String, sessionId: String, surfaceId: String, key: String, modifiers: [String]? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.key = key
        self.modifiers = modifiers
    }
}

public struct IPCBrowserUserScroll: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let deltaX: Double
    public let deltaY: Double
    public let x: Double
    public let y: Double

    public init(type: String, sessionId: String, surfaceId: String, deltaX: Double, deltaY: Double, x: Double, y: Double) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.deltaX = deltaX
        self.deltaY = deltaY
        self.x = x
        self.y = y
    }
}

public struct IPCBrowserViewSurfaceData: Codable, Sendable {
    public let sessionId: String
    public let currentUrl: String
    public let status: String
    public let frame: String?
    public let actionText: String?
    public let highlights: [IPCBrowserViewSurfaceDataHighlight]?
    public let pages: [IPCBrowserViewSurfaceDataPage]?

    public init(sessionId: String, currentUrl: String, status: String, frame: String? = nil, actionText: String? = nil, highlights: [IPCBrowserViewSurfaceDataHighlight]? = nil, pages: [IPCBrowserViewSurfaceDataPage]? = nil) {
        self.sessionId = sessionId
        self.currentUrl = currentUrl
        self.status = status
        self.frame = frame
        self.actionText = actionText
        self.highlights = highlights
        self.pages = pages
    }
}

public struct IPCBrowserViewSurfaceDataHighlight: Codable, Sendable {
    public let x: Double
    public let y: Double
    public let w: Double
    public let h: Double
    public let label: String

    public init(x: Double, y: Double, w: Double, h: Double, label: String) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.label = label
    }
}

public struct IPCBrowserViewSurfaceDataPage: Codable, Sendable {
    public let id: String
    public let title: String
    public let url: String
    public let active: Bool

    public init(id: String, title: String, url: String, active: Bool) {
        self.id = id
        self.title = title
        self.url = url
        self.active = active
    }
}

public struct IPCBundleAppRequest: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct IPCBundleAppResponse: Codable, Sendable {
    public let type: String
    public let bundlePath: String
    public let manifest: IPCBundleAppResponseManifest

    public init(type: String, bundlePath: String, manifest: IPCBundleAppResponseManifest) {
        self.type = type
        self.bundlePath = bundlePath
        self.manifest = manifest
    }
}

public struct IPCBundleAppResponseManifest: Codable, Sendable {
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

public struct IPCCancelRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String?

    public init(type: String, sessionId: String? = nil) {
        self.type = type
        self.sessionId = sessionId
    }
}

public struct IPCCardSurfaceData: Codable, Sendable {
    public let title: String
    public let subtitle: String?
    public let body: String
    public let metadata: [IPCCardSurfaceDataMetadata]?
    /// Optional template name for specialized rendering (e.g. "weather_forecast").
    public let template: String?
    /// Arbitrary data consumed by the template renderer. Shape depends on template.
    public let templateData: [String: AnyCodable]?

    public init(title: String, subtitle: String? = nil, body: String, metadata: [IPCCardSurfaceDataMetadata]? = nil, template: String? = nil, templateData: [String: AnyCodable]? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
        self.metadata = metadata
        self.template = template
        self.templateData = templateData
    }
}

public struct IPCCardSurfaceDataMetadata: Codable, Sendable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

/// Channel binding metadata exposed in session/conversation list APIs.
public struct IPCChannelBinding: Codable, Sendable {
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

public struct IPCChannelReadinessRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let channel: String?
    public let assistantId: String?
    public let includeRemote: Bool?

    public init(type: String, action: String, channel: String? = nil, assistantId: String? = nil, includeRemote: Bool? = nil) {
        self.type = type
        self.action = action
        self.channel = channel
        self.assistantId = assistantId
        self.includeRemote = includeRemote
    }
}

public struct IPCChannelReadinessResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let snapshots: [IPCChannelReadinessResponseSnapshot]?
    public let error: String?

    public init(type: String, success: Bool, snapshots: [IPCChannelReadinessResponseSnapshot]? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.snapshots = snapshots
        self.error = error
    }
}

public struct IPCChannelReadinessResponseSnapshot: Codable, Sendable {
    public let channel: String
    public let ready: Bool
    public let checkedAt: Int
    public let stale: Bool
    public let reasons: [IPCChannelReadinessResponseSnapshotReason]
    public let localChecks: [IPCChannelReadinessResponseSnapshotLocalCheck]
    public let remoteChecks: [IPCChannelReadinessResponseSnapshotRemoteCheck]?

    public init(channel: String, ready: Bool, checkedAt: Int, stale: Bool, reasons: [IPCChannelReadinessResponseSnapshotReason], localChecks: [IPCChannelReadinessResponseSnapshotLocalCheck], remoteChecks: [IPCChannelReadinessResponseSnapshotRemoteCheck]? = nil) {
        self.channel = channel
        self.ready = ready
        self.checkedAt = checkedAt
        self.stale = stale
        self.reasons = reasons
        self.localChecks = localChecks
        self.remoteChecks = remoteChecks
    }
}

public struct IPCChannelReadinessResponseSnapshotLocalCheck: Codable, Sendable {
    public let name: String
    public let passed: Bool
    public let message: String

    public init(name: String, passed: Bool, message: String) {
        self.name = name
        self.passed = passed
        self.message = message
    }
}

public struct IPCChannelReadinessResponseSnapshotReason: Codable, Sendable {
    public let code: String
    public let text: String

    public init(code: String, text: String) {
        self.code = code
        self.text = text
    }
}

public struct IPCChannelReadinessResponseSnapshotRemoteCheck: Codable, Sendable {
    public let name: String
    public let passed: Bool
    public let message: String

    public init(name: String, passed: Bool, message: String) {
        self.name = name
        self.passed = passed
        self.message = message
    }
}

public struct IPCConfirmationRequest: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let riskLevel: String
    public let executionTarget: String?
    public let allowlistOptions: [IPCConfirmationRequestAllowlistOption]
    public let scopeOptions: [IPCConfirmationRequestScopeOption]
    public let diff: IPCConfirmationRequestDiff?
    public let sandboxed: Bool?
    public let sessionId: String?
    /// When false, the client should hide "always allow" / trust-rule persistence affordances.
    public let persistentDecisionsAllowed: Bool?

    public init(type: String, requestId: String, toolName: String, input: [String: AnyCodable], riskLevel: String, executionTarget: String? = nil, allowlistOptions: [IPCConfirmationRequestAllowlistOption], scopeOptions: [IPCConfirmationRequestScopeOption], diff: IPCConfirmationRequestDiff? = nil, sandboxed: Bool? = nil, sessionId: String? = nil, persistentDecisionsAllowed: Bool? = nil) {
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
        self.sessionId = sessionId
        self.persistentDecisionsAllowed = persistentDecisionsAllowed
    }
}

public struct IPCConfirmationRequestAllowlistOption: Codable, Sendable {
    public let label: String
    public let description: String
    public let pattern: String

    public init(label: String, description: String, pattern: String) {
        self.label = label
        self.description = description
        self.pattern = pattern
    }
}

public struct IPCConfirmationRequestDiff: Codable, Sendable {
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

public struct IPCConfirmationRequestScopeOption: Codable, Sendable {
    public let label: String
    public let scope: String

    public init(label: String, scope: String) {
        self.label = label
        self.scope = scope
    }
}

public struct IPCConfirmationResponse: Codable, Sendable {
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

public struct IPCConfirmationSurfaceData: Codable, Sendable {
    public let message: String
    public let detail: String?
    public let confirmLabel: String?
    public let cancelLabel: String?
    public let destructive: Bool?

    public init(message: String, detail: String? = nil, confirmLabel: String? = nil, cancelLabel: String? = nil, destructive: Bool? = nil) {
        self.message = message
        self.detail = detail
        self.confirmLabel = confirmLabel
        self.cancelLabel = cancelLabel
        self.destructive = destructive
    }
}

public struct IPCContextCompacted: Codable, Sendable {
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

public struct IPCCuAction: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let reasoning: String?
    public let stepNumber: Int

    public init(type: String, sessionId: String, toolName: String, input: [String: AnyCodable], reasoning: String? = nil, stepNumber: Int) {
        self.type = type
        self.sessionId = sessionId
        self.toolName = toolName
        self.input = input
        self.reasoning = reasoning
        self.stepNumber = stepNumber
    }
}

public struct IPCCuComplete: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let summary: String
    public let stepCount: Int
    public let isResponse: Bool?

    public init(type: String, sessionId: String, summary: String, stepCount: Int, isResponse: Bool? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.summary = summary
        self.stepCount = stepCount
        self.isResponse = isResponse
    }
}

public struct IPCCuError: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let message: String

    public init(type: String, sessionId: String, message: String) {
        self.type = type
        self.sessionId = sessionId
        self.message = message
    }
}

public struct IPCCuObservation: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let axTree: String?
    public let axDiff: String?
    public let secondaryWindows: String?
    public let screenshot: String?
    /// Screenshot image width in pixels (`Px`).
    public let screenshotWidthPx: Double?
    /// Screenshot image height in pixels (`Px`).
    public let screenshotHeightPx: Double?
    /// Screen width in macOS points (`Pt`) used by native execution.
    public let screenWidthPt: Double?
    /// Screen height in macOS points (`Pt`) used by native execution.
    public let screenHeightPt: Double?
    /// Coordinate origin convention used by the observation payload.
    public let coordinateOrigin: String?
    /// Display ID used by screenshot capture for this observation.
    public let captureDisplayId: Double?
    public let executionResult: String?
    public let executionError: String?
    public let axTreeBlob: IPCIpcBlobRef?
    public let screenshotBlob: IPCIpcBlobRef?

    public init(type: String, sessionId: String, axTree: String? = nil, axDiff: String? = nil, secondaryWindows: String? = nil, screenshot: String? = nil, screenshotWidthPx: Double? = nil, screenshotHeightPx: Double? = nil, screenWidthPt: Double? = nil, screenHeightPt: Double? = nil, coordinateOrigin: String? = nil, captureDisplayId: Double? = nil, executionResult: String? = nil, executionError: String? = nil, axTreeBlob: IPCIpcBlobRef? = nil, screenshotBlob: IPCIpcBlobRef? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.axTree = axTree
        self.axDiff = axDiff
        self.secondaryWindows = secondaryWindows
        self.screenshot = screenshot
        self.screenshotWidthPx = screenshotWidthPx
        self.screenshotHeightPx = screenshotHeightPx
        self.screenWidthPt = screenWidthPt
        self.screenHeightPt = screenHeightPt
        self.coordinateOrigin = coordinateOrigin
        self.captureDisplayId = captureDisplayId
        self.executionResult = executionResult
        self.executionError = executionError
        self.axTreeBlob = axTreeBlob
        self.screenshotBlob = screenshotBlob
    }
}

public struct IPCCuSessionAbort: Codable, Sendable {
    public let type: String
    public let sessionId: String

    public init(type: String, sessionId: String) {
        self.type = type
        self.sessionId = sessionId
    }
}

public struct IPCCuSessionCreate: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let task: String
    public let screenWidth: Int
    public let screenHeight: Int
    public let attachments: [IPCUserMessageAttachment]?
    public let interactionType: String?

    public init(type: String, sessionId: String, task: String, screenWidth: Int, screenHeight: Int, attachments: [IPCUserMessageAttachment]? = nil, interactionType: String? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.task = task
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.attachments = attachments
        self.interactionType = interactionType
    }
}

public struct IPCDaemonStatusMessage: Codable, Sendable {
    public let type: String
    public let httpPort: Double?
    public let version: String?

    public init(type: String, httpPort: Double? = nil, version: String? = nil) {
        self.type = type
        self.httpPort = httpPort
        self.version = version
    }
}

public struct IPCDeleteQueuedMessage: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String

    public init(type: String, sessionId: String, requestId: String) {
        self.type = type
        self.sessionId = sessionId
        self.requestId = requestId
    }
}

public struct IPCDiagnosticsExportRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let anchorMessageId: String?

    public init(type: String, conversationId: String, anchorMessageId: String? = nil) {
        self.type = type
        self.conversationId = conversationId
        self.anchorMessageId = anchorMessageId
    }
}

public struct IPCDiagnosticsExportResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let filePath: String?
    public let error: String?

    public init(type: String, success: Bool, filePath: String? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.filePath = filePath
        self.error = error
    }
}

public struct IPCDictationContext: Codable, Sendable {
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

public struct IPCDictationRequest: Codable, Sendable {
    public let type: String
    public let transcription: String
    public let context: IPCDictationContext

    public init(type: String, transcription: String, context: IPCDictationContext) {
        self.type = type
        self.transcription = transcription
        self.context = context
    }
}

public struct IPCDictationResponse: Codable, Sendable {
    public let type: String
    public let text: String
    public let mode: String
    public let actionPlan: String?

    public init(type: String, text: String, mode: String, actionPlan: String? = nil) {
        self.type = type
        self.text = text
        self.mode = mode
        self.actionPlan = actionPlan
    }
}

public struct IPCDocumentEditorShow: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String
    public let initialContent: String

    public init(type: String, sessionId: String, surfaceId: String, title: String, initialContent: String) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.title = title
        self.initialContent = initialContent
    }
}

public struct IPCDocumentEditorUpdate: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let markdown: String
    public let mode: String

    public init(type: String, sessionId: String, surfaceId: String, markdown: String, mode: String) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.markdown = markdown
        self.mode = mode
    }
}

public struct IPCDocumentListRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String?

    public init(type: String, conversationId: String? = nil) {
        self.type = type
        self.conversationId = conversationId
    }
}

public struct IPCDocumentListResponse: Codable, Sendable {
    public let type: String
    public let documents: [IPCDocumentListResponseDocument]

    public init(type: String, documents: [IPCDocumentListResponseDocument]) {
        self.type = type
        self.documents = documents
    }
}

public struct IPCDocumentListResponseDocument: Codable, Sendable {
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

public struct IPCDocumentLoadRequest: Codable, Sendable {
    public let type: String
    public let surfaceId: String

    public init(type: String, surfaceId: String) {
        self.type = type
        self.surfaceId = surfaceId
    }
}

public struct IPCDocumentLoadResponse: Codable, Sendable {
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

public struct IPCDocumentPreviewSurfaceData: Codable, Sendable {
    public let title: String
    public let surfaceId: String
    public let subtitle: String?

    public init(title: String, surfaceId: String, subtitle: String? = nil) {
        self.title = title
        self.surfaceId = surfaceId
        self.subtitle = subtitle
    }
}

public struct IPCDocumentSaveRequest: Codable, Sendable {
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

public struct IPCDocumentSaveResponse: Codable, Sendable {
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

public struct IPCDynamicPagePreview: Codable, Sendable {
    public let title: String
    public let subtitle: String?
    public let description: String?
    public let icon: String?
    public let metrics: [IPCDynamicPagePreviewMetric]?

    public init(title: String, subtitle: String? = nil, description: String? = nil, icon: String? = nil, metrics: [IPCDynamicPagePreviewMetric]? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.description = description
        self.icon = icon
        self.metrics = metrics
    }
}

public struct IPCDynamicPagePreviewMetric: Codable, Sendable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

public struct IPCDynamicPageSurfaceData: Codable, Sendable {
    public let html: String
    public let width: Int?
    public let height: Int?
    public let appId: String?
    public let appType: String?
    public let reloadGeneration: Double?
    public let status: String?
    public let preview: IPCDynamicPagePreview?

    public init(html: String, width: Int? = nil, height: Int? = nil, appId: String? = nil, appType: String? = nil, reloadGeneration: Double? = nil, status: String? = nil, preview: IPCDynamicPagePreview? = nil) {
        self.html = html
        self.width = width
        self.height = height
        self.appId = appId
        self.appType = appType
        self.reloadGeneration = reloadGeneration
        self.status = status
        self.preview = preview
    }
}

public struct IPCEnvVarsRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCEnvVarsResponse: Codable, Sendable {
    public let type: String
    public let vars: [String: String]

    public init(type: String, vars: [String: String]) {
        self.type = type
        self.vars = vars
    }
}

public struct IPCErrorMessage: Codable, Sendable {
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

public struct IPCFileUploadSurfaceData: Codable, Sendable {
    public let prompt: String
    public let acceptedTypes: [String]?
    public let maxFiles: Int?
    public let maxSizeBytes: Int?

    public init(prompt: String, acceptedTypes: [String]? = nil, maxFiles: Int? = nil, maxSizeBytes: Int? = nil) {
        self.prompt = prompt
        self.acceptedTypes = acceptedTypes
        self.maxFiles = maxFiles
        self.maxSizeBytes = maxSizeBytes
    }
}

public struct IPCForkSharedAppRequest: Codable, Sendable {
    public let type: String
    public let uuid: String

    public init(type: String, uuid: String) {
        self.type = type
        self.uuid = uuid
    }
}

public struct IPCForkSharedAppResponse: Codable, Sendable {
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

public struct IPCFormField: Codable, Sendable {
    public let id: String
    public let type: String
    public let label: String
    public let placeholder: String?
    public let required: Bool?
    public let defaultValue: AnyCodable?
    public let options: [IPCFormFieldOption]?

    public init(id: String, type: String, label: String, placeholder: String? = nil, required: Bool? = nil, defaultValue: AnyCodable? = nil, options: [IPCFormFieldOption]? = nil) {
        self.id = id
        self.type = type
        self.label = label
        self.placeholder = placeholder
        self.required = required
        self.defaultValue = defaultValue
        self.options = options
    }
}

public struct IPCFormFieldOption: Codable, Sendable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

public struct IPCFormPage: Codable, Sendable {
    public let id: String
    public let title: String
    public let description: String?
    public let fields: [IPCFormField]

    public init(id: String, title: String, description: String? = nil, fields: [IPCFormField]) {
        self.id = id
        self.title = title
        self.description = description
        self.fields = fields
    }
}

public struct IPCFormSurfaceData: Codable, Sendable {
    public let description: String?
    public let fields: [IPCFormField]
    public let submitLabel: String?
    public let pages: [IPCFormPage]?
    public let pageLabels: IPCFormSurfaceDataPageLabels?

    public init(description: String? = nil, fields: [IPCFormField], submitLabel: String? = nil, pages: [IPCFormPage]? = nil, pageLabels: IPCFormSurfaceDataPageLabels? = nil) {
        self.description = description
        self.fields = fields
        self.submitLabel = submitLabel
        self.pages = pages
        self.pageLabels = pageLabels
    }
}

public struct IPCFormSurfaceDataPageLabels: Codable, Sendable {
    public let next: String?
    public let back: String?
    public let submit: String?

    public init(next: String? = nil, back: String? = nil, submit: String? = nil) {
        self.next = next
        self.back = back
        self.submit = submit
    }
}

public struct IPCGalleryApp: Codable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let icon: String
    public let category: String
    public let version: String
    public let featured: Bool?
    public let schemaJson: String
    public let htmlDefinition: String

    public init(id: String, name: String, description: String, icon: String, category: String, version: String, featured: Bool? = nil, schemaJson: String, htmlDefinition: String) {
        self.id = id
        self.name = name
        self.description = description
        self.icon = icon
        self.category = category
        self.version = version
        self.featured = featured
        self.schemaJson = schemaJson
        self.htmlDefinition = htmlDefinition
    }
}

public struct IPCGalleryCategory: Codable, Sendable {
    public let id: String
    public let name: String
    public let icon: String

    public init(id: String, name: String, icon: String) {
        self.id = id
        self.name = name
        self.icon = icon
    }
}

public struct IPCGalleryInstallRequest: Codable, Sendable {
    public let type: String
    public let galleryAppId: String

    public init(type: String, galleryAppId: String) {
        self.type = type
        self.galleryAppId = galleryAppId
    }
}

public struct IPCGalleryInstallResponse: Codable, Sendable {
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

public struct IPCGalleryListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCGalleryListResponse: Codable, Sendable {
    public let type: String
    public let gallery: IPCGalleryManifest

    public init(type: String, gallery: IPCGalleryManifest) {
        self.type = type
        self.gallery = gallery
    }
}

public struct IPCGalleryManifest: Codable, Sendable {
    public let version: Double
    public let updatedAt: String
    public let categories: [IPCGalleryCategory]
    public let apps: [IPCGalleryApp]

    public init(version: Double, updatedAt: String, categories: [IPCGalleryCategory], apps: [IPCGalleryApp]) {
        self.version = version
        self.updatedAt = updatedAt
        self.categories = categories
        self.apps = apps
    }
}

public struct IPCGenerationCancelled: Codable, Sendable {
    public let type: String
    public let sessionId: String?

    public init(type: String, sessionId: String? = nil) {
        self.type = type
        self.sessionId = sessionId
    }
}

public struct IPCGenerationHandoff: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String?
    public let queuedCount: Int
    public let attachments: [IPCUserMessageAttachment]?

    public init(type: String, sessionId: String, requestId: String? = nil, queuedCount: Int, attachments: [IPCUserMessageAttachment]? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.requestId = requestId
        self.queuedCount = queuedCount
        self.attachments = attachments
    }
}

public struct IPCGetSigningIdentityRequest: Codable, Sendable {
    public let type: String
    public let requestId: String

    public init(type: String, requestId: String) {
        self.type = type
        self.requestId = requestId
    }
}

public struct IPCGetSigningIdentityResponse: Codable, Sendable {
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

/// Server push — broadcast when a guardian action request creates a thread for the mac channel.
public struct IPCGuardianRequestThreadCreated: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let requestId: String
    public let callSessionId: String
    public let title: String

    public init(type: String, conversationId: String, requestId: String, callSessionId: String, title: String) {
        self.type = type
        self.conversationId = conversationId
        self.requestId = requestId
        self.callSessionId = callSessionId
        self.title = title
    }
}

public struct IPCGuardianVerificationRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let channel: String?
    public let sessionId: String?
    public let assistantId: String?

    public init(type: String, action: String, channel: String? = nil, sessionId: String? = nil, assistantId: String? = nil) {
        self.type = type
        self.action = action
        self.channel = channel
        self.sessionId = sessionId
        self.assistantId = assistantId
    }
}

public struct IPCGuardianVerificationResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let secret: String?
    public let instruction: String?
    /// Present when action is 'status'.
    public let bound: Bool?
    public let guardianExternalUserId: String?
    /// The channel this status pertains to (e.g. "telegram", "sms"). Present when action is 'status'.
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

    public init(type: String, success: Bool, secret: String? = nil, instruction: String? = nil, bound: Bool? = nil, guardianExternalUserId: String? = nil, channel: String? = nil, assistantId: String? = nil, guardianDeliveryChatId: String? = nil, guardianUsername: String? = nil, guardianDisplayName: String? = nil, hasPendingChallenge: Bool? = nil, error: String? = nil) {
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
    }
}

public struct IPCHistoryRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String

    public init(type: String, sessionId: String) {
        self.type = type
        self.sessionId = sessionId
    }
}

public struct IPCHistoryResponse: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let messages: [IPCHistoryResponseMessage]

    public init(type: String, sessionId: String, messages: [IPCHistoryResponseMessage]) {
        self.type = type
        self.sessionId = sessionId
        self.messages = messages
    }
}

public struct IPCHistoryResponseMessage: Codable, Sendable {
    public let id: String?
    public let role: String
    public let text: String
    public let timestamp: Double
    public let toolCalls: [IPCHistoryResponseToolCall]?
    /// True when tool_use blocks appeared before any text block in the original content.
    public let toolCallsBeforeText: Bool?
    public let attachments: [IPCUserMessageAttachment]?
    /// Text segments split by tool-call boundaries. Preserves interleaving order.
    public let textSegments: [String]?
    /// Content block ordering using "text:N", "tool:N", "surface:N" encoding.
    public let contentOrder: [String]?
    /// UI surfaces (widgets) embedded in the message.
    public let surfaces: [IPCHistoryResponseSurface]?
    /// Present when this message is a subagent lifecycle notification (completed/failed/aborted).
    public let subagentNotification: IPCHistoryResponseMessageSubagentNotification?

    public init(id: String? = nil, role: String, text: String, timestamp: Double, toolCalls: [IPCHistoryResponseToolCall]? = nil, toolCallsBeforeText: Bool? = nil, attachments: [IPCUserMessageAttachment]? = nil, textSegments: [String]? = nil, contentOrder: [String]? = nil, surfaces: [IPCHistoryResponseSurface]? = nil, subagentNotification: IPCHistoryResponseMessageSubagentNotification? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
        self.toolCalls = toolCalls
        self.toolCallsBeforeText = toolCallsBeforeText
        self.attachments = attachments
        self.textSegments = textSegments
        self.contentOrder = contentOrder
        self.surfaces = surfaces
        self.subagentNotification = subagentNotification
    }
}

public struct IPCHistoryResponseMessageSubagentNotification: Codable, Sendable {
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

public struct IPCHistoryResponseSurface: Codable, Sendable {
    public let surfaceId: String
    public let surfaceType: String
    public let title: String?
    public let data: [String: AnyCodable]
    public let actions: [IPCHistoryResponseSurfaceAction]?
    public let display: String?

    public init(surfaceId: String, surfaceType: String, title: String? = nil, data: [String: AnyCodable], actions: [IPCHistoryResponseSurfaceAction]? = nil, display: String? = nil) {
        self.surfaceId = surfaceId
        self.surfaceType = surfaceType
        self.title = title
        self.data = data
        self.actions = actions
        self.display = display
    }
}

public struct IPCHistoryResponseSurfaceAction: Codable, Sendable {
    public let id: String
    public let label: String
    public let style: String?

    public init(id: String, label: String, style: String? = nil) {
        self.id = id
        self.label = label
        self.style = style
    }
}

public struct IPCHistoryResponseToolCall: Codable, Sendable {
    public let name: String
    public let input: [String: AnyCodable]
    public let result: String?
    public let isError: Bool?
    /// Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot).
    public let imageData: String?

    public init(name: String, input: [String: AnyCodable], result: String? = nil, isError: Bool? = nil, imageData: String? = nil) {
        self.name = name
        self.input = input
        self.result = result
        self.isError = isError
        self.imageData = imageData
    }
}

public struct IPCHomeBaseGetRequest: Codable, Sendable {
    public let type: String
    /// If true, daemon ensures a durable Home Base link exists before responding.
    public let ensureLinked: Bool?

    public init(type: String, ensureLinked: Bool? = nil) {
        self.type = type
        self.ensureLinked = ensureLinked
    }
}

public struct IPCHomeBaseGetResponse: Codable, Sendable {
    public let type: String
    public let homeBase: IPCHomeBaseGetResponseHomeBase?

    public init(type: String, homeBase: IPCHomeBaseGetResponseHomeBase?) {
        self.type = type
        self.homeBase = homeBase
    }
}

public struct IPCHomeBaseGetResponseHomeBase: Codable, Sendable {
    public let appId: String
    public let source: String
    public let starterTasks: [String]
    public let onboardingTasks: [String]
    public let preview: IPCHomeBaseGetResponseHomeBasePreview

    public init(appId: String, source: String, starterTasks: [String], onboardingTasks: [String], preview: IPCHomeBaseGetResponseHomeBasePreview) {
        self.appId = appId
        self.source = source
        self.starterTasks = starterTasks
        self.onboardingTasks = onboardingTasks
        self.preview = preview
    }
}

public struct IPCHomeBaseGetResponseHomeBasePreview: Codable, Sendable {
    public let title: String
    public let subtitle: String
    public let description: String
    public let icon: String
    public let metrics: [IPCHomeBaseGetResponseHomeBasePreviewMetric]

    public init(title: String, subtitle: String, description: String, icon: String, metrics: [IPCHomeBaseGetResponseHomeBasePreviewMetric]) {
        self.title = title
        self.subtitle = subtitle
        self.description = description
        self.icon = icon
        self.metrics = metrics
    }
}

public struct IPCHomeBaseGetResponseHomeBasePreviewMetric: Codable, Sendable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

public struct IPCIdentityGetRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCIdentityGetResponse: Codable, Sendable {
    public let type: String
    /// Whether an IDENTITY.md file was found. When false, all fields are empty defaults. Optional for backwards compat with older daemons.
    public let found: Bool?
    public let name: String
    public let role: String
    public let personality: String
    public let emoji: String
    public let home: String
    public let version: String?
    public let assistantId: String?
    public let createdAt: String?
    public let originSystem: String?

    public init(type: String, found: Bool? = nil, name: String, role: String, personality: String, emoji: String, home: String, version: String? = nil, assistantId: String? = nil, createdAt: String? = nil, originSystem: String? = nil) {
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

public struct IPCImageGenModelSetRequest: Codable, Sendable {
    public let type: String
    public let model: String

    public init(type: String, model: String) {
        self.type = type
        self.model = model
    }
}

public struct IPCIngressConfigRequest: Codable, Sendable {
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

public struct IPCIngressConfigResponse: Codable, Sendable {
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

public struct IPCIntegrationConnectRequest: Codable, Sendable {
    public let type: String
    public let integrationId: String

    public init(type: String, integrationId: String) {
        self.type = type
        self.integrationId = integrationId
    }
}

public struct IPCIntegrationConnectResult: Codable, Sendable {
    public let type: String
    public let integrationId: String
    public let success: Bool
    public let accountInfo: String?
    public let error: String?
    public let setupRequired: Bool?
    public let setupSkillId: String?
    public let setupHint: String?

    public init(type: String, integrationId: String, success: Bool, accountInfo: String? = nil, error: String? = nil, setupRequired: Bool? = nil, setupSkillId: String? = nil, setupHint: String? = nil) {
        self.type = type
        self.integrationId = integrationId
        self.success = success
        self.accountInfo = accountInfo
        self.error = error
        self.setupRequired = setupRequired
        self.setupSkillId = setupSkillId
        self.setupHint = setupHint
    }
}

public struct IPCIntegrationDisconnectRequest: Codable, Sendable {
    public let type: String
    public let integrationId: String

    public init(type: String, integrationId: String) {
        self.type = type
        self.integrationId = integrationId
    }
}

public struct IPCIntegrationListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCIntegrationListResponse: Codable, Sendable {
    public let type: String
    public let integrations: [IPCIntegrationListResponseIntegration]

    public init(type: String, integrations: [IPCIntegrationListResponseIntegration]) {
        self.type = type
        self.integrations = integrations
    }
}

public struct IPCIntegrationListResponseIntegration: Codable, Sendable {
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

public struct IPCIpcBlobProbe: Codable, Sendable {
    public let type: String
    public let probeId: String
    public let nonceSha256: String

    public init(type: String, probeId: String, nonceSha256: String) {
        self.type = type
        self.probeId = probeId
        self.nonceSha256 = nonceSha256
    }
}

public struct IPCIpcBlobProbeResult: Codable, Sendable {
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

public struct IPCIpcBlobRef: Codable, Sendable {
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

public struct IPCLinkOpenRequest: Codable, Sendable {
    public let type: String
    public let url: String
    public let metadata: [String: AnyCodable]?

    public init(type: String, url: String, metadata: [String: AnyCodable]? = nil) {
        self.type = type
        self.url = url
        self.metadata = metadata
    }
}

public struct IPCListItem: Codable, Sendable {
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

public struct IPCListSurfaceData: Codable, Sendable {
    public let items: [IPCListItem]
    public let selectionMode: String

    public init(items: [IPCListItem], selectionMode: String) {
        self.items = items
        self.selectionMode = selectionMode
    }
}

public struct IPCMemoryRecalled: Codable, Sendable {
    public let type: String
    public let provider: String
    public let model: String
    public let lexicalHits: Double
    public let semanticHits: Double
    public let recencyHits: Double
    public let entityHits: Double
    public let relationSeedEntityCount: Int?
    public let relationTraversedEdgeCount: Int?
    public let relationNeighborEntityCount: Int?
    public let relationExpandedItemCount: Int?
    public let earlyTerminated: Bool?
    public let mergedCount: Int
    public let selectedCount: Int
    public let rerankApplied: Bool
    public let injectedTokens: Int
    public let latencyMs: Double
    public let topCandidates: [IPCMemoryRecalledCandidateDebug]

    public init(type: String, provider: String, model: String, lexicalHits: Double, semanticHits: Double, recencyHits: Double, entityHits: Double, relationSeedEntityCount: Int? = nil, relationTraversedEdgeCount: Int? = nil, relationNeighborEntityCount: Int? = nil, relationExpandedItemCount: Int? = nil, earlyTerminated: Bool? = nil, mergedCount: Int, selectedCount: Int, rerankApplied: Bool, injectedTokens: Int, latencyMs: Double, topCandidates: [IPCMemoryRecalledCandidateDebug]) {
        self.type = type
        self.provider = provider
        self.model = model
        self.lexicalHits = lexicalHits
        self.semanticHits = semanticHits
        self.recencyHits = recencyHits
        self.entityHits = entityHits
        self.relationSeedEntityCount = relationSeedEntityCount
        self.relationTraversedEdgeCount = relationTraversedEdgeCount
        self.relationNeighborEntityCount = relationNeighborEntityCount
        self.relationExpandedItemCount = relationExpandedItemCount
        self.earlyTerminated = earlyTerminated
        self.mergedCount = mergedCount
        self.selectedCount = selectedCount
        self.rerankApplied = rerankApplied
        self.injectedTokens = injectedTokens
        self.latencyMs = latencyMs
        self.topCandidates = topCandidates
    }
}

public struct IPCMemoryRecalledCandidateDebug: Codable, Sendable {
    public let key: String
    public let type: String
    public let kind: String
    public let finalScore: Double
    public let lexical: Double
    public let semantic: Double
    public let recency: Double

    public init(key: String, type: String, kind: String, finalScore: Double, lexical: Double, semantic: Double, recency: Double) {
        self.key = key
        self.type = type
        self.kind = kind
        self.finalScore = finalScore
        self.lexical = lexical
        self.semantic = semantic
        self.recency = recency
    }
}

public struct IPCMemoryStatus: Codable, Sendable {
    public let type: String
    public let enabled: Bool
    public let degraded: Bool
    public let reason: String?
    public let provider: String?
    public let model: String?
    public let conflictsPending: Double
    public let conflictsResolved: Double
    public let oldestPendingConflictAgeMs: Double?
    public let cleanupResolvedJobsPending: Double
    public let cleanupSupersededJobsPending: Double
    public let cleanupResolvedJobsCompleted24h: Double
    public let cleanupSupersededJobsCompleted24h: Double

    public init(type: String, enabled: Bool, degraded: Bool, reason: String? = nil, provider: String? = nil, model: String? = nil, conflictsPending: Double, conflictsResolved: Double, oldestPendingConflictAgeMs: Double?, cleanupResolvedJobsPending: Double, cleanupSupersededJobsPending: Double, cleanupResolvedJobsCompleted24h: Double, cleanupSupersededJobsCompleted24h: Double) {
        self.type = type
        self.enabled = enabled
        self.degraded = degraded
        self.reason = reason
        self.provider = provider
        self.model = model
        self.conflictsPending = conflictsPending
        self.conflictsResolved = conflictsResolved
        self.oldestPendingConflictAgeMs = oldestPendingConflictAgeMs
        self.cleanupResolvedJobsPending = cleanupResolvedJobsPending
        self.cleanupSupersededJobsPending = cleanupSupersededJobsPending
        self.cleanupResolvedJobsCompleted24h = cleanupResolvedJobsCompleted24h
        self.cleanupSupersededJobsCompleted24h = cleanupSupersededJobsCompleted24h
    }
}

public struct IPCMessageComplete: Codable, Sendable {
    public let type: String
    public let sessionId: String?
    public let attachments: [IPCUserMessageAttachment]?

    public init(type: String, sessionId: String? = nil, attachments: [IPCUserMessageAttachment]? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.attachments = attachments
    }
}

public struct IPCMessageDequeued: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String

    public init(type: String, sessionId: String, requestId: String) {
        self.type = type
        self.sessionId = sessionId
        self.requestId = requestId
    }
}

public struct IPCMessageQueued: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String
    public let position: Int

    public init(type: String, sessionId: String, requestId: String, position: Int) {
        self.type = type
        self.sessionId = sessionId
        self.requestId = requestId
        self.position = position
    }
}

public struct IPCMessageQueuedDeleted: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String

    public init(type: String, sessionId: String, requestId: String) {
        self.type = type
        self.sessionId = sessionId
        self.requestId = requestId
    }
}

public struct IPCModelGetRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCModelInfo: Codable, Sendable {
    public let type: String
    public let model: String
    public let provider: String
    public let configuredProviders: [String]?

    public init(type: String, model: String, provider: String, configuredProviders: [String]? = nil) {
        self.type = type
        self.model = model
        self.provider = provider
        self.configuredProviders = configuredProviders
    }
}

public struct IPCModelSetRequest: Codable, Sendable {
    public let type: String
    public let model: String

    public init(type: String, model: String) {
        self.type = type
        self.model = model
    }
}

public struct IPCOpenBundleRequest: Codable, Sendable {
    public let type: String
    public let filePath: String

    public init(type: String, filePath: String) {
        self.type = type
        self.filePath = filePath
    }
}

public struct IPCOpenBundleResponse: Codable, Sendable {
    public let type: String
    public let manifest: IPCOpenBundleResponseManifest
    public let scanResult: IPCOpenBundleResponseScanResult
    public let signatureResult: IPCOpenBundleResponseSignatureResult
    public let bundleSizeBytes: Int

    public init(type: String, manifest: IPCOpenBundleResponseManifest, scanResult: IPCOpenBundleResponseScanResult, signatureResult: IPCOpenBundleResponseSignatureResult, bundleSizeBytes: Int) {
        self.type = type
        self.manifest = manifest
        self.scanResult = scanResult
        self.signatureResult = signatureResult
        self.bundleSizeBytes = bundleSizeBytes
    }
}

public struct IPCOpenBundleResponseManifest: Codable, Sendable {
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

public struct IPCOpenBundleResponseScanResult: Codable, Sendable {
    public let passed: Bool
    public let blocked: [String]
    public let warnings: [String]

    public init(passed: Bool, blocked: [String], warnings: [String]) {
        self.passed = passed
        self.blocked = blocked
        self.warnings = warnings
    }
}

public struct IPCOpenBundleResponseSignatureResult: Codable, Sendable {
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

/// Server push — tells the client to open/focus the tasks window.
public struct IPCOpenTasksWindow: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCOpenUrl: Codable, Sendable {
    public let type: String
    public let url: String
    public let title: String?

    public init(type: String, url: String, title: String? = nil) {
        self.type = type
        self.url = url
        self.title = title
    }
}

public struct IPCPingMessage: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCPongMessage: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCPublishPageRequest: Codable, Sendable {
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

public struct IPCPublishPageResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let publicUrl: String?
    public let deploymentId: String?
    public let error: String?

    public init(type: String, success: Bool, publicUrl: String? = nil, deploymentId: String? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.publicUrl = publicUrl
        self.deploymentId = deploymentId
        self.error = error
    }
}

public struct IPCRegenerateRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String

    public init(type: String, sessionId: String) {
        self.type = type
        self.sessionId = sessionId
    }
}

public struct IPCReminderCancel: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCReminderFired: Codable, Sendable {
    public let type: String
    public let reminderId: String
    public let label: String
    public let message: String

    public init(type: String, reminderId: String, label: String, message: String) {
        self.type = type
        self.reminderId = reminderId
        self.label = label
        self.message = message
    }
}

public struct IPCRemindersList: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCRemindersListResponse: Codable, Sendable {
    public let type: String
    public let reminders: [IPCRemindersListResponseReminder]

    public init(type: String, reminders: [IPCRemindersListResponseReminder]) {
        self.type = type
        self.reminders = reminders
    }
}

public struct IPCRemindersListResponseReminder: Codable, Sendable {
    public let id: String
    public let label: String
    public let message: String
    public let fireAt: Int
    public let mode: String
    public let status: String
    public let firedAt: Int?
    public let createdAt: Int

    public init(id: String, label: String, message: String, fireAt: Int, mode: String, status: String, firedAt: Int?, createdAt: Int) {
        self.id = id
        self.label = label
        self.message = message
        self.fireAt = fireAt
        self.mode = mode
        self.status = status
        self.firedAt = firedAt
        self.createdAt = createdAt
    }
}

public struct IPCRemoveTrustRule: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCRideShotgunProgress: Codable, Sendable {
    public let type: String
    public let watchId: String
    public let message: String

    public init(type: String, watchId: String, message: String) {
        self.type = type
        self.watchId = watchId
        self.message = message
    }
}

public struct IPCRideShotgunResult: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let watchId: String
    public let summary: String
    public let observationCount: Int
    public let recordingId: String?
    public let recordingPath: String?

    public init(type: String, sessionId: String, watchId: String, summary: String, observationCount: Int, recordingId: String? = nil, recordingPath: String? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.watchId = watchId
        self.summary = summary
        self.observationCount = observationCount
        self.recordingId = recordingId
        self.recordingPath = recordingPath
    }
}

public struct IPCRideShotgunStart: Codable, Sendable {
    public let type: String
    public let durationSeconds: Double
    public let intervalSeconds: Double
    public let mode: String?
    public let targetDomain: String?
    /// Domain to auto-navigate (may differ from targetDomain, e.g. open.spotify.com vs spotify.com).
    public let navigateDomain: String?
    public let autoNavigate: Bool?

    public init(type: String, durationSeconds: Double, intervalSeconds: Double, mode: String? = nil, targetDomain: String? = nil, navigateDomain: String? = nil, autoNavigate: Bool? = nil) {
        self.type = type
        self.durationSeconds = durationSeconds
        self.intervalSeconds = intervalSeconds
        self.mode = mode
        self.targetDomain = targetDomain
        self.navigateDomain = navigateDomain
        self.autoNavigate = autoNavigate
    }
}

public struct IPCRideShotgunStop: Codable, Sendable {
    public let type: String
    public let watchId: String

    public init(type: String, watchId: String) {
        self.type = type
        self.watchId = watchId
    }
}

public struct IPCSandboxSetRequest: Codable, Sendable {
    public let type: String
    public let enabled: Bool

    public init(type: String, enabled: Bool) {
        self.type = type
        self.enabled = enabled
    }
}

public struct IPCScheduleComplete: Codable, Sendable {
    public let type: String
    public let scheduleId: String
    public let name: String

    public init(type: String, scheduleId: String, name: String) {
        self.type = type
        self.scheduleId = scheduleId
        self.name = name
    }
}

public struct IPCScheduleRemove: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCScheduleRunNow: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCSchedulesList: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCSchedulesListResponse: Codable, Sendable {
    public let type: String
    public let schedules: [IPCSchedulesListResponseSchedule]

    public init(type: String, schedules: [IPCSchedulesListResponseSchedule]) {
        self.type = type
        self.schedules = schedules
    }
}

public struct IPCSchedulesListResponseSchedule: Codable, Sendable {
    public let id: String
    public let name: String
    public let enabled: Bool
    public let syntax: String
    public let expression: String
    public let cronExpression: String
    public let timezone: String?
    public let message: String
    public let nextRunAt: Int
    public let lastRunAt: Int?
    public let lastStatus: String?
    public let description: String

    public init(id: String, name: String, enabled: Bool, syntax: String, expression: String, cronExpression: String, timezone: String?, message: String, nextRunAt: Int, lastRunAt: Int?, lastStatus: String?, description: String) {
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
    }
}

public struct IPCScheduleToggle: Codable, Sendable {
    public let type: String
    public let id: String
    public let enabled: Bool

    public init(type: String, id: String, enabled: Bool) {
        self.type = type
        self.id = id
        self.enabled = enabled
    }
}

public struct IPCSecretDetected: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let matches: [IPCSecretDetectedMatch]
    public let action: String

    public init(type: String, toolName: String, matches: [IPCSecretDetectedMatch], action: String) {
        self.type = type
        self.toolName = toolName
        self.matches = matches
        self.action = action
    }
}

public struct IPCSecretDetectedMatch: Codable, Sendable {
    public let type: String
    public let redactedValue: String

    public init(type: String, redactedValue: String) {
        self.type = type
        self.redactedValue = redactedValue
    }
}

public struct IPCSecretRequest: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let service: String
    public let field: String
    public let label: String
    public let description: String?
    public let placeholder: String?
    public let sessionId: String?
    /// Intended purpose of the credential (displayed to user).
    public let purpose: String?
    /// Tools allowed to use this credential.
    public let allowedTools: [String]?
    /// Domains where this credential may be used.
    public let allowedDomains: [String]?
    /// Whether one-time send override is available.
    public let allowOneTimeSend: Bool?

    public init(type: String, requestId: String, service: String, field: String, label: String, description: String? = nil, placeholder: String? = nil, sessionId: String? = nil, purpose: String? = nil, allowedTools: [String]? = nil, allowedDomains: [String]? = nil, allowOneTimeSend: Bool? = nil) {
        self.type = type
        self.requestId = requestId
        self.service = service
        self.field = field
        self.label = label
        self.description = description
        self.placeholder = placeholder
        self.sessionId = sessionId
        self.purpose = purpose
        self.allowedTools = allowedTools
        self.allowedDomains = allowedDomains
        self.allowOneTimeSend = allowOneTimeSend
    }
}

public struct IPCSecretResponse: Codable, Sendable {
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

public struct IPCSessionCreateRequest: Codable, Sendable {
    public let type: String
    public let title: String?
    public let systemPromptOverride: String?
    public let maxResponseTokens: Int?
    public let correlationId: String?
    /// Lightweight session transport metadata for channel identity and natural-language guidance.
    public let transport: IPCSessionTransportMetadata?
    public let threadType: String?
    /// Skill IDs to pre-activate in the new session (loaded before the first message).
    public let preactivatedSkillIds: [String]?
    /// If provided, automatically sent as the first user message after session creation.
    public let initialMessage: String?

    public init(type: String, title: String? = nil, systemPromptOverride: String? = nil, maxResponseTokens: Int? = nil, correlationId: String? = nil, transport: IPCSessionTransportMetadata? = nil, threadType: String? = nil, preactivatedSkillIds: [String]? = nil, initialMessage: String? = nil) {
        self.type = type
        self.title = title
        self.systemPromptOverride = systemPromptOverride
        self.maxResponseTokens = maxResponseTokens
        self.correlationId = correlationId
        self.transport = transport
        self.threadType = threadType
        self.preactivatedSkillIds = preactivatedSkillIds
        self.initialMessage = initialMessage
    }
}

public struct IPCSessionInfo: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let title: String
    public let correlationId: String?
    public let threadType: String?

    public init(type: String, sessionId: String, title: String, correlationId: String? = nil, threadType: String? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.title = title
        self.correlationId = correlationId
        self.threadType = threadType
    }
}

public struct IPCSessionListRequest: Codable, Sendable {
    public let type: String
    /// Number of sessions to skip (for pagination). Defaults to 0.
    public let offset: Double?
    /// Maximum number of sessions to return. Defaults to 50.
    public let limit: Double?

    public init(type: String, offset: Double? = nil, limit: Double? = nil) {
        self.type = type
        self.offset = offset
        self.limit = limit
    }
}

public struct IPCSessionListResponse: Codable, Sendable {
    public let type: String
    public let sessions: [IPCSessionListResponseSession]
    /// Whether more sessions exist beyond the returned page.
    public let hasMore: Bool?

    public init(type: String, sessions: [IPCSessionListResponseSession], hasMore: Bool? = nil) {
        self.type = type
        self.sessions = sessions
        self.hasMore = hasMore
    }
}

public struct IPCSessionListResponseSession: Codable, Sendable {
    public let id: String
    public let title: String
    public let updatedAt: Int
    public let threadType: String?
    public let source: String?
    /// Channel binding metadata exposed in session/conversation list APIs.
    public let channelBinding: IPCChannelBinding?

    public init(id: String, title: String, updatedAt: Int, threadType: String? = nil, source: String? = nil, channelBinding: IPCChannelBinding? = nil) {
        self.id = id
        self.title = title
        self.updatedAt = updatedAt
        self.threadType = threadType
        self.source = source
        self.channelBinding = channelBinding
    }
}

public struct IPCSessionsClearRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCSessionsClearResponse: Codable, Sendable {
    public let type: String
    public let cleared: Int

    public init(type: String, cleared: Int) {
        self.type = type
        self.cleared = cleared
    }
}

public struct IPCSessionSwitchRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String

    public init(type: String, sessionId: String) {
        self.type = type
        self.sessionId = sessionId
    }
}

/// Lightweight session transport metadata for channel identity and natural-language guidance.
public struct IPCSessionTransportMetadata: Codable, Sendable {
    /// Logical channel identifier (e.g. "desktop", "telegram", "mobile").
    public let channelId: String
    /// Optional natural-language hints for channel-specific UX behavior.
    public let hints: [String]?
    /// Optional concise UX brief for this channel.
    public let uxBrief: String?

    public init(channelId: String, hints: [String]? = nil, uxBrief: String? = nil) {
        self.channelId = channelId
        self.hints = hints
        self.uxBrief = uxBrief
    }
}

public struct IPCShareAppCloudRequest: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct IPCShareAppCloudResponse: Codable, Sendable {
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

public struct IPCSharedAppDeleteRequest: Codable, Sendable {
    public let type: String
    public let uuid: String

    public init(type: String, uuid: String) {
        self.type = type
        self.uuid = uuid
    }
}

public struct IPCSharedAppDeleteResponse: Codable, Sendable {
    public let type: String
    public let success: Bool

    public init(type: String, success: Bool) {
        self.type = type
        self.success = success
    }
}

public struct IPCSharedAppsListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCSharedAppsListResponse: Codable, Sendable {
    public let type: String
    public let apps: [IPCSharedAppsListResponseApp]

    public init(type: String, apps: [IPCSharedAppsListResponseApp]) {
        self.type = type
        self.apps = apps
    }
}

public struct IPCSharedAppsListResponseApp: Codable, Sendable {
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

public struct IPCShareToSlackRequest: Codable, Sendable {
    public let type: String
    public let appId: String

    public init(type: String, appId: String) {
        self.type = type
        self.appId = appId
    }
}

public struct IPCShareToSlackResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?

    public init(type: String, success: Bool, error: String? = nil) {
        self.type = type
        self.success = success
        self.error = error
    }
}

public struct IPCSignBundlePayloadRequest: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let payload: String

    public init(type: String, requestId: String, payload: String) {
        self.type = type
        self.requestId = requestId
        self.payload = payload
    }
}

public struct IPCSignBundlePayloadResponse: Codable, Sendable {
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

public struct IPCSkillDetailRequest: Codable, Sendable {
    public let type: String
    public let skillId: String

    public init(type: String, skillId: String) {
        self.type = type
        self.skillId = skillId
    }
}

public struct IPCSkillDetailResponse: Codable, Sendable {
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

public struct IPCSkillsCheckUpdatesRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCSkillsConfigureRequest: Codable, Sendable {
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

public struct IPCSkillsDisableRequest: Codable, Sendable {
    public let type: String
    public let name: String

    public init(type: String, name: String) {
        self.type = type
        self.name = name
    }
}

public struct IPCSkillsEnableRequest: Codable, Sendable {
    public let type: String
    public let name: String

    public init(type: String, name: String) {
        self.type = type
        self.name = name
    }
}

public struct IPCSkillsInspectRequest: Codable, Sendable {
    public let type: String
    public let slug: String

    public init(type: String, slug: String) {
        self.type = type
        self.slug = slug
    }
}

public struct IPCSkillsInspectResponse: Codable, Sendable {
    public let type: String
    public let slug: String
    public let data: IPCSkillsInspectResponseData?
    public let error: String?

    public init(type: String, slug: String, data: IPCSkillsInspectResponseData? = nil, error: String? = nil) {
        self.type = type
        self.slug = slug
        self.data = data
        self.error = error
    }
}

public struct IPCSkillsInspectResponseData: Codable, Sendable {
    public let skill: IPCSkillsInspectResponseDataSkill
    public let owner: IPCSkillsInspectResponseDataOwner?
    public let stats: IPCSkillsInspectResponseDataStats?
    public let createdAt: Int?
    public let updatedAt: Int?
    public let latestVersion: IPCSkillsInspectResponseDataLatestVersion?
    public let files: [IPCSkillsInspectResponseDataFile]?
    public let skillMdContent: String?

    public init(skill: IPCSkillsInspectResponseDataSkill, owner: IPCSkillsInspectResponseDataOwner? = nil, stats: IPCSkillsInspectResponseDataStats? = nil, createdAt: Int? = nil, updatedAt: Int? = nil, latestVersion: IPCSkillsInspectResponseDataLatestVersion? = nil, files: [IPCSkillsInspectResponseDataFile]? = nil, skillMdContent: String? = nil) {
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

public struct IPCSkillsInspectResponseDataFile: Codable, Sendable {
    public let path: String
    public let size: Int
    public let contentType: String?

    public init(path: String, size: Int, contentType: String? = nil) {
        self.path = path
        self.size = size
        self.contentType = contentType
    }
}

public struct IPCSkillsInspectResponseDataLatestVersion: Codable, Sendable {
    public let version: String
    public let changelog: String?

    public init(version: String, changelog: String? = nil) {
        self.version = version
        self.changelog = changelog
    }
}

public struct IPCSkillsInspectResponseDataOwner: Codable, Sendable {
    public let handle: String
    public let displayName: String
    public let image: String?

    public init(handle: String, displayName: String, image: String? = nil) {
        self.handle = handle
        self.displayName = displayName
        self.image = image
    }
}

public struct IPCSkillsInspectResponseDataSkill: Codable, Sendable {
    public let slug: String
    public let displayName: String
    public let summary: String

    public init(slug: String, displayName: String, summary: String) {
        self.slug = slug
        self.displayName = displayName
        self.summary = summary
    }
}

public struct IPCSkillsInspectResponseDataStats: Codable, Sendable {
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

public struct IPCSkillsInstallRequest: Codable, Sendable {
    public let type: String
    public let slug: String
    public let version: String?

    public init(type: String, slug: String, version: String? = nil) {
        self.type = type
        self.slug = slug
        self.version = version
    }
}

public struct IPCSkillsListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCSkillsListResponse: Codable, Sendable {
    public let type: String
    public let skills: [IPCSkillsListResponseSkill]

    public init(type: String, skills: [IPCSkillsListResponseSkill]) {
        self.type = type
        self.skills = skills
    }
}

public struct IPCSkillsListResponseSkill: Codable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let emoji: String?
    public let homepage: String?
    public let source: String
    public let state: String
    public let degraded: Bool
    public let missingRequirements: IPCSkillsListResponseSkillMissingRequirements?
    public let installedVersion: String?
    public let latestVersion: String?
    public let updateAvailable: Bool
    public let userInvocable: Bool
    public let clawhub: IPCSkillsListResponseSkillClawhub?

    public init(id: String, name: String, description: String, emoji: String? = nil, homepage: String? = nil, source: String, state: String, degraded: Bool, missingRequirements: IPCSkillsListResponseSkillMissingRequirements? = nil, installedVersion: String? = nil, latestVersion: String? = nil, updateAvailable: Bool, userInvocable: Bool, clawhub: IPCSkillsListResponseSkillClawhub? = nil) {
        self.id = id
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

public struct IPCSkillsListResponseSkillClawhub: Codable, Sendable {
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

public struct IPCSkillsListResponseSkillMissingRequirements: Codable, Sendable {
    public let bins: [String]?
    public let env: [String]?
    public let permissions: [String]?

    public init(bins: [String]? = nil, env: [String]? = nil, permissions: [String]? = nil) {
        self.bins = bins
        self.env = env
        self.permissions = permissions
    }
}

public struct IPCSkillsOperationResponse: Codable, Sendable {
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

public struct IPCSkillsSearchRequest: Codable, Sendable {
    public let type: String
    public let query: String

    public init(type: String, query: String) {
        self.type = type
        self.query = query
    }
}

public struct IPCSkillStateChanged: Codable, Sendable {
    public let type: String
    public let name: String
    public let state: String

    public init(type: String, name: String, state: String) {
        self.type = type
        self.name = name
        self.state = state
    }
}

public struct IPCSkillsUninstallRequest: Codable, Sendable {
    public let type: String
    public let name: String

    public init(type: String, name: String) {
        self.type = type
        self.name = name
    }
}

public struct IPCSkillsUpdateRequest: Codable, Sendable {
    public let type: String
    public let name: String

    public init(type: String, name: String) {
        self.type = type
        self.name = name
    }
}

public struct IPCSlackWebhookConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let webhookUrl: String?

    public init(type: String, action: String, webhookUrl: String? = nil) {
        self.type = type
        self.action = action
        self.webhookUrl = webhookUrl
    }
}

public struct IPCSlackWebhookConfigResponse: Codable, Sendable {
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

public struct IPCSubagentAbortRequest: Codable, Sendable {
    public let type: String
    public let subagentId: String

    public init(type: String, subagentId: String) {
        self.type = type
        self.subagentId = subagentId
    }
}

public struct IPCSubagentDetailRequest: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let conversationId: String

    public init(type: String, subagentId: String, conversationId: String) {
        self.type = type
        self.subagentId = subagentId
        self.conversationId = conversationId
    }
}

public struct IPCSubagentDetailResponse: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let objective: String?
    public let events: [IPCSubagentDetailResponseEvent]

    public init(type: String, subagentId: String, objective: String? = nil, events: [IPCSubagentDetailResponseEvent]) {
        self.type = type
        self.subagentId = subagentId
        self.objective = objective
        self.events = events
    }
}

public struct IPCSubagentDetailResponseEvent: Codable, Sendable {
    public let type: String
    public let content: String
    public let toolName: String?
    public let isError: Bool?

    public init(type: String, content: String, toolName: String? = nil, isError: Bool? = nil) {
        self.type = type
        self.content = content
        self.toolName = toolName
        self.isError = isError
    }
}

public struct IPCSubagentMessageRequest: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let content: String

    public init(type: String, subagentId: String, content: String) {
        self.type = type
        self.subagentId = subagentId
        self.content = content
    }
}

public struct IPCSubagentSpawned: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let parentSessionId: String
    public let label: String
    public let objective: String

    public init(type: String, subagentId: String, parentSessionId: String, label: String, objective: String) {
        self.type = type
        self.subagentId = subagentId
        self.parentSessionId = parentSessionId
        self.label = label
        self.objective = objective
    }
}

public struct IPCSubagentStatusChanged: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let status: String
    public let error: String?
    public let usage: IPCUsageStats?

    public init(type: String, subagentId: String, status: String, error: String? = nil, usage: IPCUsageStats? = nil) {
        self.type = type
        self.subagentId = subagentId
        self.status = status
        self.error = error
        self.usage = usage
    }
}

public struct IPCSubagentStatusRequest: Codable, Sendable {
    public let type: String
    /// If omitted, returns all subagents for the session.
    public let subagentId: String?

    public init(type: String, subagentId: String? = nil) {
        self.type = type
        self.subagentId = subagentId
    }
}

public struct IPCSuggestionRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String

    public init(type: String, sessionId: String, requestId: String) {
        self.type = type
        self.sessionId = sessionId
        self.requestId = requestId
    }
}

public struct IPCSuggestionResponse: Codable, Sendable {
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

public struct IPCSurfaceAction: Codable, Sendable {
    public let id: String
    public let label: String
    public let style: String?

    public init(id: String, label: String, style: String? = nil) {
        self.id = id
        self.label = label
        self.style = style
    }
}

public struct IPCTableColumn: Codable, Sendable {
    public let id: String
    public let label: String
    public let width: Int?

    public init(id: String, label: String, width: Int? = nil) {
        self.id = id
        self.label = label
        self.width = width
    }
}

public struct IPCTableRow: Codable, Sendable {
    public let id: String
    public let cells: [String: String]
    public let selectable: Bool?
    public let selected: Bool?

    public init(id: String, cells: [String: String], selectable: Bool? = nil, selected: Bool? = nil) {
        self.id = id
        self.cells = cells
        self.selectable = selectable
        self.selected = selected
    }
}

public struct IPCTableSurfaceData: Codable, Sendable {
    public let columns: [IPCTableColumn]
    public let rows: [IPCTableRow]
    public let selectionMode: String?
    public let caption: String?

    public init(columns: [IPCTableColumn], rows: [IPCTableRow], selectionMode: String? = nil, caption: String? = nil) {
        self.columns = columns
        self.rows = rows
        self.selectionMode = selectionMode
        self.caption = caption
    }
}

public struct IPCTaskRouted: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let interactionType: String
    /// The task text passed to the escalated session.
    public let task: String?
    /// Set when a text_qa session escalates to computer_use via computer_use_request_control.
    public let escalatedFrom: String?

    public init(type: String, sessionId: String, interactionType: String, task: String? = nil, escalatedFrom: String? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.interactionType = interactionType
        self.task = task
        self.escalatedFrom = escalatedFrom
    }
}

/// Server push — broadcast when a task run creates a conversation, so the client can show it as a chat thread.
public struct IPCTaskRunThreadCreated: Codable, Sendable {
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
public struct IPCTasksChanged: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCTaskSubmit: Codable, Sendable {
    public let type: String
    public let task: String
    public let screenWidth: Int
    public let screenHeight: Int
    public let attachments: [IPCUserMessageAttachment]?
    public let source: String?

    public init(type: String, task: String, screenWidth: Int, screenHeight: Int, attachments: [IPCUserMessageAttachment]? = nil, source: String? = nil) {
        self.type = type
        self.task = task
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.attachments = attachments
        self.source = source
    }
}

public struct IPCTelegramConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let botToken: String?
    public let commands: [IPCTelegramConfigRequestCommand]?

    public init(type: String, action: String, botToken: String? = nil, commands: [IPCTelegramConfigRequestCommand]? = nil) {
        self.type = type
        self.action = action
        self.botToken = botToken
        self.commands = commands
    }
}

public struct IPCTelegramConfigRequestCommand: Codable, Sendable {
    public let command: String
    public let description: String

    public init(command: String, description: String) {
        self.command = command
        self.description = description
    }
}

public struct IPCTelegramConfigResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let hasBotToken: Bool
    public let botUsername: String?
    public let connected: Bool
    public let hasWebhookSecret: Bool
    public let lastError: String?
    public let error: String?

    public init(type: String, success: Bool, hasBotToken: Bool, botUsername: String? = nil, connected: Bool, hasWebhookSecret: Bool, lastError: String? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.hasBotToken = hasBotToken
        self.botUsername = botUsername
        self.connected = connected
        self.hasWebhookSecret = hasWebhookSecret
        self.lastError = lastError
        self.error = error
    }
}

public struct IPCToolInputDelta: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let content: String
    public let sessionId: String?

    public init(type: String, toolName: String, content: String, sessionId: String? = nil) {
        self.type = type
        self.toolName = toolName
        self.content = content
        self.sessionId = sessionId
    }
}

public struct IPCToolInputSchema: Codable, Sendable {
    public let type: String
    public let properties: [String: AnyCodable]?
    public let required: [String]?

    public init(type: String, properties: [String: AnyCodable]? = nil, required: [String]? = nil) {
        self.type = type
        self.properties = properties
        self.required = required
    }
}

public struct IPCToolNamesListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCToolNamesListResponse: Codable, Sendable {
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

public struct IPCToolOutputChunk: Codable, Sendable {
    public let type: String
    public let chunk: String
    public let sessionId: String?
    public let subType: String?
    public let subToolName: String?
    public let subToolInput: String?
    public let subToolIsError: Bool?
    public let subToolId: String?

    public init(type: String, chunk: String, sessionId: String? = nil, subType: String? = nil, subToolName: String? = nil, subToolInput: String? = nil, subToolIsError: Bool? = nil, subToolId: String? = nil) {
        self.type = type
        self.chunk = chunk
        self.sessionId = sessionId
        self.subType = subType
        self.subToolName = subToolName
        self.subToolInput = subToolInput
        self.subToolIsError = subToolIsError
        self.subToolId = subToolId
    }
}

public struct IPCToolPermissionSimulateRequest: Codable, Sendable {
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

public struct IPCToolPermissionSimulateResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    /// The simulated permission decision.
    public let decision: String?
    /// Risk level of the simulated tool invocation.
    public let riskLevel: String?
    /// Human-readable reason for the decision.
    public let reason: String?
    /// When decision is 'prompt', the data needed to render a ToolConfirmationBubble.
    public let promptPayload: IPCToolPermissionSimulateResponsePromptPayload?
    /// Resolved execution target for the tool.
    public let executionTarget: String?
    /// ID of the trust rule that matched (if any).
    public let matchedRuleId: String?
    /// Error message when success is false.
    public let error: String?

    public init(type: String, success: Bool, decision: String? = nil, riskLevel: String? = nil, reason: String? = nil, promptPayload: IPCToolPermissionSimulateResponsePromptPayload? = nil, executionTarget: String? = nil, matchedRuleId: String? = nil, error: String? = nil) {
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

public struct IPCToolPermissionSimulateResponsePromptPayload: Codable, Sendable {
    public let allowlistOptions: [IPCToolPermissionSimulateResponsePromptPayloadAllowlistOption]
    public let scopeOptions: [IPCToolPermissionSimulateResponsePromptPayloadScopeOption]
    public let persistentDecisionsAllowed: Bool

    public init(allowlistOptions: [IPCToolPermissionSimulateResponsePromptPayloadAllowlistOption], scopeOptions: [IPCToolPermissionSimulateResponsePromptPayloadScopeOption], persistentDecisionsAllowed: Bool) {
        self.allowlistOptions = allowlistOptions
        self.scopeOptions = scopeOptions
        self.persistentDecisionsAllowed = persistentDecisionsAllowed
    }
}

public struct IPCToolPermissionSimulateResponsePromptPayloadAllowlistOption: Codable, Sendable {
    public let label: String
    public let description: String
    public let pattern: String

    public init(label: String, description: String, pattern: String) {
        self.label = label
        self.description = description
        self.pattern = pattern
    }
}

public struct IPCToolPermissionSimulateResponsePromptPayloadScopeOption: Codable, Sendable {
    public let label: String
    public let scope: String

    public init(label: String, scope: String) {
        self.label = label
        self.scope = scope
    }
}

public struct IPCToolResult: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let result: String
    public let isError: Bool?
    public let diff: IPCToolResultDiff?
    public let status: String?
    public let sessionId: String?
    /// Base64-encoded image data extracted from contentBlocks (e.g. browser_screenshot).
    public let imageData: String?

    public init(type: String, toolName: String, result: String, isError: Bool? = nil, diff: IPCToolResultDiff? = nil, status: String? = nil, sessionId: String? = nil, imageData: String? = nil) {
        self.type = type
        self.toolName = toolName
        self.result = result
        self.isError = isError
        self.diff = diff
        self.status = status
        self.sessionId = sessionId
        self.imageData = imageData
    }
}

public struct IPCToolResultDiff: Codable, Sendable {
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

public struct IPCToolUseStart: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let sessionId: String?

    public init(type: String, toolName: String, input: [String: AnyCodable], sessionId: String? = nil) {
        self.type = type
        self.toolName = toolName
        self.input = input
        self.sessionId = sessionId
    }
}

public struct IPCTrustRulesList: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCTrustRulesListResponse: Codable, Sendable {
    public let type: String
    public let rules: [IPCTrustRulesListResponseRule]

    public init(type: String, rules: [IPCTrustRulesListResponseRule]) {
        self.type = type
        self.rules = rules
    }
}

public struct IPCTrustRulesListResponseRule: Codable, Sendable {
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

public struct IPCTwilioConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let accountSid: String?
    public let authToken: String?
    public let phoneNumber: String?
    public let areaCode: String?
    public let country: String?
    public let assistantId: String?
    public let verificationSid: String?
    public let verificationParams: IPCTwilioConfigRequestVerificationParams?
    public let text: String?

    public init(type: String, action: String, accountSid: String? = nil, authToken: String? = nil, phoneNumber: String? = nil, areaCode: String? = nil, country: String? = nil, assistantId: String? = nil, verificationSid: String? = nil, verificationParams: IPCTwilioConfigRequestVerificationParams? = nil, text: String? = nil) {
        self.type = type
        self.action = action
        self.accountSid = accountSid
        self.authToken = authToken
        self.phoneNumber = phoneNumber
        self.areaCode = areaCode
        self.country = country
        self.assistantId = assistantId
        self.verificationSid = verificationSid
        self.verificationParams = verificationParams
        self.text = text
    }
}

public struct IPCTwilioConfigRequestVerificationParams: Codable, Sendable {
    public let tollfreePhoneNumberSid: String?
    public let businessName: String?
    public let businessWebsite: String?
    public let notificationEmail: String?
    public let useCaseCategories: [String]?
    public let useCaseSummary: String?
    public let productionMessageSample: String?
    public let optInImageUrls: [String]?
    public let optInType: String?
    public let messageVolume: String?
    public let businessType: String?
    public let customerProfileSid: String?

    public init(tollfreePhoneNumberSid: String? = nil, businessName: String? = nil, businessWebsite: String? = nil, notificationEmail: String? = nil, useCaseCategories: [String]? = nil, useCaseSummary: String? = nil, productionMessageSample: String? = nil, optInImageUrls: [String]? = nil, optInType: String? = nil, messageVolume: String? = nil, businessType: String? = nil, customerProfileSid: String? = nil) {
        self.tollfreePhoneNumberSid = tollfreePhoneNumberSid
        self.businessName = businessName
        self.businessWebsite = businessWebsite
        self.notificationEmail = notificationEmail
        self.useCaseCategories = useCaseCategories
        self.useCaseSummary = useCaseSummary
        self.productionMessageSample = productionMessageSample
        self.optInImageUrls = optInImageUrls
        self.optInType = optInType
        self.messageVolume = messageVolume
        self.businessType = businessType
        self.customerProfileSid = customerProfileSid
    }
}

public struct IPCTwilioConfigResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let hasCredentials: Bool
    public let phoneNumber: String?
    public let numbers: [IPCTwilioConfigResponseNumber]?
    public let error: String?
    /// Non-fatal warning message (e.g. webhook sync failure that did not prevent the primary operation).
    public let warning: String?
    public let compliance: IPCTwilioConfigResponseCompliance?
    /// Present when action is 'sms_send_test'.
    public let testResult: IPCTwilioConfigResponseTestResult?
    /// Present when action is 'sms_doctor'.
    public let diagnostics: IPCTwilioConfigResponseDiagnostics?

    public init(type: String, success: Bool, hasCredentials: Bool, phoneNumber: String? = nil, numbers: [IPCTwilioConfigResponseNumber]? = nil, error: String? = nil, warning: String? = nil, compliance: IPCTwilioConfigResponseCompliance? = nil, testResult: IPCTwilioConfigResponseTestResult? = nil, diagnostics: IPCTwilioConfigResponseDiagnostics? = nil) {
        self.type = type
        self.success = success
        self.hasCredentials = hasCredentials
        self.phoneNumber = phoneNumber
        self.numbers = numbers
        self.error = error
        self.warning = warning
        self.compliance = compliance
        self.testResult = testResult
        self.diagnostics = diagnostics
    }
}

public struct IPCTwilioConfigResponseCompliance: Codable, Sendable {
    public let numberType: String?
    public let verificationSid: String?
    public let verificationStatus: String?
    public let rejectionReason: String?
    public let rejectionReasons: [String]?
    public let errorCode: String?
    public let editAllowed: Bool?
    public let editExpiration: String?

    public init(numberType: String? = nil, verificationSid: String? = nil, verificationStatus: String? = nil, rejectionReason: String? = nil, rejectionReasons: [String]? = nil, errorCode: String? = nil, editAllowed: Bool? = nil, editExpiration: String? = nil) {
        self.numberType = numberType
        self.verificationSid = verificationSid
        self.verificationStatus = verificationStatus
        self.rejectionReason = rejectionReason
        self.rejectionReasons = rejectionReasons
        self.errorCode = errorCode
        self.editAllowed = editAllowed
        self.editExpiration = editExpiration
    }
}

public struct IPCTwilioConfigResponseDiagnostics: Codable, Sendable {
    public let readiness: IPCTwilioConfigResponseDiagnosticsReadiness
    public let compliance: IPCTwilioConfigResponseDiagnosticsCompliance
    public let lastSend: IPCTwilioConfigResponseDiagnosticsLastSend?
    public let overallStatus: String
    public let actionItems: [String]

    public init(readiness: IPCTwilioConfigResponseDiagnosticsReadiness, compliance: IPCTwilioConfigResponseDiagnosticsCompliance, lastSend: IPCTwilioConfigResponseDiagnosticsLastSend? = nil, overallStatus: String, actionItems: [String]) {
        self.readiness = readiness
        self.compliance = compliance
        self.lastSend = lastSend
        self.overallStatus = overallStatus
        self.actionItems = actionItems
    }
}

public struct IPCTwilioConfigResponseDiagnosticsCompliance: Codable, Sendable {
    public let status: String
    public let detail: String?
    public let remediation: String?

    public init(status: String, detail: String? = nil, remediation: String? = nil) {
        self.status = status
        self.detail = detail
        self.remediation = remediation
    }
}

public struct IPCTwilioConfigResponseDiagnosticsLastSend: Codable, Sendable {
    public let status: String
    public let errorCode: String?
    public let remediation: String?

    public init(status: String, errorCode: String? = nil, remediation: String? = nil) {
        self.status = status
        self.errorCode = errorCode
        self.remediation = remediation
    }
}

public struct IPCTwilioConfigResponseDiagnosticsReadiness: Codable, Sendable {
    public let ready: Bool
    public let issues: [String]

    public init(ready: Bool, issues: [String]) {
        self.ready = ready
        self.issues = issues
    }
}

public struct IPCTwilioConfigResponseNumber: Codable, Sendable {
    public let phoneNumber: String
    public let friendlyName: String
    public let capabilities: IPCTwilioConfigResponseNumberCapabilities

    public init(phoneNumber: String, friendlyName: String, capabilities: IPCTwilioConfigResponseNumberCapabilities) {
        self.phoneNumber = phoneNumber
        self.friendlyName = friendlyName
        self.capabilities = capabilities
    }
}

public struct IPCTwilioConfigResponseNumberCapabilities: Codable, Sendable {
    public let voice: Bool
    public let sms: Bool

    public init(voice: Bool, sms: Bool) {
        self.voice = voice
        self.sms = sms
    }
}

public struct IPCTwilioConfigResponseTestResult: Codable, Sendable {
    public let messageSid: String
    public let to: String
    public let initialStatus: String
    public let finalStatus: String
    public let errorCode: String?
    public let errorMessage: String?

    public init(messageSid: String, to: String, initialStatus: String, finalStatus: String, errorCode: String? = nil, errorMessage: String? = nil) {
        self.messageSid = messageSid
        self.to = to
        self.initialStatus = initialStatus
        self.finalStatus = finalStatus
        self.errorCode = errorCode
        self.errorMessage = errorMessage
    }
}

public struct IPCTwitterAuthResult: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let accountInfo: String?
    public let error: String?

    public init(type: String, success: Bool, accountInfo: String? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.accountInfo = accountInfo
        self.error = error
    }
}

public struct IPCTwitterAuthStartRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCTwitterAuthStatusRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCTwitterAuthStatusResponse: Codable, Sendable {
    public let type: String
    public let connected: Bool
    public let accountInfo: String?
    public let mode: String?
    public let error: String?

    public init(type: String, connected: Bool, accountInfo: String? = nil, mode: String? = nil, error: String? = nil) {
        self.type = type
        self.connected = connected
        self.accountInfo = accountInfo
        self.mode = mode
        self.error = error
    }
}

public struct IPCTwitterIntegrationConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let mode: String?
    public let clientId: String?
    public let clientSecret: String?
    public let strategy: String?

    public init(type: String, action: String, mode: String? = nil, clientId: String? = nil, clientSecret: String? = nil, strategy: String? = nil) {
        self.type = type
        self.action = action
        self.mode = mode
        self.clientId = clientId
        self.clientSecret = clientSecret
        self.strategy = strategy
    }
}

public struct IPCTwitterIntegrationConfigResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let mode: String?
    public let managedAvailable: Bool
    public let localClientConfigured: Bool
    public let connected: Bool
    public let accountInfo: String?
    public let strategy: String?
    /// Whether the user has explicitly set a strategy (vs. relying on the default 'auto').
    public let strategyConfigured: Bool?
    public let error: String?

    public init(type: String, success: Bool, mode: String? = nil, managedAvailable: Bool, localClientConfigured: Bool, connected: Bool, accountInfo: String? = nil, strategy: String? = nil, strategyConfigured: Bool? = nil, error: String? = nil) {
        self.type = type
        self.success = success
        self.mode = mode
        self.managedAvailable = managedAvailable
        self.localClientConfigured = localClientConfigured
        self.connected = connected
        self.accountInfo = accountInfo
        self.strategy = strategy
        self.strategyConfigured = strategyConfigured
        self.error = error
    }
}

public struct IPCUiSurfaceAction: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let actionId: String
    public let data: [String: AnyCodable]?

    public init(type: String, sessionId: String, surfaceId: String, actionId: String, data: [String: AnyCodable]? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.actionId = actionId
        self.data = data
    }
}

public struct IPCUiSurfaceComplete: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let summary: String
    public let submittedData: [String: AnyCodable]?

    public init(type: String, sessionId: String, surfaceId: String, summary: String, submittedData: [String: AnyCodable]? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.summary = summary
        self.submittedData = submittedData
    }
}

public struct IPCUiSurfaceDismiss: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String

    public init(type: String, sessionId: String, surfaceId: String) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
    }
}

public struct IPCUiSurfaceShowBrowserView: Codable, Sendable {
    public let surfaceType: String
    public let data: IPCBrowserViewSurfaceData
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String?
    public let actions: [IPCSurfaceAction]?
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?

    public init(surfaceType: String, data: IPCBrowserViewSurfaceData, type: String, sessionId: String, surfaceId: String, title: String? = nil, actions: [IPCSurfaceAction]? = nil, display: String? = nil, messageId: String? = nil) {
        self.surfaceType = surfaceType
        self.data = data
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.title = title
        self.actions = actions
        self.display = display
        self.messageId = messageId
    }
}

public struct IPCUiSurfaceShowCard: Codable, Sendable {
    public let surfaceType: String
    public let data: IPCCardSurfaceData
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String?
    public let actions: [IPCSurfaceAction]?
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?

    public init(surfaceType: String, data: IPCCardSurfaceData, type: String, sessionId: String, surfaceId: String, title: String? = nil, actions: [IPCSurfaceAction]? = nil, display: String? = nil, messageId: String? = nil) {
        self.surfaceType = surfaceType
        self.data = data
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.title = title
        self.actions = actions
        self.display = display
        self.messageId = messageId
    }
}

public struct IPCUiSurfaceShowConfirmation: Codable, Sendable {
    public let surfaceType: String
    public let data: IPCConfirmationSurfaceData
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String?
    public let actions: [IPCSurfaceAction]?
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?

    public init(surfaceType: String, data: IPCConfirmationSurfaceData, type: String, sessionId: String, surfaceId: String, title: String? = nil, actions: [IPCSurfaceAction]? = nil, display: String? = nil, messageId: String? = nil) {
        self.surfaceType = surfaceType
        self.data = data
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.title = title
        self.actions = actions
        self.display = display
        self.messageId = messageId
    }
}

public struct IPCUiSurfaceShowDocumentPreview: Codable, Sendable {
    public let surfaceType: String
    public let data: IPCDocumentPreviewSurfaceData
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String?
    public let actions: [IPCSurfaceAction]?
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?

    public init(surfaceType: String, data: IPCDocumentPreviewSurfaceData, type: String, sessionId: String, surfaceId: String, title: String? = nil, actions: [IPCSurfaceAction]? = nil, display: String? = nil, messageId: String? = nil) {
        self.surfaceType = surfaceType
        self.data = data
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.title = title
        self.actions = actions
        self.display = display
        self.messageId = messageId
    }
}

public struct IPCUiSurfaceShowDynamicPage: Codable, Sendable {
    public let surfaceType: String
    public let data: IPCDynamicPageSurfaceData
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String?
    public let actions: [IPCSurfaceAction]?
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?

    public init(surfaceType: String, data: IPCDynamicPageSurfaceData, type: String, sessionId: String, surfaceId: String, title: String? = nil, actions: [IPCSurfaceAction]? = nil, display: String? = nil, messageId: String? = nil) {
        self.surfaceType = surfaceType
        self.data = data
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.title = title
        self.actions = actions
        self.display = display
        self.messageId = messageId
    }
}

public struct IPCUiSurfaceShowFileUpload: Codable, Sendable {
    public let surfaceType: String
    public let data: IPCFileUploadSurfaceData
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String?
    public let actions: [IPCSurfaceAction]?
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?

    public init(surfaceType: String, data: IPCFileUploadSurfaceData, type: String, sessionId: String, surfaceId: String, title: String? = nil, actions: [IPCSurfaceAction]? = nil, display: String? = nil, messageId: String? = nil) {
        self.surfaceType = surfaceType
        self.data = data
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.title = title
        self.actions = actions
        self.display = display
        self.messageId = messageId
    }
}

public struct IPCUiSurfaceShowForm: Codable, Sendable {
    public let surfaceType: String
    public let data: IPCFormSurfaceData
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String?
    public let actions: [IPCSurfaceAction]?
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?

    public init(surfaceType: String, data: IPCFormSurfaceData, type: String, sessionId: String, surfaceId: String, title: String? = nil, actions: [IPCSurfaceAction]? = nil, display: String? = nil, messageId: String? = nil) {
        self.surfaceType = surfaceType
        self.data = data
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.title = title
        self.actions = actions
        self.display = display
        self.messageId = messageId
    }
}

public struct IPCUiSurfaceShowList: Codable, Sendable {
    public let surfaceType: String
    public let data: IPCListSurfaceData
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String?
    public let actions: [IPCSurfaceAction]?
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?

    public init(surfaceType: String, data: IPCListSurfaceData, type: String, sessionId: String, surfaceId: String, title: String? = nil, actions: [IPCSurfaceAction]? = nil, display: String? = nil, messageId: String? = nil) {
        self.surfaceType = surfaceType
        self.data = data
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.title = title
        self.actions = actions
        self.display = display
        self.messageId = messageId
    }
}

public struct IPCUiSurfaceShowTable: Codable, Sendable {
    public let surfaceType: String
    public let data: IPCTableSurfaceData
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String?
    public let actions: [IPCSurfaceAction]?
    public let display: String?
    /// The message ID that this surface belongs to (for history loading).
    public let messageId: String?

    public init(surfaceType: String, data: IPCTableSurfaceData, type: String, sessionId: String, surfaceId: String, title: String? = nil, actions: [IPCSurfaceAction]? = nil, display: String? = nil, messageId: String? = nil) {
        self.surfaceType = surfaceType
        self.data = data
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.title = title
        self.actions = actions
        self.display = display
        self.messageId = messageId
    }
}

public struct IPCUiSurfaceUndoRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String

    public init(type: String, sessionId: String, surfaceId: String) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
    }
}

public struct IPCUiSurfaceUndoResult: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let success: Bool
    /// Number of remaining undo entries after this undo.
    public let remainingUndos: Int

    public init(type: String, sessionId: String, surfaceId: String, success: Bool, remainingUndos: Int) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.success = success
        self.remainingUndos = remainingUndos
    }
}

public struct IPCUiSurfaceUpdate: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let data: [String: AnyCodable]

    public init(type: String, sessionId: String, surfaceId: String, data: [String: AnyCodable]) {
        self.type = type
        self.sessionId = sessionId
        self.surfaceId = surfaceId
        self.data = data
    }
}

public struct IPCUndoComplete: Codable, Sendable {
    public let type: String
    public let removedCount: Int
    public let sessionId: String?

    public init(type: String, removedCount: Int, sessionId: String? = nil) {
        self.type = type
        self.removedCount = removedCount
        self.sessionId = sessionId
    }
}

public struct IPCUndoRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String

    public init(type: String, sessionId: String) {
        self.type = type
        self.sessionId = sessionId
    }
}

public struct IPCUnpublishPageRequest: Codable, Sendable {
    public let type: String
    public let deploymentId: String

    public init(type: String, deploymentId: String) {
        self.type = type
        self.deploymentId = deploymentId
    }
}

public struct IPCUnpublishPageResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?

    public init(type: String, success: Bool, error: String? = nil) {
        self.type = type
        self.success = success
        self.error = error
    }
}

public struct IPCUpdateTrustRule: Codable, Sendable {
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

public struct IPCUsageRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String

    public init(type: String, sessionId: String) {
        self.type = type
        self.sessionId = sessionId
    }
}

public struct IPCUsageResponse: Codable, Sendable {
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

public struct IPCUsageStats: Codable, Sendable {
    public let inputTokens: Int
    public let outputTokens: Int
    public let estimatedCost: Double

    public init(inputTokens: Int, outputTokens: Int, estimatedCost: Double) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.estimatedCost = estimatedCost
    }
}

public struct IPCUsageUpdate: Codable, Sendable {
    public let type: String
    public let inputTokens: Int
    public let outputTokens: Int
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let estimatedCost: Double
    public let model: String

    public init(type: String, inputTokens: Int, outputTokens: Int, totalInputTokens: Int, totalOutputTokens: Int, estimatedCost: Double, model: String) {
        self.type = type
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.estimatedCost = estimatedCost
        self.model = model
    }
}

public struct IPCUserMessage: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let content: String?
    public let attachments: [IPCUserMessageAttachment]?
    public let activeSurfaceId: String?
    /// The page currently displayed in the WebView (e.g. "settings.html").
    public let currentPage: String?
    /// When true, skip the secret-ingress check. Set by the client when the user clicks "Send Anyway".
    public let bypassSecretCheck: Bool?

    public init(type: String, sessionId: String, content: String? = nil, attachments: [IPCUserMessageAttachment]? = nil, activeSurfaceId: String? = nil, currentPage: String? = nil, bypassSecretCheck: Bool? = nil) {
        self.type = type
        self.sessionId = sessionId
        self.content = content
        self.attachments = attachments
        self.activeSurfaceId = activeSurfaceId
        self.currentPage = currentPage
        self.bypassSecretCheck = bypassSecretCheck
    }
}

public struct IPCUserMessageAttachment: Codable, Sendable {
    public let id: String?
    public let filename: String
    public let mimeType: String
    public let data: String
    public let extractedText: String?
    /// Original file size in bytes. Present when data was omitted from history_response to reduce payload size.
    public let sizeBytes: Int?
    /// Base64-encoded JPEG thumbnail. Generated server-side for video attachments.
    public let thumbnailData: String?

    public init(id: String? = nil, filename: String, mimeType: String, data: String, extractedText: String? = nil, sizeBytes: Int? = nil, thumbnailData: String? = nil) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.data = data
        self.extractedText = extractedText
        self.sizeBytes = sizeBytes
        self.thumbnailData = thumbnailData
    }
}

public struct IPCUserMessageEcho: Codable, Sendable {
    public let type: String
    public let text: String
    public let sessionId: String?

    public init(type: String, text: String, sessionId: String? = nil) {
        self.type = type
        self.text = text
        self.sessionId = sessionId
    }
}

public struct IPCVercelApiConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let apiToken: String?

    public init(type: String, action: String, apiToken: String? = nil) {
        self.type = type
        self.action = action
        self.apiToken = apiToken
    }
}

public struct IPCVercelApiConfigResponse: Codable, Sendable {
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

public struct IPCWatchCompleteRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let watchId: String

    public init(type: String, sessionId: String, watchId: String) {
        self.type = type
        self.sessionId = sessionId
        self.watchId = watchId
    }
}

public struct IPCWatcherEscalation: Codable, Sendable {
    public let type: String
    public let title: String
    public let body: String

    public init(type: String, title: String, body: String) {
        self.type = type
        self.title = title
        self.body = body
    }
}

public struct IPCWatcherNotification: Codable, Sendable {
    public let type: String
    public let title: String
    public let body: String

    public init(type: String, title: String, body: String) {
        self.type = type
        self.title = title
        self.body = body
    }
}

public struct IPCWatchObservation: Codable, Sendable {
    public let type: String
    public let watchId: String
    public let sessionId: String
    public let ocrText: String
    public let appName: String?
    public let windowTitle: String?
    public let bundleIdentifier: String?
    public let timestamp: Double
    public let captureIndex: Int
    public let totalExpected: Int

    public init(type: String, watchId: String, sessionId: String, ocrText: String, appName: String? = nil, windowTitle: String? = nil, bundleIdentifier: String? = nil, timestamp: Double, captureIndex: Int, totalExpected: Int) {
        self.type = type
        self.watchId = watchId
        self.sessionId = sessionId
        self.ocrText = ocrText
        self.appName = appName
        self.windowTitle = windowTitle
        self.bundleIdentifier = bundleIdentifier
        self.timestamp = timestamp
        self.captureIndex = captureIndex
        self.totalExpected = totalExpected
    }
}

public struct IPCWatchStarted: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let watchId: String
    public let durationSeconds: Double
    public let intervalSeconds: Double

    public init(type: String, sessionId: String, watchId: String, durationSeconds: Double, intervalSeconds: Double) {
        self.type = type
        self.sessionId = sessionId
        self.watchId = watchId
        self.durationSeconds = durationSeconds
        self.intervalSeconds = intervalSeconds
    }
}

public struct IPCWorkItemApprovePermissionsRequest: Codable, Sendable {
    public let type: String
    public let id: String
    public let approvedTools: [String]

    public init(type: String, id: String, approvedTools: [String]) {
        self.type = type
        self.id = id
        self.approvedTools = approvedTools
    }
}

public struct IPCWorkItemApprovePermissionsResponse: Codable, Sendable {
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

public struct IPCWorkItemCancelRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCWorkItemCancelResponse: Codable, Sendable {
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

public struct IPCWorkItemCompleteRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCWorkItemDeleteRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCWorkItemDeleteResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool

    public init(type: String, id: String, success: Bool) {
        self.type = type
        self.id = id
        self.success = success
    }
}

public struct IPCWorkItemGetRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCWorkItemGetResponse: Codable, Sendable {
    public let type: String
    public let item: IPCWorkItemGetResponseItem?

    public init(type: String, item: IPCWorkItemGetResponseItem?) {
        self.type = type
        self.item = item
    }
}

public struct IPCWorkItemGetResponseItem: Codable, Sendable {
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

public struct IPCWorkItemOutputRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCWorkItemOutputResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
    public let error: String?
    public let output: IPCWorkItemOutputResponseOutput?

    public init(type: String, id: String, success: Bool, error: String? = nil, output: IPCWorkItemOutputResponseOutput? = nil) {
        self.type = type
        self.id = id
        self.success = success
        self.error = error
        self.output = output
    }
}

public struct IPCWorkItemOutputResponseOutput: Codable, Sendable {
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

public struct IPCWorkItemPreflightRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCWorkItemPreflightResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
    public let error: String?
    public let permissions: [IPCWorkItemPreflightResponsePermission]?

    public init(type: String, id: String, success: Bool, error: String? = nil, permissions: [IPCWorkItemPreflightResponsePermission]? = nil) {
        self.type = type
        self.id = id
        self.success = success
        self.error = error
        self.permissions = permissions
    }
}

public struct IPCWorkItemPreflightResponsePermission: Codable, Sendable {
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

public struct IPCWorkItemRunTaskRequest: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct IPCWorkItemRunTaskResponse: Codable, Sendable {
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

public struct IPCWorkItemsListRequest: Codable, Sendable {
    public let type: String
    public let status: String?

    public init(type: String, status: String? = nil) {
        self.type = type
        self.status = status
    }
}

public struct IPCWorkItemsListResponse: Codable, Sendable {
    public let type: String
    public let items: [IPCWorkItemsListResponseItem]

    public init(type: String, items: [IPCWorkItemsListResponseItem]) {
        self.type = type
        self.items = items
    }
}

public struct IPCWorkItemsListResponseItem: Codable, Sendable {
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
public struct IPCWorkItemStatusChanged: Codable, Sendable {
    public let type: String
    public let item: IPCWorkItemStatusChangedItem

    public init(type: String, item: IPCWorkItemStatusChangedItem) {
        self.type = type
        self.item = item
    }
}

public struct IPCWorkItemStatusChangedItem: Codable, Sendable {
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

public struct IPCWorkItemUpdateRequest: Codable, Sendable {
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

public struct IPCWorkItemUpdateResponse: Codable, Sendable {
    public let type: String
    public let item: IPCWorkItemUpdateResponseItem?

    public init(type: String, item: IPCWorkItemUpdateResponseItem?) {
        self.type = type
        self.item = item
    }
}

public struct IPCWorkItemUpdateResponseItem: Codable, Sendable {
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

public struct IPCWorkspaceFileReadRequest: Codable, Sendable {
    public let type: String
    /// Relative path within the workspace directory (e.g. "IDENTITY.md").
    public let path: String

    public init(type: String, path: String) {
        self.type = type
        self.path = path
    }
}

public struct IPCWorkspaceFileReadResponse: Codable, Sendable {
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

public struct IPCWorkspaceFilesListRequest: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct IPCWorkspaceFilesListResponse: Codable, Sendable {
    public let type: String
    public let files: [IPCWorkspaceFilesListResponseFile]

    public init(type: String, files: [IPCWorkspaceFilesListResponseFile]) {
        self.type = type
        self.files = files
    }
}

public struct IPCWorkspaceFilesListResponseFile: Codable, Sendable {
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
