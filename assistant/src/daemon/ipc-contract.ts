/**
 * IPC Contract — barrel re-export.
 *
 * All message types are defined in domain files under ./ipc-contract/.
 * This file re-exports them and defines the aggregate union types
 * (ClientMessage, ServerMessage, IPCContractSchema).
 */

// Re-export domain modules
export * from './ipc-contract/apps.js';
export * from './ipc-contract/browser.js';
export * from './ipc-contract/computer-use.js';
export * from './ipc-contract/diagnostics.js';
export * from './ipc-contract/documents.js';
export * from './ipc-contract/inbox.js';
export * from './ipc-contract/integrations.js';
export * from './ipc-contract/memory.js';
export * from './ipc-contract/messages.js';
export * from './ipc-contract/notifications.js';
export * from './ipc-contract/pairing.js';
export * from './ipc-contract/parental-control.js';
export * from './ipc-contract/schedules.js';
export * from './ipc-contract/sessions.js';
export * from './ipc-contract/shared.js';
export * from './ipc-contract/skills.js';
export * from './ipc-contract/subagents.js';
export * from './ipc-contract/surfaces.js';
export * from './ipc-contract/trust.js';
export * from './ipc-contract/work-items.js';
export * from './ipc-contract/workspace.js';

// Import types needed for aggregate unions and SubagentEvent
import type { AppDataRequest, AppDiffRequest, AppFileAtVersionRequest, AppHistoryRequest, AppOpenRequest, AppPreviewRequest, AppRestoreRequest, AppsListRequest, AppUpdatePreviewRequest, BundleAppRequest, ForkSharedAppRequest, GalleryInstallRequest, GalleryListRequest, GetSigningIdentityResponse, HomeBaseGetRequest, OpenBundleRequest, PublishPageRequest, ShareAppCloudRequest, SharedAppDeleteRequest, SharedAppsListRequest, ShareToSlackRequest, SignBundlePayloadResponse, UnpublishPageRequest } from './ipc-contract/apps.js';
import type { AppDataResponse, AppDiffResponse, AppFileAtVersionResponse, AppFilesChanged,AppHistoryResponse, AppPreviewResponse, AppRestoreResponse, AppsListResponse, AppUpdatePreviewResponse, BundleAppResponse, ForkSharedAppResponse, GalleryInstallResponse, GalleryListResponse, GetSigningIdentityRequest, HomeBaseGetResponse, OpenBundleResponse, PublishPageResponse, ShareAppCloudResponse, SharedAppDeleteResponse, SharedAppsListResponse, ShareToSlackResponse, SignBundlePayloadRequest, UnpublishPageResponse } from './ipc-contract/apps.js';
import type { BrowserCDPResponse, BrowserInteractiveMode,BrowserUserClick, BrowserUserKeypress, BrowserUserScroll } from './ipc-contract/browser.js';
import type { BrowserCDPRequest, BrowserFrame, BrowserHandoffRequest,BrowserInteractiveModeChanged } from './ipc-contract/browser.js';
import type { CuObservation, CuSessionAbort, CuSessionCreate, RideShotgunStart, RideShotgunStop, TaskSubmit, WatchObservation } from './ipc-contract/computer-use.js';
import type { CuAction, CuComplete, CuError, RideShotgunProgress, RideShotgunResult, TaskRouted, WatchCompleteRequest,WatchStarted } from './ipc-contract/computer-use.js';
import type { DiagnosticsExportRequest, DictationRequest,EnvVarsRequest, IpcBlobProbe } from './ipc-contract/diagnostics.js';
import type { DiagnosticsExportResponse, DictationResponse,EnvVarsResponse, IpcBlobProbeResult } from './ipc-contract/diagnostics.js';
import type { DocumentListRequest,DocumentLoadRequest, DocumentSaveRequest } from './ipc-contract/documents.js';
import type { DocumentEditorShow, DocumentEditorUpdate, DocumentListResponse,DocumentLoadResponse, DocumentSaveResponse } from './ipc-contract/documents.js';
import type { AssistantInboxEscalationRequest, AssistantInboxEscalationResponse, AssistantInboxReplyRequest, AssistantInboxReplyResponse,AssistantInboxRequest, AssistantInboxResponse, IngressInviteRequest, IngressInviteResponse, IngressMemberRequest, IngressMemberResponse } from './ipc-contract/inbox.js';
import type { ChannelReadinessRequest, GuardianVerificationRequest, IngressConfigRequest, IntegrationConnectRequest, IntegrationDisconnectRequest, IntegrationListRequest, LinkOpenRequest,PlatformConfigRequest, SlackWebhookConfigRequest, TelegramConfigRequest, TwilioConfigRequest, TwitterAuthStartRequest, TwitterAuthStatusRequest, TwitterIntegrationConfigRequest, VercelApiConfigRequest } from './ipc-contract/integrations.js';
import type { ChannelReadinessResponse, GuardianVerificationResponse, IngressConfigResponse, IntegrationConnectResult, IntegrationListResponse, OpenUrl,PlatformConfigResponse, SlackWebhookConfigResponse, TelegramConfigResponse, TwilioConfigResponse, TwitterAuthResult, TwitterAuthStatusResponse, TwitterIntegrationConfigResponse, VercelApiConfigResponse } from './ipc-contract/integrations.js';
import type { MemoryRecalled, MemoryStatus } from './ipc-contract/memory.js';
import type { ConfirmationResponse, SecretResponse, SuggestionRequest,UserMessage } from './ipc-contract/messages.js';
import type { AssistantTextDelta, AssistantThinkingDelta, ConfirmationRequest, ErrorMessage, MessageComplete, MessageDequeued, MessageQueued, MessageQueuedDeleted, SecretDetected, SecretRequest, SuggestionResponse, ToolInputDelta, ToolOutputChunk, ToolResult, ToolUseStart, TraceEvent,UserMessageEcho } from './ipc-contract/messages.js';
import type { NotificationIntent } from './ipc-contract/notifications.js';
import type { ApprovedDeviceRemove, ApprovedDeviceRemoveResponse,ApprovedDevicesClear, ApprovedDevicesList, ApprovedDevicesListResponse, PairingApprovalRequest, PairingApprovalResponse } from './ipc-contract/pairing.js';
import type { ParentalControlGetRequest, ParentalControlGetResponse, ParentalControlSetPinRequest, ParentalControlSetPinResponse, ParentalControlUpdateRequest, ParentalControlUpdateResponse,ParentalControlVerifyPinRequest, ParentalControlVerifyPinResponse } from './ipc-contract/parental-control.js';
import type { AgentHeartbeatAlert,ReminderFired, RemindersListResponse, ScheduleComplete, SchedulesListResponse, WatcherEscalation, WatcherNotification } from './ipc-contract/schedules.js';
import type { ReminderCancel,RemindersList, ScheduleRemove, ScheduleRunNow, SchedulesList, ScheduleToggle } from './ipc-contract/schedules.js';
import type { AuthMessage, CancelRequest, ConversationSearchRequest,DeleteQueuedMessage, HistoryRequest, ImageGenModelSetRequest, ModelGetRequest, ModelSetRequest, PingMessage, RegenerateRequest, SandboxSetRequest, SessionCreateRequest, SessionListRequest, SessionRenameRequest, SessionsClearRequest, SessionSwitchRequest, UndoRequest, UsageRequest } from './ipc-contract/sessions.js';
// Server-side imports for ServerMessage union
import type { AuthResult, ContextCompacted, ConversationSearchResponse,DaemonStatusMessage, GenerationCancelled, GenerationHandoff, HistoryResponse, ModelInfo, PongMessage, SessionErrorMessage, SessionInfo, SessionListResponse, SessionsClearResponse, SessionTitleUpdated, UndoComplete, UsageResponse, UsageUpdate } from './ipc-contract/sessions.js';
import type { SkillDetailRequest, SkillsCheckUpdatesRequest, SkillsConfigureRequest, SkillsCreateRequest,SkillsDisableRequest, SkillsDraftRequest, SkillsEnableRequest, SkillsInspectRequest, SkillsInstallRequest, SkillsListRequest, SkillsSearchRequest, SkillsUninstallRequest, SkillsUpdateRequest } from './ipc-contract/skills.js';
import type { SkillDetailResponse, SkillsDraftResponse,SkillsInspectResponse, SkillsListResponse, SkillsOperationResponse, SkillStateChanged } from './ipc-contract/skills.js';
import type { SubagentAbortRequest, SubagentDetailRequest, SubagentDetailResponse,SubagentMessageRequest, SubagentSpawned, SubagentStatusChanged, SubagentStatusRequest } from './ipc-contract/subagents.js';
import type { UiSurfaceAction, UiSurfaceUndoRequest } from './ipc-contract/surfaces.js';
import type { UiSurfaceComplete, UiSurfaceDismiss, UiSurfaceShow, UiSurfaceUndoResult,UiSurfaceUpdate } from './ipc-contract/surfaces.js';
import type { AcceptStarterBundle,AddTrustRule, RemoveTrustRule, TrustRulesList, UpdateTrustRule } from './ipc-contract/trust.js';
import type { AcceptStarterBundleResponse,TrustRulesListResponse } from './ipc-contract/trust.js';
import type { WorkItemApprovePermissionsRequest, WorkItemCancelRequest,WorkItemCompleteRequest, WorkItemDeleteRequest, WorkItemGetRequest, WorkItemOutputRequest, WorkItemPreflightRequest, WorkItemRunTaskRequest, WorkItemsListRequest, WorkItemUpdateRequest } from './ipc-contract/work-items.js';
import type { GuardianRequestThreadCreated, OpenTasksWindow,TaskRunThreadCreated, TasksChanged, WorkItemApprovePermissionsResponse, WorkItemCancelResponse, WorkItemDeleteResponse, WorkItemGetResponse, WorkItemOutputResponse, WorkItemPreflightResponse, WorkItemRunTaskResponse, WorkItemsListResponse, WorkItemStatusChanged, WorkItemUpdateResponse } from './ipc-contract/work-items.js';
import type { IdentityGetRequest, ToolNamesListRequest,ToolPermissionSimulateRequest, WorkspaceFileReadRequest, WorkspaceFilesListRequest } from './ipc-contract/workspace.js';
import type { IdentityGetResponse, ToolNamesListResponse,ToolPermissionSimulateResponse, WorkspaceFileReadResponse, WorkspaceFilesListResponse } from './ipc-contract/workspace.js';

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
  | SessionRenameRequest
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
  | SkillsDraftRequest
  | SkillsCreateRequest
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
  | PlatformConfigRequest
  | VercelApiConfigRequest
  | TwitterIntegrationConfigRequest
  | TelegramConfigRequest
  | TwilioConfigRequest
  | ChannelReadinessRequest
  | GuardianVerificationRequest
  | TwitterAuthStartRequest
  | TwitterAuthStatusRequest
  | SessionsClearRequest
  | ConversationSearchRequest
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
  | DictationRequest
  | ParentalControlGetRequest
  | ParentalControlVerifyPinRequest
  | ParentalControlSetPinRequest
  | ParentalControlUpdateRequest
  | IngressInviteRequest
  | IngressMemberRequest
  | AssistantInboxRequest
  | AssistantInboxEscalationRequest
  | AssistantInboxReplyRequest
  | PairingApprovalResponse
  | ApprovedDevicesList
  | ApprovedDeviceRemove
  | ApprovedDevicesClear;

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
  | SessionTitleUpdated
  | SessionListResponse
  | SessionsClearResponse
  | ConversationSearchResponse
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
  | SkillsDraftResponse
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
  | PlatformConfigResponse
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
  | DictationResponse
  | ParentalControlGetResponse
  | ParentalControlVerifyPinResponse
  | ParentalControlSetPinResponse
  | ParentalControlUpdateResponse
  | IngressInviteResponse
  | IngressMemberResponse
  | AssistantInboxResponse
  | AssistantInboxEscalationResponse
  | AssistantInboxReplyResponse
  | PairingApprovalRequest
  | ApprovedDevicesListResponse
  | ApprovedDeviceRemoveResponse
  | NotificationIntent;

// === Contract schema ===

export interface IPCContractSchema {
  client: ClientMessage;
  server: ServerMessage;
}
