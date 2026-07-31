/**
 * `workflow_leaf_started` SSE event.
 *
 * Server → client notification that a leaf agent within a
 * `run_workflow` run has started. Carries `runId`, the parent
 * `conversationId`, the monotonic `seq` identifying the leaf within the
 * run, and optional human-readable display fields (`label`, `phase`,
 * `promptSummary`).
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

export const WorkflowLeafStartedEventSchema = z
  .object({
    type: z.literal("workflow_leaf_started"),
    runId: z.string(),
    conversationId: z.string(),
    seq: z.number().int(),
    label: z.string().optional(),
    phase: z.string().optional(),
    promptSummary: z.string().optional(),
  })
  .strict();

export type WorkflowLeafStartedEvent = z.infer<
  typeof WorkflowLeafStartedEventSchema
>;
