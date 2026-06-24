// Inline per-subagent progress row in the transcript (Figma 6063:148642):
// status indicator → avatar → Task Name | detail carousel → "X steps" → stop,
// with a full-row --surface-active hover. The leading cluster is the open
// affordance (role="button"); the stop button stays a separate sibling so it
// isn't nested inside an interactive element.

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
  /** Open the subagent detail panel (row activation, not the stop button). */
  onSubagentClick?: (subagentId: string) => void;
  /** Stop an in-flight subagent; omit to hide the stop button. */
  onStopSubagent?: (subagentId: string) => void;
}

export function SubagentInlineProgressCard({
  subagentId,
  onSubagentClick,
  onStopSubagent,
}: SubagentInlineProgressCardProps) {
  const data = useSubagentCardData(subagentId);
  const label = useSubagentStore((s) => s.byId[subagentId]?.label);
  // "loading" = running / pending / awaiting_input (see deriveCardState).
  const isRunning = data?.state === "loading";

  const handleOpenClick = useCallback(() => {
    onSubagentClick?.(subagentId);
  }, [onSubagentClick, subagentId]);

  const handleOpenKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore keydowns bubbled from children (e.g. the stop button).
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

  // Spawn race: card mounts before the subagent_spawned event lands.
  if (!data) return null;

  // Title = task name; detail prefers the live step info, else the status word
  // (so it never reads blank or just echoes the title).
  const headerTitle = label ?? data.currentStepTitle;
  const headerInfo =
    data.currentStepInfo && data.currentStepInfo !== label
      ? data.currentStepInfo
      : data.currentStepTitle;

  // Local copy of the shell's StatusIndicator — avoids coupling the row to the
  // shared shell's chrome.
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

  // Hidden for 0/1-step rows where the carousel detail already says it.
  const stepCount = data.stepCount;
  const showStepCount =
    !!stepCount &&
    !stepCount.startsWith("0 ") &&
    !stepCount.startsWith("1 ");

  // Without a click handler the leading cluster is inert (not a button).
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
