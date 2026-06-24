/**
 * Inline subagent progress card rendered per-subagent in the assistant
 * transcript. A transparent, full-width list row (Figma node
 * `6063:148642`): a status indicator (running dots or terminal icon), the
 * subagent avatar, the `Task Name | detail` carousel, then a plain
 * "X steps" count and an in-flight stop button — laid out left→right.
 * Transparent by default; the whole row paints `--surface-active` at
 * `rounded-md` on hover.
 *
 * Subscribes to the subagent store via `useSubagentCardData(subagentId)`.
 * Returns `null` when the entry isn't in the store yet — handles the
 * spawn race where the assistant message containing the inline card
 * mounts a hair before the `subagent_spawned` SSE event lands. PR 8
 * wires this into the transcript; this PR ships the component standalone.
 *
 * Interaction model:
 *   - The leading content cluster (status indicator + avatar + carousel) is
 *     the open affordance: a `<span role="button">` carrying the
 *     `onSubagentClick` activation. Activating it opens the subagent's full
 *     timeline panel. There is no inline expand — the panel is the only
 *     detail view. The open affordance does not enclose the stop button, so
 *     the stop control stays an independent, separately focusable button.
 *   - Stop is exposed via `onStopSubagent`; a small stop button renders in
 *     the right cluster while the subagent is in-flight, as a sibling of the
 *     open affordance.
 */

import { AlertCircle, CheckCircle2, Square } from "lucide-react";
import { useCallback, type KeyboardEvent, type MouseEvent } from "react";

import { Button, Typography } from "@vellumai/design-library";

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
import { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { useSubagentCardData } from "@/domains/chat/hooks/use-subagent-card-data";
import { useSubagentStore } from "@/domains/chat/subagent-store";

export interface SubagentInlineProgressCardProps {
  subagentId: string;
  /**
   * Invoked when the user activates the row (anywhere but the stop button).
   * Routes to the subagent detail panel.
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
  // The subagent's task name (e.g. "research-car-brands") titles the row so it
  // reads as "which subagent"; the derived live status/detail moves to the
  // detail slot (below).
  const label = useSubagentStore((s) => s.byId[subagentId]?.label);
  // The `loading` state subsumes running / pending / awaiting_input
  // (see `deriveCardState` in use-subagent-card-data) — exactly the window
  // where stopping the subagent is a meaningful action.
  const isRunning = data?.state === "loading";

  const handleOpenClick = useCallback(() => {
    onSubagentClick?.(subagentId);
  }, [onSubagentClick, subagentId]);

  const handleOpenKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Only react when the open affordance itself is focused, so a stray
      // bubbled keydown can't hijack activation away from its origin.
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSubagentClick?.(subagentId);
      }
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
  // row so the transcript doesn't flicker an empty card.
  if (!data) return null;

  // Title = the subagent's task name. The derived status `data.currentStepTitle`
  // ("Working", "Searching the web") and its detail collapse into the detail
  // slot: prefer the specific detail, falling back to the status word when a
  // step carries none (e.g. a web_search, whose detail is empty) or when the
  // only "detail" is the label itself (no steps yet) — so the detail never
  // reads blank or echoes the title.
  const headerTitle = label ?? data.currentStepTitle;
  const headerInfo =
    data.currentStepInfo && data.currentStepInfo !== label
      ? data.currentStepInfo
      : data.currentStepTitle;

  // Leading status indicator. Mirrors the shared shell's `StatusIndicator`:
  // running → animated three-dot; terminal → green check / red alert. Kept
  // local rather than coupling the row to the shell's chrome.
  const statusIndicator = isRunning ? (
    <ThreeDotIndicator
      className="shrink-0"
      data-testid="subagent-inline-card-status-indicator"
    />
  ) : data.state === "complete" ? (
    <CheckCircle2
      data-testid="subagent-inline-card-status-indicator"
      aria-hidden="true"
      className="h-[14px] w-[14px] shrink-0 text-[var(--system-positive-strong)]"
    />
  ) : (
    <AlertCircle
      data-testid="subagent-inline-card-status-indicator"
      aria-hidden="true"
      className="h-[14px] w-[14px] shrink-0 text-[var(--system-negative-strong)]"
    />
  );

  // Plain tertiary "X steps" — hidden for 0/1-step rows where it's noise
  // next to the carousel detail that already describes the single step.
  const stepCount = data.stepCount;
  const showStepCount =
    !!stepCount &&
    !stepCount.startsWith("0 ") &&
    !stepCount.startsWith("1 ");

  // Absent `onSubagentClick`, the leading cluster is inert content — not
  // announced as a button and not focusable.
  const canOpen = !!onSubagentClick;

  return (
    <div
      data-testid="subagent-inline-progress-card"
      className="group flex w-full items-center justify-between gap-2 rounded-md p-2 text-left hover:bg-[var(--surface-active)]"
    >
      <span
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        aria-label={canOpen ? "Open subagent" : undefined}
        onClick={canOpen ? handleOpenClick : undefined}
        onKeyDown={canOpen ? handleOpenKeyDown : undefined}
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
      >
        {statusIndicator}
        <span className="mx-1 flex shrink-0 items-center">
          <SubagentAvatarChip subagentId={subagentId} size={16} />
        </span>
        <HeaderStepCarousel
          currentStepTitle={headerTitle}
          currentStepInfo={headerInfo}
          bypassDwell={data.state !== "loading"}
        />
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {showStepCount ? (
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
            data-testid="subagent-inline-card-step-count"
          >
            {stepCount}
          </Typography>
        ) : null}
        {onStopSubagent && isRunning ? (
          <Button
            variant="dangerGhost"
            size="compact"
            iconOnly={<Square fill="currentColor" />}
            aria-label="Stop subagent"
            data-testid="subagent-inline-card-stop"
            onClick={handleStop}
          />
        ) : null}
      </span>
    </div>
  );
}
