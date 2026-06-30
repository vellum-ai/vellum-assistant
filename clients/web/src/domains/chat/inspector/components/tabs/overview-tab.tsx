import { type ReactNode } from "react";

import {
  displayProvider,
  displayText,
  formatCacheTokens,
  formatCost,
  formatCount,
  formattedCreatedAt,
  isProviderOnlySummary,
  summaryFallbackMessage,
} from "@/domains/chat/inspector/inspector-formatters";
import { LlmCallErrorCard } from "@/domains/chat/inspector/components/llm-call-error-card";
import type {
  LatencyBreakdown,
  LLMCallSummary,
  LLMRequestLogEntry,
} from "@vellumai/assistant-api";
import { Card } from "@vellumai/design-library";

interface OverviewTabProps {
  entry: LLMRequestLogEntry;
  conversationTotalEstimatedCostUsd?: number | null;
}

interface MetadataRow {
  label: string;
  value: string;
}

/**
 * Overview tab rendering the normalized summary as a stack of cards:
 * optional conversation totals, identity (provider/model/created-at),
 * and usage (token + cost rows). Falls back to a single explanatory
 * card when the daemon couldn't normalize the call.
 */
export function OverviewTab({
  entry,
  conversationTotalEstimatedCostUsd,
}: OverviewTabProps): ReactNode {
  const summary = entry.summary;
  const error = entry.error ?? null;
  const hasError = error != null;
  const latency = entry.latency ?? null;
  const latencyCard =
    latency && latency.phases.length > 0 ? (
      <MetadataCard
        title="First-token latency"
        subtitle="Where this turn's time-to-first-token went, measured by the assistant."
        rows={buildLatencyRows(latency)}
      />
    ) : null;
  // A failed call gets a dedicated banner; only show the generic
  // "summary unavailable" fallback when the call didn't fail.
  const showFallback =
    !hasError && (!summary || isProviderOnlySummary(summary));
  // Skip the sea-of-"Unavailable" metadata cards on a failed call whose
  // summary never normalized past the provider name — the failure banner
  // already carries the useful signal.
  const showSummaryCards = summary != null && !isProviderOnlySummary(summary);
  const conversationTotals = renderConversationTotalsCard(
    conversationTotalEstimatedCostUsd,
  );

  if (showFallback) {
    return (
      <div className="flex flex-col gap-4 p-4">
        {conversationTotals}
        <FallbackCard
          message={summaryFallbackMessage(
            entry.createdAt,
            summary?.provider ?? null,
          )}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {conversationTotals}
      {hasError && <LlmCallErrorCard error={error} />}
      {showSummaryCards && (
        <>
          <MetadataCard
            title="Normalized metadata"
            subtitle="Provider, model, timestamps, and usage counts."
            rows={buildIdentityRows(
              summary,
              entry.createdAt,
              entry.agentLoopExitReason,
              hasError,
            )}
          />
          <MetadataCard
            title="Usage"
            subtitle="Token and call counts normalized by the assistant route."
            rows={buildUsageRows(summary, hasError)}
          />
        </>
      )}
      {latencyCard}
    </div>
  );
}

function formatMs(ms: number): string {
  return `${formatCount(Math.round(ms))} ms`;
}

/**
 * Build the first-token latency waterfall rows: the total-to-first-token
 * headline (first call of a turn only), then one row per phase
 * (queue → memory/context → setup → request prep → time-to-first-token →
 * generation), and the streamed first-token kind when known.
 */
function buildLatencyRows(latency: LatencyBreakdown): MetadataRow[] {
  const rows: MetadataRow[] = [];
  if (
    latency.totalToFirstTokenMs != null &&
    Number.isFinite(latency.totalToFirstTokenMs)
  ) {
    rows.push({
      label: "Total to first token",
      value: formatMs(latency.totalToFirstTokenMs),
    });
  }
  for (const phase of latency.phases) {
    rows.push({ label: phase.label, value: formatMs(phase.ms) });
  }
  if (latency.firstTokenKind) {
    rows.push({ label: "First token kind", value: latency.firstTokenKind });
  }
  return rows;
}

function renderConversationTotalsCard(
  conversationTotalEstimatedCostUsd: number | null | undefined,
): ReactNode {
  if (
    conversationTotalEstimatedCostUsd == null ||
    !Number.isFinite(conversationTotalEstimatedCostUsd)
  ) {
    return null;
  }
  return (
    <MetadataCard
      title="Conversation"
      subtitle="Running totals across every priced LLM call so far."
      rows={[
        {
          label: "Total cost so far",
          value: formatCost(conversationTotalEstimatedCostUsd),
        },
      ]}
    />
  );
}

function buildIdentityRows(
  summary: LLMCallSummary,
  createdAt: number | null | undefined,
  agentLoopExitReason: string | null | undefined,
  hasError: boolean,
): MetadataRow[] {
  const rows: MetadataRow[] = [
    { label: "Provider", value: displayProvider(summary.provider ?? null) },
    { label: "Model", value: displayText(summary.model ?? null) },
    { label: "Created", value: formattedCreatedAt(createdAt) },
    { label: "Stop reason", value: displayText(summary.stopReason ?? null) },
  ];
  if (hasError) {
    rows.push({ label: "Status", value: "Failed" });
  }
  if (agentLoopExitReason != null && agentLoopExitReason.trim().length > 0) {
    rows.push({
      label: "Loop exit reason",
      value: displayText(agentLoopExitReason),
    });
  }
  return rows;
}

function buildUsageRows(
  summary: LLMCallSummary,
  hasError: boolean,
): MetadataRow[] {
  const rows: MetadataRow[] = [
    { label: "Input tokens", value: formatCount(summary.inputTokens) },
    { label: "Output tokens", value: formatCount(summary.outputTokens) },
    {
      label: "Cache tokens",
      value: formatCacheTokens(
        summary.cacheCreationInputTokens,
        summary.cacheReadInputTokens,
      ),
    },
    // A rejected call billed nothing, so show an explicit $0.00 rather than
    // the "Unavailable" placeholder a missing cost would otherwise render.
    {
      label: "Estimated cost",
      value: hasError ? formatCost(0) : formatCost(summary.estimatedCostUsd),
    },
    {
      label: "Request messages",
      value: formatCount(summary.requestMessageCount),
    },
    { label: "Tools available", value: formatCount(summary.requestToolCount) },
    {
      label: "Tool calls",
      value: formatCount(summary.responseToolCallCount ?? 0),
    },
  ];
  if (summary.durationMs != null && Number.isFinite(summary.durationMs)) {
    rows.splice(4, 0, {
      label: "Duration",
      value: `${formatCount(Math.round(summary.durationMs))} ms`,
    });
  }
  return rows;
}

function CardHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <span
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {title}
      </span>
      {subtitle ? (
        <span
          className="text-label-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}

function MetadataCard({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: MetadataRow[];
}): ReactNode {
  return (
    <Card padding="md">
      <div className="flex flex-col gap-3">
        <CardHeader title={title} subtitle={subtitle} />
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <MetadataRowItem key={row.label} row={row} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function FallbackCard({ message }: { message: string }): ReactNode {
  return (
    <Card padding="md">
      <div className="flex flex-col gap-2">
        <CardHeader
          title="Normalized summary unavailable"
          subtitle="This call still has raw request and response payloads."
        />
        <p
          className="select-text whitespace-pre-wrap break-words text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          {message}
        </p>
      </div>
    </Card>
  );
}

function MetadataRowItem({ row }: { row: MetadataRow }): ReactNode {
  return (
    <div className="flex items-baseline gap-3">
      <span
        className="shrink-0 text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {row.label}
      </span>
      <span
        className="ml-auto select-text break-words text-right text-body-medium-lighter"
        style={{ color: "var(--content-default)" }}
      >
        {row.value}
      </span>
    </div>
  );
}
