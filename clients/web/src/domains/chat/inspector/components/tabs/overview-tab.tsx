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
import { useTranslation } from "@/i18n";
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
  /** Render inset under the preceding top-level row (latency sub-steps). */
  indent?: boolean;
  /** Explicit render key for rows whose label isn't unique in the card. */
  rowKey?: string;
}

type OverviewTranslate = ReturnType<typeof useTranslation<"chat">>["t"];

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
  const { t } = useTranslation("chat");
  const summary = entry.summary;
  const error = entry.error ?? null;
  const hasError = error != null;
  const latency = entry.latency ?? null;
  const latencyCard =
    latency && latency.phases.length > 0 ? (
      <MetadataCard
        title={t("overviewTab.firstTokenLatencyTitle")}
        subtitle={t("overviewTab.firstTokenLatencySubtitle")}
        rows={buildLatencyRows(latency, t)}
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
    t,
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
          t={t}
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
            title={t("overviewTab.normalizedMetadataTitle")}
            subtitle={t("overviewTab.normalizedMetadataSubtitle")}
            rows={buildIdentityRows(
              summary,
              entry.createdAt,
              entry.agentLoopExitReason,
              hasError,
              t,
            )}
          />
          <MetadataCard
            title={t("overviewTab.usageTitle")}
            subtitle={t("overviewTab.usageSubtitle")}
            rows={buildUsageRows(summary, hasError, t)}
          />
        </>
      )}
      {latencyCard}
    </div>
  );
}

function formatMs(ms: number, t: OverviewTranslate): string {
  return t("overviewTab.latencyMs", { ms: formatCount(Math.round(ms)) });
}

/**
 * The daemon floors recorded sub-spans at 10ms (`MIN_SUB_SPAN_MS` in
 * `assistant/src/daemon/turn-latency-sub-spans.ts`); the remainder row uses
 * the same threshold so a residue made purely of floored-away noise stays
 * hidden.
 */
const OTHER_MIN_MS = 10;

/**
 * Build the first-token latency waterfall rows: the total-to-first-token
 * headline (first call of a turn only), then one row per phase
 * (queue → memory/context → setup → request prep → time-to-first-token →
 * generation), and the streamed first-token kind when known. A phase with
 * instrumented sub-steps gets an indented row per sub-step (execution
 * order) plus an "Other" remainder for wall clock no sub-step claimed.
 */
function buildLatencyRows(
  latency: LatencyBreakdown,
  t: OverviewTranslate,
): MetadataRow[] {
  const rows: MetadataRow[] = [];
  if (
    latency.totalToFirstTokenMs != null &&
    Number.isFinite(latency.totalToFirstTokenMs)
  ) {
    rows.push({
      label: t("overviewTab.totalToFirstTokenLabel"),
      value: formatMs(latency.totalToFirstTokenMs, t),
    });
  }
  for (const phase of latency.phases) {
    rows.push({ label: phase.label, value: formatMs(phase.ms, t) });
    const subPhases = phase.subPhases ?? [];
    for (const sub of subPhases) {
      rows.push({
        label: sub.label,
        value: formatMs(sub.ms, t),
        indent: true,
        rowKey: `${phase.key}:${sub.key}`,
      });
    }
    if (subPhases.length > 0) {
      const attributed = subPhases.reduce((total, sub) => total + sub.ms, 0);
      const remainder = phase.ms - attributed;
      if (remainder >= OTHER_MIN_MS) {
        rows.push({
          label: t("overviewTab.otherLabel"),
          value: formatMs(remainder, t),
          indent: true,
          rowKey: `${phase.key}:other`,
        });
      }
    }
  }
  if (latency.firstTokenKind) {
    rows.push({
      label: t("overviewTab.firstTokenKindLabel"),
      value: latency.firstTokenKind,
    });
  }
  return rows;
}

function renderConversationTotalsCard(
  conversationTotalEstimatedCostUsd: number | null | undefined,
  t: OverviewTranslate,
): ReactNode {
  if (
    conversationTotalEstimatedCostUsd == null ||
    !Number.isFinite(conversationTotalEstimatedCostUsd)
  ) {
    return null;
  }
  return (
    <MetadataCard
      title={t("overviewTab.conversationTitle")}
      subtitle={t("overviewTab.conversationSubtitle")}
      rows={[
        {
          label: t("overviewTab.totalCostSoFarLabel"),
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
  t: OverviewTranslate,
): MetadataRow[] {
  const rows: MetadataRow[] = [
    {
      label: t("overviewTab.providerLabel"),
      value: displayProvider(summary.provider ?? null),
    },
    {
      label: t("overviewTab.modelLabel"),
      value: displayText(summary.model ?? null),
    },
    {
      label: t("overviewTab.createdLabel"),
      value: formattedCreatedAt(createdAt),
    },
    {
      label: t("overviewTab.stopReasonLabel"),
      value: displayText(summary.stopReason ?? null),
    },
  ];
  if (hasError) {
    rows.push({ label: t("overviewTab.statusLabel"), value: t("overviewTab.failedStatus") });
  }
  if (agentLoopExitReason != null && agentLoopExitReason.trim().length > 0) {
    rows.push({
      label: t("overviewTab.loopExitReasonLabel"),
      value: displayText(agentLoopExitReason),
    });
  }
  return rows;
}

function buildUsageRows(
  summary: LLMCallSummary,
  hasError: boolean,
  t: OverviewTranslate,
): MetadataRow[] {
  const rows: MetadataRow[] = [
    {
      label: t("overviewTab.inputTokensLabel"),
      value: formatCount(summary.inputTokens),
    },
    {
      label: t("overviewTab.outputTokensLabel"),
      value: formatCount(summary.outputTokens),
    },
    {
      label: t("overviewTab.cacheTokensLabel"),
      value: formatCacheTokens(
        summary.cacheCreationInputTokens,
        summary.cacheReadInputTokens,
      ),
    },
    // A rejected call billed nothing, so show an explicit $0.00 rather than
    // the "Unavailable" placeholder a missing cost would otherwise render.
    {
      label: t("overviewTab.estimatedCostLabel"),
      value: hasError ? formatCost(0) : formatCost(summary.estimatedCostUsd),
    },
    {
      label: t("overviewTab.requestMessagesLabel"),
      value: formatCount(summary.requestMessageCount),
    },
    {
      label: t("overviewTab.toolsAvailableLabel"),
      value: formatCount(summary.requestToolCount),
    },
    {
      label: t("overviewTab.toolCallsLabel"),
      value: formatCount(summary.responseToolCallCount ?? 0),
    },
  ];
  if (summary.durationMs != null && Number.isFinite(summary.durationMs)) {
    rows.splice(4, 0, {
      label: t("overviewTab.durationLabel"),
      value: t("overviewTab.latencyMs", {
        ms: formatCount(Math.round(summary.durationMs)),
      }),
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
            <MetadataRowItem key={row.rowKey ?? row.label} row={row} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function FallbackCard({
  message,
  t,
}: {
  message: string;
  t: OverviewTranslate;
}): ReactNode {
  return (
    <Card padding="md">
      <div className="flex flex-col gap-2">
        <CardHeader
          title={t("overviewTab.normalizedSummaryUnavailableTitle")}
          subtitle={t("overviewTab.normalizedSummaryUnavailableSubtitle")}
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
    <div
      className={
        row.indent
          ? "flex items-baseline gap-3 pl-4"
          : "flex items-baseline gap-3"
      }
    >
      <span
        className="shrink-0 text-label-default"
        style={{
          color: row.indent
            ? "var(--content-tertiary)"
            : "var(--content-secondary)",
        }}
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
