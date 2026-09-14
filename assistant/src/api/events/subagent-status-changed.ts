/**
 * `subagent_status_changed` SSE event.
 *
 * Server → client notification that a subagent's status has
 * transitioned. Carries `subagentId`, the new `status`, an optional
 * `error` message (typically present when transitioning into
 * `failed`), and an optional rolling `usage` snapshot.
 *
 * No `conversationId` field: the parent conversation is the envelope's,
 * stamped by that conversation's sink (`conversationEventSink` in
 * `daemon/conversation-event-sink.ts`), which is what the hub filters
 * and seq-stamps on. Clients read the parent from the envelope. Adding
 * it to this payload instead would be a breaking wire change, since
 * this schema is `.strict()` and already-deployed clients reject an
 * unknown key by dropping the whole event.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

/**
 * Subagent lifecycle status. Mirrors `SubagentStatus` in
 * `assistant/src/subagent/types.ts`. `aborted` is a terminal state
 * reached via explicit `subagent_abort` request; `interrupted` is a
 * terminal state assigned on daemon restart to a subagent that was
 * still in flight (it is not auto-resumed).
 */
export const SubagentStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "aborted",
  "interrupted",
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
