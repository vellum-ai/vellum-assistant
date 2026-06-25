// ACP (Agent Client Protocol) session lifecycle and communication types.

// === Server → Client (streamed via SSE) ===

export interface AcpSessionSpawned {
  type: "acp_session_spawned";
  acpSessionId: string;
  agent: string;
  parentConversationId: string;
  /** Tool-use id of the `acp_spawn` call that spawned this session. */
  parentToolUseId?: string;
  /** Objective text for the spawned session. */
  task?: string;
}

export interface AcpSessionUpdate {
  type: "acp_session_update";
  acpSessionId: string;
  updateType:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "user_message_chunk"
    | "tool_call"
    | "tool_call_update"
    | "plan";
  content?: string;
  toolCallId?: string;
  toolTitle?: string;
  toolKind?: string;
  toolStatus?: string;
  /** Stable id for the message this chunk belongs to. */
  messageId?: string;
  /** Monotonic ordering hint within the session. */
  seq?: number;
}

export interface AcpSessionCompleted {
  type: "acp_session_completed";
  acpSessionId: string;
  stopReason:
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled";
}

export interface AcpSessionError {
  type: "acp_session_error";
  acpSessionId: string;
  error: string;
}

// --- Domain-level union alias (consumed by message-protocol.ts) ---

export type _AcpServerMessages =
  | AcpSessionSpawned
  | AcpSessionUpdate
  | AcpSessionCompleted
  | AcpSessionError;
