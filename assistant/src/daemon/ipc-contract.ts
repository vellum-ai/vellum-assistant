/**
 * IPC Contract — barrel re-export.
 *
 * All message types are defined in domain files under ./ipc-contract/.
 * This file re-exports them and defines the aggregate union types
 * (ClientMessage, ServerMessage, IPCContractSchema).
 */

// Re-export domain modules
export * from './ipc-contract/shared.js';
export * from './ipc-contract/sessions.js';
export * from './ipc-contract/messages.js';
export * from './ipc-contract/surfaces.js';
export * from './ipc-contract/skills.js';
export * from './ipc-contract/trust.js';
export * from './ipc-contract/apps.js';
export * from './ipc-contract/integrations.js';
export * from './ipc-contract/computer-use.js';
export * from './ipc-contract/work-items.js';
export * from './ipc-contract/browser.js';
export * from './ipc-contract/subagents.js';
export * from './ipc-contract/documents.js';
export * from './ipc-contract/memory.js';
export * from './ipc-contract/workspace.js';
export * from './ipc-contract/schedules.js';
export * from './ipc-contract/diagnostics.js';

// Import types needed for aggregate unions and SubagentEvent
import type { AuthMessage, PingMessage, CancelRequest, DeleteQueuedMessage, ModelGetRequest, ModelSetRequest, ImageGenModelSetRequest, HistoryRequest, UndoRequest, RegenerateRequest, UsageRequest, SandboxSetRequest, SessionListRequest, SessionCreateRequest, SessionSwitchRequest, SessionsClearRequest } from './ipc-contract/sessions.js';
import type { UserMessage, ConfirmationResponse, SecretResponse, SuggestionRequest } from './ipc-contract/messages.js';
import type { UiSurfaceAction, UiSurfaceUndoRequest } from './ipc-contract/surfaces.js';
import type { SkillsListRequest, SkillDetailRequest, SkillsEnableRequest, SkillsDisableRequest, SkillsConfigureRequest, SkillsInstallRequest, SkillsUninstallRequest, SkillsUpdateRequest, SkillsCheckUpdatesRequest, SkillsSearchRequest, SkillsInspectRequest } from './ipc-contract/skills.js';
import type { AddTrustRule, TrustRulesList, RemoveTrustRule, UpdateTrustRule, AcceptStarterBundle } from './ipc-contract/trust.js';
import type { AppDataRequest, AppsListRequest, HomeBaseGetRequest, AppOpenRequest, SharedAppsListRequest, SharedAppDeleteRequest, ForkSharedAppRequest, BundleAppRequest, OpenBundleRequest, SignBundlePayloadResponse, GetSigningIdentityResponse, GalleryListRequest, GalleryInstallRequest, AppHistoryRequest, AppDiffRequest, AppFileAtVersionRequest, AppRestoreRequest, ShareAppCloudRequest, ShareToSlackRequest, AppUpdatePreviewRequest, AppPreviewRequest, PublishPageRequest, UnpublishPageRequest } from './ipc-contract/apps.js';
import type { SlackWebhookConfigRequest, IngressConfigRequest, VercelApiConfigRequest, TwitterIntegrationConfigRequest, TelegramConfigRequest, TwilioConfigRequest, ChannelReadinessRequest, GuardianVerificationRequest, TwitterAuthStartRequest, TwitterAuthStatusRequest, IntegrationListRequest, IntegrationConnectRequest, IntegrationDisconnectRequest, LinkOpenRequest } from './ipc-contract/integrations.js';
import type { CuSessionCreate, CuSessionAbort, CuObservation, TaskSubmit, RideShotgunStart, RideShotgunStop, WatchObservation } from './ipc-contract/computer-use.js';
import type { WorkItemsListRequest, WorkItemGetRequest, WorkItemUpdateRequest, WorkItemCompleteRequest, WorkItemDeleteRequest, WorkItemRunTaskRequest, WorkItemOutputRequest, WorkItemPreflightRequest, WorkItemApprovePermissionsRequest, WorkItemCancelRequest } from './ipc-contract/work-items.js';
import type { BrowserCDPResponse, BrowserUserClick, BrowserUserScroll, BrowserUserKeypress, BrowserInteractiveMode } from './ipc-contract/browser.js';
import type { SubagentAbortRequest, SubagentStatusRequest, SubagentMessageRequest, SubagentDetailRequest, SubagentSpawned, SubagentStatusChanged, SubagentDetailResponse } from './ipc-contract/subagents.js';
import type { DocumentSaveRequest, DocumentLoadRequest, DocumentListRequest } from './ipc-contract/documents.js';
import type { WorkspaceFilesListRequest, WorkspaceFileReadRequest, IdentityGetRequest, ToolPermissionSimulateRequest, ToolNamesListRequest } from './ipc-contract/workspace.js';
import type { DiagnosticsExportRequest, EnvVarsRequest, IpcBlobProbe, DictationRequest } from './ipc-contract/diagnostics.js';

