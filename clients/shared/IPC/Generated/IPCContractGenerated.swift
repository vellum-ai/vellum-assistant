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
}

public struct IPCAcceptStarterBundleResponse: Codable, Sendable {
    public let type: String
    public let accepted: Bool
    public let rulesAdded: Double
    public let alreadyAccepted: Bool
}

public struct IPCAddTrustRule: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let pattern: String
    public let scope: String
    public let decision: String
}

public struct IPCAgentHeartbeatAlert: Codable, Sendable {
    public let type: String
    public let title: String
    public let body: String
}

public struct IPCAppDataRequest: Codable, Sendable {
    public let type: String
    public let surfaceId: String
    public let callId: String
    public let method: String
    public let appId: String
    public let recordId: String?
    public let data: [String: AnyCodable]?
}

public struct IPCAppDataResponse: Codable, Sendable {
    public let type: String
    public let surfaceId: String
    public let callId: String
    public let success: Bool
    public let result: AnyCodable?
    public let error: String?
}

public struct IPCAppFilesChanged: Codable, Sendable {
    public let type: String
    public let appId: String
}

public struct IPCAppOpenRequest: Codable, Sendable {
    public let type: String
    public let appId: String
}

public struct IPCAppPreviewRequest: Codable, Sendable {
    public let type: String
    public let appId: String
}

public struct IPCAppPreviewResponse: Codable, Sendable {
    public let type: String
    public let appId: String
    public let preview: String?
}

public struct IPCAppsListRequest: Codable, Sendable {
    public let type: String
}

public struct IPCAppsListResponse: Codable, Sendable {
    public let type: String
    public let apps: [IPCAppsListResponseApp]
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
}

public struct IPCAppUpdatePreviewRequest: Codable, Sendable {
    public let type: String
    public let appId: String
    /// Base64-encoded PNG screenshot thumbnail.
    public let preview: String
}

public struct IPCAppUpdatePreviewResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let appId: String
}

public struct IPCAssistantTextDelta: Codable, Sendable {
    public let type: String
    public let text: String
    public let sessionId: String?
}

public struct IPCAssistantThinkingDelta: Codable, Sendable {
    public let type: String
    public let thinking: String
}

public struct IPCAuthMessage: Codable, Sendable {
    public let type: String
    public let token: String
}

public struct IPCAuthResult: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let message: String?
}

public struct IPCBrowserCDPRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
}

public struct IPCBrowserCDPResponse: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let success: Bool
    public let declined: Bool?
}

public struct IPCBrowserFrame: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let frame: String
    public let metadata: IPCBrowserFrameMetadata?
}

public struct IPCBrowserFrameMetadata: Codable, Sendable {
    public let offsetTop: Double
    public let pageScaleFactor: Double
    public let scrollOffsetX: Double
    public let scrollOffsetY: Double
    public let timestamp: Double
}

public struct IPCBrowserHandoffRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let reason: String
    public let message: String
    public let bringToFront: Bool?
}

public struct IPCBrowserInteractiveMode: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let enabled: Bool
}

public struct IPCBrowserInteractiveModeChanged: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let enabled: Bool
    public let reason: String?
    public let message: String?
}

public struct IPCBrowserUserClick: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let x: Double
    public let y: Double
    public let button: String?
    public let doubleClick: Bool?
}

public struct IPCBrowserUserKeypress: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let key: String
    public let modifiers: [String]?
}

public struct IPCBrowserUserScroll: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let deltaX: Double
    public let deltaY: Double
    public let x: Double
    public let y: Double
}

public struct IPCBrowserViewSurfaceData: Codable, Sendable {
    public let sessionId: String
    public let currentUrl: String
    public let status: String
    public let frame: String?
    public let actionText: String?
    public let highlights: [IPCBrowserViewSurfaceDataHighlight]?
    public let pages: [IPCBrowserViewSurfaceDataPage]?
}

public struct IPCBrowserViewSurfaceDataHighlight: Codable, Sendable {
    public let x: Double
    public let y: Double
    public let w: Double
    public let h: Double
    public let label: String
}

public struct IPCBrowserViewSurfaceDataPage: Codable, Sendable {
    public let id: String
    public let title: String
    public let url: String
    public let active: Bool
}

public struct IPCBundleAppRequest: Codable, Sendable {
    public let type: String
    public let appId: String
}

