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

import { DetailShell } from "@/domains/chat/components/detail-shell";
import { CodeBlock } from "@/domains/chat/components/tool-detail-panel";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";
import {
  backgroundTaskStatusColor,
  backgroundTaskStatusLabel,
  isActiveBackgroundTaskStatus,
} from "@/utils/background-task-status";

export interface BackgroundTaskDetailPanelProps {
  entry: BackgroundTaskEntry;
  onClose: () => void;
}

/** Uppercase section label in `--content-tertiary`. */
function SectionLabel({ children }: { children: string }) {
  return (
    <Typography
      variant="label-small-default"
      as="div"
      className="mb-1.5 uppercase tracking-wider text-[var(--content-tertiary)]"
    >
      {children}
    </Typography>
  );
}

/** Status pill — dot + label tinted by the task's semantic status color. */
function StatusBadge({ status }: { status: BackgroundTaskEntry["status"] }) {
  const color = backgroundTaskStatusColor(status);
  return (
    <div
      className="mb-4 inline-flex items-center gap-1.5 text-label-small-default"
      style={{ color }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      {backgroundTaskStatusLabel(status)}
    </div>
  );
}

export function BackgroundTaskDetailPanel({
  entry,
  onClose,
}: BackgroundTaskDetailPanelProps) {
  // Output is only meaningful once the task has settled (terminal status).
  const showOutput =
    !isActiveBackgroundTaskStatus(entry.status) &&
    entry.output !== undefined &&
    entry.output !== "";

  return (
    <DetailShell
      Glyph={SquareTerminal}
      title={entry.command}
      closeLabel="Close task detail"
      onClose={onClose}
    >
      <StatusBadge status={entry.status} />

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
