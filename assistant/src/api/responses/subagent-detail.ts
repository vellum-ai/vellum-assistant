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
});

export type SubagentDetailEvent = z.infer<typeof SubagentDetailEventSchema>;

export const SubagentDetailResponseSchema = z.object({
  subagentId: z.string(),
  objective: z.string().optional(),
  status: SubagentStatusSchema.optional(),
  usage: SubagentUsageStatsSchema.optional(),
  events: z.array(SubagentDetailEventSchema),
});

export type SubagentDetailResponse = z.infer<
  typeof SubagentDetailResponseSchema
>;
