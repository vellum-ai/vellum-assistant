/**
 * Memory v3 route definitions — live-lane maintenance operations for the
 * section-lane memory model.
 *
 * The daemon owns the live shadow lanes, so the maintenance verbs run here,
 * inside the daemon process, where the in-memory lanes can be invalidated or
 * rebuilt after a write:
 *
 *   - `rebuild-index` — drop the cached lanes so the next turn rebuilds.
 *   - `backfill-sections` — one-time full embed of every page's sections into
 *     the dense store, advancing the maintain high-water mark.
 *
 * Each route's behavior lives in a small DI-friendly `handle*` function (with an
 * injectable config seam) so tests can drive it without mocking module globals.
 * The exported `RouteDefinition`s are thin adapters over those handlers.
 */

import { z } from "zod";

import { getConfig } from "../../../../config/loader.js";
import type { AssistantConfig } from "../../../../config/types.js";
import { getTelemetrySqlite } from "../../../../persistence/db-connection.js";
import {
  ACTOR_PRINCIPALS,
  type RoutePolicy,
} from "../../../../runtime/auth/route-policy.js";
import type { RouteDefinition } from "../../../../runtime/routes/types.js";
import { getLogger } from "../logging.js";
import { backfillAllSections } from "../v3/maintain-job.js";
import { MEMORY_V3_INJECTION_GATE_CHECK_NAME } from "../v3/orchestrate.js";
import { invalidateLanes } from "../v3/shadow-plugin.js";

const log = getLogger("memory-v3-routes");

// ---------------------------------------------------------------------------
// rebuild-index
// ---------------------------------------------------------------------------

const MemoryV3RebuildIndexResultSchema = z.object({
  ok: z.literal(true),
});
export type MemoryV3RebuildIndexResult = z.infer<
  typeof MemoryV3RebuildIndexResultSchema
>;

/**
 * Invalidate the v3 shadow lanes so the next turn rebuilds the section index
 * from the current on-disk state. Runs in-daemon so it drops the live
 * process's cached lanes immediately; the bumped lanes-version token also
 * reaches every other process's memo on its next `getLanes`.
 */
