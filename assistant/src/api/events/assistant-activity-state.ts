/**
 * `assistant_activity_state` SSE event.
 *
 * Server-side assistant activity lifecycle, used by clients to place
 * the thinking indicator. `activityVersion` is monotonically increasing
 * per conversation; clients must ignore events with a version older
 * than their current known version.
 *
 * `phase`, `anchor`, and `reason` are strict enums because the daemon
 * emits a fixed, known set and clients switch on them. `requestId`
 * marks the active user request when available; `statusText` is a
 * human-readable description of what the assistant is doing.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AssistantActivityPhaseSchema = z.enum([
  "idle",
  "thinking",
  "streaming",
  "tool_running",
  "awaiting_confirmation",
]);

export type AssistantActivityPhase = z.infer<
  typeof AssistantActivityPhaseSchema
>;

export const AssistantActivityAnchorSchema = z.enum([
  "assistant_turn",
  "user_turn",
  "global",
]);

export type AssistantActivityAnchor = z.infer<
  typeof AssistantActivityAnchorSchema
>;

export const AssistantActivityReasonSchema = z.enum([
  "message_dequeued",
  "thinking_delta",
  "first_text_delta",
  "tool_use_start",
  "preview_start",
  "tool_result_received",
  "confirmation_requested",
  "confirmation_resolved",
  "context_compacting",
  "message_complete",
  "generation_cancelled",
  "error_terminal",
]);

export type AssistantActivityReason = z.infer<
  typeof AssistantActivityReasonSchema
>;

export const AssistantActivityStateEventSchema = z.object({
  type: z.literal("assistant_activity_state"),
  conversationId: z.string(),
  activityVersion: z.number(),
  phase: AssistantActivityPhaseSchema,
  anchor: AssistantActivityAnchorSchema,
  reason: AssistantActivityReasonSchema,
  requestId: z.string().optional(),
  statusText: z.string().optional(),
});

export type AssistantActivityStateEvent = z.infer<
  typeof AssistantActivityStateEventSchema
>;
