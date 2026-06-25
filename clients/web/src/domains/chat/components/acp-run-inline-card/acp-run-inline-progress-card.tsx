/**
 * Inline ACP run progress card rendered per-`acp_spawn` run in the assistant
 * transcript. Built on `ToolProgressCardShell` with a `Code` glyph slotted into
 * the leading-icon slot — ACP runs have no avatar.
 *
 * Subscribes to the ACP run store via `useAcpRunCardData(acpSessionId)`, which
 * returns `null` until the run's entry lands — the spawn race where the
 * assistant message containing the inline card mounts a hair before the
 * `acp_session_spawned` event. The card renders `null` in that window so the
 * transcript layout doesn't jiggle.
 *
 * Interaction model mirrors the subagent / workflow inline cards:
 *   - Clicking anywhere on the header row opens the run's detail panel via
 *     `onAcpRunClick`. There is no inline expand — the panel is the detail view.
 *   - Stop cancels the run via `stopAcpRun` while it is in-flight. A parent may
 *     override the action with `onStopAcpRun`; otherwise the card cancels the
 *     run itself. The button disables after a click to avoid a double-cancel.
 */

import { Code, Square } from "lucide-react";
import { useCallback, useState, type MouseEvent } from "react";

import { Button } from "@vellumai/design-library";

import { ToolProgressCardShell } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";
import { useAcpRunCardData } from "@/domains/chat/components/acp-run-inline-card/use-acp-run-card-data";
import { stopAcpRun } from "@/domains/chat/utils/acp-run-actions";
import { captureError } from "@/lib/sentry/capture-error";

export interface AcpRunInlineProgressCardProps {
  acpSessionId: string;
  /** Open the run's detail panel (header-row activation, not the stop button). */
  onAcpRunClick?: (acpSessionId: string) => void;
  /** Override the stop action; defaults to cancelling the run directly. */
  onStopAcpRun?: (acpSessionId: string) => void;
}

export function AcpRunInlineProgressCard({
  acpSessionId,
  onAcpRunClick,
  onStopAcpRun,
}: AcpRunInlineProgressCardProps) {
  const data = useAcpRunCardData(acpSessionId);
  // The shell's `loading` state is the live window where stopping the run is a
  // meaningful action (see `deriveCardState`).
  const isRunning = data?.state === "loading";
  const [stopping, setStopping] = useState(false);

  const handleHeaderClick = useCallback(() => {
    onAcpRunClick?.(acpSessionId);
  }, [onAcpRunClick, acpSessionId]);

  const handleStop = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      setStopping(true);
      if (onStopAcpRun) {
        onStopAcpRun(acpSessionId);
        return;
      }
      void stopAcpRun(acpSessionId).catch((err) => {
        setStopping(false);
        captureError(err, { context: "AcpRunInlineProgressCard.stop" });
      });
    },
    [onStopAcpRun, acpSessionId],
  );

  // Spawn race: assistant message references a run before its spawn event
  // lands. Render `null` rather than a blank shell so the transcript doesn't
  // flicker an empty card.
  if (!data) return null;

  const leadingIcon = <Code size={20} aria-hidden />;

  // Stop is a real action whenever the run is in-flight (it cancels the run
  // directly), so render it regardless of whether a parent passed a handler.
  const actionSlot = isRunning ? (
    <Button
      variant="dangerGhost"
      size="compact"
      iconOnly={<Square fill="currentColor" />}
      aria-label="Stop run"
      data-testid="acp-run-inline-card-stop"
      disabled={stopping}
      onClick={handleStop}
    />
  ) : undefined;

  return (
    <div className="w-full" data-testid="acp-run-inline-progress-card">
      <ToolProgressCardShell
        data-testid="acp-run-inline-card-shell"
        statusIndicatorTestId="acp-run-inline-card-status-indicator"
        state={data.state}
        leadingIcon={leadingIcon}
        currentStepTitle={data.currentStepTitle}
        currentStepInfo={data.currentStepInfo}
        stepCount={data.stepCount}
        // No inline timeline to reveal — the detail panel is the only detail
        // view, so the expanded body stays disabled.
        disableExpand
        headerActionSlot={actionSlot}
        onHeaderClick={onAcpRunClick ? handleHeaderClick : undefined}
        headerAriaLabel={onAcpRunClick ? "Open run" : undefined}
      >
        {/* Children unused — `disableExpand` suppresses the body region. */}
        <span className="hidden" />
      </ToolProgressCardShell>
    </div>
  );
}