// Server-side imports for ServerMessage union
import type { AuthResult, PongMessage, DaemonStatusMessage, GenerationCancelled, GenerationHandoff, ModelInfo, HistoryResponse, UndoComplete, UsageUpdate, UsageResponse, ContextCompacted, SessionErrorMessage, SessionInfo, SessionListResponse, SessionsClearResponse } from './ipc-contract/sessions.js';
import type { UserMessageEcho, AssistantTextDelta, AssistantThinkingDelta, ToolUseStart, ToolOutputChunk, ToolInputDelta, ToolResult, ConfirmationRequest, SecretRequest, MessageComplete, ErrorMessage, SecretDetected, MessageQueued, MessageDequeued, MessageQueuedDeleted, SuggestionResponse, TraceEvent } from './ipc-contract/messages.js';
import type { UiSurfaceShow, UiSurfaceUpdate, UiSurfaceDismiss, UiSurfaceComplete, UiSurfaceUndoResult } from './ipc-contract/surfaces.js';
import type { SkillsListResponse, SkillDetailResponse, SkillStateChanged, SkillsOperationResponse, SkillsInspectResponse } from './ipc-contract/skills.js';
import type { TrustRulesListResponse, AcceptStarterBundleResponse } from './ipc-contract/trust.js';
import type { AppDataResponse, AppsListResponse, HomeBaseGetResponse, SharedAppsListResponse, SharedAppDeleteResponse, ForkSharedAppResponse, BundleAppResponse, OpenBundleResponse, SignBundlePayloadRequest, GetSigningIdentityRequest, ShareAppCloudResponse, GalleryListResponse, GalleryInstallResponse, AppHistoryResponse, AppDiffResponse, AppFileAtVersionResponse, AppRestoreResponse, ShareToSlackResponse, AppUpdatePreviewResponse, AppPreviewResponse, PublishPageResponse, UnpublishPageResponse, AppFilesChanged } from './ipc-contract/apps.js';
import type { SlackWebhookConfigResponse, IngressConfigResponse, VercelApiConfigResponse, TwitterIntegrationConfigResponse, TelegramConfigResponse, TwilioConfigResponse, ChannelReadinessResponse, GuardianVerificationResponse, TwitterAuthResult, TwitterAuthStatusResponse, IntegrationListResponse, IntegrationConnectResult, OpenUrl } from './ipc-contract/integrations.js';
import type { CuAction, CuComplete, CuError, TaskRouted, RideShotgunProgress, RideShotgunResult, WatchStarted, WatchCompleteRequest } from './ipc-contract/computer-use.js';
import type { WorkItemsListResponse, WorkItemGetResponse, WorkItemUpdateResponse, WorkItemDeleteResponse, WorkItemRunTaskResponse, WorkItemOutputResponse, WorkItemPreflightResponse, WorkItemApprovePermissionsResponse, WorkItemCancelResponse, WorkItemStatusChanged, TaskRunThreadCreated, GuardianRequestThreadCreated, TasksChanged, OpenTasksWindow } from './ipc-contract/work-items.js';
import type { BrowserFrame, BrowserCDPRequest, BrowserInteractiveModeChanged, BrowserHandoffRequest } from './ipc-contract/browser.js';
import type { DocumentEditorShow, DocumentEditorUpdate, DocumentSaveResponse, DocumentLoadResponse, DocumentListResponse } from './ipc-contract/documents.js';
import type { MemoryRecalled, MemoryStatus } from './ipc-contract/memory.js';
import type { WorkspaceFilesListResponse, WorkspaceFileReadResponse, IdentityGetResponse, ToolPermissionSimulateResponse, ToolNamesListResponse } from './ipc-contract/workspace.js';
import type { SchedulesListResponse, RemindersListResponse, ReminderFired, ScheduleComplete, WatcherNotification, WatcherEscalation, AgentHeartbeatAlert } from './ipc-contract/schedules.js';
import type { DiagnosticsExportResponse, EnvVarsResponse, IpcBlobProbeResult, DictationResponse } from './ipc-contract/diagnostics.js';
import type { SchedulesList, ScheduleToggle, ScheduleRemove, ScheduleRunNow, RemindersList, ReminderCancel } from './ipc-contract/schedules.js';

