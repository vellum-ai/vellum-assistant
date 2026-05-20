
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Square,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { BusyIndicator } from "@/domains/chat/components/busy-indicator.js";
import { AvatarRenderer } from "@/components/avatar-renderer.js";
import { Typography } from "@vellum/design-library";
import { BUNDLED_COMPONENTS } from "@/domains/avatar/bundled-components.js";
import { subagentTraits } from "@/domains/avatar/subagent-avatar.js";
import type { SubagentStatus } from "@/domains/chat/lib/event-types.js";
import type { SubagentEntry } from "@/domains/subagents/subagent-store.js";
import {
  isActiveStatus,
  statusColor,
  statusLabel,
} from "@/domains/subagents/status-helpers.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SubagentProgressCardProps {
  entries: SubagentEntry[];
  onSubagentClick: (subagentId: string) => void;
  onStopSubagent?: (subagentId: string) => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusIcon({
  status,
  size = "md",
}: {
  status: SubagentStatus;
  size?: "sm" | "md";
}) {
  const cls =
    size === "sm"
      ? "h-3 w-3 shrink-0"
      : "h-4 w-4 shrink-0";

  switch (status) {
    case "running":
    case "pending":
    case "awaiting_input":
      return <BusyIndicator size={size === "sm" ? 6 : 8} />;
    case "completed":
      return (
        <CheckCircle2
          className={cls}
          style={{ color: statusColor(status) }}
        />
      );
    case "failed":
    case "aborted":
      return (
        <AlertTriangle
          className={cls}
          style={{ color: statusColor(status) }}
        />
      );
    default:
      return <BusyIndicator size={size === "sm" ? 6 : 8} />;
  }
}

/** Compute the headline text for the card header (matches macOS headlineText). */
function computeHeadline(entries: SubagentEntry[]): string {
  const count = entries.length;
  const allTerminal = entries.every((e) => !isActiveStatus(e.status));

  if (allTerminal) {
    const failedCount = entries.filter(
      (e) => e.status === "failed" || e.status === "aborted",
    ).length;
    const suffix = count !== 1 ? "s" : "";
    if (failedCount > 0) {
      return `Completed ${count} subagent${suffix} (${failedCount} failed)`;
    }
    return `Completed ${count} subagent${suffix}`;
  }

  const running = entries.filter((e) => isActiveStatus(e.status)).length;
  const suffix = running !== 1 ? "s" : "";
  return `${running} subagent${suffix} running`;
}

/** Compute the aggregate status for the header icon. */
function aggregateStatus(entries: SubagentEntry[]): SubagentStatus {
  if (entries.some((e) => isActiveStatus(e.status))) {
    return "running";
  }
  if (entries.every((e) => e.status === "completed")) {
    return "completed";
  }
  if (entries.some((e) => e.status === "failed" || e.status === "aborted")) {
    return "failed";
  }
  return "completed";
}

// ---------------------------------------------------------------------------
// Subagent row (expanded list item)
// ---------------------------------------------------------------------------

function SubagentRow({
  entry,
  onSubagentClick,
  onStopSubagent,
}: {
  entry: SubagentEntry;
  onSubagentClick: (subagentId: string) => void;
  onStopSubagent?: (subagentId: string) => void;
}) {
  const isRunning = isActiveStatus(entry.status);
  const traits = subagentTraits(entry.subagentId);
  const handleSelect = useCallback(
    () => onSubagentClick(entry.subagentId),
    [onSubagentClick, entry.subagentId],
  );

  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onStopSubagent?.(entry.subagentId);
    },
    [onStopSubagent, entry.subagentId],
  );

  // PanelItem hides trailingAction by default (hover-only), but the stop
  // button must be always visible while the subagent is running. Using a
  // raw div with role="button" instead.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelect(); } }}
      className="flex w-full cursor-pointer items-center gap-2 py-1.5 pl-6 pr-3 transition-colors hover:bg-[var(--surface-hover)]"
    >
      <AvatarRenderer
        components={BUNDLED_COMPONENTS}
        bodyShapeId={traits?.bodyShape}
        eyeStyleId={traits?.eyeStyle}
        colorId={traits?.color}
        size={20}
      />
      {isRunning ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <Typography
            variant="label-medium-default"
            className="min-w-0 truncate text-[var(--content-default)]"
          >
            {entry.label}
          </Typography>
          <span className="shrink-0">
            <AnimatedDots />
          </span>
        </span>
      ) : (
        <Typography
          variant="label-medium-default"
          className="min-w-0 truncate text-[var(--content-default)]"
        >
          {entry.label}
        </Typography>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {!isRunning && (
          <Typography
            variant="label-small-default"
            className="shrink-0 text-[var(--content-tertiary)]"
          >
            {statusLabel(entry.status)}
          </Typography>
        )}
        {isRunning && onStopSubagent && (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Stop ${entry.label}`}
            onClick={handleStop}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleStop(e as unknown as React.MouseEvent); } }}
            className="flex shrink-0 cursor-pointer items-center justify-center p-1 text-[var(--content-tertiary)] hover:text-[var(--system-negative-strong)] transition-colors"
          >
            <Square className="h-2.5 w-2.5" fill="currentColor" />
          </span>
        )}
        <ChevronRight className="h-3 w-3 shrink-0 text-[var(--content-tertiary)]" />
      </span>
    </div>
  );
}

/** Animated dots indicator for running subagents. */
function AnimatedDots() {
  return (
    <span className="flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1 w-1 rounded-full bg-[var(--content-secondary)] animate-pulse"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SubagentProgressCard({
  entries,
  onSubagentClick,
  onStopSubagent,
}: SubagentProgressCardProps) {
  const agg = useMemo(() => aggregateStatus(entries), [entries]);
  const [localExpanded, setLocalExpanded] = useState<boolean | null>(null);
  const expanded = localExpanded ?? true;
  const headline = useMemo(() => computeHeadline(entries), [entries]);

  return (
    <div className="my-1 w-full">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setLocalExpanded((prev) => !(prev ?? true))}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 bg-[var(--surface-overlay)] ${
          expanded ? "rounded-b-none" : ""
        }`}
      >
        <StatusIcon status={agg} />
        <Typography
          variant="body-medium-lighter"
          className="min-w-0 truncate text-[var(--content-default)]"
        >
          {headline}
        </Typography>

        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {expanded ? (
            <ChevronUp className="h-3 w-3 text-[var(--content-tertiary)]" />
          ) : (
            <ChevronDown className="h-3 w-3 text-[var(--content-tertiary)]" />
          )}
        </span>
      </button>

      {/* Expanded content: individual subagent rows */}
      {expanded && (
        <div className="rounded-b-lg bg-[var(--surface-overlay)]">
          {entries.map((entry) => (
            <SubagentRow
              key={entry.subagentId}
              entry={entry}
              onSubagentClick={onSubagentClick}
              onStopSubagent={onStopSubagent}
            />
          ))}
        </div>
      )}
    </div>
  );
}
