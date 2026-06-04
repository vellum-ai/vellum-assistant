import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
}: {
  context: LlmContextResponse | undefined;
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
          <MemoryV2Section activation={v2} />
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
}: {
  activation: MemoryV2ActivationLog;
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
      <SectionCard title="Run">
        <MetaGrid
          rows={[
            { label: "Mode", value: activation.mode },
            { label: "Turn", value: String(activation.turn) },
            {
              label: "Concepts evaluated",
              value: fmt(activation.concepts.length),
            },
          ]}
        />
      </SectionCard>

      <SectionCard title="Outcome">
        <MetaGrid
          rows={[
            { label: "In context", value: fmt(inContextCount) },
            { label: "Injected", value: fmt(injectedCount) },
            { label: "Not injected", value: fmt(notInjectedCount) },
          ]}
        />
      </SectionCard>

      {sorted.length > 0 && (
        <SectionCard
          title="Concepts"
          subtitle={`${sorted.length} concept(s) ranked by final activation.`}
        >
          <div className="flex flex-col gap-1">
            {sorted.map((concept) => (
              <ConceptRow key={concept.slug} concept={concept} config={cfg} />
            ))}
          </div>
        </SectionCard>
      )}

      <SectionCard title="Config" subtitle="Hyperparameters used for this activation run.">
        <MetaGrid
          rows={[
            { label: "d (decay)", value: fmtAct(cfg.d) },
            { label: "c_user", value: fmtAct(cfg.c_user) },
            { label: "c_assistant", value: fmtAct(cfg.c_assistant) },
            { label: "c_now", value: fmtAct(cfg.c_now) },
            { label: "k", value: fmtAct(cfg.k) },
            { label: "hops", value: String(cfg.hops) },
            { label: "top_k", value: String(cfg.top_k) },
            { label: "epsilon", value: fmtAct(cfg.epsilon) },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function MemoryV3Section({
  selection,
}: {
  selection: MemoryV3SelectionLog;
}): ReactNode {
  const { live, shadow } = selection;
  const modeLabel = live
    ? "Live — injected"
    : shadow
      ? "Shadow — not injected"
      : "Off";

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
            : "v3 ran in shadow this turn. The block below is what it WOULD have injected; the live memory came from v2."
        }
      />

      <SectionCard title="Selection">
        <MetaGrid
          rows={[
            { label: "Mode", value: modeLabel },
            { label: "Turn", value: String(selection.turn) },
            {
              label: "Selected pages",
              value: fmt(selection.selections.length),
            },
            { label: "Core", value: fmt(coreCount) },
            { label: "Carry-forward", value: fmt(carryCount) },
            { label: "Pinned", value: fmt(pinnedCount) },
          ]}
        />
      </SectionCard>

      {selection.selections.length > 0 && (
        <SectionCard
          title="Selected pages"
          subtitle={`${selection.selections.length} page(s), tagged by the lane that surfaced them.`}
        >
          <div className="flex flex-col gap-1">
            {selection.selections.map((row) => (
              <V3SelectionRow key={row.slug} row={row} />
            ))}
          </div>
        </SectionCard>
      )}

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

function V3SelectionRow({ row }: { row: MemoryV3SelectionRow }): ReactNode {
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
}: {
  concept: MemoryV2ConceptRow;
  config: MemoryV2ActivationLog["config"];
}): ReactNode {
  const [expanded, setExpanded] = useState(false);

  const isCustomSource = concept.source !== "ann_top50";
  const statusColor = v2StatusColor(concept.status);
  const statusText = v2StatusLabel(concept.status);

  const breakdownRows: { label: string; value: string }[] = [
    { label: "A_o (own)", value: fmtAct(concept.ownActivation) },
    { label: "spread Δ", value: fmtAct(concept.spreadContribution) },
    { label: "prior · d", value: fmtAct(concept.priorActivation) },
    {
      label: `sim_user (×${fmtAct(config.c_user)})`,
      value: fmtAct(concept.simUser),
    },
    {
      label: `sim_asst (×${fmtAct(config.c_assistant)})`,
      value: fmtAct(concept.simAssistant),
    },
    {
      label: `sim_now (×${fmtAct(config.c_now)})`,
      value: fmtAct(concept.simNow),
    },
  ];

  if ((concept.simUserRerankBoost ?? 0) !== 0) {
    breakdownRows.push({
      label: "rerank user Δ",
      value: fmtAct(concept.simUserRerankBoost ?? 0),
    });
  }
  if ((concept.simAssistantRerankBoost ?? 0) !== 0) {
    breakdownRows.push({
      label: "rerank asst Δ",
      value: fmtAct(concept.simAssistantRerankBoost ?? 0),
    });
  }
  if (concept.inRerankPool != null) {
    breakdownRows.push({
      label: "in rerank pool",
      value: concept.inRerankPool ? "Yes" : "No",
    });
  }
  if (isCustomSource) {
    breakdownRows.push({ label: "source", value: formatSource(concept.source) });
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
        {isCustomSource && <TypeChip label={formatSource(concept.source)} />}
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
        </div>
      )}
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

/**
 * Render a concept-row source string for display. Tier tags (`tier1`,
 * `tier2`, `tier3:N`) get spaced out for readability; legacy / non-router
 * sources pass through unchanged.
 */
function formatSource(source: string): string {
  if (source === "tier1") return "tier 1";
  if (source === "tier2") return "tier 2";
  if (source.startsWith("tier3:")) {
    const idx = source.slice("tier3:".length);
    return `tier 3 · b${idx}`;
  }
  if (source === "carry_over") return "carry over";
  return source;
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
