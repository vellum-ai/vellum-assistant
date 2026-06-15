/**
 * Minimal pricing table for the evals harness.
 *
 * The `@vellumai/assistant` package owns a much richer pricing module
 * (`assistant/src/util/pricing.ts`) with cache-tier awareness, Anthropic
 * fast-mode multipliers, OpenRouter normalization, and config-driven
 * overrides. Evals is a separate package with no dependency on assistant,
 * so we cannot import that table directly.
 *
 * Instead, evals carries this tiny local table to convert
 * `assistant events --json` usage records into dollar amounts on the
 * report. It deliberately covers only the providers and models we
 * actually point evals profiles at today — Anthropic Claude, OpenAI
 * GPT, and Fireworks-hosted open-weight models (e.g. MiniMax-M3).
 * Adding a new model that an eval run touches is a one-line edit
 * here; until the row exists, `priceUsageRecord` emits an
 * `unpriced_model` diagnostic so the report's Usage section explains
 * exactly which provider/model pair lacks coverage instead of silently
 * counting it as $0.
 *
 * Cache pricing follows the same provider-split the daemon's
 * `calculateUsageCost` uses (`assistant/src/util/pricing.ts`). Anthropic
 * reports `input_tokens` as the uncached count and exposes cache
 * reads/writes as separate, non-overlapping buckets, so they're priced
 * additively off the base input rate via Anthropic's prompt-cache
 * multipliers (read = 0.1x, 5-minute write = 1.25x, 1-hour write = 2x);
 * the two write tiers are attributed from the `cache_creation` breakdown
 * the egress recorder forwards. OpenAI-compatible providers (OpenAI,
 * Fireworks) instead fold the cached subset *into* `prompt_tokens`, so
 * the pricer splits that subset back out and charges it at the row's
 * `cacheReadPer1M` when the catalog publishes a discounted cache tier
 * (e.g. Fireworks MiniMax-M3 at $0.06/1M), falling back to the base input
 * rate otherwise. This remains a "good-enough for ranking profiles"
 * estimate (e.g. Anthropic fast-mode's 6x multiplier isn't modeled), not
 * a billing source of truth.
 */

import type { CostDiagnostic, CostDiagnosticReason } from "./metrics";

/**
 * Anthropic prompt-cache rates as multipliers on the base input rate,
 * mirroring `ANTHROPIC_PROMPT_CACHE_MULTIPLIERS` in the daemon's
 * `assistant/src/util/pricing.ts`. The two cache-write tiers are priced
 * distinctly: a 5-minute ephemeral write costs 1.25x base input, a
 * 1-hour write 2x. The egress recorder forwards Anthropic's
 * `cache_creation` breakdown so the tiers can be attributed correctly
 * instead of being collapsed into one rate.
 */
const ANTHROPIC_CACHE_MULTIPLIERS = {
  read: 0.1,
  write5m: 1.25,
  write1h: 2,
} as const;

interface ModelRow {
  /** USD per 1,000,000 input tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 output tokens. */
  outputPer1M: number;
  /**
   * USD per 1,000,000 cached input tokens, when the provider bills cache
   * reads at a discounted rate. Omitted for rows whose provider has no
   * cache-read tier, in which case cached tokens price at `inputPer1M`.
   * Mirrors `cacheReadPer1mTokens` on the assistant catalog rows in
   * `assistant/src/providers/model-catalog.ts`.
   */
  cacheReadPer1M?: number;
}

/**
 * Pricing rows, keyed by `<provider>:<model>`. Provider names and model
 * names are stored lowercase; `readProvider` / `readModel` lowercase
 * incoming records before lookup so a usage record with mixed-case ids
 * (e.g. `"Claude-Sonnet-4-6"`) still hits the right row instead of
 * falling through to `unpriced_model`.
 *
 * Model rows follow the bare ids the assistant catalog publishes
 * (`assistant/src/providers/model-catalog.ts`) — no `anthropic/` /
 * `openai/` provider prefix, dashes between version segments (not dots).
 * `readModel` strips the OpenRouter `anthropic/` prefix AND folds dot
 * versions to dash form for Anthropic so `anthropic/claude-opus-4.7`
 * lands on `claude-opus-4-7`.
 *
 * Reference: assistant's `PROVIDER_CATALOG` and `LEGACY_PRICING_FALLBACK`
 * in `assistant/src/util/pricing.ts`. The numbers here are sampled from
 * the same catalog rows so the two pipelines stay in step (manually
 * mirrored — drift is acceptable until a programmatic sync exists).
 */
