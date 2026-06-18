/**
 * `workflow_progress` SSE event.
 *
 * Server → client incremental progress update for an in-flight
 * `run_workflow` run. Carries `runId`, the parent `conversationId`, the
 * running `agentsSpawned` count, and optional human-readable display
 * fields (`phase`, `label`, `message`).
 *
 * `conversationId` is present so clients can route the event to the
 * originating conversation's inline workflow card.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const WorkflowProgressEventSchema = z
  .object({
    type: z.literal("workflow_progress"),
    runId: z.string(),
    conversationId: z.string(),
    agentsSpawned: z.number(),
    phase: z.string().optional(),
    label: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

export type WorkflowProgressEvent = z.infer<typeof WorkflowProgressEventSchema>;
