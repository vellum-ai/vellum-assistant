import { useState } from "react";
import type { ReactNode } from "react";

import { Card } from "@vellum/design-library";

import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate.js";
import { canUseLlmInspector } from "@/domains/chat/inspector/access.js";
import { useSimulateMemoryRouter } from "@/domains/chat/inspector/memory-router-simulator-api.js";
import type {
  MemoryRouterSimulateRequest,
  MemoryRouterSimulateResponse,
  RouterSource,
} from "@/domains/chat/inspector/memory-router-simulator-api.js";
import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store.js";
import { useAuthStore } from "@/stores/auth-store.js";

/**
 * Developer-only page for dry-running the v4 memory router with custom
 * config overrides. Hits the daemon's read-only `simulate_memory_router`
 * route — no writes to the EMA event log or activation logs.
 *
 * Gated by:
 *   1. The `memoryRouterPlayground` client feature flag (default off).
 *   2. The same staff gate that protects /assistant/inspect.
 */
export function MemoryRouterPlaygroundPage(): ReactNode {
  const user = useAuthStore.use.user();
  const authLoading = useAuthStore.use.isLoading();
  const flagEnabled = useClientFeatureFlagStore.use.memoryRouterPlayground();

  if (authLoading) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }
  if (!canUseLlmInspector(user) || !flagEnabled) {
    return (
      <CenteredMessage>
        Memory router playground is not available.
      </CenteredMessage>
    );
  }

  return <PlaygroundView />;
}

function PlaygroundView(): ReactNode {
  const { assistantId } = useActiveAssistantContext();
  const mutation = useSimulateMemoryRouter(assistantId);

  const [query, setQuery] = useState("");
  const [tier1Raw, setTier1Raw] = useState("");
  const [tier2Raw, setTier2Raw] = useState("");
  const [batchRaw, setBatchRaw] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const runSimulation = () => {
    setValidationError(null);
    let configOverrides: MemoryRouterSimulateRequest["configOverrides"];
    try {
      configOverrides = {
        ...maybeOverride("tier1_size", tier1Raw),
        ...maybeOverride("tier2_size", tier2Raw),
        ...maybeOverride("batch_size", batchRaw),
      };
      if (Object.keys(configOverrides).length === 0) {
        configOverrides = undefined;
      }
    } catch (err) {
      setValidationError(
        err instanceof Error ? err.message : "Invalid override input"
      );
      return;
    }
    mutation.mutate({
      query: query.trim(),
      ...(configOverrides ? { configOverrides } : {}),
    });
  };

  const canRun = query.trim().length > 0 && !mutation.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[940px] flex-col gap-6 p-6">
        <PageHeader />
        <InputForm
          query={query}
          onQueryChange={setQuery}
          tier1={tier1Raw}
          onTier1Change={setTier1Raw}
          tier2={tier2Raw}
          onTier2Change={setTier2Raw}
          batch={batchRaw}
          onBatchChange={setBatchRaw}
          onRun={runSimulation}
          canRun={canRun}
          isRunning={mutation.isPending}
        />
        {validationError !== null && <ErrorBanner message={validationError} />}
        {mutation.isError && (
          <ErrorBanner
            message={
              mutation.error instanceof Error
                ? mutation.error.message
                : "Failed to run simulation"
            }
          />
        )}
        {mutation.data !== undefined && (
          <ResultPanel result={mutation.data} query={query} />
        )}
      </div>
    </div>
  );
}

