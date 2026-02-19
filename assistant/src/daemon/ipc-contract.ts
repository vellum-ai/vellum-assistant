import type { GalleryManifest } from '../gallery/gallery-manifest.js';

// === Shared types ===

export type ThreadType = 'standard' | 'private';

/** Runtime normalizer — collapses unknown/legacy DB values to 'standard'. */
export function normalizeThreadType(raw: string | null | undefined): ThreadType {
  return raw === 'private' ? 'private' : 'standard';
}

export interface IpcBlobRef {
  id: string;
  kind: 'ax_tree' | 'screenshot_jpeg';
  encoding: 'utf8' | 'binary';
  byteLength: number;
  sha256?: string;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

// === Client → Server messages ===

export interface UserMessage {
  type: 'user_message';
  sessionId: string;
  content?: string;
  attachments?: UserMessageAttachment[];
  activeSurfaceId?: string;
  /** The page currently displayed in the WebView (e.g. "settings.html"). */
  currentPage?: string;
  /** When true, skip the secret-ingress check. Set by the client when the user clicks "Send Anyway". */
  bypassSecretCheck?: boolean;
}

export interface UserMessageAttachment {
  id?: string;
  filename: string;
  mimeType: string;
  data: string;
  extractedText?: string;
  /** Original file size in bytes. Present when data was omitted from history_response to reduce payload size. */
  sizeBytes?: number;
  /** Base64-encoded JPEG thumbnail. Generated server-side for video attachments. */
  thumbnailData?: string;
}

export interface ConfirmationResponse {
  type: 'confirmation_response';
  requestId: string;
  decision: 'allow' | 'always_allow' | 'always_allow_high_risk' | 'deny' | 'always_deny';
  selectedPattern?: string;
  selectedScope?: string;
}

export interface SecretResponse {
  type: 'secret_response';
  requestId: string;
  value?: string;    // undefined = user cancelled
  /** How the secret should be delivered: 'store' persists to keychain (default), 'transient_send' for one-time use without persisting. */
  delivery?: 'store' | 'transient_send';
}

export interface SessionListRequest {
  type: 'session_list';
}

/** Lightweight session transport metadata for channel identity and natural-language guidance. */
export interface SessionTransportMetadata {
  /** Logical channel identifier (e.g. "desktop", "telegram", "mobile"). */
  channelId: string;
  /** Optional natural-language hints for channel-specific UX behavior. */
  hints?: string[];
  /** Optional concise UX brief for this channel. */
  uxBrief?: string;
}

export interface SessionCreateRequest {
  type: 'session_create';
  title?: string;
  systemPromptOverride?: string;
  maxResponseTokens?: number;
  correlationId?: string;
  transport?: SessionTransportMetadata;
  threadType?: ThreadType;
  /** Skill IDs to pre-activate in the new session (loaded before the first message). */
  preactivatedSkillIds?: string[];
  /** If provided, automatically sent as the first user message after session creation. */
  initialMessage?: string;
}

export interface SessionSwitchRequest {
  type: 'session_switch';
  sessionId: string;
}

export interface AuthMessage {
  type: 'auth';
  token: string;
}

export interface PingMessage {
  type: 'ping';
}

export interface CancelRequest {
  type: 'cancel';
  sessionId?: string;
}

export interface DeleteQueuedMessage {
  type: 'delete_queued_message';
  sessionId: string;
  requestId: string;
}

export interface ModelGetRequest {
  type: 'model_get';
}

export interface ModelSetRequest {
  type: 'model_set';
  model: string;
}

export interface ImageGenModelSetRequest {
  type: 'image_gen_model_set';
  model: string;
}

export interface HistoryRequest {
  type: 'history_request';
  sessionId: string;
}

export interface UndoRequest {
  type: 'undo';
  sessionId: string;
}

export interface RegenerateRequest {
  type: 'regenerate';
  sessionId: string;
}

export interface UsageRequest {
  type: 'usage_request';
  sessionId: string;
}

export interface SandboxSetRequest {
  type: 'sandbox_set';
  enabled: boolean;
}

export interface CuSessionCreate {
  type: 'cu_session_create';
  sessionId: string;
  task: string;
  screenWidth: number;
  screenHeight: number;
  attachments?: UserMessageAttachment[];
  interactionType?: 'computer_use' | 'text_qa';
}

export interface CuSessionAbort {
  type: 'cu_session_abort';
  sessionId: string;
}

export interface CuObservation {
  type: 'cu_observation';
  sessionId: string;
  axTree?: string;
  axDiff?: string;
  secondaryWindows?: string;
  screenshot?: string;
  /** Screenshot image width in pixels (`Px`). */
  screenshotWidthPx?: number;
  /** Screenshot image height in pixels (`Px`). */
  screenshotHeightPx?: number;
  /** Screen width in macOS points (`Pt`) used by native execution. */
  screenWidthPt?: number;
  /** Screen height in macOS points (`Pt`) used by native execution. */
  screenHeightPt?: number;
  /** Coordinate origin convention used by the observation payload. */
  coordinateOrigin?: 'top_left';
  /** Display ID used by screenshot capture for this observation. */
  captureDisplayId?: number;
  executionResult?: string;
  executionError?: string;
  axTreeBlob?: IpcBlobRef;
  screenshotBlob?: IpcBlobRef;
}

export interface TaskSubmit {
  type: 'task_submit';
  task: string;
  screenWidth: number;
  screenHeight: number;
  attachments?: UserMessageAttachment[];
  source?: 'voice' | 'text';
}

export interface RideShotgunStart {
  type: 'ride_shotgun_start';
  durationSeconds: number;
  intervalSeconds: number;
  mode?: 'observe' | 'learn';
  targetDomain?: string;
}

export interface RideShotgunStop {
  type: 'ride_shotgun_stop';
  watchId: string;
}

export interface WatchObservation {
  type: 'watch_observation';
  watchId: string;
  sessionId: string;
  ocrText: string;
  appName?: string;
  windowTitle?: string;
  bundleIdentifier?: string;
  timestamp: number;
  captureIndex: number;
  totalExpected: number;
}

export interface AppDataRequest {
  type: 'app_data_request';
  surfaceId: string;
  callId: string;
  method: 'query' | 'create' | 'update' | 'delete';
  appId: string;
  recordId?: string;
  data?: Record<string, unknown>;
}

export interface SkillsListRequest {
  type: 'skills_list';
}

export interface SkillDetailRequest {
  type: 'skill_detail';
  skillId: string;
}

export interface SkillsEnableRequest {
  type: 'skills_enable';
  name: string;
}

export interface SkillsDisableRequest {
  type: 'skills_disable';
  name: string;
}

export interface SkillsConfigureRequest {
  type: 'skills_configure';
  name: string;
  env?: Record<string, string>;
  apiKey?: string;
  config?: Record<string, unknown>;
}

export interface SkillsInstallRequest {
  type: 'skills_install';
  slug: string;
  version?: string;
}

export interface SkillsUninstallRequest {
  type: 'skills_uninstall';
  name: string;
}

export interface SkillsUpdateRequest {
  type: 'skills_update';
  name: string;
}

export interface SkillsCheckUpdatesRequest {
  type: 'skills_check_updates';
}

export interface SkillsSearchRequest {
  type: 'skills_search';
  query: string;
}

export interface SessionsClearRequest {
  type: 'sessions_clear';
}

export interface SkillsInspectRequest {
  type: 'skills_inspect';
  slug: string;
}

export interface SuggestionRequest {
  type: 'suggestion_request';
  sessionId: string;
  requestId: string;
}

export interface AddTrustRule {
  type: 'add_trust_rule';
  toolName: string;
  pattern: string;
  scope: string;
  decision: 'allow' | 'deny' | 'ask';
}

export interface TrustRulesList {
  type: 'trust_rules_list';
}

export interface RemoveTrustRule {
  type: 'remove_trust_rule';
  id: string;
}

export interface UpdateTrustRule {
  type: 'update_trust_rule';
  id: string;
  tool?: string;
  pattern?: string;
  scope?: string;
  decision?: 'allow' | 'deny' | 'ask';
  priority?: number;
}

export interface AcceptStarterBundle {
  type: 'accept_starter_bundle';
}

export interface SchedulesList {
  type: 'schedules_list';
}

export interface RemindersList {
  type: 'reminders_list';
}

export interface ReminderCancel {
  type: 'reminder_cancel';
  id: string;
}

export interface ScheduleToggle {
  type: 'schedule_toggle';
  id: string;
  enabled: boolean;
}

export interface ScheduleRemove {
  type: 'schedule_remove';
  id: string;
}

export interface AppsListRequest {
  type: 'apps_list';
}

export interface HomeBaseGetRequest {
  type: 'home_base_get';
  /** If true, daemon ensures a durable Home Base link exists before responding. */
  ensureLinked?: boolean;
}

export interface AppOpenRequest {
  type: 'app_open_request';
  appId: string;
}

export interface SharedAppsListRequest {
  type: 'shared_apps_list';
}

export interface SharedAppDeleteRequest {
  type: 'shared_app_delete';
  uuid: string;
}

export interface ForkSharedAppRequest {
  type: 'fork_shared_app';
  uuid: string;
}

export interface BundleAppRequest {
  type: 'bundle_app';
  appId: string;
}

export interface AppUpdatePreviewRequest {
  type: 'app_update_preview';
  appId: string;
  /** Base64-encoded PNG screenshot thumbnail. */
  preview: string;
}

export interface AppUpdatePreviewResponse {
  type: 'app_update_preview_response';
  success: boolean;
  appId: string;
}

export interface AppPreviewRequest {
  type: 'app_preview_request';
  appId: string;
}

export interface AppPreviewResponse {
  type: 'app_preview_response';
  appId: string;
  preview?: string;
}

export interface OpenBundleRequest {
  type: 'open_bundle';
  filePath: string;
}

export interface SignBundlePayloadResponse {
  type: 'sign_bundle_payload_response';
  requestId: string;
  signature?: string;
  keyId?: string;
  publicKey?: string;
  error?: string;
}

export interface GetSigningIdentityResponse {
  type: 'get_signing_identity_response';
  requestId: string;
  keyId?: string;
  publicKey?: string;
  error?: string;
}

export interface GalleryListRequest {
  type: 'gallery_list';
}

export interface GalleryInstallRequest {
  type: 'gallery_install';
  galleryAppId: string;
}

export interface ShareAppCloudRequest {
  type: 'share_app_cloud';
  appId: string;
}

export interface ShareToSlackRequest {
  type: 'share_to_slack';
  appId: string;
}

export interface SlackWebhookConfigRequest {
  type: 'slack_webhook_config';
  action: 'get' | 'set';
  webhookUrl?: string;
}

export interface VercelApiConfigRequest {
  type: 'vercel_api_config';
  action: 'get' | 'set' | 'delete';
  apiToken?: string;
}

export interface VercelApiConfigResponse {
  type: 'vercel_api_config_response';
  hasToken: boolean;
  success: boolean;
  error?: string;
}

export interface LinkOpenRequest {
  type: 'link_open_request';
  url: string;
  metadata?: Record<string, unknown>;
}

export interface DiagnosticsExportRequest {
  type: 'diagnostics_export_request';
  conversationId: string;
  anchorMessageId?: string;  // if omitted, use latest assistant message
}

export interface EnvVarsRequest {
  type: 'env_vars_request';
}

export interface IpcBlobProbe {
  type: 'ipc_blob_probe';
  probeId: string;
  nonceSha256: string;
}

// === Surface types ===

export type SurfaceType = 'card' | 'form' | 'list' | 'table' | 'confirmation' | 'dynamic_page' | 'file_upload' | 'browser_view' | 'document_preview';

export const INTERACTIVE_SURFACE_TYPES: SurfaceType[] = ['form', 'confirmation', 'dynamic_page', 'file_upload'];

export interface SurfaceAction {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'destructive';
}

export interface CardSurfaceData {
  title: string;
  subtitle?: string;
  body: string;
  metadata?: Array<{ label: string; value: string }>;
  /** Optional template name for specialized rendering (e.g. "weather_forecast"). */
  template?: string;
  /** Arbitrary data consumed by the template renderer. Shape depends on template. */
  templateData?: Record<string, unknown>;
}

export interface FormField {
  id: string;
  type: 'text' | 'textarea' | 'select' | 'toggle' | 'number' | 'password';
  label: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface FormPage {
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
}

export interface FormSurfaceData {
  description?: string;
  fields: FormField[];
  submitLabel?: string;
  pages?: FormPage[];
  pageLabels?: { next?: string; back?: string; submit?: string };
}

export interface ListItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  selected?: boolean;
}

export interface ListSurfaceData {
  items: ListItem[];
  selectionMode: 'single' | 'multiple' | 'none';
}

export interface ConfirmationSurfaceData {
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface DynamicPagePreview {
  title: string;
  subtitle?: string;
  description?: string;
  icon?: string;
  metrics?: Array<{ label: string; value: string }>;
}

export interface DynamicPageSurfaceData {
  html: string;
  width?: number;
  height?: number;
  appId?: string;
  appType?: string;
  reloadGeneration?: number;
  status?: string;
  preview?: DynamicPagePreview;
}

export interface FileUploadSurfaceData {
  prompt: string;
  acceptedTypes?: string[];
  maxFiles?: number;
  maxSizeBytes?: number;
}

export interface TableColumn {
  id: string;
  label: string;
  width?: number;
}

export interface TableRow {
  id: string;
  cells: Record<string, string>;
  selectable?: boolean;
  selected?: boolean;
}

export interface TableSurfaceData {
  columns: TableColumn[];
  rows: TableRow[];
  selectionMode?: 'none' | 'single' | 'multiple';
  caption?: string;
}

export interface BrowserViewSurfaceData {
  sessionId: string;
  currentUrl: string;
  status: 'navigating' | 'idle' | 'interacting';
  frame?: string; // base64 JPEG
  actionText?: string; // "Clicking 'Submit' button"
  highlights?: Array<{ x: number; y: number; w: number; h: number; label: string }>;
  pages?: Array<{ id: string; title: string; url: string; active: boolean }>;
}

export interface DocumentPreviewSurfaceData {
  title: string;
  surfaceId: string;   // the doc's real surfaceId, for focusing the panel
  subtitle?: string;
}

export type SurfaceData = CardSurfaceData | FormSurfaceData | ListSurfaceData | TableSurfaceData | ConfirmationSurfaceData | DynamicPageSurfaceData | FileUploadSurfaceData | BrowserViewSurfaceData | DocumentPreviewSurfaceData;

export interface UiSurfaceAction {
  type: 'ui_surface_action';
  sessionId: string;
  surfaceId: string;
  actionId: string;
  data?: Record<string, unknown>;
}

export interface UiSurfaceUndoRequest {
  type: 'ui_surface_undo';
  sessionId: string;
  surfaceId: string;
}

export interface PublishPageRequest {
  type: 'publish_page';
  html: string;
  title?: string;
  appId?: string;
}

export interface PublishPageResponse {
  type: 'publish_page_response';
  success: boolean;
  publicUrl?: string;
  deploymentId?: string;
  error?: string;
}

export interface UnpublishPageRequest {
  type: 'unpublish_page';
  deploymentId: string;
}

export interface UnpublishPageResponse {
  type: 'unpublish_page_response';
  success: boolean;
  error?: string;
}

export interface DiagnosticsExportResponse {
  type: 'diagnostics_export_response';
  success: boolean;
  filePath?: string;   // path to the zip file on success
  error?: string;      // error message on failure
}

export interface EnvVarsResponse {
  type: 'env_vars_response';
  vars: Record<string, string>;
}

export interface AppFilesChanged {
  type: 'app_files_changed';
  appId: string;
}

export interface BrowserFrame {
  type: 'browser_frame';
  sessionId: string;
  surfaceId: string;
  frame: string; // base64 JPEG
  metadata?: { offsetTop: number; pageScaleFactor: number; scrollOffsetX: number; scrollOffsetY: number; timestamp: number };
}

export interface BrowserCDPRequest {
  type: 'browser_cdp_request';
  sessionId: string;
}

export interface BrowserCDPResponse {
  type: 'browser_cdp_response';
  sessionId: string;
  success: boolean;
  declined?: boolean;
}

export interface BrowserUserClick {
  type: 'browser_user_click';
  sessionId: string;
  surfaceId: string;
  x: number;
  y: number;
  button?: 'left' | 'right';
  doubleClick?: boolean;
}

export interface BrowserUserScroll {
  type: 'browser_user_scroll';
  sessionId: string;
  surfaceId: string;
  deltaX: number;
  deltaY: number;
  x: number;
  y: number;
}

export interface BrowserUserKeypress {
  type: 'browser_user_keypress';
  sessionId: string;
  surfaceId: string;
  key: string;
  modifiers?: string[];
}

export interface BrowserInteractiveMode {
  type: 'browser_interactive_mode';
  sessionId: string;
  surfaceId: string;
  enabled: boolean;
}

export interface BrowserInteractiveModeChanged {
  type: 'browser_interactive_mode_changed';
  sessionId: string;
  surfaceId: string;
  enabled: boolean;
  reason?: string;
  message?: string;
}
export interface BrowserHandoffRequest {
  type: 'browser_handoff_request';
  sessionId: string;
  surfaceId: string;
  reason: 'auth' | 'checkout' | 'captcha' | 'custom';
  message: string;
  bringToFront?: boolean;
}

// ── Work Items (Tasks) ───────────────────────────────────────────────

export interface WorkItemsListRequest {
  type: 'work_items_list';
  status?: string;  // optional filter
}

export interface WorkItemGetRequest {
  type: 'work_item_get';
  id: string;
}

export interface WorkItemCreateRequest {
  type: 'work_item_create';
  taskId: string;
  title?: string;   // defaults to task title
  notes?: string;
  priorityTier?: number;
  sortIndex?: number;
}

export interface WorkItemUpdateRequest {
  type: 'work_item_update';
  id: string;
  title?: string;
  notes?: string;
  status?: string;
  priorityTier?: number;
  sortIndex?: number;
}

export interface WorkItemCompleteRequest {
  type: 'work_item_complete';
  id: string;
}

export interface WorkItemDeleteRequest {
  type: 'work_item_delete';
  id: string;
}

export interface WorkItemRunTaskRequest {
  type: 'work_item_run_task';
  id: string;
  /** When true, the daemon sets status to "running" but skips execution — the client routes task content through the active chat session instead. */
  chatRouted?: boolean;
}

export interface WorkItemOutputRequest {
  type: 'work_item_output';
  id: string;
}

export interface WorkItemPreflightRequest {
  type: 'work_item_preflight';
  id: string;  // work item ID
}

export interface WorkItemApprovePermissionsRequest {
  type: 'work_item_approve_permissions';
  id: string;
  approvedTools: string[];  // tools the user approved
}

export interface WorkItemCancelRequest {
  type: 'work_item_cancel';
  id: string;
}

export interface WorkItemRenderRequest {
  type: 'work_item_render';
  id: string;
}

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
  | VercelApiConfigRequest
  | SessionsClearRequest
  | GalleryListRequest
  | GalleryInstallRequest
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
  | WorkItemCreateRequest
  | WorkItemUpdateRequest
  | WorkItemCompleteRequest
  | WorkItemDeleteRequest
  | WorkItemRunTaskRequest
  | WorkItemOutputRequest
  | WorkItemPreflightRequest
  | WorkItemApprovePermissionsRequest
  | WorkItemCancelRequest
  | WorkItemRenderRequest
  | SubagentAbortRequest
  | SubagentStatusRequest
  | SubagentMessageRequest;

// ── Legacy integration IPC stubs ────────────────────────────────────
// The macOS Settings panel still sends these messages. Stub types keep
// the dispatch map happy until the client-side migration lands.

export interface IntegrationListRequest {
  type: 'integration_list';
}

export interface IntegrationConnectRequest {
  type: 'integration_connect';
  integrationId: string;
}

export interface IntegrationDisconnectRequest {
  type: 'integration_disconnect';
  integrationId: string;
}

export interface IntegrationListResponse {
  type: 'integration_list_response';
  integrations: Array<{
    id: string;
    connected: boolean;
    accountInfo?: string | null;
    connectedAt?: number | null;
    lastUsed?: number | null;
    error?: string | null;
  }>;
}

export interface IntegrationConnectResult {
  type: 'integration_connect_result';
  integrationId: string;
  success: boolean;
  accountInfo?: string | null;
  error?: string | null;
  setupRequired?: boolean;
  setupSkillId?: string;
  setupHint?: string;
}

// === Server → Client messages ===

export interface UserMessageEcho {
  type: 'user_message_echo';
  text: string;
  sessionId?: string;
}

export interface AssistantTextDelta {
  type: 'assistant_text_delta';
  text: string;
  sessionId?: string;
}

export interface AssistantThinkingDelta {
  type: 'assistant_thinking_delta';
  thinking: string;
}

export interface ToolUseStart {
  type: 'tool_use_start';
  toolName: string;
  input: Record<string, unknown>;
  sessionId?: string;
}

export interface ToolOutputChunk {
  type: 'tool_output_chunk';
  chunk: string;
}

export interface ToolInputDelta {
  type: 'tool_input_delta';
  toolName: string;
  content: string;
  sessionId?: string;
}

export interface ToolResult {
  type: 'tool_result';
  toolName: string;
  result: string;
  isError?: boolean;
  diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean };
  status?: string;
  sessionId?: string;
  /** Base64-encoded image data extracted from contentBlocks (e.g. browser_screenshot). */
  imageData?: string;
}

export interface ConfirmationRequest {
  type: 'confirmation_request';
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: string;
  executionTarget?: 'sandbox' | 'host';
  allowlistOptions: Array<{ label: string; description: string; pattern: string }>;
  scopeOptions: Array<{ label: string; scope: string }>;
  diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean };
  sandboxed?: boolean;
  sessionId?: string;
  /** Principal kind that initiated this tool use (e.g. 'core' or 'skill'). */
  principalKind?: string;
  /** Skill ID when principalKind is 'skill'. */
  principalId?: string;
  /** Content-hash of the skill source for version tracking. */
  principalVersion?: string;
  /** When false, the client should hide "always allow" / trust-rule persistence affordances. */
  persistentDecisionsAllowed?: boolean;
}

