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
  content: string;
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
  | SandboxSetRequest;

// === Server → Client messages ===

export interface AssistantTextDelta {
  type: 'assistant_text_delta';
  text: string;
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
}

export interface SessionInfo {
  type: 'session_info';
  sessionId: string;
  title: string;
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

export interface ModelInfo {
  type: 'model_info';
  model: string;
  provider: string;
}

export interface HistoryResponse {
  type: 'history_response';
  messages: Array<{ role: string; text: string; timestamp: number }>;
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

export interface SecretDetected {
  type: 'secret_detected';
  toolName: string;
  matches: Array<{ type: string; redactedValue: string }>;
  action: 'redact' | 'warn' | 'block';
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
  | ModelInfo
  | HistoryResponse
  | UndoComplete
  | UsageUpdate
  | UsageResponse
  | SecretDetected;

// === Serialization ===

/** Maximum size of a single line in the IPC buffer (64KB). */
export const MAX_LINE_SIZE = 64 * 1024;

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
