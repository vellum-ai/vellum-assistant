// === Shared types ===

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
}

export interface UserMessageAttachment {
  id?: string;
  filename: string;
  mimeType: string;
  data: string;
  extractedText?: string;
}

export interface ConfirmationResponse {
  type: 'confirmation_response';
  requestId: string;
  decision: 'allow' | 'always_allow' | 'deny' | 'always_deny';
  selectedPattern?: string;
  selectedScope?: string;
}

export interface SessionListRequest {
  type: 'session_list';
}

export interface SessionCreateRequest {
  type: 'session_create';
  title?: string;
  systemPromptOverride?: string;
  maxResponseTokens?: number;
  correlationId?: string;
}

export interface SessionSwitchRequest {
  type: 'session_switch';
  sessionId: string;
}

export interface PingMessage {
  type: 'ping';
}

export interface CancelRequest {
  type: 'cancel';
  sessionId?: string;
}

export interface ModelGetRequest {
  type: 'model_get';
}

export interface ModelSetRequest {
  type: 'model_set';
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
  executionResult?: string;
  executionError?: string;
}

export interface TaskSubmit {
  type: 'task_submit';
  task: string;
  screenWidth: number;
  screenHeight: number;
  attachments?: UserMessageAttachment[];
  source?: 'voice' | 'text';
}

export interface AmbientObservation {
  type: 'ambient_observation';
  requestId: string;
  ocrText: string;
  appName?: string;
  windowTitle?: string;
  timestamp: number;
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
  decision: 'allow' | 'deny';
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
  decision?: 'allow' | 'deny';
  priority?: number;
}

export interface AppsListRequest {
  type: 'apps_list';
}

export interface SharedAppsListRequest {
  type: 'shared_apps_list';
}

export interface SharedAppDeleteRequest {
  type: 'shared_app_delete';
  uuid: string;
}

export interface BundleAppRequest {
  type: 'bundle_app';
  appId: string;
}

export interface OpenBundleRequest {
  type: 'open_bundle';
  filePath: string;
}

export interface SignBundlePayloadResponse {
  type: 'sign_bundle_payload_response';
  signature: string;
  keyId: string;
  publicKey: string;
}

export interface GetSigningIdentityResponse {
  type: 'get_signing_identity_response';
  keyId: string;
  publicKey: string;
}

// === Surface types ===

export type SurfaceType = 'card' | 'form' | 'list' | 'table' | 'confirmation' | 'dynamic_page' | 'file_upload';

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

export interface FormSurfaceData {
  description?: string;
  fields: FormField[];
  submitLabel?: string;
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

export interface DynamicPageSurfaceData {
  html: string;
  width?: number;
  height?: number;
  appId?: string;
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

export type SurfaceData = CardSurfaceData | FormSurfaceData | ListSurfaceData | TableSurfaceData | ConfirmationSurfaceData | DynamicPageSurfaceData | FileUploadSurfaceData;

export interface UiSurfaceAction {
  type: 'ui_surface_action';
  sessionId: string;
  surfaceId: string;
  actionId: string;
  data?: Record<string, unknown>;
}

export type ClientMessage =
  | UserMessage
  | ConfirmationResponse
  | SessionListRequest
  | SessionCreateRequest
  | SessionSwitchRequest
  | PingMessage
  | CancelRequest
  | ModelGetRequest
  | ModelSetRequest
  | HistoryRequest
  | UndoRequest
  | UsageRequest
  | SandboxSetRequest
  | CuSessionCreate
  | CuSessionAbort
  | CuObservation
  | AmbientObservation
  | TaskSubmit
  | UiSurfaceAction
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
  | BundleAppRequest
  | AppsListRequest
  | SharedAppsListRequest
  | SharedAppDeleteRequest
  | OpenBundleRequest
  | SignBundlePayloadResponse
  | GetSigningIdentityResponse;

// === Server → Client messages ===

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

export interface ToolResult {
  type: 'tool_result';
  toolName: string;
  result: string;
  isError?: boolean;
  diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean };
  status?: string;
  sessionId?: string;
}

export interface ConfirmationRequest {
  type: 'confirmation_request';
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: string;
  allowlistOptions: Array<{ label: string; description: string; pattern: string }>;
  scopeOptions: Array<{ label: string; scope: string }>;
  diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean };
  sandboxed?: boolean;
  sessionId?: string;
}

export interface MessageComplete {
  type: 'message_complete';
  sessionId?: string;
}

export interface SessionInfo {
  type: 'session_info';
  sessionId: string;
  title: string;
  correlationId?: string;
}

