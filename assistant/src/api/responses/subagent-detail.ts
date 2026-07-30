/**
 * Wire contract for the subagent-detail REST endpoint
 * (`GET /subagents/:id`). Returns a subagent's objective, live status,
 * cumulative usage, and the reconstructed event history parsed from its
 * stored message rows.
 *
 * Reuses the canonical `SubagentStatusSchema` and `SubagentUsageStatsSchema`
 * defined alongside the `subagent_status_changed` SSE event so the polled
 * REST detail and the streamed status update share one status/usage shape.
 *
 * Canonical wire-contract source. Assistant code imports the types
 * directly from this file via relative paths; external consumers
 * (web client, gateway, evals) import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import {
  SubagentStatusSchema,
  SubagentUsageStatsSchema,
} from "../events/subagent-status-changed.js";

/**
 * A single reconstructed event in a subagent's history. Built from the
 * subagent conversation's stored message rows (assistant text, tool calls,
 * tool results), so `type` is an open string rather than a closed enum.
 */
export const SubagentDetailEventSchema = z.object({
  type: z.string(),
  content: z.string(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  messageId: z.string().optional(),
  /**
   * Tool-call id — the `tool_use.id` on a tool-call event and the referencing
   * `tool_use_id` on its tool-result event, in the daemon's canonical
   * content-block format. That format is provider-agnostic: every provider
   * (Anthropic, OpenAI, Gemini, …) normalizes its native tool calls into these
   * `tool_use`/`tool_result` blocks (see `providers/types.ts`), so this id is
   * present regardless of which model produced the call. Lets the web client
   * pair a result with its call and key the nested tool-detail view, so tool
   * pills on reloaded/history subagents are clickable (not just live ones).
   */
  toolUseId: z.string().optional(),
  /**
   * Raw tool input object on tool-call events. (`content` also carries a
   * JSON-stringified copy for back-compat / label derivation.) Surfaced in the
   * tool-detail view's input section.
   */
  input: z.record(z.string(), z.unknown()).optional(),
});

export type SubagentDetailEvent = z.infer<typeof SubagentDetailEventSchema>;

export const SubagentDetailResponseSchema = z.object({
  subagentId: z.string(),
  objective: z.string().optional(),
  status: SubagentStatusSchema.optional(),
  usage: SubagentUsageStatsSchema.optional(),
  events: z.array(SubagentDetailEventSchema),
  /**
   * The subagent's task label, from the live manager state or, once that is
   * gone, the durable record. Lets a client that missed the
   * `subagent_spawned` event (SSE gap, store reset, page reload mid-run)
   * recover the display name it would otherwise only learn at spawn time.
   */
  label: z.string().optional(),
  /**
   * Tool-use id of the spawning `subagent_spawn` call, from the live manager
   * state or, once that is gone, the durable record. Lets a recovering client
   * re-anchor the inline card to the exact spawn tool call (same role as the
   * field on `subagent_spawned`).
   */
  parentToolUseId: z.string().optional(),
  /**
   * The resolved child conversation id, so a client recovering from a missed
   * spawn can learn it, the id the daemon actually read the transcript from,
   * which may differ from the `conversationId` the caller passed.
   */
  conversationId: z.string().optional(),
});

export type SubagentDetailResponse = z.infer<
  typeof SubagentDetailResponseSchema
>;
