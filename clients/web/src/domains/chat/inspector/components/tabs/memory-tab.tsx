import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import type {
  LlmContextResponse,
  MemoryCandidate,
  MemoryRecallLog,
  MemoryV2ActivationLog,
  MemoryV2ConceptRow,
  MemoryV3SelectionLog,
  MemoryV3SelectionRow,
} from "@vellumai/assistant-api";
import { Card } from "@vellumai/design-library";

import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { useTranslation } from "@/i18n";

import { conceptPageQueryOptions } from "../../concept-page-api";

/**
 * Memory tab rendering V1 recall, V2 activation, and/or the V3 selection.
 * When more than one is present a pill switcher lets the user toggle between
 * them; when only one is present it renders directly. The V3 section shows
 * what the v3 retriever selected — injected into context when v3 is the
 * assistant's live memory source, otherwise logged but not injected.
 */
type MemoryView = "recall" | "v2" | "v3";

type MemoryTranslate = ReturnType<typeof useTranslation<"chat">>["t"];

export function MemoryTab({
  context,
  assistantId,
}: {
  context: LlmContextResponse | undefined;
  assistantId: string | undefined;
}): ReactNode {
  const { t } = useTranslation("chat");
  const recall = context?.memoryRecall ?? null;
  const v2 = context?.memoryV2Activation ?? null;
  const v3 = context?.memoryV3Selection ?? null;
  const hasRecall = recall !== null;
  const hasV2 = v2 !== null;
  const hasV3 = v3 != null;

  const pills: { id: MemoryView; label: string; show: boolean }[] = [
    { id: "v3", label: t("memoryTab.pillMemoryV3"), show: hasV3 },
    { id: "v2", label: t("memoryTab.pillMemoryV2"), show: hasV2 },
    { id: "recall", label: t("memoryTab.pillRecallV1"), show: hasRecall },
  ];
  const available = pills.filter((p) => p.show);

  const defaultView: MemoryView = hasV2 ? "v2" : hasV3 ? "v3" : "recall";
  const [view, setView] = useState<MemoryView>(defaultView);

  useEffect(() => {
    setView(hasV2 ? "v2" : hasV3 ? "v3" : "recall");
  }, [hasV2, hasV3, hasRecall]);

  if (available.length === 0) {
    return <NoDataState t={t} />;
  }

  const activeView = available.some((p) => p.id === view)
    ? view
    : (available[0]?.id ?? "recall");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {available.length > 1 && (
        <div
          className="flex gap-1 px-4 py-2"
          style={{ borderBottom: "1px solid var(--border-base)" }}
        >
          {available.map((p) => (
            <ViewPill
              key={p.id}
              label={p.label}
              active={activeView === p.id}
              onClick={() => setView(p.id)}
            />
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeView === "v3" && v3 != null ? (
          <MemoryV3Section selection={v3} t={t} />
        ) : activeView === "v2" && v2 != null ? (
          <MemoryV2Section activation={v2} assistantId={assistantId} t={t} />
        ) : recall != null ? (
          <MemoryRecallSection recall={recall} t={t} />
        ) : null}
      </div>
    </div>
  );
}

function ViewPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className="rounded-full px-3 py-1 text-label-default transition-colors"
      style={{
        background: active ? "var(--surface-active)" : "var(--surface-overlay)",
        color: active ? "var(--content-default)" : "var(--content-secondary)",
        border: "none",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function MemoryRecallSection({
  recall,
  t,
}: {
  recall: MemoryRecallLog;
  t: MemoryTranslate;
}): ReactNode {
  const missing = t("memoryTab.missingValue");

  if (!recall.enabled) {
    return (
      <div className="p-4">
        <SectionCard
          title={t("memoryTab.memoryDisabledTitle")}
          subtitle={
            recall.reason ?? t("memoryTab.memoryDisabledDefaultReason")
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <ScopeBanner
        title={t("memoryTab.turnLevelRecallTitle")}
        body={t("memoryTab.turnLevelRecallBody")}
      />

      <SectionCard
        title={t("memoryTab.statusTitle")}
        subtitle={t("memoryTab.statusSubtitle")}
      >
        <MetaGrid
          rows={[
            {
              label: t("memoryTab.statusLabel"),
              value: recall.degraded
                ? t("memoryTab.statusDegraded")
                : t("memoryTab.statusActive"),
            },
            {
              label: t("memoryTab.providerLabel"),
              value: recall.provider ?? t("memoryTab.unavailable"),
            },
            {
              label: t("memoryTab.modelLabel"),
              value: recall.model ?? t("memoryTab.unavailable"),
            },
            {
              label: t("memoryTab.totalLatencyLabel"),
              value:
                recall.latencyMs != null
                  ? t("memoryTab.latencyMs", { ms: recall.latencyMs })
                  : missing,
            },
          ]}
        />
      </SectionCard>

      <SectionCard
        title={t("memoryTab.retrievalFunnelTitle")}
        subtitle={t("memoryTab.retrievalFunnelSubtitle")}
      >
        <MetaGrid
          rows={[
            {
              label: t("memoryTab.semanticHitsLabel"),
              value:
                recall.semanticHits != null ? fmt(recall.semanticHits) : missing,
            },
            {
              label: t("memoryTab.afterMergeLabel"),
              value: recall.mergedCount != null ? fmt(recall.mergedCount) : missing,
            },
            {
              label: t("memoryTab.tier1Label"),
              value: recall.tier1Count != null ? fmt(recall.tier1Count) : missing,
            },
            {
              label: t("memoryTab.tier2Label"),
              value: recall.tier2Count != null ? fmt(recall.tier2Count) : missing,
            },
            {
              label: t("memoryTab.selectedLabel"),
              value:
                recall.selectedCount != null ? fmt(recall.selectedCount) : missing,
            },
            {
              label: t("memoryTab.injectedTokensLabel"),
              value:
                recall.injectedTokens != null
                  ? fmt(recall.injectedTokens)
                  : missing,
            },
          ]}
        />
      </SectionCard>

      <SectionCard title={t("memoryTab.searchDetailsTitle")}>
        <MetaGrid
          rows={[
            {
              label: t("memoryTab.hybridSearchLabel"),
              value:
                recall.hybridSearchLatencyMs != null
                  ? t("memoryTab.latencyMs", { ms: recall.hybridSearchLatencyMs })
                  : missing,
            },
            {
              label: t("memoryTab.sparseVectorsLabel"),
              value:
                recall.sparseVectorUsed != null
                  ? recall.sparseVectorUsed
                    ? t("memoryTab.sparseUsed")
                    : t("memoryTab.sparseDenseOnly")
                  : missing,
            },
          ]}
        />
      </SectionCard>

      {recall.queryContext != null && (
        <SectionCard
          title={t("memoryTab.queryContextTitle")}
          subtitle={t("memoryTab.queryContextSubtitle")}
          copyText={recall.queryContext}
          t={t}
        >
          <CodeBlock text={recall.queryContext} />
        </SectionCard>
      )}

      {recall.topCandidates.length > 0 && (
        <SectionCard
          title={t("memoryTab.topCandidatesTitle")}
          subtitle={t("memoryTab.topCandidatesSubtitle", {
            count: recall.topCandidates.length,
          })}
        >
          <div className="flex flex-col gap-2">
            {[...recall.topCandidates]
              .sort((a, b) => b.score - a.score)
              .map((c, i) => (
                <CandidateRow key={`${i}-${c.nodeId}`} candidate={c} t={t} />
              ))}
          </div>
        </SectionCard>
      )}

      {recall.injectedText != null && (
        <SectionCard
          title={t("memoryTab.injectedMemoryContextTitle")}
          copyText={recall.injectedText}
          t={t}
        >
          <CodeBlock text={recall.injectedText} />
        </SectionCard>
      )}

      {recall.degraded && recall.degradation != null && (
        <SectionCard title={t("memoryTab.degradationTitle")}>
          <MetaGrid
            rows={[
              {
                label: t("memoryTab.reasonLabel"),
                value: recall.degradation.reason ?? t("memoryTab.unknown"),
              },
              {
                label: t("memoryTab.semanticUnavailableLabel"),
                value: recall.degradation.semanticUnavailable
                  ? t("memoryTab.yes")
                  : t("memoryTab.no"),
              },
              ...(recall.degradation.fallbackSources?.length
                ? [
                    {
                      label: t("memoryTab.fallbackSourcesLabel"),
                      value: recall.degradation.fallbackSources.join(", "),
                    },
                  ]
                : []),
            ]}
          />
        </SectionCard>
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  t,
}: {
  candidate: MemoryCandidate;
  t: MemoryTranslate;
}): ReactNode {
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-md px-3 py-2"
      style={{ background: "var(--surface-base)" }}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <code
          className="truncate text-body-small-default"
          style={{ color: "var(--content-default)" }}
        >
          {candidate.nodeId}
        </code>
        {candidate.type != null && <TypeChip label={candidate.type} />}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {fmtScore(candidate.score)}
        </span>
        <span
          className="text-label-small"
          style={{ color: "var(--content-tertiary)" }}
        >
          {t("memoryTab.candidateScores", {
            semantic: fmtScore(candidate.semanticSimilarity),
            recency: fmtScore(candidate.recencyBoost),
          })}
        </span>
      </div>
    </div>
  );
}

function MemoryV2Section({
  activation,
  assistantId,
  t,
}: {
  activation: MemoryV2ActivationLog;
  assistantId: string | undefined;
  t: MemoryTranslate;
}): ReactNode {
  const sorted = useMemo(
    () =>
      [...activation.concepts].sort(
        (a, b) => b.finalActivation - a.finalActivation,
      ),
    [activation.concepts],
  );

  const inContextCount = sorted.filter((c) => c.status === "in_context").length;
  const injectedCount = sorted.filter((c) => c.status === "injected").length;
  const notInjectedCount = sorted.filter(
    (c) => c.status === "not_injected",
  ).length;

  const cfg = activation.config;

  return (
    <div className="flex flex-col gap-4 p-4">
      <ScopeBanner
        title={t("memoryTab.v2TurnTitle", {
          turn: activation.turn,
          mode: activation.mode,
        })}
        body={t("memoryTab.v2TurnBody")}
      />

      <div className="flex flex-wrap gap-2">
        <CountPill
          label={t("memoryTab.inContextPill", { count: fmt(inContextCount) })}
          dotColor={v2StatusColor("in_context")}
        />
        <CountPill
          label={t("memoryTab.injectedPill", { count: fmt(injectedCount) })}
          dotColor={v2StatusColor("injected")}
        />
        <CountPill
          label={t("memoryTab.notInjectedPill", { count: fmt(notInjectedCount) })}
          dotColor={v2StatusColor("not_injected")}
        />
      </div>

      <V2ConfigCard config={cfg} t={t} />

      <SectionCard
        title={t("memoryTab.conceptActivationsTitle", {
          count: fmt(sorted.length),
        })}
        subtitle={t("memoryTab.conceptActivationsSubtitle")}
      >
        {sorted.length > 0 ? (
          <div className="flex flex-col gap-1">
            {sorted.map((concept) => (
              <ConceptRow
                key={concept.slug}
                concept={concept}
                config={cfg}
                assistantId={assistantId}
                t={t}
              />
            ))}
          </div>
        ) : (
          <span
            className="text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            {t("memoryTab.noEntriesRanked")}
          </span>
        )}
      </SectionCard>
    </div>
  );
}

/** Collapsible config card mirroring the macOS V2 tab's disclosure group. */
function V2ConfigCard({
  config,
  t,
}: {
  config: MemoryV2ActivationLog["config"];
  t: MemoryTranslate;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <button
          className="flex w-full items-start justify-between gap-2 text-left"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="flex flex-col gap-0.5">
            <span
              className="text-body-medium-default"
              style={{ color: "var(--content-default)" }}
            >
              {t("memoryTab.configTitle")}
            </span>
            <span
              className="text-label-default"
              style={{ color: "var(--content-tertiary)" }}
            >
              {t("memoryTab.configSubtitle")}
            </span>
          </span>
          <span
            className="shrink-0"
            style={{ color: "var(--content-secondary)" }}
          >
            {expanded ? (
              <ChevronDown size={14} aria-hidden />
            ) : (
              <ChevronRight size={14} aria-hidden />
            )}
          </span>
        </button>
        {expanded && (
          <MetaGrid
            rows={[
              { label: t("memoryTab.configDDecay"), value: fmtAct(config.d) },
              { label: t("memoryTab.configCUser"), value: fmtAct(config.c_user) },
              {
                label: t("memoryTab.configCAssistant"),
                value: fmtAct(config.c_assistant),
              },
              { label: t("memoryTab.configCNow"), value: fmtAct(config.c_now) },
              { label: t("memoryTab.configKSharpening"), value: fmtAct(config.k) },
              { label: t("memoryTab.configHops"), value: String(config.hops) },
              { label: t("memoryTab.configTopK"), value: String(config.top_k) },
              { label: t("memoryTab.configEpsilon"), value: fmtAct(config.epsilon) },
            ]}
          />
        )}
      </div>
    </Card>
  );
}

/** Pill with an optional leading status dot — mirrors the macOS count chips. */
function CountPill({
  label,
  dotColor,
}: {
  label: string;
  dotColor?: string;
}): ReactNode {
  return (
    <span
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-label-default"
      style={{
        background: "var(--surface-overlay)",
        color: "var(--content-secondary)",
      }}
    >
      {dotColor != null && (
        <span
          className="shrink-0 rounded-full"
          style={{ width: 6, height: 6, background: dotColor }}
          aria-hidden
        />
      )}
      {label}
    </span>
  );
}

function MemoryV3Section({
  selection,
  t,
}: {
  selection: MemoryV3SelectionLog;
  t: MemoryTranslate;
}): ReactNode {
  const coreCount = selection.selections.filter((s) =>
    s.source.startsWith("core"),
  ).length;
  const carryCount = selection.selections.filter(
    (s) => s.source === "carry-forward",
  ).length;
  const pinnedCount = selection.selections.filter((s) => s.pinned).length;

  // `selection.live` reflects whether v3 is the assistant's CURRENT live memory
  // source, not per-turn history. Persisted `memory_v3_selections` rows can be
  // inspected on an assistant that is on v2 (no v3 rows are written there, but
  // older rows survive), where the selection was logged but never injected.
  const live = selection.live;

  return (
    <div className="flex flex-col gap-4 p-4">
      <ScopeBanner
        title={
          live
            ? t("memoryTab.v3LiveInjectionTitle")
            : t("memoryTab.v3LoggedSelectionTitle")
        }
        body={
          live
            ? t("memoryTab.v3LiveInjectionBody")
            : t("memoryTab.v3LoggedSelectionBody")
        }
      />

      <div className="flex flex-wrap gap-2">
        <CountPill label={t("memoryTab.turnPill", { turn: selection.turn })} />
        <CountPill
          label={t("memoryTab.selectedPill", {
            count: fmt(selection.selections.length),
          })}
        />
        <CountPill label={t("memoryTab.corePill", { count: fmt(coreCount) })} />
        <CountPill
          label={t("memoryTab.carriedPill", { count: fmt(carryCount) })}
        />
        <CountPill
          label={t("memoryTab.pinnedPill", { count: fmt(pinnedCount) })}
        />
      </div>

      <SectionCard
        title={t("memoryTab.selectedPagesTitle", {
          count: fmt(selection.selections.length),
        })}
        subtitle={t("memoryTab.selectedPagesSubtitle")}
      >
        {selection.selections.length > 0 ? (
          <div className="flex flex-col gap-1">
            {selection.selections.map((row) => (
              <V3SelectionRow key={row.slug} row={row} t={t} />
            ))}
          </div>
        ) : (
          <span
            className="text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            {t("memoryTab.noPagesSelected")}
          </span>
        )}
      </SectionCard>

      {selection.injectedText !== "" && (
        <SectionCard
          title={
            live
              ? t("memoryTab.injectedMemoryContextTitle")
              : t("memoryTab.loggedMemorySelectionTitle")
          }
          subtitle={
            live ? undefined : t("memoryTab.loggedMemorySelectionSubtitle")
          }
          copyText={selection.injectedText}
          t={t}
        >
          <CodeBlock text={selection.injectedText} />
        </SectionCard>
      )}
    </div>
  );
}

/**
 * The persisted v3 selection carries the matched section a finder lane
 * surfaced. The generated `MemoryV3SelectionRow` type may not yet expose these
 * fields (the wire schema is built out-of-band from the assistant); the daemon
 * sends them at runtime, so they are read via this local augmentation until the
 * generated type catches up.
 */
type V3SelectionRowData = MemoryV3SelectionRow & {
  sectionOrdinal?: number | null;
  sectionHeading?: string | null;
};

function V3SelectionRow({
  row,
  t,
}: {
  row: V3SelectionRowData;
  t: MemoryTranslate;
}): ReactNode {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md px-3 py-2"
      style={{ background: "var(--surface-base)" }}
    >
      <code
        className="min-w-0 flex-1 truncate text-body-small-default"
        style={{ color: "var(--content-default)" }}
      >
        {row.slug}
        {row.sectionHeading ? (
          <span style={{ color: "var(--content-secondary)" }}>
            {` § ${row.sectionHeading}`}
          </span>
        ) : null}
      </code>
      <div className="flex shrink-0 items-center gap-1.5">
        {row.pinned && <TypeChip label={t("memoryTab.pinnedChip")} />}
        <TypeChip label={formatV3Source(row.source, t)} />
      </div>
    </div>
  );
}

/** Display label for a v3 selection lane (`source`). */
function formatV3Source(source: string, t: MemoryTranslate): string {
  switch (source) {
    case "l1+l2":
      return t("memoryTab.v3SourceL1L2");
    case "core+l2":
      return t("memoryTab.v3SourceCore");
    case "carry-forward":
      return t("memoryTab.v3SourceCarried");
    case "needle":
      return t("memoryTab.v3SourceNeedle");
    default:
      return source;
  }
}

function ConceptRow({
  concept,
  config,
  assistantId,
  t,
}: {
  concept: MemoryV2ConceptRow;
  config: MemoryV2ActivationLog["config"];
  assistantId: string | undefined;
  t: MemoryTranslate;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);

  const isCustomSource = concept.source !== "ann_top50";
  const statusColor = v2StatusColor(concept.status);
  const statusText = v2StatusLabel(concept.status, t);

  // Render the scaled contribution to A_o (coefficient × raw) with the raw
  // similarity in parens, matching the macOS tab — the scaled values are
  // what actually sum into the own-activation term.
  const breakdownRows: { label: string; value: string }[] = [
    {
      label: t("memoryTab.breakdownOwnActivation"),
      value: fmtAct(concept.ownActivation),
    },
    {
      label: t("memoryTab.breakdownSpreadDelta"),
      value: fmtAct(concept.spreadContribution),
    },
    {
      label: t("memoryTab.breakdownPriorActivation"),
      value: fmtAct(concept.priorActivation),
    },
    {
      label: t("memoryTab.breakdownCUserSim"),
      value: t("memoryTab.breakdownScaledRaw", {
        scaled: fmtAct(concept.simUser * config.c_user),
        raw: fmtAct(concept.simUser),
      }),
    },
    {
      label: t("memoryTab.breakdownCAssistantSim"),
      value: t("memoryTab.breakdownScaledRaw", {
        scaled: fmtAct(concept.simAssistant * config.c_assistant),
        raw: fmtAct(concept.simAssistant),
      }),
    },
    {
      label: t("memoryTab.breakdownCNowSim"),
      value: t("memoryTab.breakdownScaledRaw", {
        scaled: fmtAct(concept.simNow * config.c_now),
        raw: fmtAct(concept.simNow),
      }),
    },
  ];

  // Rerank contributes additively to A_o weighted by c_user / c_assistant.
  // Render both channels whenever the slug was in the rerank pool, so a
  // "+0.000" boost shows up explicitly rather than vanishing. The
  // boost-value fallback covers older log rows that pre-date `inRerankPool`.
  const rerankUser = concept.simUserRerankBoost ?? 0;
  const rerankAsst = concept.simAssistantRerankBoost ?? 0;
  if ((concept.inRerankPool ?? false) || rerankUser > 0 || rerankAsst > 0) {
    breakdownRows.push({
      label: t("memoryTab.breakdownCUserRerank"),
      value: t("memoryTab.breakdownRerankScaledRaw", {
        scaled: fmtAct(rerankUser * config.c_user),
        raw: fmtAct(rerankUser),
      }),
    });
    breakdownRows.push({
      label: t("memoryTab.breakdownCAssistantRerank"),
      value: t("memoryTab.breakdownRerankScaledRaw", {
        scaled: fmtAct(rerankAsst * config.c_assistant),
        raw: fmtAct(rerankAsst),
      }),
    });
  }
  if (isCustomSource) {
    breakdownRows.push({
      label: t("memoryTab.breakdownSource"),
      value: concept.source,
    });
  }
  breakdownRows.push({
    label: t("memoryTab.breakdownStatus"),
    value: statusText,
  });

  const barWidth = Math.max(0, Math.min(concept.finalActivation, 1));

  return (
    <div
      className="overflow-hidden rounded-md"
      style={{ background: "var(--surface-base)" }}
    >
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        style={{ background: "none", border: "none", cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span
          className="mt-0.5 shrink-0 rounded-full"
          style={{
            width: 8,
            height: 8,
            background: statusColor,
          }}
          aria-hidden
        />
        <code
          className="flex-1 truncate text-body-small-default"
          style={{ color: "var(--content-default)" }}
        >
          {concept.slug}
        </code>
        {isCustomSource && <TypeChip label={concept.source} />}
        <div
          className="shrink-0 overflow-hidden rounded-full"
          style={{
            width: 60,
            height: 6,
            background: "var(--surface-active)",
          }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${barWidth * 100}%`,
              background: "var(--primary-base)",
            }}
          />
        </div>
        <span
          className="w-12 shrink-0 text-right text-body-medium-default tabular-nums"
          style={{ color: "var(--content-default)" }}
        >
          {fmtAct(concept.finalActivation)}
        </span>
        <span
          className="shrink-0"
          style={{ color: "var(--content-secondary)" }}
        >
          {expanded ? (
            <ChevronDown size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} aria-hidden />
          )}
        </span>
      </button>

      {expanded && (
        <div
          className="flex flex-col gap-1 px-3 pb-3"
          style={{ paddingLeft: "1.5rem" }}
        >
          {breakdownRows.map(({ label, value }) => (
            <BreakdownRow key={label} label={label} value={value} />
          ))}
          <ConceptPageContent
            assistantId={assistantId}
            slug={concept.slug}
            t={t}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Lazily fetches and renders the raw markdown body of a memory v2 concept
 * page. Mounted only inside an expanded concept row, so the fetch fires on
 * expand and caches per slug — mirroring the macOS `ConceptPageContentView`.
 */
function ConceptPageContent({
  assistantId,
  slug,
  t,
}: {
  assistantId: string | undefined;
  slug: string;
  t: MemoryTranslate;
}): ReactNode {
  const query = useQuery({
    ...conceptPageQueryOptions(assistantId ?? "", slug),
    enabled: Boolean(assistantId),
  });

  let body: ReactNode;
  if (query.isError || query.data?.kind === "missing") {
    body = (
      <span
        className="text-label-small"
        style={{ color: "var(--content-tertiary)" }}
      >
        {t("memoryTab.pageNotFound")}
      </span>
    );
  } else if (query.data?.kind === "loaded") {
    body = <CodeBlock text={query.data.rendered} />;
  } else {
    body = (
      <span
        className="text-label-small"
        style={{ color: "var(--content-tertiary)" }}
      >
        {t("memoryTab.loading")}
      </span>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <span
        className="text-label-small"
        style={{ color: "var(--content-secondary)" }}
      >
        {t("memoryTab.pageContentLabel")}
      </span>
      {body}
    </div>
  );
}

function ScopeBanner({
  title,
  body,
}: {
  title: string;
  body: string;
}): ReactNode {
  return (
    <div
      className="rounded-lg px-4 py-3"
      style={{ background: "var(--surface-overlay)" }}
    >
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {title}
      </p>
      <p
        className="mt-1 text-body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        {body}
      </p>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  copyText,
  children,
  t,
}: {
  title: string;
  subtitle?: string;
  copyText?: string;
  children?: ReactNode;
  t?: MemoryTranslate;
}): ReactNode {
  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span
              className="text-body-medium-default"
              style={{ color: "var(--content-default)" }}
            >
              {title}
            </span>
            {subtitle != null && subtitle !== "" && (
              <span
                className="text-label-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                {subtitle}
              </span>
            )}
          </div>
          {copyText != null && t != null && <CopyButton text={copyText} t={t} />}
        </div>
        {children}
      </div>
    </Card>
  );
}

function MetaGrid({
  rows,
}: {
  rows: { label: string; value: string }[];
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      {rows.map(({ label, value }) => (
        <div key={label} className="flex items-baseline justify-between gap-3">
          <span
            className="shrink-0 text-label-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {label}
          </span>
          <span
            className="text-right text-body-medium-lighter"
            style={{ color: "var(--content-default)" }}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function BreakdownRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span
        className="text-label-small"
        style={{ color: "var(--content-secondary)" }}
      >
        {label}
      </span>
      <span
        className="tabular-nums text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {value}
      </span>
    </div>
  );
}

function CodeBlock({ text }: { text: string }): ReactNode {
  return (
    <pre
      className="overflow-x-auto rounded-md p-3 text-body-small-default"
      style={{
        background: "var(--surface-base)",
        color: "var(--content-default)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
    </pre>
  );
}

function TypeChip({ label }: { label: string }): ReactNode {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-label-small"
      style={{
        background: "var(--surface-base)",
        color: "var(--content-secondary)",
      }}
    >
      {label}
    </span>
  );
}

function CopyButton({
  text,
  t,
}: {
  text: string;
  t: MemoryTranslate;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(
    () => () => {
      clearTimeout(timerRef.current!);
    },
    [],
  );

  const handleCopy = () => {
    copyToClipboard(text, {
      errorMessage: t("memoryTab.copyErrorMessage"),
      onCopied: () => {
        setCopied(true);
        clearTimeout(timerRef.current!);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      },
    });
  };

  return (
    <button
      onClick={handleCopy}
      title={copied ? t("memoryTab.copyTitleCopied") : t("memoryTab.copyTitle")}
      aria-label={
        copied ? t("memoryTab.copyAriaLabelCopied") : t("memoryTab.copyAriaLabel")
      }
      className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-label-default transition-colors"
      style={{
        background: "var(--surface-overlay)",
        color: copied
          ? "var(--system-positive-strong)"
          : "var(--content-secondary)",
        border: "none",
        cursor: "pointer",
      }}
    >
      <Copy size={12} aria-hidden />
      {copied ? t("memoryTab.copyButtonCopied") : t("memoryTab.copyButtonCopy")}
    </button>
  );
}

function NoDataState({ t }: { t: MemoryTranslate }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {t("memoryTab.noDataTitle")}
      </p>
      <p
        className="max-w-sm text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {t("memoryTab.noDataBody")}
      </p>
    </div>
  );
}

function fmt(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function fmtScore(n: number): string {
  return n.toFixed(3);
}

function fmtAct(n: number): string {
  return n.toFixed(3);
}

function v2StatusColor(status: string): string {
  switch (status) {
    case "in_context":
      return "var(--content-secondary)";
    case "injected":
      return "var(--system-positive-strong)";
    case "not_injected":
      return "var(--content-disabled)";
    case "page_missing":
      return "var(--system-mid-strong)";
    default:
      return "var(--content-tertiary)";
  }
}

function v2StatusLabel(status: string, t: MemoryTranslate): string {
  switch (status) {
    case "in_context":
      return t("memoryTab.v2StatusInContext");
    case "injected":
      return t("memoryTab.v2StatusInjected");
    case "not_injected":
      return t("memoryTab.v2StatusNotInjected");
    case "page_missing":
      return t("memoryTab.v2StatusPageMissing");
    default:
      return status;
  }
}