export interface SecretRequest {
  type: 'secret_request';
  requestId: string;
  service: string;
  field: string;
  label: string;
  description?: string;
  placeholder?: string;
  sessionId?: string;
  /** Intended purpose of the credential (displayed to user). */
  purpose?: string;
  /** Tools allowed to use this credential. */
  allowedTools?: string[];
  /** Domains where this credential may be used. */
  allowedDomains?: string[];
  /** Whether one-time send override is available. */
  allowOneTimeSend?: boolean;
}

export interface MessageComplete {
  type: 'message_complete';
  sessionId?: string;
  attachments?: UserMessageAttachment[];
}

export interface SessionInfo {
  type: 'session_info';
  sessionId: string;
  title: string;
  correlationId?: string;
  threadType?: ThreadType;
}

export interface SessionListResponse {
  type: 'session_list_response';
  sessions: Array<{ id: string; title: string; updatedAt: number; threadType?: ThreadType }>;
}

export interface SessionsClearResponse {
  type: 'sessions_clear_response';
  cleared: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  /** Categorizes the error so the client can offer contextual actions (e.g. "Send Anyway" for secret_blocked). */
  category?: string;
}

export interface AuthResult {
  type: 'auth_result';
  success: boolean;
  message?: string;
}

export interface PongMessage {
  type: 'pong';
}