function maybeOverride(
  fieldName: string,
  raw: string
): Record<string, number | null> {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  if (trimmed === "null") return { [fieldName]: null };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${fieldName} must be a positive integer or 'null' (got "${trimmed}")`
    );
  }
  return { [fieldName]: parsed };
}

function PageHeader(): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <h1
        className="text-body-large-default"
        style={{ color: "var(--content-default)" }}
      >
        Memory Router Playground
      </h1>
      <p
        className="text-body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        Dry-run the v4 router with custom tier/batch overrides. Read-only — no
        rows are written to <code>memory_v2_injection_events</code> or{" "}
        <code>memory_v2_activation_logs</code>, and no activation state is
        mutated. Leave an override blank to inherit the live config value; enter{" "}
        <code>null</code> to explicitly disable a tier.
      </p>
    </div>
  );
}

function InputForm({
  query,
  onQueryChange,
  tier1,
  onTier1Change,
  tier2,
  onTier2Change,
  batch,
  onBatchChange,
  onRun,
  canRun,
  isRunning,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  tier1: string;
  onTier1Change: (value: string) => void;
  tier2: string;
  onTier2Change: (value: string) => void;
  batch: string;
  onBatchChange: (value: string) => void;
  onRun: () => void;
  canRun: boolean;
  isRunning: boolean;
}): ReactNode {
  return (
    <Card>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <label
            htmlFor="memory-router-playground-query"
            className="text-label-default"
            style={{ color: "var(--content-secondary)" }}
          >
            Query
          </label>
          <textarea
            id="memory-router-playground-query"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            rows={3}
            placeholder="e.g. what should we ship next"
            className="rounded-md border px-3 py-2 text-body-medium-default"
            style={{
              borderColor: "var(--border-base)",
              background: "var(--surface-base)",
              color: "var(--content-default)",
              resize: "vertical",
            }}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <OverrideInput
            label="tier1_size"
            value={tier1}
            onChange={onTier1Change}
          />
          <OverrideInput
            label="tier2_size"
            value={tier2}
            onChange={onTier2Change}
          />
          <OverrideInput
            label="batch_size"
            value={batch}
            onChange={onBatchChange}
          />
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onRun}
            disabled={!canRun}
            className="rounded-md px-4 py-2 text-body-medium-default transition-colors"
            style={{
              background: canRun
                ? "var(--system-positive-strong)"
                : "var(--surface-overlay)",
              color: canRun
                ? "var(--content-on-positive)"
                : "var(--content-disabled)",
              border: "none",
              cursor: canRun ? "pointer" : "not-allowed",
            }}
          >
            {isRunning ? "Running…" : "Run simulation"}
          </button>
        </div>
      </div>
    </Card>
  );
}

function OverrideInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={`memory-router-playground-${label}`}
        className="text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {label}
      </label>
      <input
        id={`memory-router-playground-${label}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="inherit"
        className="rounded-md border px-3 py-2 text-body-medium-default"
        style={{
          borderColor: "var(--border-base)",
          background: "var(--surface-base)",
          color: "var(--content-default)",
        }}
      />
    </div>
  );
}

function ResultPanel({
  result,
  query,
}: {
  result: MemoryRouterSimulateResponse;
  query: string;
}): ReactNode {
  const groups = groupSlugsBySource(result);
  return (
    <div className="flex flex-col gap-4">
      <SummaryCard result={result} query={query} />
      <ConfigCard result={result} />
      {result.failureReason !== null && (
        <ErrorBanner message={`Router failure: ${result.failureReason}`} />
      )}
      {groups.length === 0 ? (
        <EmptyResultCard />
      ) : (
        groups.map((group) => (
          <TierSectionCard
            key={group.source}
            source={group.source}
            slugs={group.slugs}
            scores={result.scores}
          />
        ))
      )}
    </div>
  );
}

function SummaryCard({
  result,
  query,
}: {
  result: MemoryRouterSimulateResponse;
  query: string;
}): ReactNode {
  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          Summary
        </span>
        <MetaGrid
          rows={[
            { label: "Query", value: query },
            {
              label: "Total candidate pages",
              value: result.totalCandidatePages.toLocaleString(),
            },
            {
              label: "Selected",
              value: `${result.selectedSlugs.length} / ${result.effectiveConfig.max_page_ids}`,
            },
          ]}
        />
      </div>
    </Card>
  );
}