public struct IPCBundleAppResponse: Codable, Sendable {
    public let type: String
    public let bundlePath: String
    public let manifest: IPCBundleAppResponseManifest
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
}

public struct IPCCancelRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String?
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
}

public struct IPCCardSurfaceDataMetadata: Codable, Sendable {
    public let label: String
    public let value: String
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
    /// Principal kind that initiated this tool use (e.g. 'core' or 'skill').
    public let principalKind: String?
    /// Skill ID when principalKind is 'skill'.
    public let principalId: String?
    /// Content-hash of the skill source for version tracking.
    public let principalVersion: String?
    /// When false, the client should hide "always allow" / trust-rule persistence affordances.
    public let persistentDecisionsAllowed: Bool?
}

public struct IPCConfirmationRequestAllowlistOption: Codable, Sendable {
    public let label: String
    public let description: String
    public let pattern: String
}

public struct IPCConfirmationRequestDiff: Codable, Sendable {
    public let filePath: String
    public let oldContent: String
    public let newContent: String
    public let isNewFile: Bool
}

public struct IPCConfirmationRequestScopeOption: Codable, Sendable {
    public let label: String
    public let scope: String
}

public struct IPCConfirmationResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let decision: String
    public let selectedPattern: String?
    public let selectedScope: String?
}

public struct IPCConfirmationSurfaceData: Codable, Sendable {
    public let message: String
    public let detail: String?
    public let confirmLabel: String?
    public let cancelLabel: String?
    public let destructive: Bool?
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
}

public struct IPCCuAction: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let reasoning: String?
    public let stepNumber: Int
}

public struct IPCCuComplete: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let summary: String
    public let stepCount: Int
    public let isResponse: Bool?
}

public struct IPCCuError: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let message: String
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
}

public struct IPCCuSessionAbort: Codable, Sendable {
    public let type: String
    public let sessionId: String
}

public struct IPCCuSessionCreate: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let task: String
    public let screenWidth: Int
    public let screenHeight: Int
    public let attachments: [IPCUserMessageAttachment]?
    public let interactionType: String?
}

public struct IPCDaemonStatusMessage: Codable, Sendable {
    public let type: String
    public let httpPort: Double?
    public let version: String?
}

public struct IPCDeleteQueuedMessage: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String
}

public struct IPCDiagnosticsExportRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let anchorMessageId: String?
}

public struct IPCDiagnosticsExportResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let filePath: String?
    public let error: String?
}

public struct IPCDocumentEditorShow: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let title: String
    public let initialContent: String
}

public struct IPCDocumentEditorUpdate: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let markdown: String
    public let mode: String
}

public struct IPCDocumentListRequest: Codable, Sendable {
    public let type: String
    public let conversationId: String?
}

public struct IPCDocumentListResponse: Codable, Sendable {
    public let type: String
    public let documents: [IPCDocumentListResponseDocument]
}

public struct IPCDocumentListResponseDocument: Codable, Sendable {
    public let surfaceId: String
    public let conversationId: String
    public let title: String
    public let wordCount: Int
    public let createdAt: Int
    public let updatedAt: Int
}

public struct IPCDocumentLoadRequest: Codable, Sendable {
    public let type: String
    public let surfaceId: String
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
}

public struct IPCDocumentPreviewSurfaceData: Codable, Sendable {
    public let title: String
    public let surfaceId: String
    public let subtitle: String?
}

public struct IPCDocumentSaveRequest: Codable, Sendable {
    public let type: String
    public let surfaceId: String
    public let conversationId: String
    public let title: String
    public let content: String
    public let wordCount: Int
}

public struct IPCDocumentSaveResponse: Codable, Sendable {
    public let type: String
    public let surfaceId: String
    public let success: Bool
    public let error: String?
}

public struct IPCDynamicPagePreview: Codable, Sendable {
    public let title: String
    public let subtitle: String?
    public let description: String?
    public let icon: String?
    public let metrics: [IPCDynamicPagePreviewMetric]?
}

public struct IPCDynamicPagePreviewMetric: Codable, Sendable {
    public let label: String
    public let value: String
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
}

public struct IPCEnvVarsRequest: Codable, Sendable {
    public let type: String
}

public struct IPCEnvVarsResponse: Codable, Sendable {
    public let type: String
    public let vars: [String: String]
}

public struct IPCErrorMessage: Codable, Sendable {
    public let type: String
    public let message: String
    /// Categorizes the error so the client can offer contextual actions (e.g. "Send Anyway" for secret_blocked).
    public let category: String?
}

