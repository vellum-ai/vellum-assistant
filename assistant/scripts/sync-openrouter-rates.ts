#!/usr/bin/env bun
/**
 * Sync the `openrouter` block of `src/providers/model-catalog.ts` to the rates
 * OpenRouter publishes at https://openrouter.ai/api/v1/models.
 *
 * OpenRouter is the one catalog provider that publishes machine-readable
 * prices for every id, so its rates are the only ones we can follow
 * mechanically instead of by hand.
 *
 * Those rates move on OpenRouter's schedule, not ours. This script therefore
 * runs from `.github/workflows/openrouter-rate-sync.yaml` on a daily cron and
 * opens a PR with whatever moved. It is deliberately not part of
 * `bun run test`: a unit suite that reaches the network turns an upstream
 * reprice into a red build for whoever happens to push next, which is the
 * failure mode this replaces.
 *
 * Scope, and why it is drawn here:
 *
 *   Applied automatically - base `inputPer1mTokens`, `outputPer1mTokens`,
 *   `cacheReadPer1mTokens` and `cacheWritePer1mTokens`, when the catalog
 *   already carries that field. Pure number swaps, and the only thing that
 *   has ever broken the build.
 *
 *   Reported, never applied - ids the live card no longer serves, live cache
 *   rates for models carrying no cache-read field, and base moves on models
 *   with derived long-context `tiers`. Each of those is a judgement call:
 *   removing a model breaks saved user profiles that name it, a published
 *   cache rate does not always mean the route reports cached tokens (see
 *   `openrouterRoutesReportCachedTokens`), and tier rates are scaled from the
 *   base rather than published. The scheduled run surfaces these in the PR
 *   body for a human.
 *
 * Usage:
 *   cd assistant && bun run sync:openrouter-rates
 *   cd assistant && bun run sync:openrouter-rates -- --check   # exit 1 if stale
 */

import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  openrouterRoutesReportCachedTokens,
  PROVIDER_CATALOG,
} from "../src/providers/model-catalog.js";

const ROOT = resolve(import.meta.dir, "../..");
const CATALOG_PATH = resolve(
  import.meta.dir,
  "../src/providers/model-catalog.ts",
);
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 30_000;

/** Relative band a rate must move beyond before it counts as drift. */
export const RATE_TOLERANCE = 0.02;

/** Catalog pricing keys this script is allowed to rewrite in place. */
const SYNCED_RATE_FIELDS = [
  ["inputPer1mTokens", "prompt"],
  ["outputPer1mTokens", "completion"],
  ["cacheReadPer1mTokens", "input_cache_read"],
  ["cacheWritePer1mTokens", "input_cache_write"],
] as const;

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

interface OpenRouterModel {
  id: string;
  pricing?: OpenRouterPricing;
}

/**
 * OpenRouter quotes per-token prices as decimal strings; the catalog stores
 * USD per 1M tokens. A zero price means "not published for this model", not
 * "free", so it reads as absent.
 */
export function perMillionFromOpenRouterPrice(
  raw: string | number | undefined | null,
): number | undefined {
  if (raw == null || raw === "") {
    return undefined;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n === 0) {
    return undefined;
  }
  return n * 1_000_000;
}

/** True when two rates differ by more than `tolerance`, relative. */
export function rateDiffers(
  catalog: number | undefined,
  live: number | undefined,
  tolerance = RATE_TOLERANCE,
): boolean {
  if (catalog === undefined && live === undefined) {
    return false;
  }
  if (catalog === undefined || live === undefined) {
    return true;
  }
  const denom = Math.max(Math.abs(live), Math.abs(catalog), Number.EPSILON);
  return Math.abs(catalog - live) / denom > tolerance;
}

/**
 * Render a number the way the catalog spells it, so a synced value produces a
 * clean diff. Floating point can hand back 0.017721200000000003 for a card
 * that reads 0.0000000177212; trailing noise past the 12th significant digit
 * is an artifact of the multiply, never a real rate.
 */
export function formatRate(value: number): string {
  const trimmed = Number(value.toPrecision(12));
  return String(trimmed);
}

export interface RateChange {
  modelId: string;
  field: string;
  from: number | undefined;
  to: number;
}

export interface StructuralFinding {
  modelId: string;
  detail: string;
}

export interface SyncPlan {
  source: string;
  changes: RateChange[];
  findings: StructuralFinding[];
}

function openrouterModels() {
  const entry = PROVIDER_CATALOG.find(
    (provider) => provider.id === "openrouter",
  );
  if (!entry) {
    throw new Error("PROVIDER_CATALOG is missing the openrouter entry");
  }
  return entry.models;
}

/**
 * Character range of the `openrouter` provider entry inside the catalog
 * source. Bounded by the next provider's `id:` line so a shared model id (for
 * example `deepseek/deepseek-v4-flash`, which the `vercel-ai-gateway` block
 * also carries at its own rates) can never be rewritten by mistake.
 */
function openrouterSourceRange(source: string): [number, number] {
  const start = source.search(/^\s*id: "openrouter",$/m);
  if (start === -1) {
    throw new Error("could not locate the openrouter provider entry");
  }
  const rest = source.slice(start + 1);
  const nextProvider = rest.search(/^\s{4}id: "[^"]+",$/m);
  const end = nextProvider === -1 ? source.length : start + 1 + nextProvider;
  return [start, end];
}

