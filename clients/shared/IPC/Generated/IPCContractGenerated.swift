// AUTO-GENERATED from assistant/src/daemon/ipc-contract.ts — DO NOT EDIT
// Regenerate: cd assistant && bun run generate:ipc
//
// This file contains Swift Codable DTOs derived from the IPC contract.
// The discriminated union enums (ClientMessage/ServerMessage) remain
// in the hand-written IPCMessages.swift since they require custom
// Decodable init logic that code generators cannot express cleanly.

import Foundation

// MARK: - Generated IPC types

public struct IPCAddTrustRule: Codable, Sendable {
    public let type: String
    public let toolName: String
    public let pattern: String
    public let scope: String
    public let decision: String
}

public struct IPCAmbientObservation: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let ocrText: String
    public let appName: String?
    public let windowTitle: String?
    public let timestamp: Double
}

public struct IPCAmbientResult: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let decision: String
    public let summary: String?
    public let suggestion: String?
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

public struct IPCAppOpenRequest: Codable, Sendable {
    public let type: String
    public let appId: String
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
    public let createdAt: Int
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
    public let preview: IPCDynamicPagePreview?
}

public struct IPCErrorMessage: Codable, Sendable {
    public let type: String
    public let message: String
}

public struct IPCFileUploadSurfaceData: Codable, Sendable {
    public let prompt: String
    public let acceptedTypes: [String]?
    public let maxFiles: Int?
    public let maxSizeBytes: Int?
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

public struct IPCFormSurfaceData: Codable, Sendable {
    public let description: String?
    public let fields: [IPCFormField]
    public let submitLabel: String?
}

public struct IPCGenerationCancelled: Codable, Sendable {
    public let type: String
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
}

public struct IPCGetSigningIdentityResponse: Codable, Sendable {
    public let type: String
    public let keyId: String
    public let publicKey: String
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
    public let role: String
    public let text: String
    public let timestamp: Double
    public let toolCalls: [IPCHistoryResponseToolCall]?
    public let attachments: [IPCUserMessageAttachment]?
}

public struct IPCHistoryResponseToolCall: Codable, Sendable {
    public let name: String
    public let input: [String: AnyCodable]
    public let result: String?
    public let isError: Bool?
    /// Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot).
    public let imageData: String?
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

public struct IPCModelGetRequest: Codable, Sendable {
    public let type: String
}

public struct IPCModelInfo: Codable, Sendable {
    public let type: String
    public let model: String
    public let provider: String
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

public struct IPCPingMessage: Codable, Sendable {
    public let type: String
}

public struct IPCPongMessage: Codable, Sendable {
    public let type: String
}

public struct IPCRegenerateRequest: Codable, Sendable {
    public let type: String
    public let sessionId: String
}

public struct IPCRemoveTrustRule: Codable, Sendable {
    public let type: String
    public let id: String
}

public struct IPCSandboxSetRequest: Codable, Sendable {
    public let type: String
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
}

public struct IPCSecretResponse: Codable, Sendable {
    public let type: String
    public let requestId: String
    public let value: String?
}

public struct IPCSessionCreateRequest: Codable, Sendable {
    public let type: String
    public let title: String?
    public let systemPromptOverride: String?
    public let maxResponseTokens: Int?
    public let correlationId: String?
}

public struct IPCSessionInfo: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let title: String
    public let correlationId: String?
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
    public let entry: String
    public let trustTier: String
    public let signerDisplayName: String?
    public let bundleSizeBytes: Int
    public let installedAt: String
}

public struct IPCSignBundlePayloadRequest: Codable, Sendable {
    public let type: String
    public let payload: String
}

public struct IPCSignBundlePayloadResponse: Codable, Sendable {
    public let type: String
    public let signature: String
    public let keyId: String
    public let publicKey: String
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
    /// Set when a text_qa session escalates to computer_use via request_computer_control.
    public let escalatedFrom: String?
}

public struct IPCTaskSubmit: Codable, Sendable {
    public let type: String
    public let task: String
    public let screenWidth: Int
    public let screenHeight: Int
    public let attachments: [IPCUserMessageAttachment]?
    public let source: String?
}

public struct IPCTimerCompleted: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let timerId: String
    public let label: String
    public let durationMinutes: Double
}

public struct IPCToolOutputChunk: Codable, Sendable {
    public let type: String
    public let chunk: String
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

public struct IPCUiSurfaceAction: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
    public let actionId: String
    public let data: [String: AnyCodable]?
}

public struct IPCUiSurfaceDismiss: Codable, Sendable {
    public let type: String
    public let sessionId: String
    public let surfaceId: String
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
}

public struct IPCUserMessageAttachment: Codable, Sendable {
    public let id: String?
    public let filename: String
    public let mimeType: String
    public let data: String
    public let extractedText: String?
}
