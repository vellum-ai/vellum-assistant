/**
 * `subagent_status_changed` SSE event.
 *
 * Server → client notification that a subagent's status has
 * transitioned. Carries `subagentId`, the parent `conversationId`, the
 * new `status`, an optional `error` message (typically present when
 * transitioning into `failed`), and an optional rolling `usage` snapshot.
 *
 * `conversationId` is the PARENT conversation, as on `subagent_event`.
 * The daemon emits through the parent's sink, which is the assistant
 * event hub, and the hub scopes and seq-stamps an event by the
 * `conversationId` on its payload: without it the event fans out
 * unscoped to every subscriber and is never replayed on reconnect, and a
 * client that never saw the `spawned` event has no parent to file the
 * status under.
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
    /**
     * Parent conversation id, the scope the event hub filters and
     * seq-stamps on. Optional on the wire only because older assistants
     * omit it and the web client validates their events with this
     * schema; every emit site sets it.
     */
    conversationId: z.string().optional(),
    status: SubagentStatusSchema,
    error: z.string().optional(),
    usage: SubagentUsageStatsSchema.optional(),
  })
  .strict();

export type SubagentStatusChangedEvent = z.infer<
  typeof SubagentStatusChangedEventSchema
>;
