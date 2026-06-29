/**
 * Side-drawer detail panel for a background bash/host_bash task — a terminal
 * glyph + the command as title, a status badge, and the command / captured
 * output as code blocks.
 *
 * Thin like `AcpRunDetailPanel`: reuses `DetailShell` + the shared `CodeBlock`
 * rather than inventing new output rendering.
 */

import { SquareTerminal } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { BackgroundTaskStatusBadge } from "@/domains/chat/components/background-task-status-badge";
import { DetailShell } from "@/domains/chat/components/detail-shell";
import {
  CodeBlock,
  SectionLabel,
} from "@/domains/chat/components/tool-detail-panel";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";
import { isActiveBackgroundTaskStatus } from "@/utils/background-task-status";

export interface BackgroundTaskDetailPanelProps {
  entry: BackgroundTaskEntry;
  onClose: () => void;
}

export function BackgroundTaskDetailPanel({
  entry,
  onClose,
}: BackgroundTaskDetailPanelProps) {
  const isTerminal = !isActiveBackgroundTaskStatus(entry.status);
  // Output and exit code are only meaningful once the task has settled.
  const showOutput =
    isTerminal && entry.output !== undefined && entry.output !== "";
  const showExitCode = isTerminal && entry.exitCode != null;

  return (
    <DetailShell
      Glyph={SquareTerminal}
      title={entry.command}
      closeLabel="Close task detail"
      onClose={onClose}
    >
      <div className="mb-4 flex items-center gap-2">
        <BackgroundTaskStatusBadge status={entry.status} />
        {showExitCode && (
          <Typography
            variant="body-small-default"
            as="span"
            className="text-[var(--content-tertiary)]"
          >
            Exit code: {entry.exitCode}
          </Typography>
        )}
      </div>

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
    </DetailShell>
  );
}
