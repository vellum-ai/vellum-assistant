/**
 * Combined per-assistant-turn progress card.
 *
 * Reuses `ToolProgressCardShell` for the chrome — the leading status
 * indicator, the animated carousel header (which "carousels" through steps as
 * `currentStepTitle` / `currentStepInfo` change), and the "N steps" pill. The
 * expanded body renders one `ToolStepPill` per `ActivityStep` in a wrapping
 * flex row; clicking a pill emits `onStepClick(anchorId)` so a parent can
 * scroll the transcript to that step's anchor.
 *
 * Purely presentational: no store, DOM, or scroll access. The `TurnActivity`
 * projection is built upstream (PR 2's `turn-activity.ts`); PR 7 wires
 * `onStepClick` to the transcript's `scrollToActivity` and sets `attachedBelow`
 * when a task-progress surface is hoisted beneath the card.
 */

import { ToolProgressCardShell } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";
import { ToolStepPill } from "@/domains/chat/components/tool-progress-card/tool-step-pill";
import type { IconName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import type {
  ActivityStep,
  TurnActivity,
} from "@/domains/chat/transcript/turn-activity";

export interface TurnProgressCardProps {
  activity: TurnActivity;
  onStepClick: (anchorId: string) => void;
  /** Whether the card starts expanded. Defaults to collapsed. */
  defaultExpanded?: boolean;
  /**
   * When `true`, the card drops its bottom rounding so a surface rendered
   * immediately below hugs it seamlessly.
   */
  attachedBelow?: boolean;
}

/**
 * Pick the pill glyph for a step. Tool steps reuse the icon derived upstream
 * (cast to the pill's `IconName` union); thinking steps use `sparkle` — the
 * closest valid `IconName` to the brain/thinking glyph used conceptually by
 * the ThinkingBlock. Falls back to `bolt` for any unrecognised value (the
 * pill itself also defaults to `Bolt` when the name misses `ICON_MAP`).
 */
function stepIconName(step: ActivityStep): IconName {
  if (step.kind === "thinking") return "sparkle";
  return (step.iconName as IconName | undefined) ?? "bolt";
}

export function TurnProgressCard({
  activity,
  onStepClick,
  defaultExpanded = false,
  attachedBelow = false,
}: TurnProgressCardProps) {
  if (activity.steps.length === 0) {
    return null;
  }

  const card = (
    <ToolProgressCardShell
      state={activity.state}
      currentStepTitle={activity.currentStepTitle}
      currentStepInfo={activity.currentStepInfo}
      stepCount={`${activity.stepCount} step${
        activity.stepCount === 1 ? "" : "s"
      }`}
      defaultExpanded={defaultExpanded}
    >
      <div className="flex flex-wrap gap-1.5 p-3">
        {activity.steps.map((step) => {
          const tone =
            step.state === "error" || step.state === "denied"
              ? "error"
              : "default";
          // `ToolStepPill` accepts only its declared primitive props (no
          // arbitrary-prop forwarding), so the test hooks live on a wrapping
          // span rather than the pill itself.
          return (
            <span
              key={step.anchorId}
              data-testid="turn-progress-pill"
              data-anchor-id={step.anchorId}
              className="contents"
            >
              <ToolStepPill
                iconName={stepIconName(step)}
                label={step.title}
                tone={tone}
                riskLevel={step.riskLevel}
                onClick={() => onStepClick(step.anchorId)}
              />
            </span>
          );
        })}
      </div>
    </ToolProgressCardShell>
  );

  // `attachedBelow` drops the shell's bottom rounding so a hoisted surface
  // below hugs it. The shell hardcodes `rounded-[var(--radius-lg)]` on its
  // outer wrapper and exposes no radius prop, so we target its direct child
  // with an arbitrary variant. `rounded-b-none` zeroes the bottom corners and,
  // at equal specificity, wins by stylesheet order over the rounded-all rule.
  if (attachedBelow) {
    return <div className="[&>*]:rounded-b-none">{card}</div>;
  }
  return card;
}
