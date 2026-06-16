import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, MinusCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button, Card } from "@vellumai/design-library";

import { useCompactionTrail } from "@/domains/chat/inspector/compaction-trail-api";
import type { CompactionTrailEvent } from "@/domains/chat/inspector/compaction-trail-fetch";
import {
    displayText,
    formatCount,
    formattedCreatedAt,
    MISSING_VALUE,
} from "@/domains/chat/inspector/inspector-formatters";
import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

/**
 * Compaction tab — the compaction(s) attributed to the **selected LLM
 * call**. A compaction is tied to the call that ran immediately after
 * it, so this shows only the compactions that landed between the
 * previous outbound call and the selected one — usually zero or one,
 * occasionally a short recovery cascade.
 *
 * Lazy-loaded: the fetch only fires when this tab is selected. Picking
 * a different call in the rail busts the query cache key, so the
 * displayed compaction tracks the selection.
 *
 * Data source: `GET /v1/assistants/:id/conversations/:cid/compaction?callId=…`,
 * served from the ClickHouse compaction-logs table (with a legacy
 * `llm_request_logs` fallback for conversations that predate it). Each
 * event reports the context-token and message reduction the compaction
 * achieved, the summarizer call's own token cost, and the summary text
 * that replaced the compacted span.
 */
interface CompactionTabProps {
  assistantId: string | undefined;
  conversationId: string | undefined;
  /** The currently-selected LLM call from the rail. Scopes which compaction(s) show. */
  entry: LLMRequestLogEntry;
}

export function CompactionTab({
  assistantId,
  conversationId,
  entry,
}: CompactionTabProps): ReactNode {
  const { data, isLoading, isError, error, refetch } = useCompactionTrail(
    assistantId,
    conversationId,
    entry.id,
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Card padding="md">
          <span
            className="text-body-medium-default"
            style={{ color: "var(--content-secondary)" }}
          >
            Loading compaction…
          </span>
        </Card>
      </div>
    );
  }

  if (isError) {
    const message =
      error instanceof Error ? error.message : "Failed to load compaction.";
    return (
      <div className="flex flex-col gap-4 p-4">
        <Card padding="md">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <AlertCircle
                size={16}
                aria-hidden
                style={{ color: "var(--content-secondary)" }}
              />
              <span
                className="text-body-medium-default"
                style={{ color: "var(--content-default)" }}
              >
                Failed to load
              </span>
            </div>
            <p
              className="text-label-default"
              style={{ color: "var(--content-secondary)" }}
            >
              {message}
            </p>
            <div>
              <Button
                variant="outlined"
                size="compact"
                onClick={() => refetch()}
              >
                Retry
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const events = data?.events ?? [];

  if (events.length === 0) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Card padding="md">
          <p
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            No compaction is tied to this call
          </p>
          <p
            className="mt-1 text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            A compaction is attributed to the call that ran right after
            it. If you expect one here, check that the conversation
            crossed its context budget just before this call.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {events.map((event, index) => (
        <EventCard
          key={event.id}
          event={event}
          index={index + 1}
          totalCount={events.length}
        />
      ))}
    </div>
  );
}

type OutcomeTone = "success" | "warning" | "neutral";

interface CompactionOutcome {
  tone: OutcomeTone;
  label: string;
  detail: string | null;
}

/**
 * Derives the human-facing outcome from the event's state flags. The
 * compaction-logs table records `compacted` (did it actually replace
 * messages) and `summaryFailed` (did the summarizer call throw)
 * independently, plus a `skipReason` for no-ops.
 *
 * All three flags land null only on the degraded `llm_request_logs`
 * fallback, which can recover the summarizer call but not the
 * applied/skipped decision or the before/after context state. Those rows
 * exist only for compactions that produced a summary, so the outcome is
 * unknown rather than failed — don't claim the run never completed.
 */
function describeOutcome(event: CompactionTrailEvent): CompactionOutcome {
  if (event.summaryFailed === true) {
    return {
      tone: "warning",
      label: "Compaction failed",
      detail: "The summarizer call errored, so the context was left intact.",
    };
  }
  if (event.compacted === true) {
    return { tone: "success", label: "Compacted", detail: null };
  }
  if (event.compacted === false) {
    return {
      tone: "neutral",
      label: "No change",
      detail: event.skipReason ? displayText(event.skipReason) : null,
    };
  }
  return {
    tone: "neutral",
    label: "Outcome unavailable",
    detail:
      "Detailed before/after metrics weren't recorded for this compaction.",
  };
}

