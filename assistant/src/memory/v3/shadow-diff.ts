/**
 * Memory v3 shadow-diff — compare the v3 shadow selection against the live v2
 * router selection, turn-for-turn, from the `memory_v2_activation_logs` table.
 *
 * When v3 runs in shadow mode it logs its per-turn selection as a `v3_shadow`
 * row while the live v2 router logs its own selection as a `router` row on the
 * same turn. This module pairs the two and reports where they agree, what v3
 * surfaced that v2 did not, and what v2 had that v3 dropped — broken down by the
 * v3 provenance lane so a shadow run is analyzable by where its recall comes
 * from.
 *
 * Pairing is by timestamp, NOT by the `turn` column: the shadow middleware logs
 * the orchestrator's per-runtime turn counter while v2 logs the cumulative
 * conversation turn, so the two numbers diverge. The shadow row and its sibling
 * router row are written within the same turn (a second or two apart), so each
 * shadow row is matched to the nearest router row in the same conversation
 * within a tolerance window.
 *
 * The v2 comparand is the router's FRESH per-turn pick (`status: "injected"`),
 * not its full in-context set. v2 accumulates pages across turns (`in_context`
 * carry-over can reach the hundreds on a long conversation) whereas v3 selects
 * fresh each turn; comparing fresh-against-fresh keeps the diff meaningful. The
 * carried-over count is surfaced per turn as context, not folded into the sets.
 *
 * Pure and DB-free: the route handler reads the rows and hands them here.
 */

import type { MemoryV2ConceptRowRecord } from "../memory-v2-activation-log-store.js";

/** An activation-log row reduced to what the diff needs. */
export interface ShadowDiffLogRow {
  conversationId: string;
  /** Epoch milliseconds. */
  createdAt: number;
  concepts: MemoryV2ConceptRowRecord[];
}

/** One paired (v2 router ↔ v3 shadow) turn. */
export interface ShadowDiffTurn {
  conversationId: string;
  /** Epoch ms of the v3 shadow row. */
  shadowAt: number;
  /** Epoch ms of the paired v2 router row. */
  routerAt: number;
  /** `routerAt - shadowAt`; small (within tolerance) by construction. */
  deltaMs: number;
  /** Size of the v2 fresh pick (`status: "injected"`). */
  v2Count: number;
  /** Size of the v3 shadow selection. */
  v3Count: number;
  /** v2 pages carried over from prior turns (`in_context`); annotation only. */
  v2CachedCount: number;
  /** `|overlap| / |v2 ∪ v3|`; 0 when both sets are empty. */
  jaccard: number;
  /** Slugs both systems picked, sorted. */
  overlap: string[];
  /** Slugs v3 surfaced but v2 did not freshly inject, sorted. */
  v3Only: string[];
  /** Slugs v2 freshly injected but v3 missed, sorted. */
  v2Only: string[];
  /** Provenance lane for each v3 slug (overlap + v3-only). */
  laneBySlug: Record<string, string>;
}

/** A shadow row with no router row inside the tolerance window. */
export interface UnpairedShadowTurn {
  conversationId: string;
  shadowAt: number;
  v3Count: number;
}

/** A slug with how many paired turns it appeared in. */
export interface SlugFrequency {
  slug: string;
  count: number;
}

export interface ShadowDiffResult {
  /** Pairing tolerance actually used (ms). */
  toleranceMs: number;
  /** Total v3 shadow rows in the read window. */
  shadowRows: number;
  /** Shadow rows that paired to a router row. */
  turnsCompared: number;
  /** Shadow rows that did not pair. */
  unpaired: UnpairedShadowTurn[];
  agg: {
    meanV2: number;
    meanV3: number;
    meanOverlap: number;
    meanJaccard: number;
    totalOverlap: number;
    totalV3Only: number;
    totalV2Only: number;
    /** v3-only slug count by the lane that surfaced it — v3's extra reach. */
    v3OnlyByLane: Record<string, number>;
    /** overlap slug count by the v3 lane that recovered v2's pick. */
    overlapByLane: Record<string, number>;
    /** Most frequently dropped v2 pages (recall-regression watchlist). */
    v2OnlyTop: SlugFrequency[];
    /** Most frequent v3 extras (associative reach beyond v2). */
    v3OnlyTop: SlugFrequency[];
  };
  /** Per-turn detail, newest first, capped at the requested limit. */
  turns: ShadowDiffTurn[];
}

/** Status on a v2 router row that counts as a fresh per-turn selection. */
const V2_PICKED_STATUS = "injected";
/** Status on a v2 router row that means carried-over from a prior turn. */
const V2_CACHED_STATUS = "in_context";
/** How many slugs to list in the top-frequency aggregates. */
const TOP_FREQUENCY_LIMIT = 15;

function selectedV2Slugs(concepts: MemoryV2ConceptRowRecord[]): Set<string> {
  const slugs = new Set<string>();
  for (const c of concepts) {
    if (c.status === V2_PICKED_STATUS) slugs.add(c.slug);
  }
  return slugs;
}

function cachedV2Count(concepts: MemoryV2ConceptRowRecord[]): number {
  let n = 0;
  for (const c of concepts) {
    if (c.status === V2_CACHED_STATUS) n += 1;
  }
  return n;
}

function v3LaneBySlug(
  concepts: MemoryV2ConceptRowRecord[],
): Map<string, string> {
  const bySlug = new Map<string, string>();
  for (const c of concepts) {
    bySlug.set(c.slug, c.lane ?? "unknown");
  }
  return bySlug;
}

