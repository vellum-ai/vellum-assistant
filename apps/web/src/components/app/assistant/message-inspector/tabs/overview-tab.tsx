
import { type ReactNode } from "react";

import { Card } from "@vellum/design-library/components/card";
import {
  compactToolNames,
  displayProvider,
  displayText,
  formatCacheTokens,
  formatCost,
  formatCount,
  formattedCreatedAt,
  isProviderOnlySummary,
  MISSING_VALUE,
  summaryFallbackMessage,
  truncatedResponsePreview,
} from "@/domains/chat/lib/inspector-formatters.js";
import type {
  LLMCallSummary,
  LLMRequestLogEntry,
} from "@/domains/chat/lib/inspector-types.js";

interface OverviewTabProps {
  entry: LLMRequestLogEntry;
  conversationTotalEstimatedCostUsd?: number | null;
}

interface MetadataRow {
  label: string;
  value: string;
}

/**
 * Overview tab — Web port of `MessageInspectorOverviewTab.swift`.
 *
 * Renders the normalized summary as a stack of cards: optional
 * conversation totals (running cost so far), identity (provider /
 * model / created-at), usage (token + cost rows), response preview,
 * and tool-call list. Falls back to a single explanatory card when
 * the daemon couldn't normalize the call (provider-only / nil
 * summary) — the Raw tab still has the underlying payloads.
 */
export function OverviewTab({
  entry,
  conversationTotalEstimatedCostUsd,
}: OverviewTabProps): ReactNode {
  const summary = entry.summary;
  const showFallback = !summary || isProviderOnlySummary(summary);
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
      <MetadataCard
        title="Normalized metadata"
        subtitle="Provider, model, timestamps, and usage counts."
        rows={buildIdentityRows(summary, entry.createdAt)}
      />
      <MetadataCard
        title="Usage"
        subtitle="Token and call counts normalized by the assistant route."
        rows={buildUsageRows(summary)}
      />
      <SecondaryCard
        title="Response preview"
        body={truncatedResponsePreview(summary.responsePreview ?? null)}
      />
      <SecondaryCard
        title="Tool calls"
        body={compactToolNames(summary.toolCallNames ?? null)}
      />
    </div>
  );
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
): MetadataRow[] {
  return [
    { label: "Provider", value: displayProvider(summary.provider ?? null) },
    { label: "Model", value: displayText(summary.model ?? null) },
    { label: "Created", value: formattedCreatedAt(createdAt) },
    {
      label: "Status",
      value: displayText(summary.status ?? null),
    },
    {
      label: "Stop reason",
      value: displayText(summary.stopReason ?? null),
    },
  ];
}

function buildUsageRows(summary: LLMCallSummary): MetadataRow[] {
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
    {
      label: "Estimated cost",
      value: formatCost(summary.estimatedCostUsd),
    },
    {
      label: "Request messages",
      value: formatCount(summary.requestMessageCount),
    },
    {
      label: "Tools available",
      value: formatCount(summary.requestToolCount),
    },
    {
      label: "Tool calls",
      value: formatCount(summary.responseToolCallCount),
    },
  ];
  // Surface duration when present — not in macOS' reference rows but
  // useful for web debugging and the daemon already populates it.
  if (
    summary.durationMs != null &&
    Number.isFinite(summary.durationMs as number)
  ) {
    rows.splice(4, 0, {
      label: "Duration",
      value: `${formatCount(Math.round(summary.durationMs as number))} ms`,
    });
  }
  return rows;
}

interface CardHeaderProps {
  title: string;
  subtitle?: string;
}

function CardHeader({ title, subtitle }: CardHeaderProps): ReactNode {
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

interface MetadataCardProps {
  title: string;
  subtitle: string;
  rows: MetadataRow[];
}

function MetadataCard({
  title,
  subtitle,
  rows,
}: MetadataCardProps): ReactNode {
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

interface SecondaryCardProps {
  title: string;
  body: string;
}

function SecondaryCard({ title, body }: SecondaryCardProps): ReactNode {
  return (
    <Card padding="md">
      <div className="flex flex-col gap-2">
        <CardHeader title={title} />
        <p
          className="select-text whitespace-pre-wrap break-words text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          {body || MISSING_VALUE}
        </p>
      </div>
    </Card>
  );
}

interface FallbackCardProps {
  message: string;
}

function FallbackCard({ message }: FallbackCardProps): ReactNode {
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

interface MetadataRowItemProps {
  row: MetadataRow;
}

function MetadataRowItem({ row }: MetadataRowItemProps): ReactNode {
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
