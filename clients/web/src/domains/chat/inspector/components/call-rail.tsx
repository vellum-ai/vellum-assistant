import { TriangleAlert } from "lucide-react";
import { type ReactNode } from "react";
import { Link } from "react-router";

import {
  displayProvider,
  displayText,
  formatCost,
  formattedCreatedAt,
  MISSING_VALUE,
} from "@/domains/chat/inspector/inspector-formatters";
import {
  CALL_SITE_COMPACTION_AGENT,
  CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE,
  type LLMRequestLogEntry,
} from "@vellumai/assistant-api";
import { Tooltip } from "@vellumai/design-library";

interface CallRailProps {
  logs: LLMRequestLogEntry[];
  selectedLogId: string | undefined;
  buildCallHref: (logId: string) => string;
  /**
   * Fires when a row is tapped, *before* `Link` navigation kicks in.
   *
   * The desktop rail lives in a persistent `<aside>` so it never needs
   * to know when a selection was made. The mobile bottom-sheet wrapper
   * (`mobile-call-selector.tsx`) hooks this to close itself once the
   * user picks a call — the URL update alone wouldn't reset the sheet's
   * local `open` state.
   */
  onSelect?: () => void;
  /**
   * Conversation-wide call numbers keyed by log id. Provided in
   * message-scoped mode so each row keeps its position from the start
   * of the conversation (e.g. "Call 12") instead of renumbering the
   * scoped subset from 1. Rows without an entry fall back to the
   * subset-relative number.
   */
  callNumbers?: ReadonlyMap<string, number>;
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
  onSelect,
  callNumbers,
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
          callNumber={callNumbers?.get(entry.id) ?? logs.length - displayIndex}
          isSelected={entry.id === selectedLogId}
          isLatest={displayIndex === 0}
          href={buildCallHref(entry.id)}
          onSelect={onSelect}
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
  onSelect?: () => void;
}

function CallRow({
  entry,
  callNumber,
  isSelected,
  isLatest,
  href,
  onSelect,
}: CallRowProps): ReactNode {
  const isSynthetic = isSyntheticAgentErrorMessage(entry);
  const isFailed = isFailedCall(entry);
  const isCompaction = isCompactionAgentCall(entry);
  const subtitle = buildCallSubtitle(entry) ?? "Unrecognized call";
  // A rejected call accrued no billable cost — show $0.00 rather than the
  // "Unavailable" placeholder a missing cost would otherwise render.
  const estimatedCost = isFailed
    ? formatCost(0)
    : formatCost(entry.summary?.estimatedCostUsd ?? null);

  // Synthetic rows (e.g. budget_yield_unrecovered) represent agent-loop
  // error messages with no LLM call backing them; failed rows are real
  // calls the provider rejected. Both render with a warning-tinted border
  // + icon so a problem turn is spottable in the rail at a glance, while
  // still occupying a numbered call slot so the "Call N" framing stays
  // consistent with the rest of the conversation.
  const isWarning = isSynthetic || isFailed;
  const borderColor = isSelected
    ? "var(--border-active)"
    : isWarning
      ? "var(--system-negative-strong)"
      : "var(--border-base)";

  return (
    <Link
      to={href}
      onClick={onSelect}
      aria-current={isSelected ? "page" : undefined}
      className="flex flex-col gap-2 rounded-md p-3 text-left no-underline transition-colors hover:opacity-90"
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
          {isWarning ? (
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
        {isFailed ? (
          <span
            className="rounded-[4px] px-1.5 py-0.5 text-label-default"
            style={{
              background: "var(--system-negative-weak)",
              color: "var(--system-negative-strong)",
            }}
          >
            Failed
          </span>
        ) : null}
        {isCompaction ? (
          <span
            className="rounded-[4px] px-1.5 py-0.5 text-label-default"
            style={{
              background: "var(--system-info-weak)",
              color: "var(--system-info-strong)",
            }}
          >
            Compaction
          </span>
        ) : null}
        {isLatest ? (
          <span
            className="rounded-[4px] px-1.5 py-0.5 text-label-default"
            style={{
              background: "var(--surface-base)",
              color: "var(--primary-default, var(--content-default))",
            }}
          >
            Latest
          </span>
        ) : null}
      </div>
      <Tooltip content={subtitle}>
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
      </Tooltip>
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        <span
          className="inline-flex items-baseline gap-1 rounded-[4px] px-1.5 py-0.5"
          style={{
            background: "var(--surface-base)",
            color: "var(--content-default)",
          }}
        >
          <span style={{ color: "var(--content-secondary)" }}>Cost</span>
          <span className="font-medium">{estimatedCost}</span>
        </span>
        <span className="min-w-0 flex-1 text-right">
          {formattedCreatedAt(entry.createdAt)}
        </span>
      </div>
    </Link>
  );
}

function isSyntheticAgentErrorMessage(entry: LLMRequestLogEntry): boolean {
  return entry.callSite === CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE;
}

/**
 * A real LLM call the provider rejected before returning a response. The
 * daemon records the failure as a structured `error` object on the entry.
 */
function isFailedCall(entry: LLMRequestLogEntry): boolean {
  return entry.error != null;
}

/**
 * Compaction summarizer calls are captured as ordinary `llm_request_log`
 * rows, so they appear in the rail alongside main-agent calls. The
 * "Compaction" pill tags them so the summarizer isn't mistaken for a
 * normal agent turn.
 */
function isCompactionAgentCall(entry: LLMRequestLogEntry): boolean {
  return entry.callSite === CALL_SITE_COMPACTION_AGENT;
}

/**
 * Single source of truth for a rail row's subtitle. For real LLM calls
 * this is `provider · model`; for synthetic error-message rows it's a
 * recognizable phrase derived from the `agentLoopExitReason` column.
 * Returns `null` when the row has neither — caller renders a generic
 * "Unrecognized call" string.
 */
function buildCallSubtitle(entry: LLMRequestLogEntry): string | null {
  if (isSyntheticAgentErrorMessage(entry)) {
    return syntheticErrorSubtitle(entry.agentLoopExitReason ?? null);
  }
  const provider = displayProvider(entry.summary?.provider ?? null);
  const model = entry.summary?.model ? displayText(entry.summary.model) : null;
  const parts = [provider !== MISSING_VALUE ? provider : null, model].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Maps the stamped `agent_loop_exit_reason` on a synthetic row to a
 * recognizable rail subtitle. New exit reasons added in the future
 * (out_of_funds, …) get their own branch here — the fallback keeps the
 * row rendering with the raw reason instead of a blank subtitle.
 */
function syntheticErrorSubtitle(exitReason: string | null): string {
  switch (exitReason) {
    case "budget_yield_unrecovered":
      return "Yield · compaction couldn't fit next step";
    case null:
    case "":
      return "Agent loop error";
    default:
      return `Agent loop error · ${exitReason}`;
  }
}
