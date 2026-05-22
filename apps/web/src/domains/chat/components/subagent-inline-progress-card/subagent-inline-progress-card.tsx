/**
 * Inline subagent progress card rendered per-subagent in the assistant
 * transcript. Built on `ToolProgressCardShell` with the
 * `SubagentAvatarChip` slotted into the leading-icon slot per
 * Figma node `4922-103839`.
 *
 * Subscribes to the subagent store via `useSubagentCardData(subagentId)`.
 * Returns `null` when the entry isn't in the store yet — handles the
 * spawn race where the assistant message containing the inline card
 * mounts a hair before the `subagent_spawned` SSE event lands. PR 8
 * wires this into the transcript; this PR ships the component standalone.
 *
 * Interaction model:
 *   - Clicking the card header expands/collapses the body inline (the
 *     shell's default behaviour).
 *   - The "open" affordance in the right rail opens the subagent's full
 *     timeline panel via `onSubagentClick` — preserves the side-panel
 *     route users had before the inline-card rollout.
 *   - Stop is exposed via `onStopSubagent`; the shell renders a small
 *     stop chip in the right rail next to the open button while the
 *     subagent is in-flight.
 */

import { ExternalLink, Square } from "lucide-react";
import { useCallback, type MouseEvent } from "react";

import { SubagentAvatarChip } from "@/domains/avatar/subagent-avatar-chip.js";
import { PhaseGroupedStepList } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list.js";
import { ToolProgressCardShell } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell.js";
import { useSubagentCardData } from "@/domains/chat/hooks/use-subagent-card-data.js";

export interface SubagentInlineProgressCardProps {
  subagentId: string;
  /**
   * Invoked when the user activates the "open full timeline" button in
   * the right rail. Routes to the subagent detail panel.
   */
  onSubagentClick?: (subagentId: string) => void;
  /**
   * Invoked when the user activates the stop button while the subagent
   * is in-flight. Omitted callers hide the button entirely.
   */
  onStopSubagent?: (subagentId: string) => void;
}

export function SubagentInlineProgressCard({
  subagentId,
  onSubagentClick,
  onStopSubagent,
}: SubagentInlineProgressCardProps) {
  const data = useSubagentCardData(subagentId);
  // The shell's `loading` state subsumes running / pending / awaiting_input
  // (see `deriveCardState` in use-subagent-card-data) — exactly the window
  // where stopping the subagent is a meaningful action.
  const isRunning = data?.state === "loading";

  const handleOpen = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onSubagentClick?.(subagentId);
    },
    [onSubagentClick, subagentId],
  );

  const handleStop = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onStopSubagent?.(subagentId);
    },
    [onStopSubagent, subagentId],
  );

  // Spawn-race: assistant message references a subagent before the
  // `subagent_spawned` event lands. Render `null` rather than a blank
  // shell so the transcript doesn't flicker an empty card.
  if (!data) return null;

  const leadingIcon = <SubagentAvatarChip subagentId={subagentId} size={16} />;

  // Action cluster slotted into the shell's `headerActionSlot`. The shell
  // positions it just to the left of the step-count pill so we no longer
  // need fragile per-consumer pixel offsets to align with the pill chrome.
  const hasAction = Boolean(onSubagentClick || (onStopSubagent && isRunning));
  const actionSlot = hasAction ? (
    <>
      {onStopSubagent && isRunning && (
        <button
          type="button"
          aria-label="Stop subagent"
          data-testid="subagent-inline-card-stop"
          onClick={handleStop}
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--system-negative-strong)]"
        >
          <Square className="h-3 w-3" fill="currentColor" />
        </button>
      )}
      {onSubagentClick && (
        <button
          type="button"
          aria-label="Open subagent timeline"
          data-testid="subagent-inline-card-open"
          onClick={handleOpen}
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]"
        >
          <ExternalLink className="h-3 w-3" />
        </button>
      )}
    </>
  ) : undefined;

  return (
    <div className="w-full" data-testid="subagent-inline-progress-card">
      <ToolProgressCardShell
        data-testid="subagent-inline-card-shell"
        statusIndicatorTestId="subagent-inline-card-status-indicator"
        state={data.state}
        leadingIcon={leadingIcon}
        currentStepTitle={data.currentStepTitle}
        currentStepInfo={data.currentStepInfo}
        stepCount={data.stepCount}
        disableExpand={data.steps.length === 0}
        headerActionSlot={actionSlot}
      >
        <div className="flex w-full flex-col gap-3 px-3 pb-3">
          <PhaseGroupedStepList steps={data.steps} />
        </div>
      </ToolProgressCardShell>
    </div>
  );
}