public struct IPCFileUploadSurfaceData: Codable, Sendable {
    public let prompt: String
    public let acceptedTypes: [String]?
    public let maxFiles: Int?
    public let maxSizeBytes: Int?
}

public struct IPCForkSharedAppRequest: Codable, Sendable {
    public let type: String
    public let uuid: String
}

public struct IPCForkSharedAppResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let appId: String?
    public let name: String?
    public let error: String?
}

public struct IPCFormField: Codable, Sendable {
    public let id: String
    public let type: String
    public let label: String
    public let placeholder: String?
    public let required: Bool?
    public let defaultValue: AnyCodable?
    public let options: [IPCFormFieldOption]?
}

public struct IPCFormFieldOption: Codable, Sendable {
    public let label: String
    public let value: String
}

public struct IPCFormPage: Codable, Sendable {
    public let id: String
    public let title: String
    public let description: String?
    public let fields: [IPCFormField]
}

public struct IPCFormSurfaceData: Codable, Sendable {
    public let description: String?
    public let fields: [IPCFormField]
    public let submitLabel: String?
    public let pages: [IPCFormPage]?
    public let pageLabels: IPCFormSurfaceDataPageLabels?
}

public struct IPCFormSurfaceDataPageLabels: Codable, Sendable {
    public let next: String?
    public let back: String?
    public let submit: String?
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
}

public struct IPCGalleryCategory: Codable, Sendable {
    public let id: String
    public let name: String
    public let icon: String
}

public struct IPCGalleryInstallRequest: Codable, Sendable {
    public let type: String
    public let galleryAppId: String
}

public struct IPCGalleryInstallResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let appId: String?
    public let name: String?
    public let error: String?
}

public struct IPCGalleryListRequest: Codable, Sendable {
    public let type: String
}

public struct IPCGalleryListResponse: Codable, Sendable {
    public let type: String
    public let gallery: IPCGalleryManifest
}

public struct IPCGalleryManifest: Codable, Sendable {
    public let version: Double
    public let updatedAt: String
    public let categories: [IPCGalleryCategory]
    public let apps: [IPCGalleryApp]
}

public struct IPCGenerationCancelled: Codable, Sendable {
    public let type: String
    public let sessionId: String?
}

public struct IPCGenerationHandoff: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String?
    public let queuedCount: Int
    public let attachments: [IPCUserMessageAttachment]?
}

public struct IPCGetSigningIdentityRequest: Codable, Sendable {
    public let type: String
    public let requestId: String
}

public struct IPCGetSigningIdentityResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let keyId: String?
    public let publicKey: String?
    public let error: String?
}

public struct IPCHistoryRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
}

public struct IPCHistoryResponse: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let messages: [IPCHistoryResponseMessage]
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
}

public struct IPCHistoryResponseMessageSubagentNotification: Codable, Sendable {
    public let subagentId: String
    public let label: String
    public let status: String
    public let error: String?
    public let conversationId: String?
    /// Subagent objective text, populated from DB on history load.
    public let objective: String?
    /// Subagent events (text, tool_use, tool_result), populated from DB on history load.
    public let events: [IPCHistoryResponseMessageSubagentNotificationEvent]?
}

public struct IPCHistoryResponseMessageSubagentNotificationEvent: Codable, Sendable {
    public let type: String
    public let content: String
    public let toolName: String?
    public let isError: Bool?
}

public struct IPCHistoryResponseSurface: Codable, Sendable {
    public let surfaceId: String
    public let surfaceType: String
    public let title: String?
    public let data: [String: AnyCodable]
    public let actions: [IPCHistoryResponseSurfaceAction]?
    public let display: String?
}

public struct IPCHistoryResponseSurfaceAction: Codable, Sendable {
    public let id: String
    public let label: String
    public let style: String?
}

public struct IPCHistoryResponseToolCall: Codable, Sendable {
    public let name: String
    public let input: [String: AnyCodable]
    public let result: String?
    public let isError: Bool?
    /// Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot).
    public let imageData: String?
}

public struct IPCHomeBaseGetRequest: Codable, Sendable {
    public let type: String
    /// If true, daemon ensures a durable Home Base link exists before responding.
    public let ensureLinked: Bool?
}

public struct IPCHomeBaseGetResponse: Codable, Sendable {
    public let type: String
    public let homeBase: IPCHomeBaseGetResponseHomeBase?
}

