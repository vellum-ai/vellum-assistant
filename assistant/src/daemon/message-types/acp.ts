// ACP (Agent Client Protocol) session lifecycle and communication types.

// === Server → Client (streamed via SSE) ===

export interface AcpSessionSpawned {
  type: "acp_session_spawned";
  acpSessionId: string;
  agent: string;
  parentConversationId: string;
}

/**
 * Wire event: an existing idle session has been reused and a follow-up turn is
 * now running. Unlike `acp_session_spawned` (which creates a session), this
 * targets a session the client already tracks — emitted from `steer()` on the
 * idle→running reuse path so clients flip the existing session back to running
 * instead of leaving it looking finished until the next `/acp/sessions` refresh.
 */
export interface AcpSessionResumed {
  type: "acp_session_resumed";
  acpSessionId: string;
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
  | AcpSessionResumed
  | AcpSessionUpdate
  | AcpSessionCompleted
  | AcpSessionError;