function ConfigCard({
  result,
}: {
  result: MemoryRouterSimulateResponse;
}): ReactNode {
  const knobs: Array<keyof MemoryRouterSimulateResponse["effectiveConfig"]> = [
    "tier1_size",
    "tier2_size",
    "batch_size",
    "max_page_ids",
  ];
  const rows = knobs.map((key) => {
    const eff = result.effectiveConfig[key];
    const overrideValue = (result.overrides as Record<
      string,
      number | null | undefined
    >)[key];
    const effStr = eff === null ? "null" : String(eff);
    const suffix = overrideValue !== undefined ? "  (override)" : "";
    return { label: key, value: `${effStr}${suffix}` };
  });
  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          Effective config
        </span>
        <MetaGrid rows={rows} />
      </div>
    </Card>
  );
}

interface SourceGroup {
  source: RouterSource;
  slugs: string[];
}

function groupSlugsBySource(
  result: MemoryRouterSimulateResponse
): SourceGroup[] {
  const byKey = new Map<RouterSource, string[]>();
  for (const slug of result.selectedSlugs) {
    const source = result.sourceBySlug[slug];
    if (source === undefined) continue;
    const bucket = byKey.get(source) ?? [];
    bucket.push(slug);
    byKey.set(source, bucket);
  }
  const sorted = [...byKey.keys()].sort(
    (a, b) => sourceOrder(a) - sourceOrder(b)
  );
  return sorted.map((source) => ({
    source,
    slugs: byKey.get(source)!,
  }));
}

function sourceOrder(source: RouterSource): number {
  if (source === "tier1") return 0;
  if (source === "tier2") return 1;
  if (source.startsWith("tier3:")) {
    return 2 + Number(source.slice("tier3:".length));
  }
  return Number.MAX_SAFE_INTEGER;
}

function formatSourceLabel(source: RouterSource): string {
  if (source === "tier1") return "tier 1";
  if (source === "tier2") return "tier 2";
  if (source.startsWith("tier3:")) {
    return `tier 3 · b${source.slice("tier3:".length)}`;
  }
  return source;
}

function TierSectionCard({
  source,
  slugs,
  scores,
}: {
  source: RouterSource;
  slugs: string[];
  scores: Record<string, number>;
}): ReactNode {
  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-baseline justify-between">
          <span
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {formatSourceLabel(source)}
          </span>
          <span
            className="text-label-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {slugs.length} {slugs.length === 1 ? "page" : "pages"}
          </span>
        </div>
        <ul className="flex flex-col gap-1">
          {slugs.map((slug) => (
            <li
              key={slug}
              className="flex items-baseline justify-between gap-3"
            >
              <code
                className="text-body-medium-default"
                style={{ color: "var(--content-default)" }}
              >
                {slug}
              </code>
              {source === "tier2" && (
                <span
                  className="tabular-nums text-label-default"
                  style={{ color: "var(--content-secondary)" }}
                >
                  EMA {(scores[slug] ?? 0).toFixed(3)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function EmptyResultCard(): ReactNode {
  return (
    <Card>
      <div className="flex flex-col gap-2 p-4">
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          No pages selected
        </span>
        <span
          className="text-label-default"
          style={{ color: "var(--content-secondary)" }}
        >
          The router returned an empty selection. Try a more specific query, or
          relax the override values.
        </span>
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

function ErrorBanner({ message }: { message: string }): ReactNode {
  return (
    <div
      className="rounded-md px-4 py-3 text-body-medium-default"
      style={{
        background: "var(--surface-overlay)",
        color: "var(--system-negative-strong)",
      }}
    >
      {message}
    </div>
  );
}

function CenteredMessage({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      className="flex h-full w-full items-center justify-center p-8 text-label-default"
      style={{ color: "var(--content-tertiary)" }}
    >
      {children}
    </div>
  );
}
