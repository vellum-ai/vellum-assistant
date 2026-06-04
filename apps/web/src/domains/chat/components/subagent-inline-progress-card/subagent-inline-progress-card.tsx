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
 *   - Clicking anywhere on the header row opens the subagent's full
 *     timeline panel via `onSubagentClick`. There is no inline expand —
 *     the panel is the only detail view, so a separate open affordance
 *     and an inline timeline both end up redundant.
 *   - Stop is exposed via `onStopSubagent`; the shell renders a small
 *     stop chip in the right rail while the subagent is in-flight.
 */

import { Square } from "lucide-react";
import { useCallback, type MouseEvent } from "react";

import { Button } from "@vellumai/design-library";

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
import { PhaseGroupedStepList } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { ToolProgressCardShell } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";
import { useSubagentCardData } from "@/domains/chat/hooks/use-subagent-card-data";

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

  const handleHeaderClick = useCallback(() => {
    onSubagentClick?.(subagentId);
  }, [onSubagentClick, subagentId]);

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

  const leadingIcon = <SubagentAvatarChip subagentId={subagentId} size={20} />;

  // Stop button only — the open affordance is gone; the whole header row
  // now fires `onSubagentClick` via the shell's `onHeaderClick` override.
  // The shell slots this into a right-aligned flex rail (8px gap to the
  // step-count pill); we use the design-library icon button so the stop
  // affordance matches the platform button chrome.
  const actionSlot =
    onStopSubagent && isRunning ? (
      <Button
        variant="dangerGhost"
        size="compact"
        iconOnly={<Square fill="currentColor" />}
        aria-label="Stop subagent"
        data-testid="subagent-inline-card-stop"
        onClick={handleStop}
      />
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
        // The shell's expanded body is unused — there is no inline timeline
        // to reveal. Disabling expand keeps the shell from tracking state
        // that would never be exposed via UI.
        disableExpand
        headerActionSlot={actionSlot}
        onHeaderClick={onSubagentClick ? handleHeaderClick : undefined}
        headerAriaLabel={
          onSubagentClick ? "Open subagent" : undefined
        }
      >
        {/* Children unused — `disableExpand` suppresses the body region. */}
        <div className="hidden">
          <PhaseGroupedStepList steps={data.steps} />
        </div>
      </ToolProgressCardShell>
    </div>
  );
}
