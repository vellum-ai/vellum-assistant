/**
 * `workflow_leaf_finished` SSE event.
 *
 * Server → client notification that a leaf agent within a
 * `run_workflow` run has finished. Carries `runId`, the parent
 * `conversationId`, the monotonic `seq` identifying the leaf within the
 * run, the terminal `status`, optional `inputTokens`/`outputTokens`
 * counters, and optional human-readable display fields (`label`,
 * `resultSummary`).
 *
 * `conversationId` is present so clients can route the event to the
 * originating conversation's inline workflow card and its live leaf
 * tree.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const WorkflowLeafFinishedEventSchema = z
  .object({
    type: z.literal("workflow_leaf_finished"),
    runId: z.string(),
    conversationId: z.string(),
    seq: z.number().int(),
    status: z.enum(["completed", "failed"]),
    label: z.string().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    resultSummary: z.string().optional(),
  })
  .strict();

export type WorkflowLeafFinishedEvent = z.infer<
  typeof WorkflowLeafFinishedEventSchema
>;