public struct IPCHomeBaseGetResponseHomeBase: Codable, Sendable {
    public let appId: String
    public let source: String
    public let starterTasks: [String]
    public let onboardingTasks: [String]
    public let preview: IPCHomeBaseGetResponseHomeBasePreview
}

public struct IPCHomeBaseGetResponseHomeBasePreview: Codable, Sendable {
    public let title: String
    public let subtitle: String
    public let description: String
    public let icon: String
    public let metrics: [IPCHomeBaseGetResponseHomeBasePreviewMetric]
}

public struct IPCHomeBaseGetResponseHomeBasePreviewMetric: Codable, Sendable {
    public let label: String
    public let value: String
}

public struct IPCImageGenModelSetRequest: Codable, Sendable {
    public let type: String
    public let model: String
}

public struct IPCIngressConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let publicBaseUrl: String?
}

public struct IPCIngressConfigResponse: Codable, Sendable {
    public let type: String
    public let publicBaseUrl: String
    /// Read-only gateway target computed from GATEWAY_PORT env var (default 7830) + loopback host.
    public let localGatewayTarget: String
    public let success: Bool
    public let error: String?
}

public struct IPCIntegrationConnectRequest: Codable, Sendable {
    public let type: String
    public let integrationId: String
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
}

public struct IPCIntegrationDisconnectRequest: Codable, Sendable {
    public let type: String
    public let integrationId: String
}

public struct IPCIntegrationListRequest: Codable, Sendable {
    public let type: String
}

public struct IPCIntegrationListResponse: Codable, Sendable {
    public let type: String
    public let integrations: [IPCIntegrationListResponseIntegration]
}

public struct IPCIntegrationListResponseIntegration: Codable, Sendable {
    public let id: String
    public let connected: Bool
    public let accountInfo: String?
    public let connectedAt: Int?
    public let lastUsed: Double?
    public let error: String?
}

public struct IPCIpcBlobProbe: Codable, Sendable {
    public let type: String
    public let probeId: String
    public let nonceSha256: String
}

public struct IPCIpcBlobProbeResult: Codable, Sendable {
    public let type: String
    public let probeId: String
    public let ok: Bool
    public let observedNonceSha256: String?
    public let reason: String?
}

public struct IPCIpcBlobRef: Codable, Sendable {
    public let id: String
    public let kind: String
    public let encoding: String
    public let byteLength: Int
    public let sha256: String?
}

public struct IPCLinkOpenRequest: Codable, Sendable {
    public let type: String
    public let url: String
    public let metadata: [String: AnyCodable]?
}

public struct IPCListItem: Codable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String?
    public let icon: String?
    public let selected: Bool?
}

public struct IPCListSurfaceData: Codable, Sendable {
    public let items: [IPCListItem]
    public let selectionMode: String
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
}

public struct IPCMemoryRecalledCandidateDebug: Codable, Sendable {
    public let key: String
    public let type: String
    public let kind: String
    public let finalScore: Double
    public let lexical: Double
    public let semantic: Double
    public let recency: Double
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
}

public struct IPCMessageComplete: Codable, Sendable {
    public let type: String
    public let sessionId: String?
    public let attachments: [IPCUserMessageAttachment]?
}

public struct IPCMessageDequeued: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String
}

public struct IPCMessageQueued: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String
    public let position: Int
}

public struct IPCMessageQueuedDeleted: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String
}

public struct IPCModelGetRequest: Codable, Sendable {
    public let type: String
}

public struct IPCModelInfo: Codable, Sendable {
    public let type: String
    public let model: String
    public let provider: String
    public let configuredProviders: [String]?
}

public struct IPCModelSetRequest: Codable, Sendable {
    public let type: String
    public let model: String
}

public struct IPCOpenBundleRequest: Codable, Sendable {
    public let type: String
    public let filePath: String
}

public struct IPCOpenBundleResponse: Codable, Sendable {
    public let type: String
    public let manifest: IPCOpenBundleResponseManifest
    public let scanResult: IPCOpenBundleResponseScanResult
    public let signatureResult: IPCOpenBundleResponseSignatureResult
    public let bundleSizeBytes: Int
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
}

public struct IPCOpenBundleResponseScanResult: Codable, Sendable {
    public let passed: Bool
    public let blocked: [String]
    public let warnings: [String]
}

