/**
 * The stacked agent marks that stand in for a conversation's sessions, capped
 * at {@link MAX_CHIPS_PER_GROUP} per status group.
 *
 * Shows WHO is working without anything being opened.
 *
 * Two status groups rather than one flat run, so running agents lead and
 * finished ones follow. Neither carries a status glyph: the trigger's own
 * gradient sweep already says something is working, and a pulsing indicator
 * beside it said the same thing twice in the same 36px row.
 */

import type { ReactNode } from "react";

import { ACP_RUN_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/acp-run";
import { SUBAGENT_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/subagent";

import type {
  ConversationActivity,
  ConversationActivityRow,
} from "@/domains/chat/hooks/use-conversation-activity";
import type { BackgroundProcessDescriptor } from "@/domains/chat/process-registry/types";

/**
 * The two kinds these surfaces cover, keyed for row lookup. Workflows and
 * background tools are deliberately absent: they keep their own surfaces.
 */
export const ACTIVITY_DESCRIPTORS: Record<
  ConversationActivityRow["kind"],
  BackgroundProcessDescriptor
> = {
  subagent: SUBAGENT_DESCRIPTOR,
  "acp-run": ACP_RUN_DESCRIPTOR,
};

export const RUNNING_GROUP_TESTID = "activity-trigger-running";
export const COMPLETED_GROUP_TESTID = "activity-trigger-completed";

/**
 * Visible marks per status group. The trigger can carry two groups at once and
 * shares a row with Assets and Progress, so more than this crowds the cluster.
 * Anything past it is simply not drawn; the panel lists every session.
 */
const MAX_CHIPS_PER_GROUP = 3;

/** The stacked chip a row contributes, from its own descriptor. */
function rowChip(row: ConversationActivityRow): ReactNode {
  const { pill } = ACTIVITY_DESCRIPTORS[row.kind];
  // Both covered kinds are `stacked`; the guard is for the type, and degrades
  // to no chip rather than throwing if a kind ever switches to a count pill.
  return pill.variant === "stacked" ? pill.renderChip(row.id) : null;
}

function TriggerGroup({
  rows,
  max,
  testId,
}: {
  rows: ConversationActivityRow[];
  max: number;
  testId: string;
}) {
  if (rows.length === 0) {
    return null;
  }
  // No `+N` remainder. The trigger is a glance, not a census: the marks say who
  // is working, and the exact count is in the accessible name and the panel the
  // trigger opens. A number tacked onto the stack read as a badge you were
  // meant to act on.
  return (
    <span data-testid={testId} className="inline-flex items-center gap-1">
      <span className="flex items-center">{rows.slice(0, max).map(rowChip)}</span>
    </span>
  );
}

export function ConversationActivityChips({
  activity,
  maxChips = MAX_CHIPS_PER_GROUP,
}: {
  activity: ConversationActivity;
  /** Visible chips per group before `+N`. Lower it on a narrow host. */
  maxChips?: number;
}) {
  return (
    <span className="pointer-events-none inline-flex items-center gap-2">
      {/* No status glyphs on either group. The marks are the content, and the
          "something is working" signal lives in the trigger's sweep. */}
      <TriggerGroup
        rows={activity.running}
        max={maxChips}
        testId={RUNNING_GROUP_TESTID}
      />
      <TriggerGroup
        rows={activity.completed}
        max={maxChips}
        testId={COMPLETED_GROUP_TESTID}
      />
    </span>
  );
}
