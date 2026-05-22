
import {
  AlertCircle,
  Bolt,
  CheckCircle2,
  Code,
  FileText,
  Monitor,
  Pen,
  Plug,
  Sparkles,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import { Typography } from "@vellum/design-library";

import { BusyIndicator } from "@/domains/chat/components/busy-indicator.js";
import type { IconName } from "@/domains/chat/components/tool-progress-card/derive-step-label.js";

/**
 * Map each `IconName` from `deriveStepLabel` to its concrete lucide icon.
 *
 * Centralised here so the dispatcher row doesn't have to branch on icon
 * identifiers — `deriveStepLabel` chooses the name, this map renders it.
 */
const ICON_MAP: Record<IconName, LucideIcon> = {
  code: Code,
  file: FileText,
  pen: Pen,
  monitor: Monitor,
  plug: Plug,
  sparkle: Sparkles,
  "user-plus": UserPlus,
  bolt: Bolt,
};

/**
 * A single non-web tool-call step row inside the expanded
 * `ToolCallProgressCard`. Renders a leading status icon (busy dot while
 * running, check / alert when terminal), a tool-specific glyph chosen via
 * `iconName`, the step's title, an optional info subtext, and an optional
 * duration label on the right.
 *
 * The row geometry mirrors the embedded `ToolCallChip` layout the unified
 * card replaced: 24-pixel left indent under the carousel header, gap-2
 * between status icon / glyph / label, and a right-aligned duration cluster.
 */
export function ToolStepRow({
  title,
  info,
  iconName,
  status,
  durationLabel,
}: {
  title: string;
  info: string;
  iconName: IconName;
  status: "running" | "completed" | "error" | "denied";
  /** Pre-formatted duration label (e.g. "2s"). Empty / omitted hides the cluster. */
  durationLabel?: string;
}) {
  const Glyph = ICON_MAP[iconName] ?? Bolt;
  return (
    <div className="flex min-w-0 items-center gap-2 pl-6 pr-3 py-2 text-body-small-default">
      <StatusIcon status={status} />
      <Glyph
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-[var(--content-secondary)]"
      />
      <Typography
        variant="body-small-default"
        className="min-w-0 truncate text-[var(--content-default)]"
      >
        {title}
      </Typography>
      {info ? (
        <Typography
          variant="body-small-default"
          className="min-w-0 truncate text-[var(--content-secondary)]"
        >
          {info}
        </Typography>
      ) : null}
      {durationLabel ? (
        <Typography
          variant="label-small-default"
          className="ml-auto shrink-0 text-[var(--content-tertiary)]"
        >
          {durationLabel}
        </Typography>
      ) : null}
    </div>
  );
}

function StatusIcon({
  status,
}: {
  status: "running" | "completed" | "error" | "denied";
}) {
  if (status === "running") {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <BusyIndicator size={6} />
      </span>
    );
  }
  if (status === "error" || status === "denied") {
    return (
      <AlertCircle
        aria-hidden="true"
        data-status={status}
        className="h-4 w-4 shrink-0 text-[var(--system-negative-strong)]"
      />
    );
  }
  return (
    <CheckCircle2
      aria-hidden="true"
      data-status="completed"
      className="h-4 w-4 shrink-0 text-[var(--system-positive-strong)]"
    />
  );
}