public struct IPCOpenBundleResponseSignatureResult: Codable, Sendable {
    public let trustTier: String
    public let signerKeyId: String?
    public let signerDisplayName: String?
    public let signerAccount: String?
}

/// Server push — tells the client to open/focus the tasks window.
public struct IPCOpenTasksWindow: Codable, Sendable {
    public let type: String
}

public struct IPCOpenUrl: Codable, Sendable {
    public let type: String
    public let url: String
    public let title: String?
}

public struct IPCPingMessage: Codable, Sendable {
    public let type: String
}

public struct IPCPongMessage: Codable, Sendable {
    public let type: String
}

public struct IPCPublishPageRequest: Codable, Sendable {
    public let type: String
    public let html: String
    public let title: String?
    public let appId: String?
}

public struct IPCPublishPageResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let publicUrl: String?
    public let deploymentId: String?
    public let error: String?
}

public struct IPCRegenerateRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
}

public struct IPCReminderCancel: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCReminderFired: Codable, Sendable {
    public let type: String
    public let reminderId: String
    public let label: String
    public let message: String
}

public struct IPCRemindersList: Codable, Sendable {
    public let type: String
}

public struct IPCRemindersListResponse: Codable, Sendable {
    public let type: String
    public let reminders: [IPCRemindersListResponseReminder]
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
}

public struct IPCRemoveTrustRule: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCRideShotgunResult: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let watchId: String
    public let summary: String
    public let observationCount: Int
    public let recordingId: String?
    public let recordingPath: String?
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
}

public struct IPCRideShotgunStop: Codable, Sendable {
    public let type: String
    public let watchId: String
}

public struct IPCSandboxSetRequest: Codable, Sendable {
    public let type: String
    public let enabled: Bool
}

public struct IPCScheduleComplete: Codable, Sendable {
    public let type: String
    public let scheduleId: String
    public let name: String
}

public struct IPCScheduleRemove: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCSchedulesList: Codable, Sendable {
    public let type: String
}

public struct IPCSchedulesListResponse: Codable, Sendable {
    public let type: String
    public let schedules: [IPCSchedulesListResponseSchedule]
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
}

public struct IPCScheduleToggle: Codable, Sendable {
    public let type: String
    public let id: String
    public let enabled: Bool
}

public struct IPCSecretDetected: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let matches: [IPCSecretDetectedMatch]
    public let action: String
}

public struct IPCSecretDetectedMatch: Codable, Sendable {
    public let type: String
    public let redactedValue: String
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
}

public struct IPCSecretResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let value: String?
    /// How the secret should be delivered: 'store' persists to keychain (default), 'transient_send' for one-time use without persisting.
    public let delivery: String?
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
}

public struct IPCSessionInfo: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let title: String
    public let correlationId: String?
    public let threadType: String?
}

public struct IPCSessionListRequest: Codable, Sendable {
    public let type: String
}

public struct IPCSessionListResponse: Codable, Sendable {
    public let type: String
    public let sessions: [IPCSessionListResponseSession]
}

public struct IPCSessionListResponseSession: Codable, Sendable {
    public let id: String
    public let title: String
    public let updatedAt: Int
    public let threadType: String?
}

public struct IPCSessionsClearRequest: Codable, Sendable {
    public let type: String
}

public struct IPCSessionsClearResponse: Codable, Sendable {
    public let type: String
    public let cleared: Int
}

public struct IPCSessionSwitchRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
}

/// Lightweight session transport metadata for channel identity and natural-language guidance.
public struct IPCSessionTransportMetadata: Codable, Sendable {
    /// Logical channel identifier (e.g. "desktop", "telegram", "mobile").
    public let channelId: String
    /// Optional natural-language hints for channel-specific UX behavior.
    public let hints: [String]?
    /// Optional concise UX brief for this channel.
    public let uxBrief: String?
}

public struct IPCShareAppCloudRequest: Codable, Sendable {
    public let type: String
    public let appId: String
}

public struct IPCShareAppCloudResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let shareToken: String?
    public let shareUrl: String?
    public let error: String?
}

public struct IPCSharedAppDeleteRequest: Codable, Sendable {
    public let type: String
    public let uuid: String
}

public struct IPCSharedAppDeleteResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
}

public struct IPCSharedAppsListRequest: Codable, Sendable {
    public let type: String
}

public struct IPCSharedAppsListResponse: Codable, Sendable {
    public let type: String
    public let apps: [IPCSharedAppsListResponseApp]
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
}