export interface SessionListResponse {
  type: 'session_list_response';
  sessions: Array<{ id: string; title: string; updatedAt: number }>;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface PongMessage {
  type: 'pong';
}

export interface GenerationCancelled {
  type: 'generation_cancelled';
}

export interface GenerationHandoff {
  type: 'generation_handoff';
  sessionId: string;
  requestId?: string;
  queuedCount: number;
}

export interface ModelInfo {
  type: 'model_info';
  model: string;
  provider: string;
}

export interface HistoryResponseToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface HistoryResponse {
  type: 'history_response';
  messages: Array<{
    role: string;
    text: string;
    timestamp: number;
    toolCalls?: HistoryResponseToolCall[];
  }>;
}

export interface UndoComplete {
  type: 'undo_complete';
  removedCount: number;
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
  action: 'redact' | 'warn' | 'block';
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

export interface TaskRouted {
  type: 'task_routed';
  sessionId: string;
  interactionType: 'computer_use' | 'text_qa';
  /** The task text passed to the escalated session. */
  task?: string;
  /** Set when a text_qa session escalates to computer_use via request_computer_control. */
  escalatedFrom?: string;
}

export interface AmbientResult {
  type: 'ambient_result';
  requestId: string;
  decision: 'ignore' | 'observe' | 'suggest';
  summary?: string;
  suggestion?: string;
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
    decision: 'allow' | 'deny';
    priority: number;
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
    createdAt: number;
  }>;
}

export interface SharedAppsListResponse {
  type: 'shared_apps_list_response';
  apps: Array<{
    uuid: string;
    name: string;
    description?: string;
    icon?: string;
    entry: string;
    trustTier: string;
    signerDisplayName?: string;
    bundleSizeBytes: number;
    installedAt: string;
  }>;
}

export interface SharedAppDeleteResponse {
  type: 'shared_app_delete_response';
  success: boolean;
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
  payload: string;
}

export interface GetSigningIdentityRequest {
  type: 'get_signing_identity';
}

export interface TimerCompleted {
  type: 'timer_completed';
  sessionId: string;
  timerId: string;
  label: string;
  durationMinutes: number;
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

/** Common fields shared by all UiSurfaceShow variants. */
interface UiSurfaceShowBase {
  type: 'ui_surface_show';
  sessionId: string;
  surfaceId: string;
  title?: string;
  actions?: SurfaceAction[];
  display?: 'inline' | 'panel';
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

export type UiSurfaceShow =
  | UiSurfaceShowCard
  | UiSurfaceShowForm
  | UiSurfaceShowList
  | UiSurfaceShowTable
  | UiSurfaceShowConfirmation
  | UiSurfaceShowDynamicPage
  | UiSurfaceShowFileUpload;

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

export type ServerMessage =
  | AssistantTextDelta
  | AssistantThinkingDelta
  | ToolUseStart
  | ToolOutputChunk
  | ToolResult
  | ConfirmationRequest
  | MessageComplete
  | SessionInfo
  | SessionListResponse
  | ErrorMessage
  | PongMessage
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
  | TaskRouted
  | AmbientResult
  | UiSurfaceShow
  | UiSurfaceUpdate
  | UiSurfaceDismiss
  | AppDataResponse
  | SkillsListResponse
  | SkillDetailResponse
  | SkillStateChanged
  | SkillsOperationResponse
  | SkillsInspectResponse
  | SuggestionResponse
  | MessageQueued
  | MessageDequeued
  | TimerCompleted
  | TrustRulesListResponse
  | BundleAppResponse
  | AppsListResponse
  | SharedAppsListResponse
  | SharedAppDeleteResponse
  | OpenBundleResponse
  | SignBundlePayloadRequest
  | GetSigningIdentityRequest;

// === Serialization ===

/**
 * Maximum size of a single line in the IPC buffer (96MB).
 *
 * Attachment payloads are sent inline as base64 in `user_message`, so the
 * parser must tolerate large partial frames before the terminating newline
 * arrives.
 */
export const MAX_LINE_SIZE = 96 * 1024 * 1024;

export function serialize(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function createMessageParser(options?: { maxLineSize?: number }) {
  let buffer = '';
  const maxLineSize = options?.maxLineSize;

  return {
    feed(data: string): Array<ClientMessage | ServerMessage> {
      buffer += data;
      const messages: Array<ClientMessage | ServerMessage> = [];
      const lines = buffer.split('\n');
      // Keep the last partial line in the buffer
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            messages.push(JSON.parse(trimmed));
          } catch {
            // Skip malformed messages
          }
        }
      }
      if (maxLineSize != null && buffer.length > maxLineSize) {
        buffer = '';
        throw new Error(
          `IPC message exceeds maximum line size of ${maxLineSize} bytes. Message discarded.`,
        );
      }
      return messages;
    },
  };
}