// === SubagentEvent — defined here because it references ServerMessage ===

/** Wraps any ServerMessage emitted by a subagent session for routing to the client. */
export interface SubagentEvent {
  type: 'subagent_event';
  subagentId: string;
  event: ServerMessage;
}

// === Client → Server aggregate union ===

export type ClientMessage =
  | AuthMessage
  | UserMessage
  | ConfirmationResponse
  | SecretResponse
  | SessionListRequest
  | SessionCreateRequest
  | SessionSwitchRequest
  | PingMessage
  | CancelRequest
  | DeleteQueuedMessage
  | ModelGetRequest
  | ModelSetRequest
  | ImageGenModelSetRequest
  | HistoryRequest
  | UndoRequest
  | RegenerateRequest
  | UsageRequest
  | SandboxSetRequest
  | CuSessionCreate
  | CuSessionAbort
  | CuObservation
  | RideShotgunStart
  | RideShotgunStop
  | WatchObservation
  | TaskSubmit
  | UiSurfaceAction
  | UiSurfaceUndoRequest
  | AppDataRequest
  | SkillsListRequest
  | SkillDetailRequest
  | SkillsEnableRequest
  | SkillsDisableRequest
  | SkillsConfigureRequest
  | SkillsInstallRequest
  | SkillsUninstallRequest
  | SkillsUpdateRequest
  | SkillsCheckUpdatesRequest
  | SkillsSearchRequest
  | SkillsInspectRequest
  | SuggestionRequest
  | AddTrustRule
  | TrustRulesList
  | RemoveTrustRule
  | UpdateTrustRule
  | AcceptStarterBundle
  | SchedulesList
  | ScheduleToggle
  | ScheduleRemove
  | ScheduleRunNow
  | RemindersList
  | ReminderCancel
  | BundleAppRequest
  | AppsListRequest
  | HomeBaseGetRequest
  | AppOpenRequest
  | SharedAppsListRequest
  | SharedAppDeleteRequest
  | ForkSharedAppRequest
  | OpenBundleRequest
  | SignBundlePayloadResponse
  | GetSigningIdentityResponse
  | IpcBlobProbe
  | LinkOpenRequest
  | ShareAppCloudRequest
  | ShareToSlackRequest
  | SlackWebhookConfigRequest
  | IngressConfigRequest
  | VercelApiConfigRequest
  | TwitterIntegrationConfigRequest
  | TelegramConfigRequest
  | TwilioConfigRequest
  | ChannelReadinessRequest
  | GuardianVerificationRequest
  | TwitterAuthStartRequest
  | TwitterAuthStatusRequest
  | SessionsClearRequest
  | GalleryListRequest
  | GalleryInstallRequest
  | AppHistoryRequest
  | AppDiffRequest
  | AppFileAtVersionRequest
  | AppRestoreRequest
  | AppUpdatePreviewRequest
  | AppPreviewRequest
  | PublishPageRequest
  | UnpublishPageRequest
  | DiagnosticsExportRequest
  | EnvVarsRequest
  | IntegrationListRequest
  | IntegrationConnectRequest
  | IntegrationDisconnectRequest
  | DocumentSaveRequest
  | DocumentLoadRequest
  | DocumentListRequest
  | BrowserCDPResponse
  | BrowserUserClick
  | BrowserUserScroll
  | BrowserUserKeypress
  | BrowserInteractiveMode
  | WorkItemsListRequest
  | WorkItemGetRequest
  | WorkItemUpdateRequest
  | WorkItemCompleteRequest
  | WorkItemDeleteRequest
  | WorkItemRunTaskRequest
  | WorkItemOutputRequest
  | WorkItemPreflightRequest
  | WorkItemApprovePermissionsRequest
  | WorkItemCancelRequest
  | SubagentAbortRequest
  | SubagentStatusRequest
  | SubagentMessageRequest
  | SubagentDetailRequest
  | WorkspaceFilesListRequest
  | WorkspaceFileReadRequest
  | IdentityGetRequest
  | ToolPermissionSimulateRequest
  | ToolNamesListRequest
  | DictationRequest;