public struct IPCShareToSlackRequest: Codable, Sendable {
    public let type: String
    public let appId: String
}

public struct IPCShareToSlackResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?
}

public struct IPCSignBundlePayloadRequest: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let payload: String
}

public struct IPCSignBundlePayloadResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let signature: String?
    public let keyId: String?
    public let publicKey: String?
    public let error: String?
}

public struct IPCSkillDetailRequest: Codable, Sendable {
    public let type: String
    public let skillId: String
}

public struct IPCSkillDetailResponse: Codable, Sendable {
    public let type: String
    public let skillId: String
    public let body: String
    public let icon: String?
    public let error: String?
}

public struct IPCSkillsCheckUpdatesRequest: Codable, Sendable {
    public let type: String
}

public struct IPCSkillsConfigureRequest: Codable, Sendable {
    public let type: String
    public let name: String
    public let env: [String: String]?
    public let apiKey: String?
    public let config: [String: AnyCodable]?
}

public struct IPCSkillsDisableRequest: Codable, Sendable {
    public let type: String
    public let name: String
}

public struct IPCSkillsEnableRequest: Codable, Sendable {
    public let type: String
    public let name: String
}

public struct IPCSkillsInspectRequest: Codable, Sendable {
    public let type: String
    public let slug: String
}

public struct IPCSkillsInspectResponse: Codable, Sendable {
    public let type: String
    public let slug: String
    public let data: IPCSkillsInspectResponseData?
    public let error: String?
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
}

public struct IPCSkillsInspectResponseDataFile: Codable, Sendable {
    public let path: String
    public let size: Int
    public let contentType: String?
}

public struct IPCSkillsInspectResponseDataLatestVersion: Codable, Sendable {
    public let version: String
    public let changelog: String?
}

public struct IPCSkillsInspectResponseDataOwner: Codable, Sendable {
    public let handle: String
    public let displayName: String
    public let image: String?
}

public struct IPCSkillsInspectResponseDataSkill: Codable, Sendable {
    public let slug: String
    public let displayName: String
    public let summary: String
}

public struct IPCSkillsInspectResponseDataStats: Codable, Sendable {
    public let stars: Int
    public let installs: Int
    public let downloads: Int
    public let versions: Int
}

public struct IPCSkillsInstallRequest: Codable, Sendable {
    public let type: String
    public let slug: String
    public let version: String?
}

public struct IPCSkillsListRequest: Codable, Sendable {
    public let type: String
}

public struct IPCSkillsListResponse: Codable, Sendable {
    public let type: String
    public let skills: [IPCSkillsListResponseSkill]
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
}

public struct IPCSkillsListResponseSkillClawhub: Codable, Sendable {
    public let author: String
    public let stars: Int
    public let installs: Int
    public let reports: Int
    public let publishedAt: String
}

public struct IPCSkillsListResponseSkillMissingRequirements: Codable, Sendable {
    public let bins: [String]?
    public let env: [String]?
    public let permissions: [String]?
}

public struct IPCSkillsOperationResponse: Codable, Sendable {
    public let type: String
    public let operation: String
    public let success: Bool
    public let error: String?
    public let data: AnyCodable?
}

public struct IPCSkillsSearchRequest: Codable, Sendable {
    public let type: String
    public let query: String
}

public struct IPCSkillStateChanged: Codable, Sendable {
    public let type: String
    public let name: String
    public let state: String
}

public struct IPCSkillsUninstallRequest: Codable, Sendable {
    public let type: String
    public let name: String
}

public struct IPCSkillsUpdateRequest: Codable, Sendable {
    public let type: String
    public let name: String
}

public struct IPCSlackWebhookConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let webhookUrl: String?
}

public struct IPCSlackWebhookConfigResponse: Codable, Sendable {
    public let type: String
    public let webhookUrl: String?
    public let success: Bool
    public let error: String?
}

public struct IPCSubagentAbortRequest: Codable, Sendable {
    public let type: String
    public let subagentId: String
}

public struct IPCSubagentMessageRequest: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let content: String
}

public struct IPCSubagentSpawned: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let parentSessionId: String
    public let label: String
    public let objective: String
}

public struct IPCSubagentStatusChanged: Codable, Sendable {
    public let type: String
    public let subagentId: String
    public let status: String
    public let error: String?
    public let usage: IPCUsageStats?
}

public struct IPCSubagentStatusRequest: Codable, Sendable {
    public let type: String
    /// If omitted, returns all subagents for the session.
    public let subagentId: String?
}