export interface DaemonStatusMessage {
  type: 'daemon_status';
  httpPort?: number;
  version?: string;
}

export interface GenerationCancelled {
  type: 'generation_cancelled';
  sessionId?: string;
}

export interface GenerationHandoff {
  type: 'generation_handoff';
  sessionId: string;
  requestId?: string;
  queuedCount: number;
  attachments?: UserMessageAttachment[];
}

export interface ModelInfo {
  type: 'model_info';
  model: string;
  provider: string;
  configuredProviders?: string[];
}

export interface HistoryResponseToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot). */
  imageData?: string;
}

export interface HistoryResponseSurface {
  surfaceId: string;
  surfaceType: string;
  title?: string;
  data: Record<string, unknown>;
  actions?: Array<{ id: string; label: string; style?: string }>;
  display?: string;
}

export interface HistoryResponse {
  type: 'history_response';
  sessionId: string;
  messages: Array<{
    id?: string;  // Database message ID (for matching surfaces)
    role: string;
    text: string;
    timestamp: number;
    toolCalls?: HistoryResponseToolCall[];
    /** True when tool_use blocks appeared before any text block in the original content. */
    toolCallsBeforeText?: boolean;
    attachments?: UserMessageAttachment[];
    /** Text segments split by tool-call boundaries. Preserves interleaving order. */
    textSegments?: string[];
    /** Content block ordering using "text:N", "tool:N", "surface:N" encoding. */
    contentOrder?: string[];
    /** UI surfaces (widgets) embedded in the message. */
    surfaces?: HistoryResponseSurface[];
  }>;
}