function EventCard({
  event,
  index,
  totalCount,
}: {
  event: CompactionTrailEvent;
  index: number;
  totalCount: number;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const outcome = describeOutcome(event);
  const reduction = computeReductionRatio(
    event.contextTokensBefore,
    event.contextTokensAfter,
  );

  return (
    <Card padding="md">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <StatusBadge tone={outcome.tone} />
            <span
              className="text-body-medium-default"
              style={{ color: "var(--content-default)" }}
            >
              {outcome.label}
              {totalCount > 1 ? (
                <span style={{ color: "var(--content-tertiary)" }}>
                  {" "}· {index} of {totalCount}
                </span>
              ) : null}
            </span>
          </div>
          <span
            className="text-label-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {formattedCreatedAt(event.createdAt)}
          </span>
        </div>

        {outcome.detail ? (
          <p
            className="text-label-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {outcome.detail}
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <MetadataRow label="Trigger" value={displayText(event.trigger)} />
          <MetadataRow
            label="Context tokens"
            value={`${formatCount(event.contextTokensBefore)} → ${formatCount(
              event.contextTokensAfter,
            )}${reduction ? `  (${reduction})` : ""}`}
          />
          <MetadataRow
            label="Messages"
            value={`${formatCount(event.messagesBefore)} → ${formatCount(
              event.messagesAfter,
            )}`}
          />
          <MetadataRow
            label="Compacted / preserved"
            value={formatMessageBreakdown(
              event.compactedMessages,
              event.preservedTailMessages,
            )}
          />
          <MetadataRow label="Duration" value={formatDuration(event.durationMs)} />
          <MetadataRow label="Summary model" value={displayText(event.summaryModel)} />
          <MetadataRow
            label="Summary cost"
            value={formatSummarizerUsage(
              event.summaryInputTokens,
              event.summaryOutputTokens,
            )}
          />
        </div>

        {event.summaryText ? (
          <div
            className="flex flex-col gap-2 border-t pt-3"
            style={{ borderColor: "var(--border-base)" }}
          >
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-label-medium-default hover:underline"
              style={{ color: "var(--content-secondary)" }}
            >
              {expanded ? (
                <ChevronDown size={14} aria-hidden />
              ) : (
                <ChevronRight size={14} aria-hidden />
              )}
              {expanded ? "Hide summary text" : "Show summary text"}
            </button>
            {expanded ? (
              <p
                className="select-text whitespace-pre-wrap break-words text-body-medium-lighter"
                style={{ color: "var(--content-secondary)" }}
              >
                {event.summaryText}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function StatusBadge({ tone }: { tone: OutcomeTone }): ReactNode {
  const Icon =
    tone === "warning"
      ? AlertCircle
      : tone === "success"
        ? CheckCircle2
        : MinusCircle;
  const color =
    tone === "warning"
      ? "var(--content-warning)"
      : tone === "success"
        ? "var(--content-success)"
        : "var(--content-tertiary)";
  return (
    <span className="inline-flex items-center" style={{ color }}>
      <Icon size={14} aria-hidden />
    </span>
  );
}

function MetadataRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactNode {
  return (
    <div className="flex items-baseline gap-3">
      <span
        className="shrink-0 text-label-default"
        style={{ color: "var(--content-secondary)", minWidth: "10rem" }}
      >
        {label}
      </span>
      <span
        className="text-label-default"
        style={{ color: "var(--content-default)" }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * "900 → 300" reads better with the reduction factor next to it:
 * "(3× smaller)" makes the magnitude of the context reduction
 * immediately legible. Returns null when the numbers don't represent a
 * real reduction (missing, non-finite, or not actually smaller).
 */
function computeReductionRatio(
  before: number | null,
  after: number | null,
): string | null {
  if (before == null || after == null) {
    return null;
  }
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return null;
  }
  if (after <= 0 || before <= after) {
    return null;
  }
  const ratio = before / after;
  if (!Number.isFinite(ratio)) {
    return null;
  }
  return `${Math.round(ratio)}× smaller`;
}

/**
 * Renders the message-count breakdown, dropping whichever part the row
 * doesn't carry (the legacy `llm_request_logs` fallback knows the
 * compacted count but not the preserved tail).
 */
function formatMessageBreakdown(
  compacted: number | null,
  preserved: number | null,
): string {
  const parts: string[] = [];
  if (compacted != null && Number.isFinite(compacted)) {
    parts.push(`${formatCount(compacted)} compacted`);
  }
  if (preserved != null && Number.isFinite(preserved)) {
    parts.push(`${formatCount(preserved)} preserved`);
  }
  return parts.length ? parts.join(" · ") : MISSING_VALUE;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs == null || !Number.isFinite(durationMs)) {
    return MISSING_VALUE;
  }
  return `${formatCount(Math.round(durationMs))} ms`;
}

/**
 * The summarizer LLM call's own token usage — distinct from the
 * context reduction above. This is what running the compaction *cost*,
 * not what it saved (the headline `3 → 882`-style numbers belong here,
 * not on the context-tokens row).
 */
function formatSummarizerUsage(
  input: number | null,
  output: number | null,
): string {
  const haveInput = input != null && Number.isFinite(input);
  const haveOutput = output != null && Number.isFinite(output);
  if (!haveInput && !haveOutput) {
    return MISSING_VALUE;
  }
  return `${formatCount(input)} in / ${formatCount(output)} out`;
}