/** Increment a string-keyed tally in place. */
function bump(tally: Record<string, number>, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1;
}

/** Sort a frequency map into the top-N slugs, ties broken by slug name. */
function topSlugs(freq: Map<string, number>, limit: number): SlugFrequency[] {
  return [...freq.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

/**
 * Pair each shadow row to the nearest unconsumed router row in the same
 * conversation within `toleranceMs`, then diff the two selections. Pairing is
 * greedy by absolute time delta; since real turns are minutes apart while a
 * shadow/router sibling pair lands a second or two apart, the greedy match is a
 * clean bijection in practice.
 */
export function computeShadowDiff(
  shadow: readonly ShadowDiffLogRow[],
  router: readonly ShadowDiffLogRow[],
  opts: { toleranceMs: number; detailLimit: number },
): ShadowDiffResult {
  const { toleranceMs, detailLimit } = opts;

  // Index router rows by conversation, time-sorted, with a consumed flag so a
  // router row pairs to at most one shadow row.
  const routerByConv = new Map<
    string,
    Array<{ row: ShadowDiffLogRow; consumed: boolean }>
  >();
  for (const row of router) {
    const bucket = routerByConv.get(row.conversationId) ?? [];
    bucket.push({ row, consumed: false });
    routerByConv.set(row.conversationId, bucket);
  }
  for (const bucket of routerByConv.values()) {
    bucket.sort((a, b) => a.row.createdAt - b.row.createdAt);
  }

  const sortedShadow = [...shadow].sort((a, b) => a.createdAt - b.createdAt);

  const turns: ShadowDiffTurn[] = [];
  const unpaired: UnpairedShadowTurn[] = [];
  const v3OnlyByLane: Record<string, number> = {};
  const overlapByLane: Record<string, number> = {};
  const v2OnlyFreq = new Map<string, number>();
  const v3OnlyFreq = new Map<string, number>();

  for (const sh of sortedShadow) {
    const bucket = routerByConv.get(sh.conversationId);
    let best: { row: ShadowDiffLogRow; consumed: boolean } | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of bucket ?? []) {
      if (candidate.consumed) continue;
      const delta = Math.abs(candidate.row.createdAt - sh.createdAt);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = candidate;
      }
    }

    if (!best || bestDelta > toleranceMs) {
      unpaired.push({
        conversationId: sh.conversationId,
        shadowAt: sh.createdAt,
        v3Count: new Set(sh.concepts.map((c) => c.slug)).size,
      });
      continue;
    }
    best.consumed = true;

    const v2Set = selectedV2Slugs(best.row.concepts);
    const laneBySlug = v3LaneBySlug(sh.concepts);
    const v3Set = new Set(laneBySlug.keys());

    const overlap: string[] = [];
    const v3Only: string[] = [];
    for (const slug of v3Set) {
      if (v2Set.has(slug)) {
        overlap.push(slug);
        bump(overlapByLane, laneBySlug.get(slug)!);
      } else {
        v3Only.push(slug);
        bump(v3OnlyByLane, laneBySlug.get(slug)!);
        v3OnlyFreq.set(slug, (v3OnlyFreq.get(slug) ?? 0) + 1);
      }
    }
    const v2Only: string[] = [];
    for (const slug of v2Set) {
      if (!v3Set.has(slug)) {
        v2Only.push(slug);
        v2OnlyFreq.set(slug, (v2OnlyFreq.get(slug) ?? 0) + 1);
      }
    }

    const unionSize = new Set([...v2Set, ...v3Set]).size;
    turns.push({
      conversationId: sh.conversationId,
      shadowAt: sh.createdAt,
      routerAt: best.row.createdAt,
      deltaMs: best.row.createdAt - sh.createdAt,
      v2Count: v2Set.size,
      v3Count: v3Set.size,
      v2CachedCount: cachedV2Count(best.row.concepts),
      jaccard: unionSize === 0 ? 0 : overlap.length / unionSize,
      overlap: overlap.sort(),
      v3Only: v3Only.sort(),
      v2Only: v2Only.sort(),
      laneBySlug: Object.fromEntries(laneBySlug),
    });
  }

  const n = turns.length;
  const sum = (pick: (t: ShadowDiffTurn) => number): number =>
    turns.reduce((acc, t) => acc + pick(t), 0);
  const mean = (pick: (t: ShadowDiffTurn) => number): number =>
    n === 0 ? 0 : sum(pick) / n;

  // Newest-first for the detail listing; aggregates are order-independent.
  const detail = [...turns]
    .sort((a, b) => b.shadowAt - a.shadowAt)
    .slice(0, detailLimit);

  return {
    toleranceMs,
    shadowRows: shadow.length,
    turnsCompared: n,
    unpaired,
    agg: {
      meanV2: mean((t) => t.v2Count),
      meanV3: mean((t) => t.v3Count),
      meanOverlap: mean((t) => t.overlap.length),
      meanJaccard: mean((t) => t.jaccard),
      totalOverlap: sum((t) => t.overlap.length),
      totalV3Only: sum((t) => t.v3Only.length),
      totalV2Only: sum((t) => t.v2Only.length),
      v3OnlyByLane,
      overlapByLane,
      v2OnlyTop: topSlugs(v2OnlyFreq, TOP_FREQUENCY_LIMIT),
      v3OnlyTop: topSlugs(v3OnlyFreq, TOP_FREQUENCY_LIMIT),
    },
    turns: detail,
  };
}
