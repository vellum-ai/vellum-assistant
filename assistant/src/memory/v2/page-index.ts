/**
 * Memory v2 — Numbered page index for the router prompt.
 *
 * Renders a compact catalog of every concept page plus every seeded skill
 * entry, sorted by slug ASCII for deterministic IDs, with each entry's
 * outgoing edges resolved to numeric IDs. The router prompt consumes the
 * pre-rendered block to choose which slugs to activate per turn.
 *
 * Skill entries (those in the `skills/<id>` namespace) participate alongside
 * concept pages so the router can reach them through the same mechanism.
 * Skill entries always have `edges: []` — the cross-page edge graph is a
 * concept-page-only construct.
 *
 * The build is cached module-locally per `workspaceDir`, mirroring
 * `edge-index.ts`. Callers must invalidate via `invalidatePageIndex` when
 * concept pages or seeded skill entries change.
 */

import { getLogger } from "../../util/logger.js";
import { getPageMtimeMs, listPages, readPage } from "./page-store.js";

// Dynamic import for `./skill-store.js` happens inside `getPageIndex` so that
// modules that only need `invalidatePageIndex` (page-store.ts,
// tool-side-effects.ts) don't transitively pull in the embedding-backend
// chain via skill-store. Loading it at call time keeps the invalidation hook
// cheap and avoids cross-module import cycles in tests that mock jobs-store
// or embedding-backend.

const log = getLogger("memory-v2-page-index");

const SUMMARY_MAX_LENGTH = 200;

/**
 * Collapse every run of whitespace (including embedded newlines and tabs) to a
 * single space and trim. The router prompt renders one entry per line, so an
 * embedded newline anywhere in `summary` would split that entry across lines
 * and corrupt the format the router parses.
 */
function normalizeSummary(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX_LENGTH);
}

/**
 * One row in the rendered page index. `id` is a 1-based dense integer that is
 * stable within a single index version (i.e. a single build). It changes when
 * the index is rebuilt because IDs are derived from the slug-sorted position;
 * callers must not persist them across builds.
 */
export interface PageIndexEntry {
  /** 1-based dense numeric id, stable within an index version. */
  id: number;
  /** Concept-page slug or `skills/<id>`. */
  slug: string;
  /** Truncated to {@link SUMMARY_MAX_LENGTH} characters. */
  summary: string;
  /** Numeric IDs of outgoing edges, in sorted order. */
  edges: number[];
  /**
   * Leaf slugs declared in the page's `leaves:` frontmatter; `[]` when absent.
   * Synthetic entries (skills, CLI commands) never declare leaves.
   */
  leaves: string[];
  /**
   * File mtime in epoch ms; 0 for synthetic entries (skills, CLI commands)
   * that have no on-disk source file. Used by `splitTier1` to rank pages
   * by recency.
   */
  modifiedAt: number;
}

/**
 * Snapshot of the page index for one workspace. `entries` is sorted by slug
 * ASCII so IDs are deterministic across rebuilds with the same input. The
 * `bySlug` and `byId` maps are convenience lookups; `rendered` is the prompt
 * block consumed by the router.
 */
export interface PageIndex {
  entries: PageIndexEntry[];
  bySlug: Map<string, PageIndexEntry>;
  byId: Map<number, PageIndexEntry>;
  rendered: string;
}

interface CachedIndex {
  workspaceDir: string;
  index: PageIndex;
}

let cache: CachedIndex | null = null;

/**
 * Return a `PageIndex` for `workspaceDir`. Cached module-locally; the cache
 * is invalidated by `invalidatePageIndex` (called by daemon-side hooks when
 * concept pages, skill entries, or CLI-command entries change).
 *
 * Cold builds list every concept page in parallel, drop pages whose read
 * rejects, append seeded skill entries from `listSkillEntries()` and CLI
 * command entries from `listCliCommandEntries()`, sort by slug for
 * deterministic IDs, then resolve outgoing edges to numeric IDs.
 */
