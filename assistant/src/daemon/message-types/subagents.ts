// Subagent lifecycle and communication types.

import type { UsageStats } from "./shared.js";

// === Server → Client ===

export interface SubagentSpawned {
  type: "subagent_spawned";
  subagentId: string;
  parentConversationId: string;
  label: string;
  objective: string;
  isFork?: boolean;
}

export interface SubagentStatusChanged {
  type: "subagent_status_changed";
  subagentId: string;
  status: import("../../subagent/types.js").SubagentStatus;
  error?: string;
  usage?: UsageStats;
}

export interface SubagentDetailResponse {
  type: "subagent_detail_response";
  subagentId: string;
  objective?: string;
  events: Array<{
    type: string;
    content: string;
    toolName?: string;
    isError?: boolean;
  }>;
}

// === Client → Server ===

export interface SubagentAbortRequest {
  type: "subagent_abort";
  subagentId: string;
}

export interface SubagentStatusRequest {
  type: "subagent_status";
  /** If omitted, returns all subagents for the conversation. */
  subagentId?: string;
}

export interface SubagentMessageRequest {
  type: "subagent_message";
  subagentId: string;
  content: string;
}

export interface SubagentDetailRequest {
  type: "subagent_detail_request";
  subagentId: string;
  conversationId: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SubagentsClientMessages =
  | SubagentAbortRequest
  | SubagentStatusRequest
  | SubagentMessageRequest
  | SubagentDetailRequest;

export type _SubagentsServerMessages =
  | SubagentSpawned
  | SubagentStatusChanged
  | SubagentDetailResponse;
