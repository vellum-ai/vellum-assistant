import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button, Card } from "@vellum/design-library";

import { useCompactionTrail } from "@/domains/chat/inspector/compaction-trail-api.js";
import type { CompactionTrailEvent } from "@/domains/chat/inspector/compaction-trail-types.js";
import {
  displayProvider,
  displayText,
  formatCost,
  formatCount,
  formattedCreatedAt,
  MISSING_VALUE,
} from "@/domains/chat/inspector/inspector-formatters.js";

/**
 * Compaction tab — chronological trail of every compaction event in
 * the conversation. Lazy-loaded: the fetch only fires when this tab
 * mounts (i.e. is selected), so other tabs render at full speed.
 *
 * Today the data comes from `compaction-trail-mock.ts`. The real API
 * route (planned: `GET /v1/assistants/:id/conversations/:cid/compaction-trail`)
 * will return the same `CompactionTrailResponse` shape, projected from
 * `llm_request_logs` filtered by `call_site = "compactionAgent"`.
 * Whether the existing column is sufficient or we need a richer
 * `compaction_logs` table is the question this UI is here to answer
 * — review feedback drives that data-model decision.
 */
interface CompactionTabProps {
  assistantId: string | undefined;
  conversationId: string | undefined;
}

export function CompactionTab({
  assistantId,
  conversationId,
}: CompactionTabProps): ReactNode {
  const { data, isLoading, isError, error, refetch } = useCompactionTrail(
    assistantId,
    conversationId,
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
            No compaction events recorded for this conversation
          </p>
          <p
            className="mt-1 text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            The compactor only runs when the conversation crosses its
            context budget. If you expect events here, check that the
            conversation has actually been compacted (e.g. it's a long
            session that crossed the auto-compaction threshold).
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
  const inputTokenSum = events.reduce(
    (sum, e) => sum + (e.inputTokens ?? 0),
    0,
  );
  const outputTokenSum = events.reduce(
    (sum, e) => sum + (e.outputTokens ?? 0),
    0,
  );
  const durations = events
    .map((e) => e.durationMs)
    .filter((d): d is number => d != null && Number.isFinite(d));
  const avgDuration = durations.length
    ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
    : null;
  const totalCost = events.reduce(
    (sum, e) => sum + (e.estimatedCostUsd ?? 0),
    0,
  );

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
            {total === 1 ? "1 compaction" : `${total} compactions`}
            {errorCount > 0 ? ` · ${errorCount} failed` : ""}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <MetadataRow
            label="Total tokens compacted"
            value={formatCount(inputTokenSum)}
          />
          <MetadataRow
            label="Total summary tokens"
            value={formatCount(outputTokenSum)}
          />
          <MetadataRow
            label="Avg compaction latency"
            value={avgDuration != null ? `${formatCount(avgDuration)} ms` : MISSING_VALUE}
          />
          <MetadataRow label="Total compaction cost" value={formatCost(totalCost)} />
        </div>
      </div>
    </Card>
  );
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