export interface UndoComplete {
  type: 'undo_complete';
  removedCount: number;
  sessionId?: string;
}

export interface UsageUpdate {
  type: 'usage_update';
  inputTokens: number;
  outputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  model: string;
}

export interface UsageResponse {
  type: 'usage_response';
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  model: string;
}

export interface ContextCompacted {
  type: 'context_compacted';
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  compactedMessages: number;
  summaryCalls: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryModel: string;
}

export interface SecretDetected {
  type: 'secret_detected';
  toolName: string;
  matches: Array<{ type: string; redactedValue: string }>;
  action: 'redact' | 'warn' | 'block' | 'prompt';
}

export interface MemoryRecalledCandidateDebug {
  key: string;
  type: string;
  kind: string;
  finalScore: number;
  lexical: number;
  semantic: number;
  recency: number;
}

export interface MemoryRecalled {
  type: 'memory_recalled';
  provider: string;
  model: string;
  lexicalHits: number;
  semanticHits: number;
  recencyHits: number;
  entityHits: number;
  relationSeedEntityCount?: number;
  relationTraversedEdgeCount?: number;
  relationNeighborEntityCount?: number;
  relationExpandedItemCount?: number;
  earlyTerminated?: boolean;
  mergedCount: number;
  selectedCount: number;
  rerankApplied: boolean;
  injectedTokens: number;
  latencyMs: number;
  topCandidates: MemoryRecalledCandidateDebug[];
}

