/**
 * `trace_event` SSE event.
 *
 * Diagnostic timeline event emitted by the daemon's `TraceEmitter` as a
 * request moves through its lifecycle (received, queued, LLM calls, tool
 * invocations, completion). Each event carries a monotonic per-conversation
 * `sequence` so clients can reconstruct order even when timestamps collide,
 * plus optional structured `attributes` (e.g. token counts, latency, tool
 * name). The daemon normalizes every attribute value to a primitive, so the
 * value type is the `string | number | boolean | null` union below.
 *
 * `kind` and `status` are strict enums because the daemon emits a fixed,
 * known set and clients switch on them (icons, metrics, group status).
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const TraceEventKindSchema = z.enum([
  "request_received",
  "request_queued",
  "request_dequeued",
  "llm_call_started",
  "llm_call_finished",
  "assistant_message",
  "tool_started",
  "tool_permission_requested",
  "tool_permission_decided",
  "tool_finished",
  "tool_failed",
  "generation_handoff",
  "message_complete",
  "generation_cancelled",
  "request_error",
  "tool_profiling_summary",
]);

export type TraceEventKind = z.infer<typeof TraceEventKindSchema>;

export const TraceEventStatusSchema = z.enum([
  "info",
  "success",
  "warning",
  "error",
]);

export type TraceEventStatus = z.infer<typeof TraceEventStatusSchema>;

export const TraceEventSchema = z.object({
  type: z.literal("trace_event"),
  eventId: z.string(),
  conversationId: z.string(),
  requestId: z.string().optional(),
  timestampMs: z.number(),
  sequence: z.number(),
  kind: TraceEventKindSchema,
  status: TraceEventStatusSchema.optional(),
  summary: z.string(),
  attributes: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;
