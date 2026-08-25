#!/usr/bin/env bun
/**
 * Sync the `openrouter` block of `src/providers/model-catalog.ts` to the rates
 * OpenRouter publishes at https://openrouter.ai/api/v1/models.
 *
 * OpenRouter is the one catalog provider that publishes machine-readable
 * prices for every id, so its rates are the only ones we can follow
 * mechanically instead of by hand.
 *
 * Those rates move on OpenRouter's schedule, not ours, so this runs from
 * `.github/workflows/openrouter-rate-sync.yaml` on a daily cron and opens a
 * PR with whatever moved. It stays out of `bun run test` on purpose: a unit
 * suite that reaches the network fails the build for whoever pushes next
 * whenever an upstream price changes.
 *
 * Scope, and why it is drawn here:
 *
 *   Applied automatically - base `inputPer1mTokens`, `outputPer1mTokens`,
 *   `cacheReadPer1mTokens` and `cacheWritePer1mTokens`, when the catalog
 *   already carries that field and the model has no `tiers`. These are pure
 *   number swaps with nothing to decide.
 *
 *   Reported, never applied - ids the live card no longer serves, live cache
 *   rates for models carrying no cache-read field, and any base move on a
 *   model with derived long-context `tiers`. Each is a judgement call:
 *   removing a model breaks saved user profiles that name it, a published
 *   cache rate does not always mean the route reports cached tokens (see
 *   `openrouterRoutesReportCachedTokens`), and tier rates are scaled from the
 *   base rather than published, so moving a base alone leaves a model priced
 *   inconsistently above its threshold.
 *
 * The workflow greps the report for the `Needs a human:` heading emitted by
 * `renderReport` to decide whether findings need a durable home.
 *
 * Usage:
 *   cd assistant && bun run sync:openrouter-rates
 *   cd assistant && bun run sync:openrouter-rates -- --check   # exit 1 if stale
 */
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { z } from "zod";

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
const RATE_TOLERANCE = 0.02;

/**
 * A numeric literal as TypeScript source spells it, including forms a parsed
 * number does not round-trip (`2.0`, `1e-6`).
 */
const NUMERIC_LITERAL = "-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?";

/** Catalog pricing keys this script is allowed to rewrite in place. */
const SYNCED_RATE_FIELDS = [
  ["inputPer1mTokens", "prompt"],
  ["outputPer1mTokens", "completion"],
  ["cacheReadPer1mTokens", "input_cache_read"],
  ["cacheWritePer1mTokens", "input_cache_write"],
] as const;

/**
 * A price as OpenRouter quotes it: a decimal string, or "" when unpriced.
 * Refused rather than coerced, so a boolean or object upstream cannot reach
 * `Number()` and become a committed rate.
 */
const OpenRouterPrice = z
  .string()
  .refine((raw) => raw === "" || Number.isFinite(Number(raw)), {
    message: "price is not a decimal string",
  });

const OpenRouterModelSchema = z.object({
  id: z.string().min(1),
  pricing: z
    .object({
      prompt: OpenRouterPrice.optional(),
      completion: OpenRouterPrice.optional(),
      input_cache_read: OpenRouterPrice.optional(),
      input_cache_write: OpenRouterPrice.optional(),
    })
    .optional(),
});

const OpenRouterModelsResponseSchema = z.object({
  data: z.array(z.unknown()).min(1),
});

type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

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