export interface MemoryStatus {
  type: 'memory_status';
  enabled: boolean;
  degraded: boolean;
  reason?: string;
  provider?: string;
  model?: string;
  conflictsPending: number;
  conflictsResolved: number;
  oldestPendingConflictAgeMs: number | null;
  cleanupResolvedJobsPending: number;
  cleanupSupersededJobsPending: number;
  cleanupResolvedJobsCompleted24h: number;
  cleanupSupersededJobsCompleted24h: number;
}

export interface CuAction {
  type: 'cu_action';
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  reasoning?: string;
  stepNumber: number;
}

export interface CuComplete {
  type: 'cu_complete';
  sessionId: string;
  summary: string;
  stepCount: number;
  isResponse?: boolean;
}

export interface CuError {
  type: 'cu_error';
  sessionId: string;
  message: string;
}

export type SessionErrorCode =
  | 'PROVIDER_NETWORK'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_API'
  | 'CONTEXT_TOO_LARGE'
  | 'QUEUE_FULL'
  | 'SESSION_ABORTED'
  | 'SESSION_PROCESSING_FAILED'
  | 'REGENERATE_FAILED'
  | 'UNKNOWN';

export interface SessionErrorMessage {
  type: 'session_error';
  sessionId: string;
  code: SessionErrorCode;
  userMessage: string;
  retryable: boolean;
  debugDetails?: string;
}

export interface TaskRouted {
  type: 'task_routed';
  sessionId: string;
  interactionType: 'computer_use' | 'text_qa';
  /** The task text passed to the escalated session. */
  task?: string;
  /** Set when a text_qa session escalates to computer_use via computer_use_request_control. */
  escalatedFrom?: string;
}

export interface RideShotgunResult {
  type: 'ride_shotgun_result';
  sessionId: string;
  watchId: string;
  summary: string;
  observationCount: number;
  recordingId?: string;
  recordingPath?: string;
}

export interface MessageQueued {
  type: 'message_queued';
  sessionId: string;
  requestId: string;
  position: number;
}