// === Server → Client aggregate union ===

export type ServerMessage =
  | AuthResult
  | UserMessageEcho
  | AssistantTextDelta
  | AssistantThinkingDelta
  | ToolUseStart
  | ToolOutputChunk
  | ToolInputDelta
  | ToolResult
  | ConfirmationRequest
  | SecretRequest
  | MessageComplete
  | SessionInfo
  | SessionListResponse
  | SessionsClearResponse
  | ErrorMessage
  | PongMessage
  | DaemonStatusMessage
  | GenerationCancelled
  | GenerationHandoff
  | ModelInfo
  | HistoryResponse
  | UndoComplete
  | UsageUpdate
  | UsageResponse
  | ContextCompacted
  | SecretDetected
  | MemoryRecalled
  | MemoryStatus
  | CuAction
  | CuComplete
  | CuError
  | SessionErrorMessage
  | TaskRouted
  | RideShotgunProgress
  | RideShotgunResult
  | UiSurfaceShow
  | UiSurfaceUpdate
  | UiSurfaceDismiss
  | UiSurfaceComplete
  | UiSurfaceUndoResult
  | AppDataResponse
  | SkillsListResponse
  | SkillDetailResponse
  | SkillStateChanged
  | SkillsOperationResponse
  | SkillsInspectResponse
  | SuggestionResponse
  | MessageQueued
  | MessageDequeued
  | MessageQueuedDeleted
  | ReminderFired
  | ScheduleComplete
  | WatcherNotification
  | WatcherEscalation
  | AgentHeartbeatAlert
  | WatchStarted
  | WatchCompleteRequest
  | TrustRulesListResponse
  | AcceptStarterBundleResponse
  | SchedulesListResponse
  | RemindersListResponse
  | BundleAppResponse
  | AppsListResponse
  | HomeBaseGetResponse
  | SharedAppsListResponse
  | SharedAppDeleteResponse
  | ForkSharedAppResponse
  | OpenBundleResponse
  | SignBundlePayloadRequest
  | GetSigningIdentityRequest
  | IpcBlobProbeResult
  | ShareAppCloudResponse
  | TraceEvent
  | GalleryListResponse
  | GalleryInstallResponse
  | AppHistoryResponse
  | AppDiffResponse
  | AppFileAtVersionResponse
  | AppRestoreResponse
  | ShareToSlackResponse
  | SlackWebhookConfigResponse
  | IngressConfigResponse
  | VercelApiConfigResponse
  | TwitterIntegrationConfigResponse
  | TelegramConfigResponse
  | TwilioConfigResponse
  | ChannelReadinessResponse
  | GuardianVerificationResponse
  | TwitterAuthResult
  | TwitterAuthStatusResponse
  | OpenUrl
  | AppUpdatePreviewResponse
  | AppPreviewResponse
  | PublishPageResponse
  | UnpublishPageResponse
  | DiagnosticsExportResponse
  | AppFilesChanged
  | BrowserFrame
  | EnvVarsResponse
  | IntegrationListResponse
  | IntegrationConnectResult
  | DocumentEditorShow
  | DocumentEditorUpdate
  | DocumentSaveResponse
  | DocumentLoadResponse
  | DocumentListResponse
  | BrowserCDPRequest
  | BrowserInteractiveModeChanged
  | BrowserHandoffRequest
  | WorkItemsListResponse
  | WorkItemGetResponse
  | WorkItemUpdateResponse
  | WorkItemDeleteResponse
  | WorkItemRunTaskResponse
  | WorkItemOutputResponse
  | WorkItemPreflightResponse
  | WorkItemApprovePermissionsResponse
  | WorkItemCancelResponse
  | WorkItemStatusChanged
  | TaskRunThreadCreated
  | GuardianRequestThreadCreated
  | TasksChanged
  | OpenTasksWindow
  | SubagentSpawned
  | SubagentStatusChanged
  | SubagentEvent
  | SubagentDetailResponse
  | WorkspaceFilesListResponse
  | WorkspaceFileReadResponse
  | IdentityGetResponse
  | ToolPermissionSimulateResponse
  | ToolNamesListResponse
  | DictationResponse;

// === Contract schema ===

export interface IPCContractSchema {
  client: ClientMessage;
  server: ServerMessage;
}
