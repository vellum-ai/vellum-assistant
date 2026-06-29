/**
 * Learned-edge lane: a co-selection association graph over
 * `memory_v3_selections`, scored by NPMI (normalized pointwise mutual
 * information).
 *
 * Two pages that keep getting SELECTED together are associated in how the
 * corpus is actually used, whether or not any authored `[[link]]` connects
 * them. That behavioral signal is exactly what the static edge lane cannot
 * see, and it reaches the candidate class no other lane can: pages relevant
 * by association, with no lexical/semantic overlap with the query and no
 * curated link from any seed. Capability slugs (skills / CLI commands)
 * participate like any page — a skill co-selected with a topic page is a
 * real association worth following.
 *
 * Scoring: selections are grouped into selector calls
 * (`conversation_id` + `created_at`); each call contributes a
 * recency-decayed weight `2^(−age / halfLifeMs)` to every slug (unigram) and
 * unordered slug-pair (co-occurrence) it selected. NPMI per pair:
 *
 *     npmi(a,b) = ln(p(a,b) / (p(a)·p(b))) / −ln(p(a,b))
 *
 * NPMI is what makes the lane safe around the stable-prefix pages: a page
 * selected in (nearly) every call has p(a) ≈ 1, so p(a,b) ≈ p(b) and the
 * numerator collapses to ~0 — ubiquitous pages form no edges, mathematically,
 * rather than by special-casing. The `minCount` mass floor suppresses
 * rare-pair noise (NPMI explodes on coincidences), and `maxPerPage` bounds
 * each page's out-degree, which is the lane's real noise control.
 *
 * The result is emitted as an {@link EdgeGraph} so expansion REUSES
 * `edgeExpand` unchanged. Neighbors are inserted in NPMI-descending order —
 * `edgeExpand` takes neighbors in insertion order, so its `perSeed` budget
 * consumes the strongest associations first. The graph carries no hubs
 * (the per-page cap is the degree control) and no curated descriptions
 * (the orchestrator falls back to a section descriptor).
 *
 * Like the other computed lanes, the graph is built at lane init and rebuilt
 * on lane invalidation (the consolidation cadence). The selections table is
 * the persistence; nothing else is stored.
 */

import {
  type DrizzleDb,
  getSqliteFrom,
} from "../../../../persistence/db-connection.js";
import type { EdgeGraph } from "./edge.js";
import type { Slug } from "./types.js";

export interface LearnedEdgesDeps {
  /** Handle to the database containing `memory_v3_selections`. */
  db: DrizzleDb;
}

export interface LearnedEdgesOptions {
  /** Decay half-life in milliseconds: a selector call this old contributes
   *  half the weight of one made now. */
  halfLifeMs: number;
  /** Minimum decayed co-occurrence mass for a pair to form an edge — the
   *  rare-pair noise floor (NPMI explodes on coincidences). */
  minCount: number;
  /** Minimum NPMI for a pair to form an edge. */
  npmiFloor: number;
  /** Maximum out-edges kept per page (strongest-NPMI first); `0` disables
   *  the lane (empty graph). */
  maxPerPage: number;
  /** Reference timestamp (ms epoch) ages are measured against. */
  now: number;
  /** Only selections younger than this window are read. At a 30-day
   *  half-life, rows beyond ~90 days carry negligible weight anyway — the
   *  window bounds the scan, not the math. */
  windowMs: number;
  /** Slugs that may form edges — the live section-index membership, so
   *  selections of since-deleted pages can never surface a dangling
   *  candidate. */
  knownSlugs: Set<string>;
}

interface SelectionRow {
  conversation_id: string;
  slug: string;
  created_at: number;
}

/**
 * Build the learned-edge {@link EdgeGraph} from the selection log.
 *
 * Deterministic for fixed inputs: per-page neighbors order by NPMI desc, then
 * peer slug asc. Symmetric by construction — an edge contributes to BOTH
 * endpoints' neighbor lists (each independently subject to `maxPerPage`).
 */
export function computeLearnedEdgeGraph(
  deps: LearnedEdgesDeps,
  opts: LearnedEdgesOptions,
): EdgeGraph {
  const { halfLifeMs, minCount, npmiFloor, maxPerPage, now, windowMs } = opts;
  const empty: EdgeGraph = {
    adjacency: new Map(),
    hubs: new Set(),
    slugs: opts.knownSlugs,
  };
  if (maxPerPage <= 0) return empty;

  const rows = getSqliteFrom(deps.db)
    .query(
      /*sql*/ `
      SELECT conversation_id, slug, created_at FROM memory_v3_selections
      WHERE created_at >= ?
    `,
    )
    .all(now - windowMs) as SelectionRow[];
  if (rows.length === 0) return empty;

  // Group into selector calls; one decayed weight per call.
  const calls = new Map<string, { weight: number; slugs: Set<Slug> }>();
  for (const row of rows) {
    if (!opts.knownSlugs.has(row.slug)) continue;
    const key = `${row.conversation_id}|${row.created_at}`;
    let call = calls.get(key);
    if (!call) {
      const age = Math.max(0, now - row.created_at);
      call = { weight: 2 ** (-age / halfLifeMs), slugs: new Set() };
      calls.set(key, call);
    }
    call.slugs.add(row.slug);
  }

  // Decayed unigram and pair masses. Pair keys order endpoints
  // lexicographically so (a,b) and (b,a) accumulate together.
  const uni = new Map<Slug, number>();
  const pair = new Map<string, number>();
  let total = 0;
  for (const { weight, slugs } of calls.values()) {
    total += weight;
    const arr = [...slugs];
    for (const slug of arr) uni.set(slug, (uni.get(slug) ?? 0) + weight);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key =
          arr[i]! < arr[j]! ? `${arr[i]}\t${arr[j]}` : `${arr[j]}\t${arr[i]}`;
        pair.set(key, (pair.get(key) ?? 0) + weight);
      }
    }
  }
  if (total <= 0) return empty;

  // Score pairs and collect each endpoint's qualifying neighbors.
  const neighbors = new Map<Slug, Array<{ peer: Slug; npmi: number }>>();
  const addNeighbor = (from: Slug, peer: Slug, npmi: number): void => {
    let list = neighbors.get(from);
    if (!list) {
      list = [];
      neighbors.set(from, list);
    }
    list.push({ peer, npmi });
  };
  for (const [key, mass] of pair) {
    if (mass < minCount) continue;
    const [a, b] = key.split("\t") as [Slug, Slug];
    const pab = mass / total;
    const pa = uni.get(a)! / total;
    const pb = uni.get(b)! / total;
    const npmi = Math.log(pab / (pa * pb)) / -Math.log(pab);
    if (npmi <= npmiFloor) continue;
    addNeighbor(a, b, npmi);
    addNeighbor(b, a, npmi);
  }

  // Emit adjacency with neighbors in NPMI-desc order (edgeExpand consumes
  // insertion order), capped per page.
  const adjacency = new Map<Slug, Map<Slug, string | undefined>>();
  for (const [slug, list] of neighbors) {
    list.sort((x, y) => y.npmi - x.npmi || (x.peer < y.peer ? -1 : 1));
    const out = new Map<Slug, string | undefined>();
    for (const { peer } of list.slice(0, maxPerPage)) out.set(peer, undefined);
    adjacency.set(slug, out);
  }

  return { adjacency, hubs: new Set(), slugs: opts.knownSlugs };
}