export interface MessageDequeued {
  type: 'message_dequeued';
  sessionId: string;
  requestId: string;
}

export interface MessageQueuedDeleted {
  type: 'message_queued_deleted';
  sessionId: string;
  requestId: string;
}

export interface AppDataResponse {
  type: 'app_data_response';
  surfaceId: string;
  callId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface SkillsListResponse {
  type: 'skills_list_response';
  skills: Array<{
    id: string;
    name: string;
    description: string;
    emoji?: string;
    homepage?: string;
    source: 'bundled' | 'managed' | 'workspace' | 'clawhub' | 'extra';
    state: 'enabled' | 'disabled' | 'available';
    degraded: boolean;
    missingRequirements?: { bins?: string[]; env?: string[]; permissions?: string[] };
    installedVersion?: string;
    latestVersion?: string;
    updateAvailable: boolean;
    userInvocable: boolean;
    clawhub?: { author: string; stars: number; installs: number; reports: number; publishedAt: string };
  }>;
}

export interface SkillStateChanged {
  type: 'skills_state_changed';
  name: string;
  state: 'enabled' | 'disabled' | 'installed' | 'uninstalled';
}

export interface SkillsOperationResponse {
  type: 'skills_operation_response';
  operation: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface SkillDetailResponse {
  type: 'skill_detail_response';
  skillId: string;
  body: string;
  icon?: string;
  error?: string;
}

export interface SkillsInspectResponse {
  type: 'skills_inspect_response';
  slug: string;
  data?: {
    skill: { slug: string; displayName: string; summary: string };
    owner?: { handle: string; displayName: string; image?: string } | null;
    stats?: { stars: number; installs: number; downloads: number; versions: number } | null;
    createdAt?: number | null;
    updatedAt?: number | null;
    latestVersion?: { version: string; changelog?: string } | null;
    files?: Array<{ path: string; size: number; contentType?: string }> | null;
    skillMdContent?: string | null;
  };
  error?: string;
}

export interface SuggestionResponse {
  type: 'suggestion_response';
  requestId: string;
  suggestion: string | null;
  source: 'llm' | 'none';
}

export interface TrustRulesListResponse {
  type: 'trust_rules_list_response';
  rules: Array<{
    id: string;
    tool: string;
    pattern: string;
    scope: string;
    decision: 'allow' | 'deny' | 'ask';
    priority: number;
    createdAt: number;
  }>;
}

export interface AcceptStarterBundleResponse {
  type: 'accept_starter_bundle_response';
  accepted: boolean;
  rulesAdded: number;
  alreadyAccepted: boolean;
}

export interface SchedulesListResponse {
  type: 'schedules_list_response';
  schedules: Array<{
    id: string;
    name: string;
    enabled: boolean;
    syntax: string;
    expression: string;
    cronExpression: string;
    timezone: string | null;
    message: string;
    nextRunAt: number;
    lastRunAt: number | null;
    lastStatus: string | null;
    description: string;
  }>;
}

export interface RemindersListResponse {
  type: 'reminders_list_response';
  reminders: Array<{
    id: string;
    label: string;
    message: string;
    fireAt: number;
    mode: string;
    status: string;
    firedAt: number | null;
    createdAt: number;
  }>;
}

export interface AppsListResponse {
  type: 'apps_list_response';
  apps: Array<{
    id: string;
    name: string;
    description?: string;
    icon?: string;
    preview?: string;
    createdAt: number;
    version?: string;
    contentId?: string;
    appType?: string;
  }>;
}

export interface HomeBaseGetResponse {
  type: 'home_base_get_response';
  homeBase: {
    appId: string;
    source: string;
    starterTasks: string[];
    onboardingTasks: string[];
    preview: {
      title: string;
      subtitle: string;
      description: string;
      icon: string;
      metrics: Array<{ label: string; value: string }>;
    };
  } | null;
}

export interface SharedAppsListResponse {
  type: 'shared_apps_list_response';
  apps: Array<{
    uuid: string;
    name: string;
    description?: string;
    icon?: string;
    preview?: string;
    entry: string;
    trustTier: string;
    signerDisplayName?: string;
    bundleSizeBytes: number;
    installedAt: string;
    version?: string;
    contentId?: string;
    updateAvailable?: boolean;
  }>;
}

export interface SharedAppDeleteResponse {
  type: 'shared_app_delete_response';
  success: boolean;
}

export interface ForkSharedAppResponse {
  type: 'fork_shared_app_response';
  success: boolean;
  appId?: string;
  name?: string;
  error?: string;
}

export interface BundleAppResponse {
  type: 'bundle_app_response';
  bundlePath: string;
  manifest: {
    format_version: number;
    name: string;
    description?: string;
    icon?: string;
    created_at: string;
    created_by: string;
    entry: string;
    capabilities: string[];
    version?: string;
    content_id?: string;
  };
}

export interface OpenBundleResponse {
  type: 'open_bundle_response';
  manifest: {
    format_version: number;
    name: string;
    description?: string;
    icon?: string;
    created_at: string;
    created_by: string;
    entry: string;
    capabilities: string[];
  };
  scanResult: {
    passed: boolean;
    blocked: string[];
    warnings: string[];
  };
  signatureResult: {
    trustTier: 'verified' | 'signed' | 'unsigned' | 'tampered';
    signerKeyId?: string;
    signerDisplayName?: string;
    signerAccount?: string;
  };
  bundleSizeBytes: number;
}

export interface SignBundlePayloadRequest {
  type: 'sign_bundle_payload';
  requestId: string;
  payload: string;
}

export interface GetSigningIdentityRequest {
  type: 'get_signing_identity';
  requestId: string;
}

export interface ShareAppCloudResponse {
  type: 'share_app_cloud_response';
  success: boolean;
  shareToken?: string;
  shareUrl?: string;
  error?: string;
}

export interface IpcBlobProbeResult {
  type: 'ipc_blob_probe_result';
  probeId: string;
  ok: boolean;
  observedNonceSha256?: string;
  reason?: string;
}

export interface GalleryListResponse {
  type: 'gallery_list_response';
  gallery: GalleryManifest;
}

export interface GalleryInstallResponse {
  type: 'gallery_install_response';
  success: boolean;
  appId?: string;
  name?: string;
  error?: string;
}

export interface ShareToSlackResponse {
  type: 'share_to_slack_response';
  success: boolean;
  error?: string;
}

export interface SlackWebhookConfigResponse {
  type: 'slack_webhook_config_response';
  webhookUrl?: string;
  success: boolean;
  error?: string;
}

export interface OpenUrl {
  type: 'open_url';
  url: string;
  title?: string;
}

export interface ReminderFired {
  type: 'reminder_fired';
  reminderId: string;
  label: string;
  message: string;
}

export interface ScheduleComplete {
  type: 'schedule_complete';
  scheduleId: string;
  name: string;
}

export interface WatcherNotification {
  type: 'watcher_notification';
  title: string;
  body: string;
}

export interface WatcherEscalation {
  type: 'watcher_escalation';
  title: string;
  body: string;
}

export interface WatchStarted {
  type: 'watch_started';
  sessionId: string;
  watchId: string;
  durationSeconds: number;
  intervalSeconds: number;
}

export interface WatchCompleteRequest {
  type: 'watch_complete_request';
  sessionId: string;
  watchId: string;
}

export type TraceEventKind =
  | 'request_received'
  | 'request_queued'
  | 'request_dequeued'
  | 'llm_call_started'
  | 'llm_call_finished'
  | 'assistant_message'
  | 'tool_started'
  | 'tool_permission_requested'
  | 'tool_permission_decided'
  | 'tool_finished'
  | 'tool_failed'
  | 'secret_detected'
  | 'generation_handoff'
  | 'message_complete'
  | 'generation_cancelled'
  | 'request_error'
  | 'tool_profiling_summary';

export interface TraceEvent {
  type: 'trace_event';
  eventId: string;
  sessionId: string;
  requestId?: string;
  timestampMs: number;
  sequence: number;
  kind: TraceEventKind;
  status?: 'info' | 'success' | 'warning' | 'error';
  summary: string;
  attributes?: Record<string, string | number | boolean | null>;
}

/** Common fields shared by all UiSurfaceShow variants. */
interface UiSurfaceShowBase {
  type: 'ui_surface_show';
  sessionId: string;
  surfaceId: string;
  title?: string;
  actions?: SurfaceAction[];
  display?: 'inline' | 'panel';
  /** The message ID that this surface belongs to (for history loading). */
  messageId?: string;
}

export interface UiSurfaceShowCard extends UiSurfaceShowBase {
  surfaceType: 'card';
  data: CardSurfaceData;
}

export interface UiSurfaceShowForm extends UiSurfaceShowBase {
  surfaceType: 'form';
  data: FormSurfaceData;
}

export interface UiSurfaceShowList extends UiSurfaceShowBase {
  surfaceType: 'list';
  data: ListSurfaceData;
}

export interface UiSurfaceShowConfirmation extends UiSurfaceShowBase {
  surfaceType: 'confirmation';
  data: ConfirmationSurfaceData;
}

export interface UiSurfaceShowDynamicPage extends UiSurfaceShowBase {
  surfaceType: 'dynamic_page';
  data: DynamicPageSurfaceData;
}

export interface UiSurfaceShowTable extends UiSurfaceShowBase {
  surfaceType: 'table';
  data: TableSurfaceData;
}

export interface UiSurfaceShowFileUpload extends UiSurfaceShowBase {
  surfaceType: 'file_upload';
  data: FileUploadSurfaceData;
}

export interface UiSurfaceShowBrowserView extends UiSurfaceShowBase {
  surfaceType: 'browser_view';
  data: BrowserViewSurfaceData;
}

export interface UiSurfaceShowDocumentPreview extends UiSurfaceShowBase {
  surfaceType: 'document_preview';
  data: DocumentPreviewSurfaceData;
}

export type UiSurfaceShow =
  | UiSurfaceShowCard
  | UiSurfaceShowForm
  | UiSurfaceShowList
  | UiSurfaceShowTable
  | UiSurfaceShowConfirmation
  | UiSurfaceShowDynamicPage
  | UiSurfaceShowFileUpload
  | UiSurfaceShowBrowserView
  | UiSurfaceShowDocumentPreview;

export interface UiSurfaceUpdate {
  type: 'ui_surface_update';
  sessionId: string;
  surfaceId: string;
  data: Partial<SurfaceData>;
}

export interface UiSurfaceDismiss {
  type: 'ui_surface_dismiss';
  sessionId: string;
  surfaceId: string;
}

export interface UiSurfaceComplete {
  type: 'ui_surface_complete';
  sessionId: string;
  surfaceId: string;
  summary: string;
  submittedData?: Record<string, unknown>;
}

export interface UiSurfaceUndoResult {
  type: 'ui_surface_undo_result';
  sessionId: string;
  surfaceId: string;
  success: boolean;
  /** Number of remaining undo entries after this undo. */
  remainingUndos: number;
}

// ── Document Editor Messages ────────────────────────────────────────

export interface DocumentEditorShow {
  type: 'document_editor_show';
  sessionId: string;
  surfaceId: string;
  title: string;
  initialContent: string;
}

export interface DocumentEditorUpdate {
  type: 'document_editor_update';
  sessionId: string;
  surfaceId: string;
  markdown: string;
  mode: string;
}

export interface DocumentSaveRequest {
  type: 'document_save';
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
}

export interface DocumentSaveResponse {
  type: 'document_save_response';
  surfaceId: string;
  success: boolean;
  error?: string;
}

export interface DocumentLoadRequest {
  type: 'document_load';
  surfaceId: string;
}

export interface DocumentLoadResponse {
  type: 'document_load_response';
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
  createdAt: number;
  updatedAt: number;
  success: boolean;
  error?: string;
}

export interface DocumentListRequest {
  type: 'document_list';
  conversationId?: string;
}

export interface DocumentListResponse {
  type: 'document_list_response';
  documents: Array<{
    surfaceId: string;
    conversationId: string;
    title: string;
    wordCount: number;
    createdAt: number;
    updatedAt: number;
  }>;
}

// ── Work Items (Tasks) — Server Responses ───────────────────────────

export interface WorkItemsListResponse {
  type: 'work_items_list_response';
  items: Array<{
    id: string;
    taskId: string;
    title: string;
    notes: string | null;
    status: string;
    priorityTier: number;
    sortIndex: number | null;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: number;
    updatedAt: number;
  }>;
}

export interface WorkItemGetResponse {
  type: 'work_item_get_response';
  item: {
    id: string;
    taskId: string;
    title: string;
    notes: string | null;
    status: string;
    priorityTier: number;
    sortIndex: number | null;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
}

export interface WorkItemCreateResponse {
  type: 'work_item_create_response';
  item: {
    id: string;
    taskId: string;
    title: string;
    notes: string | null;
    status: string;
    priorityTier: number;
    sortIndex: number | null;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: number;
    updatedAt: number;
  };
}

export interface WorkItemUpdateResponse {
  type: 'work_item_update_response';
  item: {
    id: string;
    taskId: string;
    title: string;
    notes: string | null;
    status: string;
    priorityTier: number;
    sortIndex: number | null;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    sourceType: string | null;
    sourceId: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
}

export interface WorkItemDeleteResponse {
  type: 'work_item_delete_response';
  id: string;
  success: boolean;
}

export type WorkItemRunTaskErrorCode = 'not_found' | 'already_running' | 'invalid_status' | 'no_task';

export interface WorkItemRunTaskResponse {
  type: 'work_item_run_task_response';
  id: string;
  lastRunId: string;
  success: boolean;
  error?: string;
  /** Structured error code so the client can deterministically re-enable buttons or show contextual UI. */
  errorCode?: WorkItemRunTaskErrorCode;
}

export interface WorkItemOutputResponse {
  type: 'work_item_output_response';
  id: string;
  success: boolean;
  error?: string;
  output?: {
    title: string;
    status: string;
    runId: string | null;
    conversationId: string | null;
    completedAt: number | null;
    summary: string;
    highlights: string[];
  };
}

export interface WorkItemPreflightResponse {
  type: 'work_item_preflight_response';
  id: string;
  success: boolean;
  error?: string;
  permissions?: {
    tool: string;
    description: string;
    riskLevel: 'low' | 'medium' | 'high';
    currentDecision: 'allow' | 'deny' | 'prompt';
  }[];
}

export interface WorkItemApprovePermissionsResponse {
  type: 'work_item_approve_permissions_response';
  id: string;
  success: boolean;
  error?: string;
}

export interface WorkItemCancelResponse {
  type: 'work_item_cancel_response';
  id: string;
  success: boolean;
  error?: string;
}

export interface WorkItemRenderResponse {
  type: 'work_item_render_response';
  id: string;
  success: boolean;
  content?: string;
  title?: string;
  error?: string;
}

/** Server push — tells the client to open/focus the tasks window. */
export interface OpenTasksWindow {
  type: 'open_tasks_window';
}

/** Server push — lightweight invalidation signal: the task queue has been mutated, refetch your list. */
export interface TasksChanged {
  type: 'tasks_changed';
}

/** Server push — broadcast when a work item status changes (e.g. running -> awaiting_review). */
export interface WorkItemStatusChanged {
  type: 'work_item_status_changed';
  item: {
    id: string;
    taskId: string;
    title: string;
    status: string;
    lastRunId: string | null;
    lastRunConversationId: string | null;
    lastRunStatus: string | null;
    updatedAt: number;
  };
}

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
  | ShareToSlackResponse
  | SlackWebhookConfigResponse
  | VercelApiConfigResponse
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
  | WorkItemCreateResponse
  | WorkItemUpdateResponse
  | WorkItemDeleteResponse
  | WorkItemRunTaskResponse
  | WorkItemOutputResponse
  | WorkItemPreflightResponse
  | WorkItemApprovePermissionsResponse
  | WorkItemCancelResponse
  | WorkItemRenderResponse
  | WorkItemStatusChanged
  | TasksChanged
  | OpenTasksWindow
  | SubagentSpawned
  | SubagentStatusChanged
  | SubagentEvent;

// === Subagent IPC ─────────────────────────────────────────────────────

export interface SubagentSpawned {
  type: 'subagent_spawned';
  subagentId: string;
  parentSessionId: string;
  label: string;
  objective: string;
}

export interface SubagentStatusChanged {
  type: 'subagent_status_changed';
  subagentId: string;
  status: import('../subagent/types.js').SubagentStatus;
  error?: string;
  usage?: UsageStats;
}

/** Wraps any ServerMessage emitted by a subagent session for routing to the client. */
export interface SubagentEvent {
  type: 'subagent_event';
  subagentId: string;
  event: ServerMessage;
}

// === Client → Server subagent messages ───────────────────────────────

export interface SubagentAbortRequest {
  type: 'subagent_abort';
  subagentId: string;
}

export interface SubagentStatusRequest {
  type: 'subagent_status';
  /** If omitted, returns all subagents for the session. */
  subagentId?: string;
  sessionId: string;
}

export interface SubagentMessageRequest {
  type: 'subagent_message';
  subagentId: string;
  content: string;
}

// === Contract schema ===

export interface IPCContractSchema {
  client: ClientMessage;
  server: ServerMessage;
}