/** Source span of one model object inside the openrouter block. */
function modelSourceSpan(
  block: string,
  modelId: string,
): [number, number] | undefined {
  const marker = block.indexOf(`id: "${modelId}",`);
  if (marker === -1) {
    return undefined;
  }
  const close = block.indexOf("\n      },", marker);
  if (close === -1) {
    return undefined;
  }
  return [marker, close];
}

/**
 * Compute the rewritten catalog source plus everything that needs a human.
 * Rewrites only rate literals that already exist, and asserts each rewrite
 * matched exactly once so a shape change fails loudly instead of silently
 * editing the wrong number.
 */
export function planSync(
  source: string,
  live: ReadonlyMap<string, OpenRouterModel>,
): SyncPlan {
  const [start, end] = openrouterSourceRange(source);
  let block = source.slice(start, end);
  const changes: RateChange[] = [];
  const findings: StructuralFinding[] = [];

  for (const model of openrouterModels()) {
    const liveModel = live.get(model.id);
    if (!liveModel) {
      findings.push({
        modelId: model.id,
        detail:
          "OpenRouter no longer serves this id. Removal breaks saved profiles that name it, so it needs a human.",
      });
      continue;
    }

    for (const [field, liveKey] of SYNCED_RATE_FIELDS) {
      const current = model.pricing?.[field];
      const liveRate = perMillionFromOpenRouterPrice(
        liveModel.pricing?.[liveKey],
      );
      if (liveRate === undefined || !rateDiffers(current, liveRate)) {
        continue;
      }
      if (current === undefined) {
        findings.push({
          modelId: model.id,
          detail: `OpenRouter publishes ${liveKey} ${formatRate(liveRate)} but the catalog carries no ${field}. Adding one usually means flipping supportsCaching too, which is a judgement call.`,
        });
        continue;
      }

      const span = modelSourceSpan(block, model.id);
      if (!span) {
        throw new Error(`could not locate ${model.id} in the openrouter block`);
      }
      const [segStart, segEnd] = span;
      const segment = block.slice(segStart, segEnd);
      const pattern = new RegExp(
        `(${field}: )${String(current).replace(".", "\\.")}(\\b)`,
      );
      const matches = segment.match(new RegExp(pattern, "g"));
      if (!matches || matches.length !== 1) {
        throw new Error(
          `expected exactly one ${field} literal for ${model.id}, found ${matches?.length ?? 0}`,
        );
      }
      block =
        block.slice(0, segStart) +
        segment.replace(pattern, `$1${formatRate(liveRate)}$2`) +
        block.slice(segEnd);
      changes.push({ modelId: model.id, field, from: current, to: liveRate });

      if (model.pricing?.tiers?.length) {
        findings.push({
          modelId: model.id,
          detail: `base ${field} moved and this model carries derived long-context tiers. OpenRouter does not publish tier rates, so rescale them by hand.`,
        });
      }
    }

    const liveCacheRead = perMillionFromOpenRouterPrice(
      liveModel.pricing?.input_cache_read,
    );
    if (
      liveCacheRead !== undefined &&
      model.pricing?.cacheReadPer1mTokens === undefined &&
      openrouterRoutesReportCachedTokens(model.id) &&
      !model.supportsCaching
    ) {
      findings.push({
        modelId: model.id,
        detail: `OpenRouter publishes a cache-read rate of ${formatRate(liveCacheRead)} but supportsCaching is false.`,
      });
    }
  }

  return {
    source: source.slice(0, start) + block + source.slice(end),
    changes,
    findings,
  };
}

async function fetchLiveModels(): Promise<Map<string, OpenRouterModel>> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `OpenRouter /api/v1/models returned HTTP ${response.status}`,
    );
  }
  const payload = (await response.json()) as { data?: OpenRouterModel[] };
  const models = payload.data;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("OpenRouter /api/v1/models returned no models");
  }
  return new Map(models.map((model) => [model.id, model]));
}

/** One line per change, stable order, so a PR body reads as a changelog. */
export function renderReport(plan: SyncPlan): string {
  const lines: string[] = [];
  if (plan.changes.length > 0) {
    lines.push("Rates updated:");
    for (const change of plan.changes) {
      lines.push(
        `  ${change.modelId}: ${change.field} ${change.from} -> ${formatRate(change.to)}`,
      );
    }
  }
  if (plan.findings.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("Needs a human:");
    for (const finding of plan.findings) {
      lines.push(`  ${finding.modelId}: ${finding.detail}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const isCheck = process.argv.includes("--check");
  const source = await readFile(CATALOG_PATH, "utf-8");
  const plan = planSync(source, await fetchLiveModels());
  const rel = relative(ROOT, CATALOG_PATH);
  const report = renderReport(plan);

  if (report) {
    console.log(report);
  }

  if (isCheck) {
    if (plan.changes.length > 0) {
      console.error(`\n${rel} is stale. Run: bun run sync:openrouter-rates`);
      process.exit(1);
    }
    console.log(`${rel} rates are up to date.`);
    return;
  }

  if (plan.changes.length === 0) {
    console.log(`${rel} rates are up to date.`);
    return;
  }

  await writeFile(CATALOG_PATH, plan.source);
  console.log(`\nUpdated ${plan.changes.length} rate(s) in ${rel}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
