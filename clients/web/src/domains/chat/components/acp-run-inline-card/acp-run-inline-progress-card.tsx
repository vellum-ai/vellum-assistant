// Inline per-`acp_spawn` run progress row in the transcript and the
// active-acp-runs overlay. Mirrors the subagent / workflow inline cards
// (`SubagentInlineProgressCard`, `WorkflowInlineProgressCard`) exactly so the
// three read as one language: status indicator → `Code` glyph → Title | detail
// carousel → "X steps" → stop, on the transparent chat background with a
// full-row --surface-active hover (no boxed surface). The leading cluster is
// the open affordance (role="button"); the stop button stays a separate sibling
// so it isn't nested inside an interactive element.
//
// Subscribes to the ACP run store via `useAcpRunCardData(acpSessionId)`. Returns
// `null` until the run's entry lands — the spawn race where the assistant
// message containing the inline card mounts a hair before the
// `acp_session_spawned` event. The card renders `null` in that window so the
// transcript layout doesn't jiggle.
//
// Interaction model:
//   - Clicking the leading cluster opens the run's detail panel via
//     `onAcpRunClick`. There is no inline expand — the panel is the detail view.
//   - Stop cancels the run via `stopAcpRun` while it is in-flight; the button
//     disables after a click to avoid a double-cancel.

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Code,
  Square,
} from "lucide-react";
import {
  useCallback,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { Button, Typography } from "@vellumai/design-library";

import { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { useAcpRunCardData } from "@/domains/chat/components/acp-run-inline-card/use-acp-run-card-data";
import type { ToolProgressCardState } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";
import { stopAcpRun } from "@/domains/chat/utils/acp-run-actions";
import { captureError } from "@/lib/sentry/capture-error";

export interface AcpRunInlineProgressCardProps {
  acpSessionId: string;
  /** Open the run's detail panel (leading-cluster activation, not the stop button). */
  onAcpRunClick?: (acpSessionId: string) => void;
}

const STATUS_TESTID = "acp-run-inline-card-status-indicator";

/**
 * Local copy of the shell's StatusIndicator chrome (matches the subagent /
 * workflow rows) — keeps ACP's richer state set: `warning` (a cancelled-but-
 * completed run = partial work) renders an amber triangle distinct from the red
 * error alert.
 */
function StatusIndicator({ state }: { state: ToolProgressCardState }) {
  switch (state) {
    case "loading":
      return <ThreeDotIndicator data-testid={STATUS_TESTID} className="shrink-0" />;
    case "complete":
      return (
        <CheckCircle2
          data-testid={STATUS_TESTID}
          aria-hidden="true"
          data-state="complete"
          className="h-[14px] w-[14px] shrink-0 text-[var(--system-positive-strong)]"
        />
      );
    case "warning":
      return (
        <AlertTriangle
          data-testid={STATUS_TESTID}
          aria-hidden="true"
          data-state="warning"
          className="h-[14px] w-[14px] shrink-0 text-[var(--system-mid-strong)]"
        />
      );
    case "denied":
    case "error":
    default:
      return (
        <AlertCircle
          data-testid={STATUS_TESTID}
          aria-hidden="true"
          data-state={state}
          className="h-[14px] w-[14px] shrink-0 text-[var(--system-negative-strong)]"
        />
      );
  }
}

export function AcpRunInlineProgressCard({
  acpSessionId,
  onAcpRunClick,
}: AcpRunInlineProgressCardProps) {
  const data = useAcpRunCardData(acpSessionId);
  // "loading" = the live window where stopping the run is meaningful.
  const isRunning = data?.state === "loading";
  const [stopping, setStopping] = useState(false);

  const handleOpenClick = useCallback(() => {
    onAcpRunClick?.(acpSessionId);
  }, [onAcpRunClick, acpSessionId]);

  const handleOpenKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore keydowns bubbled from children (e.g. the stop button).
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onAcpRunClick?.(acpSessionId);
      }
    },
    [onAcpRunClick, acpSessionId],
  );

  const handleStop = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      setStopping(true);
      void stopAcpRun(acpSessionId).catch((err) => {
        setStopping(false);
        captureError(err, { context: "AcpRunInlineProgressCard.stop" });
      });
    },
    [acpSessionId],
  );

  // Spawn race: no entry yet (see header).
  if (!data) return null;

  // Hidden for 0/1-step rows where the carousel detail already says it.
  const stepCount = data.stepCount;
  const showStepCount =
    !!stepCount && !stepCount.startsWith("0 ") && !stepCount.startsWith("1 ");

  // Without a click handler the leading cluster is inert (not a button).
  const canOpen = !!onAcpRunClick;

  return (
    <div
      data-testid="acp-run-inline-progress-card"
      className="group flex w-full items-center justify-between gap-2 rounded-md p-2 text-left hover:bg-[var(--surface-active)]"
    >
      <span
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        aria-label={canOpen ? "Open run" : undefined}
        onClick={canOpen ? handleOpenClick : undefined}
        onKeyDown={canOpen ? handleOpenKeyDown : undefined}
        className={`flex min-w-0 flex-1 items-center gap-1 text-left${
          canOpen ? " cursor-pointer" : ""
        }`}
      >
        <StatusIndicator state={data.state} />
        <span className="mx-1 flex shrink-0 items-center">
          <Code className="h-4 w-4 text-[var(--content-secondary)]" aria-hidden />
        </span>
        <HeaderStepCarousel
          currentStepTitle={data.currentStepTitle}
          currentStepInfo={data.currentStepInfo}
          bypassDwell={data.state !== "loading"}
        />
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {showStepCount ? (
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
            data-testid="acp-run-inline-card-step-count"
          >
            {stepCount}
          </Typography>
        ) : null}
        {isRunning ? (
          <Button
            variant="dangerGhost"
            size="compact"
            iconOnly={<Square fill="currentColor" />}
            aria-label="Stop run"
            data-testid="acp-run-inline-card-stop"
            disabled={stopping}
            onClick={handleStop}
          />
        ) : null}
      </span>
    </div>
  );
}
