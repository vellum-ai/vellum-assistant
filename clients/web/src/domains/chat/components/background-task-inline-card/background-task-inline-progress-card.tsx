/**
 * Inline background-task progress card rendered per backgrounded `bash` /
 * `host_bash` run in the assistant transcript. Built on `ToolProgressCardShell`
 * with a `SquareTerminal` glyph slotted into the leading-icon slot.
 *
 * Subscribes to the background task store via `useBackgroundTaskCardData(id)`,
 * which returns `null` until the task's entry lands — the window where the
 * assistant message containing the inline card mounts a hair before the
 * `background_tool_started` event. The card renders `null` in that window so the
 * transcript layout doesn't jiggle.
 *
 * Interaction model mirrors the ACP / subagent / workflow inline cards:
 *   - Clicking anywhere on the header row opens the task's detail panel via
 *     `onClick`. There is no inline expand — the panel is the detail view.
 *   - Stop cancels the task via `stopBackgroundTask` while it is running. The
 *     button disables after a click to avoid a double-cancel.
 */

import { Square, SquareTerminal } from "lucide-react";
import { useCallback, useState, type MouseEvent } from "react";

import { Button } from "@vellumai/design-library";

import { ToolProgressCardShell } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";
import { useBackgroundTaskCardData } from "@/domains/chat/components/background-task-inline-card/use-background-task-card-data";
import { stopBackgroundTask } from "@/domains/chat/utils/background-task-actions";
import { captureError } from "@/lib/sentry/capture-error";

export interface BackgroundTaskInlineProgressCardProps {
  id: string;
  /** Open the task's detail panel (header-row activation, not the stop button). */
  onClick?: (id: string) => void;
}

export function BackgroundTaskInlineProgressCard({
  id,
  onClick,
}: BackgroundTaskInlineProgressCardProps) {
  const data = useBackgroundTaskCardData(id);
  // The shell's `loading` state is the live window where stopping the task is a
  // meaningful action (see `deriveCardState`).
  const isRunning = data?.state === "loading";
  const [stopping, setStopping] = useState(false);

  const handleHeaderClick = useCallback(() => {
    onClick?.(id);
  }, [onClick, id]);

  const handleStop = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      setStopping(true);
      void stopBackgroundTask(id).catch((err) => {
        setStopping(false);
        captureError(err, { context: "BackgroundTaskInlineProgressCard.stop" });
      });
    },
    [id],
  );

  // Start race: no entry yet (see header).
  if (!data) return null;

  const leadingIcon = <SquareTerminal size={20} aria-hidden />;

  const actionSlot = isRunning ? (
    <Button
      variant="dangerGhost"
      size="compact"
      iconOnly={<Square fill="currentColor" />}
      aria-label="Stop command"
      data-testid="background-task-inline-card-stop"
      disabled={stopping}
      onClick={handleStop}
    />
  ) : undefined;

  return (
    <div className="w-full" data-testid="background-task-inline-progress-card">
      <ToolProgressCardShell
        data-testid="background-task-inline-card-shell"
        statusIndicatorTestId="background-task-inline-card-status-indicator"
        state={data.state}
        leadingIcon={leadingIcon}
        currentStepTitle={data.title}
        currentStepInfo={data.info}
        // Background tasks have no discrete steps, so the count pill stays empty.
        stepCount=""
        // No inline timeline to reveal — the detail panel is the only detail
        // view, so the expanded body stays disabled.
        disableExpand
        headerActionSlot={actionSlot}
        onHeaderClick={onClick ? handleHeaderClick : undefined}
        headerAriaLabel={onClick ? "Open command" : undefined}
      >
        {/* Children unused — `disableExpand` suppresses the body region. */}
        <span className="hidden" />
      </ToolProgressCardShell>
    </div>
  );
}
