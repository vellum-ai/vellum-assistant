/**
 * Type definitions mirroring the assistant daemon's trace event store.
 * The endpoint is served by the daemon via RuntimeProxyWildcardView
 * under /v1/assistants/{id}/trace-events and is not part of the Django
 * OpenAPI schema, so we maintain types by hand here.
 */

export type TraceEventKind =
  | "request_received"
  | "request_queued"
  | "request_dequeued"
  | "llm_call_started"
  | "llm_call_finished"
  | "assistant_message"
  | "tool_started"
  | "tool_permission_requested"
  | "tool_permission_decided"
  | "tool_finished"
  | "tool_failed"
  | "secret_detected"
  | "generation_handoff"
  | "message_complete"
  | "generation_cancelled"
  | "request_error"
  | "tool_profiling_summary";

export type TraceEventStatus = "info" | "success" | "warning" | "error";

export interface TraceEventRow {
  eventId: string;
  conversationId: string;
  requestId?: string;
  timestampMs: number;
  sequence: number;
  kind: TraceEventKind;
  status?: TraceEventStatus;
  summary: string;
  attributes?: Record<string, string | number | boolean | null>;
}

export interface TraceEventsListResponse {
  events: TraceEventRow[];
}
