// === Client → Server messages ===

export interface UserMessage {
  type: 'user_message';
  sessionId: string;
  content: string;
}

export interface ConfirmationResponse {
  type: 'confirmation_response';
  requestId: string;
  decision: 'allow' | 'always_allow' | 'deny';
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

export type ClientMessage =
  | UserMessage
  | ConfirmationResponse
  | SessionListRequest
  | SessionCreateRequest
  | SessionSwitchRequest
  | PingMessage
  | CancelRequest;

// === Server → Client messages ===

export interface AssistantTextDelta {
  type: 'assistant_text_delta';
  text: string;
}

export interface ToolUseStart {
  type: 'tool_use_start';
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  type: 'tool_result';
  toolName: string;
  result: string;
  isError?: boolean;
}

export interface ConfirmationRequest {
  type: 'confirmation_request';
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: string;
  allowlistOptions: Array<{ label: string; pattern: string }>;
  scopeOptions: Array<{ label: string; scope: string }>;
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
  sessions: Array<{ id: string; title: string }>;
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

export type ServerMessage =
  | AssistantTextDelta
  | ToolUseStart
  | ToolResult
  | ConfirmationRequest
  | MessageComplete
  | SessionInfo
  | SessionListResponse
  | ErrorMessage
  | PongMessage
  | GenerationCancelled;

// === Serialization ===

export function serialize(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function createMessageParser() {
  let buffer = '';

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
      return messages;
    },
  };
}
