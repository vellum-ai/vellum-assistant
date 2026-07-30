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
 * The kinds that still render a floating overlay above the transcript.
 *
 * Subagents and ACP runs left: their doorway is now the header's
 * `ConversationActivityPill`, which covers finished sessions too and doesn't
 * sit on top of the transcript (the floating subagent banner covered incoming
 * messages — LUM-2800). Two entry points for one process is worse than one, so
 * the overlay yields rather than duplicating it.
 *
 * Workflows and background tasks keep theirs: the Activity control does not
 * cover them, so retiring their overlay too would leave them with no ambient
 * surface at all.
 */
export const OVERLAY_PROCESS_KINDS: BackgroundProcessDescriptor[] = [
  WORKFLOW_DESCRIPTOR,
  BACKGROUND_TASK_DESCRIPTOR,
];