export async function getPageIndex(workspaceDir: string): Promise<PageIndex> {
  if (cache && cache.workspaceDir === workspaceDir) {
    return cache.index;
  }

  const slugs = await listPages(workspaceDir);

  // Read pages and stat their mtimes in parallel. Pages whose read rejects
  // are dropped with a warn so a single broken page never blocks the rest
  // of the index. mtime is stat'd alongside readPage so tier-1 sorting has
  // recency without a second pass over the filesystem.
  const settled = await Promise.allSettled(
    slugs.map(async (slug) => {
      const [page, mtimeMs] = await Promise.all([
        readPage(workspaceDir, slug),
        getPageMtimeMs(workspaceDir, slug),
      ]);
      return { page, mtimeMs };
    }),
  );

  interface DraftEntry {
    slug: string;
    summary: string;
    outgoingSlugs: string[];
    leaves: string[];
    modifiedAt: number;
  }

  const [
    { listSkillEntries, SKILL_SLUG_PREFIX },
    { listCliCommandEntries, CLI_COMMAND_SLUG_PREFIX },
  ] = await Promise.all([
    import("./skill-store.js"),
    import("./cli-command-store.js"),
  ]);

  // Build the synthetic-slug sets first so we can drop colliding concept
  // pages. Collision policy: **synthetic entries win**. Skill and CLI rows
  // are seeded from authoritative in-process catalogs; a hand-authored page
  // sitting under `skills/<id>` or `cli-commands/<name>` is either a stale
  // leftover from a prior write or a user mistake. `bySlug` is last-writer-
  // wins, so without explicit dedupe one side would silently shadow the
  // other depending on iteration order.
  const skillEntries = listSkillEntries();
  const skillSlugs = new Set(
    skillEntries.map((entry) => `${SKILL_SLUG_PREFIX}${entry.id}`),
  );
  const cliCommandEntries = listCliCommandEntries();
  const cliCommandSlugs = new Set(
    cliCommandEntries.map((entry) => `${CLI_COMMAND_SLUG_PREFIX}${entry.id}`),
  );

  const drafts: DraftEntry[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const slug = slugs[i];
    if (result.status === "rejected") {
      log.warn(
        { slug, err: result.reason },
        "Dropping concept page from index — read failed",
      );
      continue;
    }
    const { page, mtimeMs } = result.value;
    if (!page) continue;
    if (skillSlugs.has(slug)) {
      log.warn(
        { slug },
        "Dropping concept page from index — slug collides with a seeded skill entry; skill wins",
      );
      continue;
    }
    if (cliCommandSlugs.has(slug)) {
      log.warn(
        { slug },
        "Dropping concept page from index — slug collides with a seeded CLI-command entry; CLI command wins",
      );
      continue;
    }
    const summarySource = page.frontmatter.summary?.trim() || page.body.trim();
    drafts.push({
      slug,
      summary: normalizeSummary(summarySource),
      outgoingSlugs: page.frontmatter.edges,
      leaves: page.frontmatter.leaves ?? [],
      modifiedAt: mtimeMs,
    });
  }

  for (const entry of skillEntries) {
    drafts.push({
      slug: `${SKILL_SLUG_PREFIX}${entry.id}`,
      summary: normalizeSummary(entry.content),
      outgoingSlugs: [],
      leaves: [],
      modifiedAt: 0,
    });
  }

  for (const entry of cliCommandEntries) {
    drafts.push({
      slug: `${CLI_COMMAND_SLUG_PREFIX}${entry.id}`,
      summary: normalizeSummary(entry.description),
      outgoingSlugs: [],
      leaves: [],
      modifiedAt: 0,
    });
  }

  drafts.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  // Assign 1-based dense IDs in sort order so entries[i].id === i + 1.
  const bySlug = new Map<string, PageIndexEntry>();
  const byId = new Map<number, PageIndexEntry>();
  const entries: PageIndexEntry[] = drafts.map((draft, i) => {
    const entry: PageIndexEntry = {
      id: i + 1,
      slug: draft.slug,
      summary: draft.summary,
      edges: [],
      leaves: draft.leaves,
      modifiedAt: draft.modifiedAt,
    };
    bySlug.set(entry.slug, entry);
    byId.set(entry.id, entry);
    return entry;
  });

  // Edges whose target slug isn't in the index are dropped silently — the
  // frontmatter sweep is responsible for surfacing those as warnings.
  for (let i = 0; i < entries.length; i++) {
    const draft = drafts[i];
    const resolved: number[] = [];
    for (const targetSlug of draft.outgoingSlugs) {
      const target = bySlug.get(targetSlug);
      if (target) resolved.push(target.id);
    }
    resolved.sort((a, b) => a - b);
    entries[i].edges = resolved;
  }

  const rendered = renderIndex(entries);
  const index: PageIndex = { entries, bySlug, byId, rendered };
  cache = { workspaceDir, index };
  return index;
}

