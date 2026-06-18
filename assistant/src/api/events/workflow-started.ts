/**
 * `workflow_started` SSE event.
 *
 * Server → client notification that a `run_workflow` run has begun.
 * Carries `runId`, the parent `conversationId`, an optional anchoring
 * `toolUseId`, and an optional human-readable `label`.
 *
 * `conversationId` is present so clients can route the event to the
 * originating conversation's inline workflow card. `toolUseId` (the
 * `skill_execute` block id that launched the run) anchors that inline
 * card to the exact spawn tool call, mirroring
 * `subagent_spawned.parentToolUseId`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const WorkflowStartedEventSchema = z
  .object({
    type: z.literal("workflow_started"),
    runId: z.string(),
    conversationId: z.string(),
    toolUseId: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();

export type WorkflowStartedEvent = z.infer<typeof WorkflowStartedEventSchema>;