export async function handleMemoryV3RebuildIndex(): Promise<MemoryV3RebuildIndexResult> {
  invalidateLanes();
  log.info("memory-v3 lanes invalidated (rebuild-index)");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// backfill-sections
// ---------------------------------------------------------------------------

const MemoryV3BackfillSectionsResultSchema = z.object({
  /** Pages whose sections were embedded this pass. */
  articles: z.number(),
  /** Total section points upserted across all articles. */
  sections: z.number(),
  /** Pages whose embed threw (and was contained). */
  failures: z.number(),
});
export type MemoryV3BackfillSectionsResult = z.infer<
  typeof MemoryV3BackfillSectionsResultSchema
>;

/**
 * One-time full backfill of the section dense store: embed EVERY page in the
 * index — including synthetic skill/CLI rows the incremental maintain pass
 * skips — into the `memory_v3_sections` collection, then advance the maintain
 * high-water mark so the next incremental run deltas from here. Runs in-daemon
 * so it uses the live config and so the maintain checkpoint it advances is the
 * one the daemon's incremental pass reads.
 *
 * `config` is injectable for tests; production resolves the live config.
 */
export async function handleMemoryV3BackfillSections(
  config: AssistantConfig = getConfig(),
): Promise<MemoryV3BackfillSectionsResult> {
  const outcome = await backfillAllSections(config);
  log.info(outcome, "memory-v3 section backfill complete (route)");
  return outcome;
}

// ---------------------------------------------------------------------------
// Route definitions (RouteHandlerArgs adapters over the handlers above)
// ---------------------------------------------------------------------------

/**
 * Mutating verbs require `settings.write`. `rebuild-index` invalidates the live
 * lanes and `backfill-sections` writes the dense store + advances the maintain
 * checkpoint, so a `settings.read`-only principal must not reach them.
 */
const WRITE_POLICY: RoutePolicy = {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

// ---------------------------------------------------------------------------
// gate-stats
// ---------------------------------------------------------------------------

const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Corpus size buckets for gate-stats aggregation (in concept pages). */
const CORPUS_BUCKETS = [
  { label: "0–9", min: 0, max: 9 },
  { label: "10–49", min: 10, max: 49 },
  { label: "50–199", min: 50, max: 199 },
  { label: "200+", min: 200, max: Infinity },
] as const;

type BucketLabel = (typeof CORPUS_BUCKETS)[number]["label"];

interface BucketAcc {
  total: number;
  scored: number;
  passed: number;
  /** Passes that came from scored runs — the numerator for scoredPassRate. */
  scoredPassed: number;
  reasons: Record<string, number>;
}

function corpusBucketLabel(pageCount: number): BucketLabel {
  for (const b of CORPUS_BUCKETS) {
    if (pageCount <= b.max) {
      return b.label;
    }
  }
  return "200+";
}

interface GatePayloadDetail {
  pass?: boolean;
  reason?: string;
  scored?: boolean;
  real_concept_page_count?: number;
}

const GateStatsBucketSchema = z.object({
  pageCountRange: z
    .string()
    .describe("Concept page count range (e.g. '10–49')"),
  total: z
    .number()
    .describe("All gate runs in this bucket (scored + pass-open)"),
  scored: z
    .number()
    .describe("Runs that weighed scores (dense lane available)"),
  passed: z.number().describe("Runs that passed the gate"),
  scoredPassRate: z
    .number()
    .nullable()
    .describe(
      "scoredPasses / scored (contested decisions only); null when no scored runs in bucket",
    ),
  reasons: z
    .record(z.string(), z.number())
    .describe("Gate reason code → run count (dense_pass, fail_no_signal, …)"),
});

export const GateStatsResponseSchema = z.object({
  lookbackDays: z.number().describe("Lookback window applied"),
  totalRuns: z.number().describe("Total gate runs found in the window"),
  buckets: z
    .array(GateStatsBucketSchema)
    .describe("Stats by concept page count range, lean→large"),
  unknownPageCount: z
    .object({
      total: z.number(),
      passed: z.number(),
      reasons: z.record(z.string(), z.number()),
    })
    .describe("Runs with no real_concept_page_count in telemetry detail"),
});

export type GateStatsResponse = z.infer<typeof GateStatsResponseSchema>;

/**
 * Aggregate memory v3 injection gate runs from the telemetry outbox for the
 * given lookback window. Groups runs by concept page count bucket and computes
 * pass rates and reason distributions per bucket.
 *
 * Pass-open shortcuts (dense disabled/unavailable, gate threw) are included in
 * `total` but not in `scored`, so `scoredPassRate` reflects only contested gate
 * decisions — the signal that actually reveals whether the gate thresholds are
 * calibrated correctly.
 */
export function handleMemoryV3GateStats(
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
  db: ReturnType<typeof getTelemetrySqlite> = getTelemetrySqlite(),
): GateStatsResponse {
  const days = Math.min(
    Math.max(1, Math.floor(lookbackDays)),
    MAX_LOOKBACK_DAYS,
  );
  const since = Date.now() - days * MS_PER_DAY;

  const emptyBuckets = (): GateStatsResponse["buckets"] =>
    CORPUS_BUCKETS.map((b) => ({
      pageCountRange: b.label,
      total: 0,
      scored: 0,
      passed: 0,
      scoredPassRate: null,
      reasons: {},
    }));
  if (!db) {
    return {
      lookbackDays: days,
      totalRuns: 0,
      buckets: emptyBuckets(),
      unknownPageCount: { total: 0, passed: 0, reasons: {} },
    };
  }

  const rows = db
    .query(
      /*sql*/ `
      SELECT payload FROM telemetry_events
      WHERE name = 'watchdog'
        AND created_at >= ?
        AND json_extract(payload, '$.check_name') = ?
    `,
    )
    .all(since, MEMORY_V3_INJECTION_GATE_CHECK_NAME) as Array<{
    payload: string;
  }>;

  const bucketMap = new Map<BucketLabel, BucketAcc>(
    CORPUS_BUCKETS.map((b) => [
      b.label,
      { total: 0, scored: 0, passed: 0, scoredPassed: 0, reasons: {} },
    ]),
  );
  const unknown: BucketAcc = {
    total: 0,
    scored: 0,
    passed: 0,
    scoredPassed: 0,
    reasons: {},
  };

  for (const row of rows) {
    let detail: GatePayloadDetail;
    try {
      const parsed = JSON.parse(row.payload) as { detail?: GatePayloadDetail };
      detail = parsed.detail ?? {};
    } catch {
      continue;
    }

    const pageCount =
      typeof detail.real_concept_page_count === "number"
        ? detail.real_concept_page_count
        : null;

    const acc =
      pageCount !== null
        ? (bucketMap.get(corpusBucketLabel(pageCount)) ?? unknown)
        : unknown;

    acc.total += 1;
    if (detail.scored === true) {
      acc.scored += 1;
      if (detail.pass === true) {
        acc.scoredPassed += 1;
      }
    }
    if (detail.pass === true) {
      acc.passed += 1;
    }
    const reason =
      typeof detail.reason === "string" ? detail.reason : "unknown";
    acc.reasons[reason] = (acc.reasons[reason] ?? 0) + 1;
  }

  const buckets = CORPUS_BUCKETS.map((b) => {
    const acc = bucketMap.get(b.label)!;
    return {
      pageCountRange: b.label,
      total: acc.total,
      scored: acc.scored,
      passed: acc.passed,
      scoredPassRate: acc.scored > 0 ? acc.scoredPassed / acc.scored : null,
      reasons: acc.reasons,
    };
  });

  return {
    lookbackDays: days,
    totalRuns: rows.length,
    buckets,
    unknownPageCount: {
      total: unknown.total,
      passed: unknown.passed,
      reasons: unknown.reasons,
    },
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_v3_rebuild_index",
    method: "POST",
    policy: WRITE_POLICY,
    endpoint: "memory/v3/rebuild-index",
    handler: () => handleMemoryV3RebuildIndex(),
    summary: "Invalidate the v3 lanes so the next turn rebuilds",
    tags: ["memory"],
    responseBody: MemoryV3RebuildIndexResultSchema,
  },
  {
    operationId: "memory_v3_backfill_sections",
    method: "POST",
    policy: WRITE_POLICY,
    endpoint: "memory/v3/backfill-sections",
    handler: () => handleMemoryV3BackfillSections(),
    summary:
      "One-time: embed every page's sections (incl synthetic skill/CLI rows) into the dense store",
    tags: ["memory"],
    responseBody: MemoryV3BackfillSectionsResultSchema,
  },
];
