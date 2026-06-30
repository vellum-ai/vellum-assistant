/**
 * Side-drawer detail panel for a background bash/host_bash task — a terminal
 * glyph + a status-derived title ("Running command" / "Command finished"), a
 * status badge plus (while running) a Stop button in the header, and the
 * command / captured output as code blocks.
 *
 * Thin like `AcpRunDetailPanel`: reuses `DetailShell` + the shared `CodeBlock`
 * rather than inventing new output rendering.
 */

import { useCallback, useState } from "react";

import { Typography } from "@vellumai/design-library";

import { BackgroundTaskStatusBadge } from "@/domains/chat/components/background-task-status-badge";
import { backgroundTaskGlyph } from "@/domains/chat/components/background-task-glyph";
import { DetailPanelStopButton } from "@/domains/chat/components/detail-panel-stop-button";
import { DetailShell } from "@/domains/chat/components/detail-shell";
import {
  CodeBlock,
  SectionLabel,
} from "@/domains/chat/components/tool-detail-panel";
import { stopBackgroundTask } from "@/domains/chat/utils/background-task-actions";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";
import {
  backgroundTaskTitle,
  isActiveBackgroundTaskStatus,
} from "@/utils/background-task-status";
import { captureError } from "@/lib/sentry/capture-error";

export interface BackgroundTaskDetailPanelProps {
  entry: BackgroundTaskEntry;
  onClose: () => void;
}

export function BackgroundTaskDetailPanel({
  entry,
  onClose,
}: BackgroundTaskDetailPanelProps) {
  const isRunning = isActiveBackgroundTaskStatus(entry.status);
  const isTerminal = !isRunning;
  // Output and exit code are only meaningful once the task has settled.
  const showOutput =
    isTerminal && entry.output !== undefined && entry.output !== "";
  const showExitCode = isTerminal && entry.exitCode != null;

  // Mirrors the inline card's Stop: optimistic, disabled after a click to
  // avoid a double-cancel. The panel's `entry` is a live store selector, so
  // the cancel settles the status and the button unmounts on its own.
  const [stopping, setStopping] = useState(false);
  const handleStop = useCallback(() => {
    setStopping(true);
    void stopBackgroundTask(entry.id).catch((err) => {
      setStopping(false);
      captureError(err, { context: "BackgroundTaskDetailPanel.stop" });
    });
  }, [entry.id]);

  return (
    <DetailShell
      Glyph={backgroundTaskGlyph(entry.toolName)}
      title={backgroundTaskTitle(entry.status)}
      headerTrailing={<BackgroundTaskStatusBadge status={entry.status} />}
      headerActions={
        isRunning ? (
          <DetailPanelStopButton
            onStop={handleStop}
            ariaLabel="Stop command"
            disabled={stopping}
          />
        ) : undefined
      }
      closeVariant="outlined"
      closeLabel="Close task detail"
      onClose={onClose}
    >
      <div>
        <SectionLabel>Command</SectionLabel>
        <CodeBlock text={entry.command} />
      </div>

      {showOutput && (
        <div className="mt-5">
          <SectionLabel>Output</SectionLabel>
          <CodeBlock text={entry.output as string} />
        </div>
      )}

      {showExitCode && (
        <Typography
          variant="body-small-default"
          as="p"
          className="mt-2 text-[var(--content-tertiary)]"
        >
          Exit code: {entry.exitCode}
        </Typography>
      )}
    </DetailShell>
  );
}
