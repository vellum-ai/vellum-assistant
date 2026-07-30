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
 * then workflows, then background-tasks. Reordering this array reorders the
 * overlay.
 */
export const PROCESS_KINDS: BackgroundProcessDescriptor[] = [
  SUBAGENT_DESCRIPTOR,
  ACP_RUN_DESCRIPTOR,
  WORKFLOW_DESCRIPTOR,
  BACKGROUND_TASK_DESCRIPTOR,
];

/**
 * The kinds that float an overlay above the transcript in a windowed chat.
 *
 * Workflows and background tasks only. Subagent and ACP sessions are surfaced
 * by the header's `ConversationActivityPill`, which also covers finished
 * sessions and keeps the transcript clear, so overlaying them as well would
 * give one process two entry points.
 */
export const OVERLAY_PROCESS_KINDS: BackgroundProcessDescriptor[] = [
  WORKFLOW_DESCRIPTOR,
  BACKGROUND_TASK_DESCRIPTOR,
];

/**
 * The kinds that float an overlay in a pop-out window: every kind.
 *
 * A pop-out renders no header, so it has no `ConversationActivityPill` to carry
 * subagent and ACP sessions. The overlay is the only ambient surface there, and
 * it covers all four kinds so running work stays visible.
 */
export const POPOUT_OVERLAY_PROCESS_KINDS: BackgroundProcessDescriptor[] =
  PROCESS_KINDS;
