/**
 * `subagent_status_changed` SSE event.
 *
 * Server → client notification that a subagent's status has
 * transitioned. Carries `subagentId`, the new `status`, an optional
 * `error` message (typically present when transitioning into
 * `failed`), and an optional rolling `usage` snapshot.
 *
 * NOTE: no `conversationId` field. Like `subagent_spawned`, status
 * transitions route to the parent conversation's SSE stream via
 * `parentSendToClient` closure, not via conversation-scoped seq
 * stamping. The subagent is identified by `subagentId`; clients
 * already know the parent association from the prior `spawned` event.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

/**
 * Subagent lifecycle status. Mirrors `SubagentStatus` in
 * `assistant/src/subagent/types.ts`. `aborted` is a terminal state
 * reached via explicit `subagent_abort` request.
 */
export const SubagentStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "aborted",
]);

export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

/**
 * Rolling usage snapshot for a subagent. Field names mirror the
 * daemon's `UsageStats` interface (`shared.ts`) — in particular,
 * `estimatedCost` is the canonical wire field, not `totalCost`.
 */
export const SubagentUsageStatsSchema = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    estimatedCost: z.number(),
  })
  .strict();

export type SubagentUsageStats = z.infer<typeof SubagentUsageStatsSchema>;

export const SubagentStatusChangedEventSchema = z
  .object({
    type: z.literal("subagent_status_changed"),
    subagentId: z.string(),
    status: SubagentStatusSchema,
    error: z.string().optional(),
    usage: SubagentUsageStatsSchema.optional(),
  })
  .strict();

export type SubagentStatusChangedEvent = z.infer<
  typeof SubagentStatusChangedEventSchema
>;
