/**
 * Cache-health panel for the Prompt tab. Turns the raw
 * `cacheCreationInputTokens` / `cacheReadInputTokens` / `inputTokens`
 * counts on an {@link LLMCallSummary} into an at-a-glance hit-rate bar,
 * a token legend, and a status banner so a reader can immediately tell
 * whether a call reused the prompt cache or re-created it from scratch.
 *
 * Reads only fields already present on the summary — no backend or raw
 * payload fetch — so it renders inline with the rest of the Prompt tab.
 */

import { type ReactNode } from "react";

import {
  displayProvider,
  formatCount,
  formatPercent,
  isProviderOnlySummary,
  MISSING_VALUE,
} from "@/domains/chat/inspector/inspector-formatters";
import { useTranslation } from "@/i18n";
import type { LLMCallSummary } from "@vellumai/assistant-api";
import { Card, Notice, type NoticeTone } from "@vellumai/design-library";
type ChatTranslate = ReturnType<typeof useTranslation<"chat">>["t"];

export interface CacheHealthCardProps {
  summary: LLMCallSummary | null | undefined;
}

/**
 * Provider-aware split of a call's prompt tokens into the three buckets a
 * cache bar needs: read-from-cache, re-created this turn, and fresh input.
 *
 * The arithmetic differs by provider because the providers report
 * `inputTokens` differently:
 * - Anthropic reports `input_tokens` *disjoint* from the cache counters, so
 *   the prompt total is `input + created + read`.
 * - OpenAI reports `prompt_tokens` (`inputTokens`) as the full prompt with
 *   the cached subset *included*, so `read` is part of `inputTokens`, there
 *   is no separate creation counter, and fresh input is `input - read`.
 *
 * `hasCreationSignal` distinguishes the two so the bar can drop the
 * "re-created" segment for providers that don't report one.
 */
interface CacheBreakdown {
  readTokens: number;
  createdTokens: number;
  freshTokens: number;
  totalTokens: number;
  hitRate: number;
  hasCreationSignal: boolean;
}

function computeCacheBreakdown(summary: LLMCallSummary): CacheBreakdown | null {
  const created = summary.cacheCreationInputTokens;
  const read = summary.cacheReadInputTokens;
  const input = summary.inputTokens;

  const hasCreation = created != null && Number.isFinite(created);
  const hasRead = read != null && Number.isFinite(read);
  const inputTokens =
    input != null && Number.isFinite(input) ? Math.max(input, 0) : 0;

  if (hasCreation) {
    const createdTokens = Math.max(created, 0);
    const readTokens = hasRead ? Math.max(read, 0) : 0;
    const freshTokens = inputTokens;
    const totalTokens = createdTokens + readTokens + freshTokens;
    if (totalTokens <= 0) {
      return null;
    }
    return {
      readTokens,
      createdTokens,
      freshTokens,
      totalTokens,
      hitRate: readTokens / totalTokens,
      hasCreationSignal: true,
    };
  }

  if (hasRead) {
    const readTokens = Math.max(read, 0);
    const totalTokens = Math.max(inputTokens, readTokens);
    const freshTokens = Math.max(totalTokens - readTokens, 0);
    if (totalTokens <= 0) {
      return null;
    }
    return {
      readTokens,
      createdTokens: 0,
      freshTokens,
      totalTokens,
      hitRate: readTokens / totalTokens,
      hasCreationSignal: false,
    };
  }

  return null;
}

const READ_COLOR = "var(--system-positive-strong)";
const CREATED_COLOR = "var(--system-mid-strong)";
const FRESH_COLOR = "var(--content-faint)";

interface CacheSegment {
  key: string;
  label: string;
  tokens: number;
  color: string;
}

interface CacheStatus {
  tone: NoticeTone;
  title: string;
  body: string;
}

function buildStatus(
  breakdown: CacheBreakdown,
  t: ChatTranslate,
): CacheStatus {
  if (breakdown.readTokens === 0) {
    const reCreated =
      breakdown.hasCreationSignal && breakdown.createdTokens > 0
        ? t("cacheHealthCard.statusFullMissReCreatedSuffix", {
            count: formatCount(breakdown.createdTokens),
          })
        : "";
    return {
      tone: "warning",
      title: t("cacheHealthCard.statusFullMissTitle"),
      body: `${t("cacheHealthCard.statusFullMissBody")}${reCreated}`,
    };
  }
  if (breakdown.hitRate >= 0.9) {
    return {
      tone: "success",
      title: t("cacheHealthCard.statusHealthyTitle"),
      body: t("cacheHealthCard.statusHealthyBody", {
        percent: formatPercent(breakdown.hitRate),
        count: formatCount(breakdown.readTokens),
      }),
    };
  }
  return {
    tone: "info",
    title: t("cacheHealthCard.statusPartialTitle"),
    body: t("cacheHealthCard.statusPartialBody", {
      percent: formatPercent(breakdown.hitRate),
      count: formatCount(breakdown.readTokens),
    }),
  };
}

