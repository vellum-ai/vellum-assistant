// Subagent lifecycle and communication types.
//
// The `subagent_spawned` and `subagent_status_changed` server events are
// single-sourced from their canonical `api/events` wire schemas; this file
// composes them into the domain union consumed by `message-protocol.ts`.

import type { SubagentSpawnedEvent } from "../../api/events/subagent-spawned.js";
import type { SubagentStatusChangedEvent } from "../../api/events/subagent-status-changed.js";
import type { UsageStats } from "./shared.js";

// === Server → Client ===

export interface SubagentDetailResponse {
  type: "subagent_detail_response";
  subagentId: string;
  objective?: string;
  usage?: UsageStats;
  events: Array<{
    type: string;
    content: string;
    toolName?: string;
    isError?: boolean;
    messageId?: string;
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
  | SubagentSpawnedEvent
  | SubagentStatusChangedEvent
  | SubagentDetailResponse;
