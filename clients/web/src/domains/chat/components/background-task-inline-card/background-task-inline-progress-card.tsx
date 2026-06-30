// Inline per-background-task progress row in the transcript. Mirrors the
// subagent / workflow inline cards exactly so the three read as one language:
// status indicator → terminal glyph → title | command carousel → stop, on the
// transparent chat background with a full-row --surface-active hover (no boxed
// surface). The leading cluster is the open affordance (role="button"); the
// stop button stays a separate sibling so it isn't nested inside it.
//
// Subscribes to the background task store via `useBackgroundTaskCardData(id)`,
// which returns `null` until the task's entry lands — the spawn race where the
// assistant message mounts a hair before the `background_tool_started` event.
// The card renders `null` in that window so the transcript layout doesn't jiggle.
//
// Interaction model:
//   - Clicking the leading cluster opens the task's detail panel via `onClick`.
//     There is no inline expand — the panel is the only detail view.
//   - Stop cancels the task via `stopBackgroundTask` while it is running; the
//     button disables after a click to avoid a double-cancel.

import { AlertCircle, CheckCircle2, Square, SquareTerminal } from "lucide-react";
import {
  useCallback,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { Button } from "@vellumai/design-library";

import { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { useBackgroundTaskCardData } from "@/domains/chat/components/background-task-inline-card/use-background-task-card-data";
import { stopBackgroundTask } from "@/domains/chat/utils/background-task-actions";
import { captureError } from "@/lib/sentry/capture-error";

const STATUS_TESTID = "background-task-inline-card-status-indicator";

export interface BackgroundTaskInlineProgressCardProps {
  id: string;
  /** Open the task's detail panel (row activation, not the stop button). */
  onClick?: (id: string) => void;
}

export function BackgroundTaskInlineProgressCard({
  id,
  onClick,
}: BackgroundTaskInlineProgressCardProps) {
  const data = useBackgroundTaskCardData(id);
  // "loading" = the live window where stopping the task is meaningful.
  const isRunning = data?.state === "loading";
  const [stopping, setStopping] = useState(false);

  const handleOpenClick = useCallback(() => {
    onClick?.(id);
  }, [onClick, id]);

  const handleOpenKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore keydowns bubbled from children (e.g. the stop button).
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick?.(id);
      }
    },
    [onClick, id],
  );

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

  // Local copy of the shared StatusIndicator chrome (matches the subagent /
  // workflow rows). Terminal icons carry `data-state` so the panel/tests can
  // read the settled state; the running ThreeDotIndicator has none.
  const statusIndicator = isRunning ? (
    <ThreeDotIndicator className="shrink-0" data-testid={STATUS_TESTID} />
  ) : data.state === "complete" ? (
    <CheckCircle2
      data-testid={STATUS_TESTID}
      data-state="complete"
      aria-hidden="true"
      className="h-[14px] w-[14px] shrink-0 text-[var(--system-positive-strong)]"
    />
  ) : (
    <AlertCircle
      data-testid={STATUS_TESTID}
      data-state={data.state === "warning" ? "warning" : "error"}
      aria-hidden="true"
      className="h-[14px] w-[14px] shrink-0 text-[var(--system-negative-strong)]"
    />
  );

  // Without a click handler the leading cluster is inert (not a button).
  const canOpen = !!onClick;

  return (
    <div
      data-testid="background-task-inline-progress-card"
      className="group flex w-full items-center justify-between gap-2 rounded-md p-2 text-left hover:bg-[var(--surface-active)]"
    >
      <span
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        aria-label={canOpen ? "Open command" : undefined}
        onClick={canOpen ? handleOpenClick : undefined}
        onKeyDown={canOpen ? handleOpenKeyDown : undefined}
        className={`flex min-w-0 flex-1 items-center gap-1 text-left${
          canOpen ? " cursor-pointer" : ""
        }`}
      >
        {statusIndicator}
        <span className="mx-1 flex shrink-0 items-center">
          <SquareTerminal
            className="h-4 w-4 text-[var(--content-secondary)]"
            aria-hidden
          />
        </span>
        <HeaderStepCarousel
          currentStepTitle={data.title}
          currentStepInfo={data.info}
          bypassDwell={data.state !== "loading"}
        />
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {isRunning ? (
          <Button
            variant="dangerGhost"
            size="compact"
            iconOnly={<Square fill="currentColor" />}
            aria-label="Stop command"
            data-testid="background-task-inline-card-stop"
            disabled={stopping}
            onClick={handleStop}
          />
        ) : null}
      </span>
    </div>
  );
}