const PRICING_TABLE: Record<string, ModelRow> = {
  // Anthropic — sampled from the assistant model catalog. The 4.5+ Opus
  // generation is priced at $5/$25 in the catalog (older Opus 3.x and
  // pre-4.5 Opus generations carried the $15/$75 rate but are not in
  // the evals profile coverage set).
  "anthropic:claude-fable-5": { inputPer1M: 10, outputPer1M: 50 },
  "anthropic:claude-opus-4-8": { inputPer1M: 5, outputPer1M: 25 },
  "anthropic:claude-opus-4-7": { inputPer1M: 5, outputPer1M: 25 },
  "anthropic:claude-opus-4-6": { inputPer1M: 5, outputPer1M: 25 },
  "anthropic:claude-opus-4-5": { inputPer1M: 5, outputPer1M: 25 },
  "anthropic:claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
  "anthropic:claude-sonnet-4-5": { inputPer1M: 3, outputPer1M: 15 },
  "anthropic:claude-haiku-4-5": { inputPer1M: 1, outputPer1M: 5 },

  // OpenAI — published rates, USD per 1M tokens. The gpt-5.x rows
  // mirror the base (non-long-context) tier in
  // `assistant/src/providers/model-catalog.ts`. Evals doesn't model
  // OpenAI's long-context tier multiplier yet. The catalog is the
  // source of truth; drift is acceptable until a programmatic sync
  // exists.
  "openai:gpt-5.5-pro": { inputPer1M: 30.0, outputPer1M: 180.0 },
  "openai:gpt-5.5": { inputPer1M: 5.0, outputPer1M: 30.0 },
  "openai:gpt-5.4": { inputPer1M: 2.5, outputPer1M: 15.0 },
  "openai:gpt-5.4-mini": { inputPer1M: 0.75, outputPer1M: 4.5 },
  "openai:gpt-5.4-nano": { inputPer1M: 0.2, outputPer1M: 1.25 },
  "openai:gpt-5.2": { inputPer1M: 1.75, outputPer1M: 14.0 },
  "openai:gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "openai:gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "openai:gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "openai:gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "openai:gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "openai:o3": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "openai:o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "openai:o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },

  // Fireworks — open-weight models served on Fireworks' own infra,
  // priced per the `accounts/fireworks/models/*` catalog rows in
  // `assistant/src/providers/model-catalog.ts`. MiniMax-M3 is what the
  // `vellum-minimax` eval profile points at. Fireworks is
  // OpenAI-compatible (chat-completions wire format), so its cached
  // subset folds into `prompt_tokens`; the catalog bills those cached
  // tokens at a discounted $0.06/1M, so the row carries `cacheReadPer1M`
  // and `priceUsageRecord` splits the cached read out of the inclusive
  // input count before pricing.
  "fireworks:minimax-m3": {
    inputPer1M: 0.3,
    outputPer1M: 1.2,
    cacheReadPer1M: 0.06,
  },
};

/**
 * Pick the best matching row for a (provider, model) pair. Tries an
 * exact match first, then walks prefixes so date-versioned IDs like
 * `claude-sonnet-4-5-20251022` map onto the bare `claude-sonnet-4-5`
 * row. Returns `undefined` when nothing matches.
 */
function findPricing(provider: string, model: string): ModelRow | undefined {
  const exact = PRICING_TABLE[`${provider}:${model}`];
  if (exact) return exact;

  let best: ModelRow | undefined;
  let bestLen = 0;
  const prefix = `${provider}:`;
  for (const [key, row] of Object.entries(PRICING_TABLE)) {
    if (!key.startsWith(prefix)) continue;
    const bareModel = key.slice(prefix.length);
    if (model.startsWith(bareModel) && bareModel.length > bestLen) {
      best = row;
      bestLen = bareModel.length;
    }
  }
  return best;
}

