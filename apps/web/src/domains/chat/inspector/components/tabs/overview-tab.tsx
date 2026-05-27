import { TriangleAlert } from "lucide-react";
import { type ReactNode } from "react";

import { Card } from "@vellum/design-library";
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
import type {
  LLMCallSummary,
  LLMRequestLogEntry,
  SyntheticCallEvent,
} from "@/domains/chat/types/inspector-types";

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
  const showFallback = !summary || isProviderOnlySummary(summary);
  const conversationTotals = renderConversationTotalsCard(
    conversationTotalEstimatedCostUsd,
  );

  // Synthetic agent-loop event (e.g. budget_yield_unrecovered): no LLM
  // call, so the normalized metadata + usage cards are meaningless.
  // Render a dedicated yield-notice card with the exact text the user
  // saw in chat plus the exit reason — that's what Vargas asked for
  // when he wanted Call 52 to land on "see why this turn failed".
  if (entry.syntheticEvent) {
    return (
      <div className="flex flex-col gap-4 p-4">
        {conversationTotals}
        <SyntheticEventCard
          event={entry.syntheticEvent}
          createdAt={entry.createdAt}
        />
      </div>
    );
  }

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
        rows={buildIdentityRows(
          summary,
          entry.createdAt,
          entry.agentLoopExitReason,
        )}
      />
      <MetadataCard
        title="Usage"
        subtitle="Token and call counts normalized by the assistant route."
        rows={buildUsageRows(summary)}
      />
    </div>
  );
}

function syntheticEventTitle(event: SyntheticCallEvent): string {
  switch (event.kind) {
    case "agentLoopYield":
      return "Agent loop yielded";
    default: {
      const _exhaustive: never = event.kind;
      return _exhaustive;
    }
  }
}

function SyntheticEventCard({
  event,
  createdAt,
}: {
  event: SyntheticCallEvent;
  createdAt: number;
}): ReactNode {
  return (
    <Card padding="md">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <TriangleAlert
            className="h-4 w-4"
            style={{ color: "var(--system-negative-strong)" }}
            aria-hidden
          />
          <span
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {syntheticEventTitle(event)}
          </span>
        </div>
        <span
          className="text-label-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          No LLM call was made for this entry — the agent loop emitted a
          system notice and ended the turn.
        </span>
        <div className="flex flex-col gap-2">
          <MetadataRowItem
            row={{
              label: "Exit reason",
              value: displayText(event.exitReason || null),
            }}
          />
          <MetadataRowItem
            row={{
              label: "Created",
              value: formattedCreatedAt(createdAt),
            }}
          />
        </div>
        {event.userMessageText ? (
          <p
            className="select-text whitespace-pre-wrap break-words text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            {event.userMessageText}
          </p>
        ) : null}
      </div>
    </Card>
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
  agentLoopExitReason: string | null | undefined,
): MetadataRow[] {
  const rows: MetadataRow[] = [
    { label: "Provider", value: displayProvider(summary.provider ?? null) },
    { label: "Model", value: displayText(summary.model ?? null) },
    { label: "Created", value: formattedCreatedAt(createdAt) },
    { label: "Stop reason", value: displayText(summary.stopReason ?? null) },
  ];
  if (agentLoopExitReason != null && agentLoopExitReason.trim().length > 0) {
    rows.push({
      label: "Loop exit reason",
      value: displayText(agentLoopExitReason),
    });
  }
  return rows;
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
    { label: "Estimated cost", value: formatCost(summary.estimatedCostUsd) },
    {
      label: "Request messages",
      value: formatCount(summary.requestMessageCount),
    },
    { label: "Tools available", value: formatCount(summary.requestToolCount) },
    { label: "Tool calls", value: formatCount(summary.responseToolCallCount ?? 0) },
  ];
  if (
    summary.durationMs != null &&
    Number.isFinite(summary.durationMs)
  ) {
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