/**
 * Clear the cached index. Pass `workspaceDir` to scope invalidation to a
 * specific cache entry; omit it to clear unconditionally.
 */
export function invalidatePageIndex(workspaceDir?: string): void {
  if (!cache) return;
  if (workspaceDir === undefined || cache.workspaceDir === workspaceDir) {
    cache = null;
  }
}

/**
 * Render the prompt block: one line per entry shaped
 * `[id] slug — summary (edges: a, b, c)`. Lines without outgoing edges drop
 * the parenthetical entirely. Trailing newline so the block can be
 * concatenated into a larger prompt without manual padding.
 */
function renderIndex(entries: readonly PageIndexEntry[]): string {
  const lines = entries.map((entry) => {
    const head = `[${entry.id}] ${entry.slug} — ${entry.summary}`;
    if (entry.edges.length === 0) return head;
    return `${head} (edges: ${entry.edges.join(", ")})`;
  });
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// FNV-1a 32-bit. Stable across runtimes — never change the constants or
// future releases will silently reshuffle batches and torch every batch's
// KV cache simultaneously.
function fnv1aHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Split a global `PageIndex` into batches of approximately `batchSize`
 * entries for parallel routing. Each batch is a self-contained `PageIndex`
 * with batch-local 1-based IDs and a re-rendered prompt block.
 *
 * `batchSize === null` or `entries.length <= batchSize` short-circuits to
 * `[pageIndex]` (the same object) so single-batch callers send a request
 * bit-identical to the pre-batching code path and reuse v3's KV cache
 * untouched.
 *
 * Assignment uses FNV-1a on the slug: adding or removing one page only
 * invalidates the KV cache of the one batch it lands in, instead of
 * cascading through every batch the way index-modulo chunking would.
 *
 * Edges are re-resolved to batch-local IDs — edges pointing to pages in
 * other batches drop silently (the model can't reference them anyway).
 */
export function partitionPageIndex(
  pageIndex: PageIndex,
  batchSize: number | null,
): PageIndex[] {
  if (batchSize === null || pageIndex.entries.length <= batchSize) {
    return [pageIndex];
  }
  const batchCount = Math.ceil(pageIndex.entries.length / batchSize);
  const buckets: PageIndexEntry[][] = Array.from(
    { length: batchCount },
    () => [],
  );
  for (const entry of pageIndex.entries) {
    buckets[fnv1aHash(entry.slug) % batchCount].push(entry);
  }
  return buckets
    .filter((b) => b.length > 0)
    .map((entries) => buildLocalPageIndex(entries, pageIndex));
}

/**
 * Build a self-contained `PageIndex` from a subset of another index's
 * entries. Local entries get fresh 1-based IDs in input order, edges are
 * remapped through the source index's `byId` to local IDs (cross-batch
 * edges drop silently), and the prompt block is re-rendered.
 */
function buildLocalPageIndex(
  entries: readonly PageIndexEntry[],
  source: PageIndex,
): PageIndex {
  const localBySlug = new Map<string, PageIndexEntry>();
  const localById = new Map<number, PageIndexEntry>();
  const localEntries: PageIndexEntry[] = entries.map((src, i) => {
    const local: PageIndexEntry = {
      id: i + 1,
      slug: src.slug,
      summary: src.summary,
      edges: [],
      leaves: src.leaves,
      modifiedAt: src.modifiedAt,
    };
    localBySlug.set(local.slug, local);
    localById.set(local.id, local);
    return local;
  });
  for (let i = 0; i < localEntries.length; i++) {
    const localEdges: number[] = [];
    for (const globalEdgeId of entries[i].edges) {
      const target = source.byId.get(globalEdgeId);
      if (!target) continue;
      const localTarget = localBySlug.get(target.slug);
      if (localTarget) localEdges.push(localTarget.id);
    }
    localEdges.sort((a, b) => a - b);
    localEntries[i].edges = localEdges;
  }
  return {
    entries: localEntries,
    bySlug: localBySlug,
    byId: localById,
    rendered: renderIndex(localEntries),
  };
}

/**
 * Carve the top-N most recently modified pages into their own batch (tier
 * 1 in the v4 router architecture) and return the leftover as a second
 * `PageIndex` for downstream partitioning.
 *
 * `tier1Size === null` is a no-op — `{ tier1: null, rest: pageIndex }`
 * with the original index reference preserved so the single-batch path
 * stays bit-identical to v3 and the KV cache survives.
 *
 * Tier 1 entries are sorted by `modifiedAt` descending; ties break by
 * slug ASCII so the order is deterministic when several pages share a
 * mtime (e.g. fresh workspaces). Synthetic entries (mtime=0) sort to the
 * bottom and only enter tier 1 when there aren't enough real pages to
 * fill the pool. The rest is sorted by slug ASCII so downstream
 * hash-bucketing produces stable batches across mtime churn.
 */
export function splitTier1(
  pageIndex: PageIndex,
  tier1Size: number | null,
): { tier1: PageIndex | null; rest: PageIndex } {
  if (tier1Size === null || pageIndex.entries.length === 0) {
    return { tier1: null, rest: pageIndex };
  }
  const sortedByRecency = [...pageIndex.entries].sort((a, b) => {
    if (a.modifiedAt !== b.modifiedAt) return b.modifiedAt - a.modifiedAt;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const tier1Entries = sortedByRecency.slice(0, tier1Size);
  const tier1Slugs = new Set(tier1Entries.map((e) => e.slug));
  const restEntries = pageIndex.entries.filter((e) => !tier1Slugs.has(e.slug));

  const tier1 = buildLocalPageIndex(tier1Entries, pageIndex);
  if (restEntries.length === 0) {
    return { tier1, rest: emptyPageIndex() };
  }
  return { tier1, rest: buildLocalPageIndex(restEntries, pageIndex) };
}

/**
 * Carve the top-M highest-EMA pages into their own batch (tier 2 in the
 * v4 router architecture). Caller computes `scores` via
 * `computeInjectionScores`; this function stays pure so unit tests don't
 * need a database.
 *
 * `tier2Size === null` is a no-op. Pages with `score <= 0` (no events in
 * the read window) are ineligible regardless of `tier2Size` — a stale
 * page with zero score belongs in tier 3, not in the "useful" pool.
 * Ordering is score desc, slug-ASCII tiebreak.
 *
 * Expected call shape: orchestrator passes the *post-tier-1* `PageIndex`,
 * so we never re-promote a tier-1 page to tier 2.
 */
export function splitTier2(
  pageIndex: PageIndex,
  tier2Size: number | null,
  scores: ReadonlyMap<string, number>,
): { tier2: PageIndex | null; rest: PageIndex } {
  if (tier2Size === null || pageIndex.entries.length === 0) {
    return { tier2: null, rest: pageIndex };
  }
  const eligible = pageIndex.entries
    .map((entry) => ({ entry, score: scores.get(entry.slug) ?? 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.entry.slug < b.entry.slug
        ? -1
        : a.entry.slug > b.entry.slug
          ? 1
          : 0;
    });
  const tier2Entries = eligible.slice(0, tier2Size).map((x) => x.entry);
  if (tier2Entries.length === 0) {
    return { tier2: null, rest: pageIndex };
  }
  const tier2Slugs = new Set(tier2Entries.map((e) => e.slug));
  const restEntries = pageIndex.entries.filter((e) => !tier2Slugs.has(e.slug));
  const tier2 = buildLocalPageIndex(tier2Entries, pageIndex);
  if (restEntries.length === 0) {
    return { tier2, rest: emptyPageIndex() };
  }
  return { tier2, rest: buildLocalPageIndex(restEntries, pageIndex) };
}

function emptyPageIndex(): PageIndex {
  return {
    entries: [],
    bySlug: new Map(),
    byId: new Map(),
    rendered: "",
  };
}
