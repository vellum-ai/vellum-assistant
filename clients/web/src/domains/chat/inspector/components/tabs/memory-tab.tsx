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

import { conceptPageQueryOptions } from "../../concept-page-api";

/**
 * Memory tab rendering V1 recall, V2 activation, and/or the V3 selection.
 * When more than one is present a pill switcher lets the user toggle between
 * them; when only one is present it renders directly. The V3 section shows
 * what the v3 retriever selected — actually injected in live mode, or the
 * would-be block in shadow mode.
 */
type MemoryView = "recall" | "v2" | "v3";

export function MemoryTab({
  context,
  assistantId,
}: {
  context: LlmContextResponse | undefined;
  assistantId: string | undefined;
}): ReactNode {
  const recall = context?.memoryRecall ?? null;
  const v2 = context?.memoryV2Activation ?? null;
  const v3 = context?.memoryV3Selection ?? null;
  const hasRecall = recall !== null;
  const hasV2 = v2 !== null;
  const hasV3 = v3 != null;

  const pills: { id: MemoryView; label: string; show: boolean }[] = [
    { id: "v3", label: "Memory V3", show: hasV3 },
    { id: "v2", label: "Memory V2", show: hasV2 },
    { id: "recall", label: "Recall (v1)", show: hasRecall },
  ];
  const available = pills.filter((p) => p.show);

  const defaultView: MemoryView = hasV2 ? "v2" : hasV3 ? "v3" : "recall";
  const [view, setView] = useState<MemoryView>(defaultView);

  useEffect(() => {
    setView(hasV2 ? "v2" : hasV3 ? "v3" : "recall");
  }, [hasV2, hasV3, hasRecall]);

  if (available.length === 0) {
    return <NoDataState />;
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
          <MemoryV3Section selection={v3} />
        ) : activeView === "v2" && v2 != null ? (
          <MemoryV2Section activation={v2} assistantId={assistantId} />
        ) : recall != null ? (
          <MemoryRecallSection recall={recall} />
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
        background: active
          ? "var(--surface-active)"
          : "var(--surface-overlay)",
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
}: {
  recall: MemoryRecallLog;
}): ReactNode {
  if (!recall.enabled) {
    return (
      <div className="p-4">
        <SectionCard
          title="Memory disabled"
          subtitle={recall.reason ?? "Memory recall was disabled for this turn."}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <ScopeBanner
        title="Turn-level recall"
        body="Memory recall runs once per turn. This data applies to all LLM calls for this message."
      />

      <SectionCard
        title="Status"
        subtitle="Provider, model, and latency for this recall."
      >
        <MetaGrid
          rows={[
            { label: "Status", value: recall.degraded ? "Degraded" : "Active" },
            { label: "Provider", value: recall.provider ?? "Unavailable" },
            { label: "Model", value: recall.model ?? "Unavailable" },
            {
              label: "Total latency",
              value: recall.latencyMs != null ? `${recall.latencyMs} ms` : "—",
            },
          ]}
        />
      </SectionCard>

      <SectionCard
        title="Retrieval funnel"
        subtitle="How memories were filtered from semantic search to injection."
      >
        <MetaGrid
          rows={[
            {
              label: "Semantic hits",
              value: recall.semanticHits != null ? fmt(recall.semanticHits) : "—",
            },
            {
              label: "After merge",
              value: recall.mergedCount != null ? fmt(recall.mergedCount) : "—",
            },
            {
              label: "Tier 1",
              value: recall.tier1Count != null ? fmt(recall.tier1Count) : "—",
            },
            {
              label: "Tier 2",
              value: recall.tier2Count != null ? fmt(recall.tier2Count) : "—",
            },
            {
              label: "Selected",
              value: recall.selectedCount != null ? fmt(recall.selectedCount) : "—",
            },
            {
              label: "Injected tokens",
              value: recall.injectedTokens != null ? fmt(recall.injectedTokens) : "—",
            },
          ]}
        />
      </SectionCard>

      <SectionCard title="Search details">
        <MetaGrid
          rows={[
            {
              label: "Hybrid search",
              value:
                recall.hybridSearchLatencyMs != null
                  ? `${recall.hybridSearchLatencyMs} ms`
                  : "—",
            },
            {
              label: "Sparse vectors",
              value:
                recall.sparseVectorUsed != null
                  ? recall.sparseVectorUsed
                    ? "Used"
                    : "Dense only"
                  : "—",
            },
          ]}
        />
      </SectionCard>

      {recall.queryContext != null && (
        <SectionCard
          title="Query context"
          subtitle="The text embedded as the search vector for semantic retrieval."
          copyText={recall.queryContext}
        >
          <CodeBlock text={recall.queryContext} />
        </SectionCard>
      )}

      {recall.topCandidates.length > 0 && (
        <SectionCard
          title="Top candidates"
          subtitle={`${recall.topCandidates.length} candidate(s) ranked by final score.`}
        >
          <div className="flex flex-col gap-2">
            {[...recall.topCandidates]
              .sort((a, b) => b.score - a.score)
              .map((c, i) => (
                <CandidateRow key={`${i}-${c.nodeId}`} candidate={c} />
              ))}
          </div>
        </SectionCard>
      )}

      {recall.injectedText != null && (
        <SectionCard
          title="Injected memory context"
          copyText={recall.injectedText}
        >
          <CodeBlock text={recall.injectedText} />
        </SectionCard>
      )}

      {recall.degraded && recall.degradation != null && (
        <SectionCard title="Degradation">
          <MetaGrid
            rows={[
              {
                label: "Reason",
                value: recall.degradation.reason ?? "Unknown",
              },
              {
                label: "Semantic unavailable",
                value: recall.degradation.semanticUnavailable ? "Yes" : "No",
              },
              ...(recall.degradation.fallbackSources?.length
                ? [
                    {
                      label: "Fallback sources",
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

function CandidateRow({ candidate }: { candidate: MemoryCandidate }): ReactNode {
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
        {candidate.type != null && (
          <TypeChip label={candidate.type} />
        )}
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
          sem {fmtScore(candidate.semanticSimilarity)} · rec{" "}
          {fmtScore(candidate.recencyBoost)}
        </span>
      </div>
    </div>
  );
}

function MemoryV2Section({
  activation,
  assistantId,
}: {
  activation: MemoryV2ActivationLog;
  assistantId: string | undefined;
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
        title={`Memory — turn ${activation.turn} (${activation.mode})`}
        body="Spreading-activation memory pass that ranks concepts and skills for this turn."
      />

      <div className="flex flex-wrap gap-2">
        <CountPill
          label={`In context: ${fmt(inContextCount)}`}
          dotColor={v2StatusColor("in_context")}
        />
        <CountPill
          label={`Injected: ${fmt(injectedCount)}`}
          dotColor={v2StatusColor("injected")}
        />
        <CountPill
          label={`Not injected: ${fmt(notInjectedCount)}`}
          dotColor={v2StatusColor("not_injected")}
        />
      </div>

      <V2ConfigCard config={cfg} />

      <SectionCard
        title={`Concept activations (${fmt(sorted.length)})`}
        subtitle="Sorted by final activation. Skill entries appear with the `skills/` slug prefix; expand a row for the activation breakdown."
      >
        {sorted.length > 0 ? (
          <div className="flex flex-col gap-1">
            {sorted.map((concept) => (
              <ConceptRow
                key={concept.slug}
                concept={concept}
                config={cfg}
                assistantId={assistantId}
              />
            ))}
          </div>
        ) : (
          <span
            className="text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            No entries ranked.
          </span>
        )}
      </SectionCard>
    </div>
  );
}

/** Collapsible config card mirroring the macOS V2 tab's disclosure group. */
function V2ConfigCard({
  config,
}: {
  config: MemoryV2ActivationLog["config"];
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
              Config
            </span>
            <span
              className="text-label-default"
              style={{ color: "var(--content-tertiary)" }}
            >
              Activation weights and selection thresholds.
            </span>
          </span>
          <span className="shrink-0" style={{ color: "var(--content-secondary)" }}>
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
              { label: "d (decay)", value: fmtAct(config.d) },
              { label: "c_user", value: fmtAct(config.c_user) },
              { label: "c_assistant", value: fmtAct(config.c_assistant) },
              { label: "c_now", value: fmtAct(config.c_now) },
              { label: "k (sharpening)", value: fmtAct(config.k) },
              { label: "hops", value: String(config.hops) },
              { label: "top_k", value: String(config.top_k) },
              { label: "epsilon", value: fmtAct(config.epsilon) },
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
}: {
  selection: MemoryV3SelectionLog;
}): ReactNode {
  const live = selection.live;

  const coreCount = selection.selections.filter((s) =>
    s.source.startsWith("core"),
  ).length;
  const carryCount = selection.selections.filter(
    (s) => s.source === "carry-forward",
  ).length;
  const pinnedCount = selection.selections.filter((s) => s.pinned).length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <ScopeBanner
        title={
          live
            ? "Memory V3 — live injection"
            : "Memory V3 — shadow (observation only)"
        }
        body={
          live
            ? "v3 is the live memory source this turn — the block below was injected into context (v2 suppressed)."
            : "v3 ran in shadow this turn. The block below is what it would have injected; the live memory came from v2."
        }
      />

      <div className="flex flex-wrap gap-2">
        <CountPill label={`Turn ${selection.turn}`} />
        <CountPill label={`Selected: ${fmt(selection.selections.length)}`} />
        <CountPill label={`Core: ${fmt(coreCount)}`} />
        <CountPill label={`Carried: ${fmt(carryCount)}`} />
        <CountPill label={`Pinned: ${fmt(pinnedCount)}`} />
      </div>

      <SectionCard
        title={`Selected pages (${fmt(selection.selections.length)})`}
        subtitle="Pages v3 selected, tagged by the lane that surfaced them and the matched section (when a finder lane surfaced one)."
      >
        {selection.selections.length > 0 ? (
          <div className="flex flex-col gap-1">
            {selection.selections.map((row) => (
              <V3SelectionRow key={row.slug} row={row} />
            ))}
          </div>
        ) : (
          <span
            className="text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            No pages selected.
          </span>
        )}
      </SectionCard>

      {selection.injectedText !== "" && (
        <SectionCard
          title={live ? "Injected memory context" : "Would-be memory context"}
          subtitle={
            live
              ? undefined
              : "Rendered from the v3 selection — not injected this turn."
          }
          copyText={selection.injectedText}
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

function V3SelectionRow({ row }: { row: V3SelectionRowData }): ReactNode {
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
        {row.pinned && <TypeChip label="pinned" />}
        <TypeChip label={formatV3Source(row.source)} />
      </div>
    </div>
  );
}

/** Display label for a v3 selection lane (`source`). */
function formatV3Source(source: string): string {
  switch (source) {
    case "l1+l2":
      return "L1+L2";
    case "core+l2":
      return "core";
    case "carry-forward":
      return "carried";
    case "needle":
      return "needle";
    default:
      return source;
  }
}

function ConceptRow({
  concept,
  config,
  assistantId,
}: {
  concept: MemoryV2ConceptRow;
  config: MemoryV2ActivationLog["config"];
  assistantId: string | undefined;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);

  const isCustomSource = concept.source !== "ann_top50";
  const statusColor = v2StatusColor(concept.status);
  const statusText = v2StatusLabel(concept.status);

  // Render the scaled contribution to A_o (coefficient × raw) with the raw
  // similarity in parens, matching the macOS tab — the scaled values are
  // what actually sum into the own-activation term.
  const breakdownRows: { label: string; value: string }[] = [
    { label: "A_o (own)", value: fmtAct(concept.ownActivation) },
    { label: "spread Δ", value: fmtAct(concept.spreadContribution) },
    { label: "prior · d", value: fmtAct(concept.priorActivation) },
    {
      label: "c_user · sim_u",
      value: `${fmtAct(concept.simUser * config.c_user)}  (raw ${fmtAct(concept.simUser)})`,
    },
    {
      label: "c_assistant · sim_a",
      value: `${fmtAct(concept.simAssistant * config.c_assistant)}  (raw ${fmtAct(concept.simAssistant)})`,
    },
    {
      label: "c_now · sim_n",
      value: `${fmtAct(concept.simNow * config.c_now)}  (raw ${fmtAct(concept.simNow)})`,
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
      label: "c_user · rerank Δ_u",
      value: `+${fmtAct(rerankUser * config.c_user)}  (raw ${fmtAct(rerankUser)})`,
    });
    breakdownRows.push({
      label: "c_assistant · rerank Δ_a",
      value: `+${fmtAct(rerankAsst * config.c_assistant)}  (raw ${fmtAct(rerankAsst)})`,
    });
  }
  if (isCustomSource) {
    breakdownRows.push({ label: "source", value: concept.source });
  }
  breakdownRows.push({ label: "status", value: statusText });

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
          <ConceptPageContent assistantId={assistantId} slug={concept.slug} />
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
}: {
  assistantId: string | undefined;
  slug: string;
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
        Page not found on disk — slug may reference a stale Qdrant entry.
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
        Loading…
      </span>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <span
        className="text-label-small"
        style={{ color: "var(--content-secondary)" }}
      >
        page content
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
}: {
  title: string;
  subtitle?: string;
  copyText?: string;
  children?: ReactNode;
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
          {copyText != null && (
            <CopyButton text={copyText} />
          )}
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
        <div
          key={label}
          className="flex items-baseline justify-between gap-3"
        >
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

function CopyButton({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => () => { clearTimeout(timerRef.current!); }, []);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current!);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy"}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-label-default transition-colors"
      style={{
        background: "var(--surface-overlay)",
        color: copied ? "var(--system-positive-strong)" : "var(--content-secondary)",
        border: "none",
        cursor: "pointer",
      }}
    >
      <Copy size={12} aria-hidden />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function NoDataState(): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        No memory data
      </p>
      <p
        className="max-w-sm text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Memory recall information is not available for this message.
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

function v2StatusLabel(status: string): string {
  switch (status) {
    case "in_context":
      return "In context";
    case "injected":
      return "Injected";
    case "not_injected":
      return "Not injected";
    case "page_missing":
      return "Page missing";
    default:
      return status;
  }
}
