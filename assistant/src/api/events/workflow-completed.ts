/**
 * `workflow_completed` SSE event.
 *
 * Server → client notification that a `run_workflow` run has reached a
 * terminal state. Carries `runId`, the parent `conversationId`, the
 * terminal `status`, cumulative `agentsSpawned`/`inputTokens`/
 * `outputTokens` counters, and an optional human-readable `summary`.
 *
 * `conversationId` is present so clients can route the event to the
 * originating conversation's inline workflow card.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

/**
 * Lifecycle status of a `run_workflow` run. `running` is the live
 * state; the remainder are terminal. `cap_exceeded` is reached when a
 * run hits its configured agent/token cap; `interrupted` when the run
 * is halted by an external signal.
 */
export const WorkflowRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "aborted",
  "cap_exceeded",
  "interrupted",
]);

export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowCompletedEventSchema = z
  .object({
    type: z.literal("workflow_completed"),
    runId: z.string(),
    conversationId: z.string(),
    status: WorkflowRunStatusSchema,
    agentsSpawned: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    summary: z.string().optional(),
  })
  .strict();

export type WorkflowCompletedEvent = z.infer<
  typeof WorkflowCompletedEventSchema
>;