/**
 * `provider` and `actualProvider` are both observed in the wild on
 * `event.message.usage`. `actualProvider` wins because it reflects the
 * provider that actually served the request — when an OpenRouter route
 * delegates to Anthropic, `actualProvider` is `anthropic` and
 * `provider` is `openrouter`. We want to price against Anthropic's
 * rates because OpenRouter passes those through.
 */
function readProvider(record: Record<string, unknown>): string | undefined {
  const candidates = [record.actualProvider, record.provider];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().toLowerCase();
    }
  }
  return undefined;
}

function readModel(record: Record<string, unknown>): string | undefined {
  const value = record.model;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  // Reduce a slash-qualified model id to its final segment so the table
  // key matches the bare model id stored in PRICING_TABLE. This covers
  // both the OpenRouter-style `anthropic/<model>` prefix and Fireworks'
  // `accounts/fireworks/models/<model>` path, which both collapse to the
  // trailing `<model>`.
  const bare = value.includes("/") ? value.split("/").pop()! : value;
  // Lowercase so a record with `"Claude-Sonnet-4-6"` still hits a
  // lowercase table row. PRICING_TABLE is lowercase by construction.
  return bare.trim().toLowerCase();
}

/**
 * Provider-aware model normalization. Currently only used to fold
 * OpenRouter's dot-separated Anthropic ids onto the canonical dash form
 * Anthropic's own catalog uses — `claude-opus-4.7` → `claude-opus-4-7`,
 * `claude-sonnet-4.5` → `claude-sonnet-4-5`. Other providers (OpenAI,
 * Google) genuinely ship dot versions (`gpt-4.1`, `gpt-4o`), so we
 * leave their model strings alone.
 *
 * Centralized here so the rule can grow without sprinkling regex calls
 * through findPricing.
 */