public struct IPCSuggestionRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let requestId: String
}

public struct IPCSuggestionResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let suggestion: String?
    public let source: String
}

public struct IPCSurfaceAction: Codable, Sendable {
    public let id: String
    public let label: String
    public let style: String?
}

public struct IPCTableColumn: Codable, Sendable {
    public let id: String
    public let label: String
    public let width: Int?
}

public struct IPCTableRow: Codable, Sendable {
    public let id: String
    public let cells: [String: String]
    public let selectable: Bool?
    public let selected: Bool?
}

public struct IPCTableSurfaceData: Codable, Sendable {
    public let columns: [IPCTableColumn]
    public let rows: [IPCTableRow]
    public let selectionMode: String?
    public let caption: String?
}

public struct IPCTaskRouted: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let interactionType: String
    /// The task text passed to the escalated session.
    public let task: String?
    /// Set when a text_qa session escalates to computer_use via computer_use_request_control.
    public let escalatedFrom: String?
}

/// Server push — broadcast when a task run creates a conversation, so the client can show it as a chat thread.
public struct IPCTaskRunThreadCreated: Codable, Sendable {
    public let type: String
    public let conversationId: String
    public let workItemId: String
    public let title: String
}

/// Server push — lightweight invalidation signal: the task queue has been mutated, refetch your list.
public struct IPCTasksChanged: Codable, Sendable {
    public let type: String
}

public struct IPCTaskSubmit: Codable, Sendable {
    public let type: String
    public let task: String
    public let screenWidth: Int
    public let screenHeight: Int
    public let attachments: [IPCUserMessageAttachment]?
    public let source: String?
}

public struct IPCToolInputDelta: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let content: String
    public let sessionId: String?
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
}

public struct IPCToolResultDiff: Codable, Sendable {
    public let filePath: String
    public let oldContent: String
    public let newContent: String
    public let isNewFile: Bool
}

public struct IPCToolUseStart: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let input: [String: AnyCodable]
    public let sessionId: String?
}

public struct IPCTrustRulesList: Codable, Sendable {
    public let type: String
}

public struct IPCTrustRulesListResponse: Codable, Sendable {
    public let type: String
    public let rules: [IPCTrustRulesListResponseRule]
}

public struct IPCTrustRulesListResponseRule: Codable, Sendable {
    public let id: String
    public let tool: String
    public let pattern: String
    public let scope: String
    public let decision: String
    public let priority: Int
    public let createdAt: Int
}

public struct IPCTwilioWebhookConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let webhookBaseUrl: String?
}

public struct IPCTwilioWebhookConfigResponse: Codable, Sendable {
    public let type: String
    public let webhookBaseUrl: String
    public let success: Bool
    public let error: String?
}

public struct IPCTwitterAuthResult: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let accountInfo: String?
    public let error: String?
}

public struct IPCTwitterAuthStartRequest: Codable, Sendable {
    public let type: String
}

public struct IPCTwitterAuthStatusRequest: Codable, Sendable {
    public let type: String
}

public struct IPCTwitterAuthStatusResponse: Codable, Sendable {
    public let type: String
    public let connected: Bool
    public let accountInfo: String?
    public let mode: String?
    public let error: String?
}

public struct IPCTwitterIntegrationConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let mode: String?
    public let clientId: String?
    public let clientSecret: String?
}

public struct IPCTwitterIntegrationConfigResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let mode: String?
    public let managedAvailable: Bool
    public let localClientConfigured: Bool
    public let connected: Bool
    public let accountInfo: String?
    public let error: String?
}

public struct IPCUiSurfaceAction: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let actionId: String
    public let data: [String: AnyCodable]?
}

public struct IPCUiSurfaceComplete: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let summary: String
    public let submittedData: [String: AnyCodable]?
}

public struct IPCUiSurfaceDismiss: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
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
}

public struct IPCUiSurfaceUndoRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
}

public struct IPCUiSurfaceUndoResult: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let success: Bool
    /// Number of remaining undo entries after this undo.
    public let remainingUndos: Int
}

public struct IPCUiSurfaceUpdate: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let data: [String: AnyCodable]
}

public struct IPCUndoComplete: Codable, Sendable {
    public let type: String
    public let removedCount: Int
    public let sessionId: String?
}

public struct IPCUndoRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
}

