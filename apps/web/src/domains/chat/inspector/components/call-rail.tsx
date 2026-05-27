import { TriangleAlert } from "lucide-react";
import { type ReactNode } from "react";
import { Link } from "react-router";

import {
  displayProvider,
  displayText,
  formattedCreatedAt,
  MISSING_VALUE,
} from "@/domains/chat/inspector/inspector-formatters";
import type {
  LLMRequestLogEntry,
  SyntheticCallEvent,
} from "@/domains/chat/types/inspector-types";

interface CallRailProps {
  logs: LLMRequestLogEntry[];
  selectedLogId: string | undefined;
  buildCallHref: (logId: string) => string;
}

/**
 * Left rail listing every LLM call captured for the inspected message.
 *
 * Sort order: newest call on top, oldest on the bottom. The `Call N`
 * label tracks chronological order — Call 1 is the first call made
 * for this message, Call N is the most recent.
 */
export function CallRail({
  logs,
  selectedLogId,
  buildCallHref,
}: CallRailProps): ReactNode {
  if (!logs.length) {
    return (
      <div
        className="flex h-full items-center justify-center p-4 text-label-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        No LLM calls recorded.
      </div>
    );
  }

  const orderedLogs = [...logs].reverse();

  return (
    <nav className="flex flex-col gap-2 p-3" aria-label="LLM calls">
      <div
        className="px-1 text-label-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {logs.length === 1 ? "1 LLM call" : `${logs.length} LLM calls`}
      </div>
      {orderedLogs.map((entry, displayIndex) => (
        <CallRow
          key={entry.id}
          entry={entry}
          callNumber={logs.length - displayIndex}
          isSelected={entry.id === selectedLogId}
          isLatest={displayIndex === 0}
          href={buildCallHref(entry.id)}
        />
      ))}
    </nav>
  );
}

interface CallRowProps {
  entry: LLMRequestLogEntry;
  callNumber: number;
  isSelected: boolean;
  isLatest: boolean;
  href: string;
}

function CallRow({
  entry,
  callNumber,
  isSelected,
  isLatest,
  href,
}: CallRowProps): ReactNode {
  const syntheticEvent = entry.syntheticEvent ?? null;
  const isSynthetic = syntheticEvent !== null;
  const subtitle = isSynthetic
    ? syntheticEventLabel(syntheticEvent)
    : (buildCallSubtitle(entry) ?? "Unrecognized call");

  // Synthetic rows (e.g. budget_yield_unrecovered) represent agent-loop
  // events with no LLM call backing them. Render with a warning-tinted
  // border + icon so Vargas can spot a yield in the rail at a glance,
  // while still occupying a numbered call slot (his "Call 52" framing).
  const borderColor = isSelected
    ? "var(--border-active)"
    : isSynthetic
      ? "var(--system-negative-strong)"
      : "var(--border-base)";

  return (
    <Link
      to={href}
      aria-current={isSelected ? "page" : undefined}
      className="flex flex-col gap-1 rounded-md p-3 text-left no-underline transition-colors hover:opacity-90"
      style={{
        background: isSelected
          ? "var(--surface-active)"
          : "var(--surface-overlay)",
        border: `1px solid ${borderColor}`,
      }}
    >
      <div className="flex items-baseline gap-2">
        <span
          className="line-clamp-1 flex-1 text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {isSynthetic ? (
            <span className="inline-flex items-center gap-1.5">
              <TriangleAlert
                className="h-3.5 w-3.5"
                style={{ color: "var(--system-negative-strong)" }}
                aria-hidden
              />
              <span>Call {callNumber}</span>
            </span>
          ) : (
            <>Call {callNumber}</>
          )}
        </span>
        {isLatest ? (
          <span
            className="text-label-default"
            style={{ color: "var(--primary-default, var(--content-default))" }}
          >
            Latest
          </span>
        ) : null}
      </div>
      <div
        className="line-clamp-2 text-label-default"
        style={{
          color: isSynthetic
            ? "var(--system-negative-strong)"
            : "var(--content-secondary)",
        }}
      >
        {subtitle}
      </div>
      <div
        className="text-label-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {formattedCreatedAt(entry.createdAt)}
      </div>
    </Link>
  );
}

function buildCallSubtitle(entry: LLMRequestLogEntry): string | null {
  const provider = displayProvider(entry.summary?.provider ?? null);
  const model = entry.summary?.model ? displayText(entry.summary.model) : null;
  const parts = [provider !== MISSING_VALUE ? provider : null, model].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Short human label for the rail row's subtitle when the entry is a
 * synthetic agent-loop event. Maps each `kind` to a recognizable phrase
 * so the rail makes sense at a glance — distinct from the Overview tab,
 * which renders the full user-visible notice text.
 */
function syntheticEventLabel(event: SyntheticCallEvent): string {
  switch (event.kind) {
    case "agentLoopYield":
      return event.exitReason === "budget_yield_unrecovered"
        ? "Yield · compaction couldn't fit next step"
        : `Yield · ${event.exitReason || "agent loop"}`;
    default: {
      // Exhaustiveness check — TS narrows `event.kind` to `never` here.
      const _exhaustive: never = event.kind;
      return _exhaustive;
    }
  }
}