function canonicalizeModel(provider: string, model: string): string {
  if (provider === "anthropic") {
    return model.replace(/\./g, "-");
  }
  return model;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Split Anthropic cache-creation tokens into 5-minute and 1-hour
 * ephemeral tiers, mirroring the daemon's `getAnthropicCacheWriteTokens`
 * (`assistant/src/util/pricing.ts`). The breakdown lives on the
 * `cache_creation` object the egress recorder forwards; the daemon's
 * own usage events expose the same numbers under `anthropicCacheCreation`.
 * When neither is present the aggregate is attributed to the 5-minute
 * tier — the default TTL the agent loop writes with.
 */
function splitAnthropicCacheWriteTokens(record: Record<string, unknown>): {
  ephemeral5m: number;
  ephemeral1h: number;
} {
  const total = Math.max(
    readNumber(
      record.cache_creation_input_tokens ?? record.cacheCreationInputTokens,
    ) ?? 0,
    0,
  );
  const breakdownRaw = record.cache_creation ?? record.anthropicCacheCreation;
  const breakdown: Record<string, unknown> =
    typeof breakdownRaw === "object" && breakdownRaw !== null
      ? (breakdownRaw as Record<string, unknown>)
      : {};
  const explicit5m = Math.max(
    readNumber(breakdown.ephemeral_5m_input_tokens) ?? 0,
    0,
  );
  const explicit1h = Math.max(
    readNumber(breakdown.ephemeral_1h_input_tokens) ?? 0,
    0,
  );

  if (explicit5m === 0 && explicit1h === 0) {
    return { ephemeral5m: total, ephemeral1h: 0 };
  }

  const remaining5m = Math.max(total - explicit5m - explicit1h, 0);
  return { ephemeral5m: explicit5m + remaining5m, ephemeral1h: explicit1h };
}

export interface PriceUsageResult {
  /** Computed cost in USD, or undefined when the record was unpriceable. */
  costUsd?: number;
  /**
   * Diagnostic for the report when the record couldn't be priced. Omitted
   * on success.
   */
  diagnostic?: Omit<CostDiagnostic, "requestIndex">;
}

/**
 * Price a single usage record. Surface logic for `summarizeAssistantUsage`:
 *
 *   1. If the record already carries `estimatedCostUsd` / `estimated_cost_usd`,
 *      trust it (the daemon has its own pricing pipeline and we'd rather
 *      report what it computed than re-derive).
 *   2. Otherwise look up the (provider, model) pair against the local
 *      table and compute `(input/1e6 * inputPer1M) + (output/1e6 * outputPer1M)`.
 *   3. Anything missing yields a diagnostic so the report can explain
 *      "why this row didn't contribute to cost".
 */
export function priceUsageRecord(
  record: Record<string, unknown>,
): PriceUsageResult {
  // (1) Daemon-supplied cost wins, when present.
  const supplied =
    readNumber(record.estimatedCostUsd) ??
    readNumber(record.estimated_cost_usd);
  if (supplied !== undefined) {
    return { costUsd: supplied };
  }

  const provider = readProvider(record);
  const rawModel = readModel(record);
  const inputTokens = readNumber(record.input_tokens ?? record.inputTokens);
  const outputTokens = readNumber(record.output_tokens ?? record.outputTokens);

  // (3a) Walk the diagnostic reasons in priority order: identity gaps
  // first (most actionable for adapter authors), then token gaps.
  const reason = pickDiagnosticReason({
    provider,
    model: rawModel,
    inputTokens,
    outputTokens,
  });
  if (reason) {
    return { diagnostic: { reason, provider, model: rawModel } };
  }

  // (2) provider+model+tokens all present — table lookup. Run the bare
  // model id through provider-aware canonicalization so OpenRouter
  // Anthropic's dot versions resolve to the dash-form keys.
  const model = canonicalizeModel(provider!, rawModel!);
  const pricing = findPricing(provider!, model);
  if (!pricing) {
    return { diagnostic: { reason: "unpriced_model", provider, model } };
  }

  const inputTok = inputTokens ?? 0;
  const outputCost = ((outputTokens ?? 0) / 1_000_000) * pricing.outputPer1M;
  const cacheReadTokens =
    readNumber(record.cache_read_input_tokens ?? record.cacheReadInputTokens) ??
    0;

  // Anthropic reports `input_tokens` as the *uncached* count, with cache
  // reads/writes as separate, non-overlapping buckets — so they're priced
  // additively off the base input rate via Anthropic's prompt-cache
  // multipliers, else the bulk of a cached agentic turn's cost is dropped.
  // The two write tiers come from the `cache_creation` breakdown.
  if (provider === "anthropic") {
    const { ephemeral5m, ephemeral1h } = splitAnthropicCacheWriteTokens(record);
    const cost =
      (inputTok / 1_000_000) * pricing.inputPer1M +
      outputCost +
      (ephemeral5m / 1_000_000) *
        pricing.inputPer1M *
        ANTHROPIC_CACHE_MULTIPLIERS.write5m +
      (ephemeral1h / 1_000_000) *
        pricing.inputPer1M *
        ANTHROPIC_CACHE_MULTIPLIERS.write1h +
      (cacheReadTokens / 1_000_000) *
        pricing.inputPer1M *
        ANTHROPIC_CACHE_MULTIPLIERS.read;
    return { costUsd: cost };
  }

  // OpenAI-compatible providers (OpenAI, Fireworks) fold the cached subset
  // *into* `input_tokens`. Split it back out and price it at the catalog's
  // dedicated cache-read rate when the row publishes one, else at the base
  // input rate. Mirrors the non-Anthropic branch of the daemon's
  // `calculateUsageCost` (`assistant/src/util/pricing.ts`), where
  // `directInputTokens` is the uncached remainder and `cacheReadInputTokens`
  // bills at `cacheReadPer1M ?? inputPer1M`. For rows without a cache-read
  // rate this collapses to `input_tokens * inputPer1M`, leaving the
  // cache-less OpenAI rows unchanged.
  const uncachedInputTokens = Math.max(inputTok - cacheReadTokens, 0);
  const cacheReadRate = pricing.cacheReadPer1M ?? pricing.inputPer1M;
  const cost =
    (uncachedInputTokens / 1_000_000) * pricing.inputPer1M +
    (cacheReadTokens / 1_000_000) * cacheReadRate +
    outputCost;

  return { costUsd: cost };
}

function pickDiagnosticReason(input: {
  provider: string | undefined;
  model: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): CostDiagnosticReason | undefined {
  if (!input.provider) return "missing_provider";
  if (!input.model) return "missing_model";
  if (input.inputTokens === undefined && input.outputTokens === undefined) {
    return "missing_tokens";
  }
  return undefined;
}
