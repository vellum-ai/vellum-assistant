import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button, Card } from "@vellum/design-library";

import { useCompactionTrail } from "@/domains/chat/inspector/compaction-trail-api";
import type { CompactionTrailEvent } from "@/domains/chat/inspector/compaction-trail-fetch";
import {
  displayProvider,
  displayText,
  formatCost,
  formatCount,
  formattedCreatedAt,
  MISSING_VALUE,
} from "@/domains/chat/inspector/inspector-formatters";
import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

/**
 * Compaction tab — the compaction events that led up to the **selected
 * LLM call**, not the entire conversation. Mirrors the call-scoped
 * model the rest of the inspector tabs follow (Overview / Prompt /
 * Response / Raw all operate on the selected call too).
 *
 * Lazy-loaded: the fetch only fires when this tab mounts (i.e. is
 * selected), so other tabs render at full speed. Picking a different
 * call in the rail busts the query cache key, so the displayed trail
 * tracks the selection.
 *
 * Data source: `GET /v1/assistants/:id/conversations/:cid/compaction?callId=…`,
 * projected from `llm_request_logs` rows where
 * `call_site = "compactionAgent"`. The assistant resolves the trail's
 * floor server-side to the most recent non-`compactionAgent` call
 * before the selected one — so the events here are strictly the
 * compactions that ran between the previous outbound call and this
 * one, not the conversation's full compaction history. Whether
 * `llm_request_logs` is sufficient or we need a richer
 * `compaction_logs` table is still open — review feedback against
 * this surface drives that data-model decision.
 */
interface CompactionTabProps {
  assistantId: string | undefined;
  conversationId: string | undefined;
  /** The currently-selected LLM call from the rail. Scopes the trail. */
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
            Loading compaction trail…
          </span>
        </Card>
      </div>
    );
  }

  if (isError) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "Failed to load compaction trail.";
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
            No compaction ran before this call
          </p>
          <p
            className="mt-1 text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            The compactor only runs when the conversation crosses its
            context budget. If you expect events here, check that the
            conversation actually crossed the auto-compaction threshold
            prior to this call.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <SummaryCard events={events} />
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

function SummaryCard({
  events,
}: {
  events: CompactionTrailEvent[];
}): ReactNode {
  const total = events.length;
  const errorCount = events.filter(
    (e) => e.stopReason && e.stopReason !== "end_turn",
  ).length;
  // Aggregates fall back to MISSING_VALUE when ANY contributing event
  // is missing the field — otherwise partial data masquerades as an
  // exact total. The compactionAgent call-site fills these reliably
  // for healthy runs, but stamping is best-effort: a daemon crash
  // mid-compaction can leave a row with null tokens/cost.
  const inputTokenSum = sumOrNull(events.map((e) => e.inputTokens));
  const outputTokenSum = sumOrNull(events.map((e) => e.outputTokens));
  const avgDuration = avgOrNull(events.map((e) => e.durationMs));
  const totalCost = sumOrNull(events.map((e) => e.estimatedCostUsd));

  return (
    <Card padding="md">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            Compaction trail
          </span>
          <span
            className="text-label-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {total === 1
              ? "1 compaction before this call"
              : `${total} compactions before this call`}
            {errorCount > 0 ? ` · ${errorCount} failed` : ""}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <MetadataRow
            label="Total tokens compacted"
            value={inputTokenSum != null ? formatCount(inputTokenSum) : MISSING_VALUE}
          />
          <MetadataRow
            label="Total summary tokens"
            value={outputTokenSum != null ? formatCount(outputTokenSum) : MISSING_VALUE}
          />
          <MetadataRow
            label="Avg compaction latency"
            value={avgDuration != null ? `${formatCount(avgDuration)} ms` : MISSING_VALUE}
          />
          <MetadataRow
            label="Total compaction cost"
            value={totalCost != null ? formatCost(totalCost) : MISSING_VALUE}
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * Sum nullable numbers. Returns null if any value is null/undefined
 * or non-finite, so partial data renders as `MISSING_VALUE` rather
 * than masquerading as an exact total.
 */
function sumOrNull(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) return null;
    sum += v;
  }
  return sum;
}

/**
 * Mean of nullable numbers, rounded to the nearest integer. Returns
 * null if there are no values, or if any value is null/non-finite —
 * same contract as `sumOrNull`. Averaging over partial data would be
 * just as misleading as a coerced sum.
 */
function avgOrNull(values: Array<number | null | undefined>): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) return null;
    sum += v;
  }
  return Math.round(sum / values.length);
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
  const isError = event.stopReason != null && event.stopReason !== "end_turn";
  const compression = computeCompressionRatio(
    event.inputTokens,
    event.outputTokens,
  );

  return (
    <Card padding="md">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <StatusBadge isError={isError} />
            <span
              className="text-body-medium-default"
              style={{ color: "var(--content-default)" }}
            >
              Compaction {index}
              <span style={{ color: "var(--content-tertiary)" }}>
                {" "}/ {totalCount}
              </span>
            </span>
          </div>
          <span
            className="text-label-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {formattedCreatedAt(event.createdAt)}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <MetadataRow
            label="Model"
            value={`${displayProvider(event.provider)} · ${displayText(event.model)}`}
          />
          <MetadataRow
            label="Tokens"
            value={`${formatCount(event.inputTokens)} → ${formatCount(event.outputTokens)}${
              compression ? `  (${compression})` : ""
            }`}
          />
          <MetadataRow
            label="Messages compacted"
            value={formatCount(event.requestMessageCount)}
          />
          <MetadataRow
            label="Duration"
            value={
              event.durationMs != null && Number.isFinite(event.durationMs)
                ? `${formatCount(Math.round(event.durationMs))} ms`
                : MISSING_VALUE
            }
          />
          <MetadataRow
            label="Stop reason"
            value={displayText(event.stopReason)}
          />
          <MetadataRow
            label="Cost"
            value={formatCost(event.estimatedCostUsd)}
          />
        </div>

        {event.responsePreview ? (
          <div className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--border-base)" }}>
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
              {expanded ? "Hide summary excerpt" : "Show summary excerpt"}
            </button>
            {expanded ? (
              <p
                className="select-text whitespace-pre-wrap break-words text-body-medium-lighter"
                style={{ color: "var(--content-secondary)" }}
              >
                {event.responsePreview}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function StatusBadge({ isError }: { isError: boolean }): ReactNode {
  const Icon = isError ? AlertCircle : CheckCircle2;
  const color = isError ? "var(--content-warning)" : "var(--content-success)";
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
 * "184,231 → 4,872" reads better with the compression ratio next to it:
 * "(38× smaller)" makes the magnitude immediately legible.
 */
function computeCompressionRatio(
  input: number | null,
  output: number | null,
): string | null {
  if (input == null || output == null) return null;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (output <= 0 || input <= output) return null;
  const ratio = input / output;
  if (!Number.isFinite(ratio)) return null;
  return `${Math.round(ratio)}× smaller`;
}