public struct IPCUnpublishPageRequest: Codable, Sendable {
    public let type: String
    public let deploymentId: String
}

public struct IPCUnpublishPageResponse: Codable, Sendable {
    public let type: String
    public let success: Bool
    public let error: String?
}

public struct IPCUpdateTrustRule: Codable, Sendable {
    public let type: String
    public let id: String
    public let tool: String?
    public let pattern: String?
    public let scope: String?
    public let decision: String?
    public let priority: Int?
}

public struct IPCUsageRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
}

public struct IPCUsageResponse: Codable, Sendable {
    public let type: String
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let estimatedCost: Double
    public let model: String
}

public struct IPCUsageStats: Codable, Sendable {
    public let inputTokens: Int
    public let outputTokens: Int
    public let estimatedCost: Double
}

public struct IPCUsageUpdate: Codable, Sendable {
    public let type: String
    public let inputTokens: Int
    public let outputTokens: Int
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let estimatedCost: Double
    public let model: String
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
}

public struct IPCUserMessageEcho: Codable, Sendable {
    public let type: String
    public let text: String
    public let sessionId: String?
}

public struct IPCVercelApiConfigRequest: Codable, Sendable {
    public let type: String
    public let action: String
    public let apiToken: String?
}

public struct IPCVercelApiConfigResponse: Codable, Sendable {
    public let type: String
    public let hasToken: Bool
    public let success: Bool
    public let error: String?
}

public struct IPCWatchCompleteRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let watchId: String
}

public struct IPCWatcherEscalation: Codable, Sendable {
    public let type: String
    public let title: String
    public let body: String
}

public struct IPCWatcherNotification: Codable, Sendable {
    public let type: String
    public let title: String
    public let body: String
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
}

public struct IPCWatchStarted: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let watchId: String
    public let durationSeconds: Double
    public let intervalSeconds: Double
}

public struct IPCWorkItemApprovePermissionsRequest: Codable, Sendable {
    public let type: String
    public let id: String
    public let approvedTools: [String]
}

public struct IPCWorkItemApprovePermissionsResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
    public let error: String?
}

public struct IPCWorkItemCancelRequest: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCWorkItemCancelResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
    public let error: String?
}

public struct IPCWorkItemCompleteRequest: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCWorkItemDeleteRequest: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCWorkItemDeleteResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
}

public struct IPCWorkItemGetRequest: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCWorkItemGetResponse: Codable, Sendable {
    public let type: String
    public let item: IPCWorkItemGetResponseItem?
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
}

public struct IPCWorkItemOutputRequest: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCWorkItemOutputResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
    public let error: String?
    public let output: IPCWorkItemOutputResponseOutput?
}

public struct IPCWorkItemOutputResponseOutput: Codable, Sendable {
    public let title: String
    public let status: String
    public let runId: String?
    public let conversationId: String?
    public let completedAt: Int?
    public let summary: String
    public let highlights: [String]
}

public struct IPCWorkItemPreflightRequest: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCWorkItemPreflightResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let success: Bool
    public let error: String?
    public let permissions: [IPCWorkItemPreflightResponsePermission]?
}

public struct IPCWorkItemPreflightResponsePermission: Codable, Sendable {
    public let tool: String
    public let description: String
    public let riskLevel: String
    public let currentDecision: String
}

public struct IPCWorkItemRunTaskRequest: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCWorkItemRunTaskResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let lastRunId: String
    public let success: Bool
    public let error: String?
    /// Structured error code so the client can deterministically re-enable buttons or show contextual UI.
    public let errorCode: String?
}

public struct IPCWorkItemsListRequest: Codable, Sendable {
    public let type: String
    public let status: String?
}

public struct IPCWorkItemsListResponse: Codable, Sendable {
    public let type: String
    public let items: [IPCWorkItemsListResponseItem]
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
}

/// Server push — broadcast when a work item status changes (e.g. running -> awaiting_review).
public struct IPCWorkItemStatusChanged: Codable, Sendable {
    public let type: String
    public let item: IPCWorkItemStatusChangedItem
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
}

public struct IPCWorkItemUpdateRequest: Codable, Sendable {
    public let type: String
    public let id: String
    public let title: String?
    public let notes: String?
    public let status: String?
    public let priorityTier: Double?
    public let sortIndex: Int?
}

public struct IPCWorkItemUpdateResponse: Codable, Sendable {
    public let type: String
    public let item: IPCWorkItemUpdateResponseItem?
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
}
