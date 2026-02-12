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

// === Surface types ===

export type SurfaceType = 'card' | 'form' | 'list' | 'confirmation' | 'dynamic_page' | 'file_upload';

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
}

export interface FormField {
  id: string;
  type: 'text' | 'textarea' | 'select' | 'toggle' | 'number';
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

export type SurfaceData = CardSurfaceData | FormSurfaceData | ListSurfaceData | ConfirmationSurfaceData | DynamicPageSurfaceData | FileUploadSurfaceData;

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
  | AppDataRequest;

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
}

export interface ConfirmationRequest {
  type: 'confirmation_request';
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: string;
  allowlistOptions: Array<{ label: string; pattern: string }>;
  scopeOptions: Array<{ label: string; scope: string }>;
  diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean };
  sandboxed?: boolean;
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

export interface MemoryRecalled {
  type: 'memory_recalled';
  provider: string;
  model: string;
  lexicalHits: number;
  semanticHits: number;
  recencyHits: number;
  injectedTokens: number;
  latencyMs: number;
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

export interface UiSurfaceShowFileUpload extends UiSurfaceShowBase {
  surfaceType: 'file_upload';
  data: FileUploadSurfaceData;
}

export type UiSurfaceShow =
  | UiSurfaceShowCard
  | UiSurfaceShowForm
  | UiSurfaceShowList
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
  | MessageQueued
  | MessageDequeued;

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
