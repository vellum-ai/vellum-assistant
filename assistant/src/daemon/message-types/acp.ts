// ACP (Agent Client Protocol) session lifecycle and communication types.

// === Server → Client (streamed via SSE) ===

export interface AcpSessionSpawned {
  type: "acp_session_spawned";
  acpSessionId: string;
  agent: string;
  parentSessionId: string;
}

export interface AcpSessionUpdate {
  type: "acp_session_update";
  acpSessionId: string;
  updateType:
    | "agent_message_chunk"
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

export interface AcpPermissionRequest {
  type: "acp_permission_request";
  acpSessionId: string;
  requestId: string;
  toolTitle: string;
  toolKind: string;
  rawInput?: unknown;
  options: Array<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
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
  | AcpPermissionRequest
  | AcpSessionCompleted
  | AcpSessionError;
