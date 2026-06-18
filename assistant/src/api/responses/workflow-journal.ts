/**
 * Wire contract for the workflow-journal REST endpoint. Returns a
 * `run_workflow` run's live status, cumulative usage/agent counters,
 * current phase, and the ordered list of leaf agents spawned by the
 * run.
 *
 * Reuses the canonical `WorkflowRunStatusSchema` defined alongside the
 * `workflow_completed` SSE event so the polled REST journal and the
 * streamed lifecycle events share one status shape.
 *
 * Canonical wire-contract source. Assistant code imports the types
 * directly from this file via relative paths; external consumers
 * (web client, gateway, evals) import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import { WorkflowRunStatusSchema } from "../events/workflow-completed.js";

/**
 * A single leaf within a workflow run. `kind` distinguishes a leaf
 * agent from a nested workflow; `status` is an open string rather than
 * a closed enum since it covers both lifecycle states and terminal
 * results.
 */
export const WorkflowLeafSchema = z.object({
  seq: z.number().int(),
  kind: z.enum(["agent", "workflow"]),
  label: z.string().optional(),
  phase: z.string().optional(),
  promptSummary: z.string().optional(),
  status: z.string(),
  resultSummary: z.string().optional(),
  createdAt: z.number().nullable(),
});

export type WorkflowLeaf = z.infer<typeof WorkflowLeafSchema>;

export const WorkflowJournalResponseSchema = z.object({
  runId: z.string(),
  status: WorkflowRunStatusSchema.optional(),
  agentsSpawned: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  phase: z.string().optional(),
  leaves: z.array(WorkflowLeafSchema),
});

export type WorkflowJournalResponse = z.infer<
  typeof WorkflowJournalResponseSchema
>;
