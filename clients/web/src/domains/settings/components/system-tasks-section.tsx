import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import { ScheduleUsageStats } from "@/domains/settings/components/schedule-shared-ui";
import {
  consolidationSubtitle,
  formatScheduleCost,
  formatTimestamp,
  heartbeatSubtitle,
  RETROSPECTIVE_SUBTITLE,
  type ScheduleRowUsage,
} from "@/domains/settings/utils/schedule-formatters";
import { Trans, useTranslation } from "@/i18n";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag, type TagTone } from "@vellumai/design-library/components/tag";

import type {
  ConsolidationConfigGetResponse,
  HeartbeatConfigGetResponse,
  RetrospectiveConfigGetResponse,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// SystemTaskRow
// ---------------------------------------------------------------------------

interface SystemTaskRowProps {
  name: string;
  subtitle: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  usage: ScheduleRowUsage;
  helperText?: string;
  statusLabel?: string;
  statusTone?: TagTone;
  onClick: () => void;
}

export function SystemTaskRow({
  name,
  subtitle,
  enabled,
  nextRunAt,
  lastRunAt,
  usage,
  helperText,
  statusLabel,
  statusTone = "neutral",
  onClick,
}: SystemTaskRowProps) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-[var(--surface-hover)] [&+&]:border-t [&+&]:border-[var(--border-base)]">
      <button
        type="button"
        onClick={onClick}
        aria-label={t("systemTasksSection.openAriaLabel", { name })}
        className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-body-medium-default text-[var(--content-default)]">
              {name}
            </span>
          </div>
          <div className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
            {subtitle}
          </div>
          {helperText ? (
            <div className="mt-0.5 text-body-small-default text-[var(--content-secondary)]">
              {helperText}
            </div>
          ) : null}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-small-default text-[var(--content-tertiary)]">
            {nextRunAt ? (
              <span>
                {t("systemTasksSection.nextRun", {
                  time: formatTimestamp(nextRunAt),
                })}
              </span>
            ) : null}
            {lastRunAt ? (
              <span>
                {t("systemTasksSection.lastRun", {
                  time: formatTimestamp(lastRunAt),
                })}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
          <ScheduleUsageStats scheduleName={name} usage={usage} />
          {statusLabel ? (
            <Tag tone={statusTone}>{statusLabel}</Tag>
          ) : (
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: enabled
                  ? "var(--system-positive-strong)"
                  : "var(--content-disabled)",
              }}
              aria-label={
                enabled
                  ? t("systemTasksSection.enabled")
                  : t("systemTasksSection.disabled")
              }
            />
          )}
          <ChevronRight className="h-4 w-4 text-[var(--content-tertiary)]" />
        </div>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SystemTasksSection
// ---------------------------------------------------------------------------

interface SystemTasksSectionProps {
  heartbeatConfig: HeartbeatConfigGetResponse | undefined;
  consolidationConfig: ConsolidationConfigGetResponse | undefined;
  retrospectiveConfig: RetrospectiveConfigGetResponse | undefined;
  heartbeatUsage: ScheduleRowUsage;
  consolidationUsage: ScheduleRowUsage;
  retrospectiveUsage: ScheduleRowUsage;
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
  onSelectHeartbeat: () => void;
  onSelectConsolidation: () => void;
  onSelectRetrospective: () => void;
}

export function SystemTasksSection({
  heartbeatConfig,
  consolidationConfig,
  retrospectiveConfig,
  heartbeatUsage,
  consolidationUsage,
  retrospectiveUsage,
  isLoading,
  hasError,
  onRetry,
  onSelectHeartbeat,
  onSelectConsolidation,
  onSelectRetrospective,
}: SystemTasksSectionProps) {
  const { t } = useTranslation("settings");
  const showHeartbeat = heartbeatConfig != null;
  const showConsolidation = consolidationConfig?.available === true;
  const showRetrospective = retrospectiveConfig?.available === true;
  const showAny = showHeartbeat || showConsolidation || showRetrospective;

  if (!isLoading && !hasError && !showAny) {
    return null;
  }

  // Aggregate only the visible jobs — a hidden job's query can still hold
  // cached usage (e.g. consolidation after memory is turned off).
  const readyUsages = [
    ...(showHeartbeat ? [heartbeatUsage] : []),
    ...(showConsolidation ? [consolidationUsage] : []),
    ...(showRetrospective ? [retrospectiveUsage] : []),
  ].filter(
    (usage): usage is Extract<ScheduleRowUsage, { status: "ready" }> =>
      usage.status === "ready",
  );
  const totalCost = readyUsages.reduce(
    (sum, usage) => sum + (usage.summary.totalEstimatedCostUsd ?? 0),
    0,
  );

  const body = isLoading ? (
    <div className="flex items-center justify-center py-8">
      <Loader2 className="h-5 w-5 animate-spin text-stone-400" />
    </div>
  ) : hasError && !showAny ? (
    <Notice tone="error">
      <Trans
        ns="settings"
        i18nKey="systemTasksSection.loadError"
        components={{
          retryButton: (
            <button
              type="button"
              onClick={onRetry}
              className="cursor-pointer underline hover:no-underline"
            />
          ),
        }}
      />
    </Notice>
  ) : (
    <div>
      {showHeartbeat ? (
        <SystemTaskRow
          name={t("systemTasksSection.heartbeatName")}
          subtitle={heartbeatSubtitle(heartbeatConfig)}
          enabled={heartbeatConfig.enabled}
          nextRunAt={heartbeatConfig.nextRunAt}
          lastRunAt={heartbeatConfig.lastRunAt}
          usage={heartbeatUsage}
          onClick={onSelectHeartbeat}
        />
      ) : null}
      {showConsolidation ? (
        <SystemTaskRow
          name={t("systemTasksSection.consolidationName")}
          subtitle={consolidationSubtitle(consolidationConfig)}
          enabled={consolidationConfig.enabled}
          helperText={
            consolidationConfig.enabled
              ? undefined
              : t("systemTasksSection.consolidationPausedHelper")
          }
          nextRunAt={consolidationConfig.nextRunAt}
          lastRunAt={consolidationConfig.lastRunAt}
          usage={consolidationUsage}
          statusLabel={
            consolidationConfig.enabled
              ? undefined
              : t("systemTasksSection.paused")
          }
          statusTone="warning"
          onClick={onSelectConsolidation}
        />
      ) : null}
      {showRetrospective ? (
        <SystemTaskRow
          name={t("systemTasksSection.retrospectiveName")}
          subtitle={RETROSPECTIVE_SUBTITLE}
          enabled={retrospectiveConfig.enabled}
          helperText={
            retrospectiveConfig.enabled
              ? undefined
              : // The row only renders when `available` is true (memory is on),
                // so a false `enabled` here means the retrospective's own
                // switch is off, not memory itself.
                t("systemTasksSection.retrospectivePausedHelper")
          }
          // Always null — retrospectives are event-driven, not scheduled;
          // the row simply omits the "Next:" timestamp.
          nextRunAt={retrospectiveConfig.nextRunAt}
          lastRunAt={retrospectiveConfig.lastRunAt}
          usage={retrospectiveUsage}
          statusLabel={
            retrospectiveConfig.enabled
              ? undefined
              : t("systemTasksSection.paused")
          }
          statusTone="warning"
          onClick={onSelectRetrospective}
        />
      ) : null}
      {hasError ? (
        <div className="pt-3 first:pt-0">
          <Notice tone="error">
            <Trans
              ns="settings"
              i18nKey="systemTasksSection.partialLoadError"
              components={{
                retryButton: (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="cursor-pointer underline hover:no-underline"
                  />
                ),
              }}
            />
          </Notice>
        </div>
      ) : null}
    </div>
  );

  return (
    <DetailCard>
      <Collapsible.Root type="multiple">
        <Collapsible.Item value="system-jobs">
          <Collapsible.Trigger className="group justify-between gap-3">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-left">
              <span className="text-body-medium-default text-[var(--content-secondary)]">
                {t("systemTasksSection.title")}
              </span>
              <span className="text-body-small-default text-[var(--content-tertiary)]">
                {t("systemTasksSection.subtitle")}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              {readyUsages.length > 0 ? (
                <span className="text-body-small-default text-[var(--content-tertiary)]">
                  {t("systemTasksSection.cost7d", {
                    cost: formatScheduleCost(totalCost),
                  })}
                </span>
              ) : null}
              <ChevronDown className="h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-180" />
            </span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="mt-3">{body}</div>
          </Collapsible.Content>
        </Collapsible.Item>
      </Collapsible.Root>
    </DetailCard>
  );
}