export function openrouterCatalogModels() {
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

/** Source of the `openrouter` provider entry, bounded by the next provider. */
export function openrouterBlock(source: string): string {
  const [start, end] = openrouterSourceRange(source);
  return source.slice(start, end);
}

/** Source of one model's object inside the openrouter block. */
export function modelEntry(block: string, modelId: string): string | undefined {
  const span = modelSourceSpan(block, modelId);
  return span ? block.slice(span[0], span[1]) : undefined;
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

  for (const model of openrouterCatalogModels()) {
    const liveModel = live.get(model.id);
    if (!liveModel) {
      findings.push({
        modelId: model.id,
        detail:
          "OpenRouter no longer serves this id. Removal breaks saved profiles that name it, so it needs a human.",
      });
      continue;
    }

    const hasTiers = Boolean(model.pricing?.tiers?.length);

    for (const [field, liveKey] of SYNCED_RATE_FIELDS) {
      const current = model.pricing?.[field];
      const liveRate = perMillionFromOpenRouterPrice(
        liveModel.pricing?.[liveKey],
      );
      if (liveRate === undefined || !rateDiffers(current, liveRate)) {
        continue;
      }
      if (current === undefined) {
        if (
          field === "cacheReadPer1mTokens" &&
          !openrouterRoutesReportCachedTokens(model.id)
        ) {
          continue;
        }
        findings.push({
          modelId: model.id,
          detail: `OpenRouter publishes ${liveKey} ${formatRate(liveRate)} but the catalog carries no ${field}. Adding one usually means flipping supportsCaching too, which is a judgement call.`,
        });
        continue;
      }
      if (hasTiers) {
        findings.push({
          modelId: model.id,
          detail: `${field} moves ${current} to ${formatRate(liveRate)}, and this model carries derived long-context tiers. Tier rates are scaled from the base rather than published, so the two move together by hand.`,
        });
        continue;
      }

      const span = modelSourceSpan(block, model.id);
      if (!span) {
        throw new Error(`could not locate ${model.id} in the openrouter block`);
      }
      const [segStart, segEnd] = span;
      const segment = block.slice(segStart, segEnd);

      // Match the literal as the source spells it. A pattern rebuilt from the
      // parsed number loses that spelling: `2.0` parses to `2`, so the pattern
      // matches just the leading digit and the replacement strands the `.0`,
      // emitting something like `2.5.0`.
      const pattern = new RegExp(`(${field}: )(${NUMERIC_LITERAL})`, "g");
      const matches = [...segment.matchAll(pattern)];
      if (matches.length !== 1) {
        throw new Error(
          `expected exactly one ${field} literal for ${model.id}, found ${matches.length}`,
        );
      }
      const sourceLiteral = matches[0]![2]!;
      if (Number(sourceLiteral) !== current) {
        throw new Error(
          `${model.id} ${field}: source literal ${sourceLiteral} does not match the catalog value ${current}`,
        );
      }
      block =
        block.slice(0, segStart) +
        segment.replace(pattern, `$1${formatRate(liveRate)}`) +
        block.slice(segEnd);
      changes.push({ modelId: model.id, field, from: current, to: liveRate });
    }
  }

  return {
    source: source.slice(0, start) + block + source.slice(end),
    changes,
    findings,
  };
}

/**
 * Validate a live card into the models the catalog tracks.
 *
 * Entries for ids the catalog does not carry are dropped quietly; there are
 * hundreds of them and none can reach a rate. A malformed entry for an id the
 * catalog does carry throws, so vendor schema drift fails the run instead of
 * looking like a dropped model and being committed as one.
 */
export function parseLiveModels(
  payload: unknown,
  trackedIds: ReadonlySet<string>,
): Map<string, OpenRouterModel> {
  const envelope = OpenRouterModelsResponseSchema.safeParse(payload);
  if (!envelope.success) {
    throw new Error(
      `OpenRouter /api/v1/models did not return a model list: ${envelope.error.message}`,
    );
  }

  const live = new Map<string, OpenRouterModel>();
  const malformed: string[] = [];
  for (const raw of envelope.data.data) {
    const model = OpenRouterModelSchema.safeParse(raw);
    if (model.success) {
      live.set(model.data.id, model.data);
      continue;
    }
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string" && trackedIds.has(id)) {
      malformed.push(`${id}: ${model.error.message}`);
    }
  }
  if (malformed.length > 0) {
    throw new Error(
      `OpenRouter returned unusable entries for catalog models:\n${malformed.join("\n")}`,
    );
  }
  return live;
}

async function fetchLiveModels(
  trackedIds: ReadonlySet<string>,
): Promise<Map<string, OpenRouterModel>> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `OpenRouter /api/v1/models returned HTTP ${response.status}`,
    );
  }
  return parseLiveModels(await response.json(), trackedIds);
}

/** One line per change, stable order, so a PR body reads as a changelog. */
function renderReport(plan: SyncPlan): string {
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
  const trackedIds = new Set(openrouterCatalogModels().map((m) => m.id));
  const plan = planSync(source, await fetchLiveModels(trackedIds));
  const rel = relative(ROOT, CATALOG_PATH);
  const report = renderReport(plan);

  if (report) {
    console.log(report);
  }

  // Findings alone never make the catalog stale: nothing in them is this
  // script's to apply.
  const settled =
    plan.findings.length > 0
      ? `${rel} has no rates this sync can apply.`
      : `${rel} rates are up to date.`;

  if (isCheck) {
    if (plan.changes.length > 0) {
      console.error(`\n${rel} is stale. Run: bun run sync:openrouter-rates`);
      process.exit(1);
    }
    console.log(settled);
    return;
  }

  if (plan.changes.length === 0) {
    console.log(settled);
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
