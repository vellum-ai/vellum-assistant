import { ACP_RUN_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/acp-run";
import { BACKGROUND_TASK_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/background-task";
import { SUBAGENT_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/subagent";
import { WORKFLOW_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/workflow";
import type { BackgroundProcessDescriptor } from "@/domains/chat/process-registry/types";

/**
 * The registry of background-process descriptors.
 *
 * The array ORDER is load-bearing: it encodes the left-to-right order in which
 * the overlay pills are stacked above the composer — subagents, then acp-runs,
 * then workflows, then background-tasks. This replaces the former "do not
 * reorder" comment that lived next to the hard-coded slots in `chat-body.tsx`.
 * Reordering this array reorders the overlay.
 */
export const PROCESS_KINDS: BackgroundProcessDescriptor[] = [
  SUBAGENT_DESCRIPTOR,
  ACP_RUN_DESCRIPTOR,
  WORKFLOW_DESCRIPTOR,
  BACKGROUND_TASK_DESCRIPTOR,
];