function heroColor(breakdown: CacheBreakdown): string {
  if (breakdown.readTokens === 0) {
    return "var(--system-negative-strong)";
  }
  if (breakdown.hitRate >= 0.9) {
    return "var(--system-positive-strong)";
  }
  return "var(--system-mid-strong)";
}

interface LegendItemProps {
  color: string;
  label: string;
  value: string;
}

function LegendItem({ color, label, value }: LegendItemProps): ReactNode {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-label-default"
      style={{ color: "var(--content-secondary)" }}
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: color }}
      />
      <span>{label}</span>
      <span style={{ color: "var(--content-default)" }}>{value}</span>
    </span>
  );
}

function UnavailableNote({ summary }: { summary: LLMCallSummary }): ReactNode {
  const { t } = useTranslation("chat");
  const provider = displayProvider(summary.provider);

  return (
    <Card>
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {t("cacheHealthCard.title")}
      </p>
      <p
        className="mt-1 text-body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        {provider === MISSING_VALUE
          ? t("cacheHealthCard.unavailableNote")
          : t("cacheHealthCard.unavailableNoteForProvider", { provider })}
      </p>
    </Card>
  );
}

/**
 * Renders the cache-health panel, or nothing when the call has no
 * normalized summary (so callers can drop it in unconditionally).
 */
export function CacheHealthCard({ summary }: CacheHealthCardProps): ReactNode {
  const { t } = useTranslation("chat");

  if (!summary || isProviderOnlySummary(summary)) {
    return null;
  }

  const breakdown = computeCacheBreakdown(summary);
  if (!breakdown) {
    return <UnavailableNote summary={summary} />;
  }

  const segments: CacheSegment[] = [
    {
      key: "read",
      label: t("cacheHealthCard.segmentRead"),
      tokens: breakdown.readTokens,
      color: READ_COLOR,
    },
    ...(breakdown.hasCreationSignal
      ? [
          {
            key: "created",
            label: t("cacheHealthCard.segmentCreated"),
            tokens: breakdown.createdTokens,
            color: CREATED_COLOR,
          },
        ]
      : []),
    {
      key: "fresh",
      label: t("cacheHealthCard.segmentFresh"),
      tokens: breakdown.freshTokens,
      color: FRESH_COLOR,
    },
  ];

  const status = buildStatus(breakdown, t);
  const segmentParts = segments.map((seg) =>
    t("cacheHealthCard.barSegment", {
      count: formatCount(seg.tokens),
      label: seg.label,
    }),
  );
  const barLabel = t("cacheHealthCard.barAriaLabel", {
    total: formatCount(breakdown.totalTokens),
    segments: segmentParts.join(", "),
    percent: formatPercent(breakdown.hitRate),
  });

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {t("cacheHealthCard.title")}
          </p>
          <p
            className="mt-1 text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            {t("cacheHealthCard.description")}
          </p>
        </div>
        <div className="flex shrink-0 items-baseline gap-1">
          <span
            className="text-title-medium"
            style={{ color: heroColor(breakdown) }}
          >
            {formatPercent(breakdown.hitRate)}
          </span>
          <span
            className="text-label-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {t("cacheHealthCard.cached")}
          </span>
        </div>
      </div>

      <div
        role="img"
        aria-label={barLabel}
        className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full"
        style={{ background: "var(--surface-base)" }}
      >
        {segments.map((seg) => {
          const pct = (seg.tokens / breakdown.totalTokens) * 100;
          return pct > 0 ? (
            <span
              key={seg.key}
              style={{ width: `${pct}%`, background: seg.color }}
            />
          ) : null;
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((seg) => (
          <LegendItem
            key={seg.key}
            color={seg.color}
            label={seg.label}
            value={formatCount(seg.tokens)}
          />
        ))}
      </div>

      <div className="mt-3">
        <Notice tone={status.tone} title={status.title}>
          {status.body}
        </Notice>
      </div>
    </Card>
  );
}
