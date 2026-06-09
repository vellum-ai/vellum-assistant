/**
 * Memory v3 — flag-gated shadow/live orchestration engine.
 *
 * Runs the v3 orchestrator each turn and records its selection set to
 * `memory_v3_selections`. Two flags gate behavior:
 *
 *   - `memory-v3-shadow` (live OFF): observation-only. {@link observeTurn}
 *     orchestrates and logs the selection set; no injection is produced, so v2
 *     injection is bit-for-bit identical — the only difference is the
 *     side-effect telemetry write.
 *   - `memory-v3-live`: live injection. The injector (`memoryV3Injector` in
 *     `./injector.ts`) additionally renders this turn's selections into a
 *     `<memory>` block and returns it at v2's dynamic-memory placement
 *     (`after-memory-prefix`). Selections are still logged.
 *   - both OFF: orchestration is skipped entirely.
 *
 * On each turn (either flag on):
 *   1. Lazy-init the v3 lanes ONCE across the whole process (section index,
 *      section-grain BM25 needle, dense lane config, link-graph edge graph,
 *      curated core set, frecency hot set), memoizing the init promise so
 *      concurrent first turns share a single build.
 *   2. Build a {@link MemoryRoutingTurn} from the conversation's recent messages.
 *   3. Run {@link orchestrate} and record its selection set to
 *      `memory_v3_selections` with a best-effort lane attribution.
 *
 * {@link observeTurn} wraps everything after the flag read in try/catch — any
 * failure is logged and swallowed so it can never affect the live turn. The
 * injector treats a `null`/empty result as "no v3 injection", so v2 memory
 * remains the fallback rather than dropping all memory.
 */

import { existsSync, readFileSync } from "node:fs";

import { isAssistantFeatureFlagEnabled } from "../../../config/assistant-feature-flags.js";
import { getConfig } from "../../../config/loader.js";
import type { AssistantConfig } from "../../../config/schema.js";
import { getMessages } from "../../../memory/conversation-crud.js";
import { getDb, getSqliteFrom } from "../../../memory/db-connection.js";
import { stringifyMessageContent } from "../../../memory/message-content.js";
import { getPageIndex } from "../../../memory/v2/page-index.js";
import { readPage, renderPageContent } from "../../../memory/v2/page-store.js";
import { getLogger } from "../../../util/logger.js";
import {
  getWorkspaceDir,
  getWorkspacePromptPath,
} from "../../../util/platform.js";
import { stripCommentLines } from "../../../util/strip-comment-lines.js";
import { capabilityOrDiskBody } from "./capabilities.js";
import { loadCoreSet } from "./core-set.js";
import type { EdgeGraph } from "./edge.js";
import { buildEdgeGraph } from "./edge.js";
import { computeHotSet } from "./hot-set.js";
import type { OrchestrateResult } from "./orchestrate.js";
import { orchestrate } from "./orchestrate.js";
import { ensureSectionCollection } from "./section-dense-store.js";
import type { SectionNeedle } from "./section-needle.js";
import { buildSectionNeedle } from "./section-needle.js";
import { buildSectionIndex } from "./sections.js";
import {
  type MemoryRoutingTurn,
  type SectionIndex,
  type SelectionSource,
  type Slug,
} from "./types.js";

export const MEMORY_V3_SHADOW = "memory-v3-shadow" as const;
export const MEMORY_V3_LIVE = "memory-v3-live" as const;

const log = getLogger("memory-v3-shadow");

/** How many recent messages to fold into the shadow `recentContext` string. */
const RECENT_CONTEXT_MESSAGES = 6;

/**
 * The lazily-built, process-lifetime v3 lanes. The core and hot sets are
 * computed here (not per turn) because they are the candidate pool's STABLE
 * PREFIX — recomputing them mid-conversation would reorder the prefix and bust
 * the selector's KV cache. Lane memoization is the recompute cadence:
 * `invalidateLanes()` (called by the maintain job at consolidation) forces a
 * rebuild on the next turn.
 */
export interface ShadowLanes {
  sectionIndex: SectionIndex;
  needle: SectionNeedle;
  /** Config the dense lane needs to embed the query + search the section
   *  collection. */
  denseConfig: AssistantConfig;
  edgeGraph: EdgeGraph;
  /** Curated core set in file order, filtered to pages in the section index. */
  coreSlugs: string[];
  /** Frecency hot set in score order: core excluded, filtered to pages in the
   *  section index. */
  hotSlugs: string[];
}

/** Milliseconds per day — converts `hotSet.halfLifeDays` config to ms. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Memoized init promise. Caching the PROMISE (not the resolved value) means
 * concurrent first turns all await the same build instead of racing several
 * section-index / needle / edge-graph passes.
 */
let lanesPromise: Promise<ShadowLanes> | null = null;

/**
 * Drop the memoized lanes so the NEXT `getLanes` rebuilds them from scratch
 * (fresh section index + fresh needle + fresh edge graph). The rebuild is lazy
 * — this only clears the cache, so the cost is paid by the next caller, and
 * concurrent first-callers after the invalidation still share a single build via
 * the re-memoized promise. Call this whenever the underlying pages change on
 * disk.
 */
export function invalidateLanes(): void {
  lanesPromise = null;
}

/** Test-only alias for {@link invalidateLanes}. */
export function resetShadowLanesForTests(): void {
  invalidateLanes();
}

async function initLanes(config: AssistantConfig): Promise<ShadowLanes> {
  const pageIndex = await getPageIndex(getWorkspaceDir());
  const slugs = pageIndex.entries.map((entry) => entry.slug);

  // Read each page ONCE and feed BOTH forms downstream: the frontmatter-stripped
  // body to the section index (lexical/dense matching), and the raw page
  // (frontmatter + body) to the edge graph (so the `links:` frontmatter is
  // available). A per-slug cache holds the parsed page so the second consumer
  // reuses the first read.
  const pageCache = new Map<Slug, { body: string; raw: string } | null>();
  async function loadPage(
    slug: Slug,
  ): Promise<{ body: string; raw: string } | null> {
    if (pageCache.has(slug)) return pageCache.get(slug)!;
    let loaded: { body: string; raw: string } | null = null;
    try {
      const page = await readPage(getWorkspaceDir(), slug);
      if (page) loaded = { body: page.body, raw: renderPageContent(page) };
    } catch {
      loaded = null;
    }
    pageCache.set(slug, loaded);
    return loaded;
  }
  // Synthetic capability slugs (skills / CLI commands) have no on-disk page, so
  // they contribute their rendered capability content to the section index —
  // exactly the content `page-content.ts` injects for them. This puts them in
  // the section index, so the needle lane (and, once a backfill embeds them, the
  // dense lane) ranks them by relevance like any other page, instead of being
  // blindly added to the select pool every turn. Real pages read their body
  // through the cached `loadPage`.
  const pageBody = async (slug: Slug): Promise<string> =>
    capabilityOrDiskBody(slug, async (s) => (await loadPage(s))?.body ?? "");
  const pageRaw = async (slug: Slug): Promise<string> => {
    const loaded = await loadPage(slug);
    if (!loaded) throw new Error(`page not found: ${slug}`);
    return loaded.raw;
  };

  const sectionIndex = await buildSectionIndex(slugs, pageBody);
  const needle = buildSectionNeedle(sectionIndex);

  // The stable-prefix lanes. Core is the maintainer-curated file (file order
  // preserved — it is the prefix's stable sort), filtered to pages that exist
  // in the live section index so a dangling entry can never reach the pool.
  // Hot is the frecency top-K over `memory_v3_selections` with core excluded
  // (hot never duplicates core), filtered the same way — selection rows can
  // outlive their pages. Both are recomputed only on lane invalidation (the
  // consolidation cadence), keeping the prefix stable between rebuilds.
  const coreSlugs = loadCoreSet(getWorkspaceDir()).filter((slug) =>
    sectionIndex.byArticle.has(slug),
  );
  const hotSlugs = computeHotSet(
    { db: getDb() },
    {
      k: config.memory.v3.hotSet.k,
      halfLifeMs: config.memory.v3.hotSet.halfLifeDays * DAY_MS,
      now: Date.now(),
      excludeSlugs: new Set(coreSlugs),
    },
  )
    .map((entry) => entry.slug)
    .filter((slug) => sectionIndex.byArticle.has(slug));

  const edgeGraph = await buildEdgeGraph(pageIndex.entries, pageRaw, {
    hubDegree: config.memory.v3.edge.hubDegree,
  });
  // Ensuring the dense collection is best-effort: the needle + edge lanes and
  // the core/hot prefix are in-memory and independent of Qdrant, so a Qdrant outage
  // must NOT reject lane init (which would return `null` from observeTurn and
  // disable ALL of v3, plus poison the memoized lanes until invalidation). On
  // failure we log and continue with the dense lane degraded — denseLane already
  // returns no hits on a Qdrant error, and maintain/backfill re-ensure the
  // collection once Qdrant recovers.
  try {
    await ensureSectionCollection(config);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory-v3: section collection ensure failed; continuing with the dense lane degraded",
    );
  }

  return {
    sectionIndex,
    needle,
    denseConfig: config,
    edgeGraph,
    coreSlugs,
    hotSlugs,
  };
}

/** Lazy, memoized accessor for the shadow lanes. */
function getLanes(config: AssistantConfig): Promise<ShadowLanes> {
  if (!lanesPromise) {
    lanesPromise = initLanes(config).catch((err) => {
      // Reset on failure so a transient init error doesn't permanently wedge
      // the shadow lane — the next turn retries.
      lanesPromise = null;
      throw err;
    });
  }
  return lanesPromise;
}

/**
 * Read the live NOW.md scratchpad (the user's short "what's salient right now"
 * file), stripped of its comment lines. Mirrors `readNowScratchpad` but reads
 * through the light platform / strip utilities directly, keeping the v3
 * plugin's load (and its test) free of heavier module graphs. Returns `null`
 * when absent, empty, or unreadable.
 */
function readNowContext(): string | null {
  const nowPath = getWorkspacePromptPath("NOW.md");
  if (!existsSync(nowPath)) return null;
  try {
    const stripped = stripCommentLines(readFileSync(nowPath, "utf-8")).trim();
    return stripped.length > 0 ? stripped : null;
  } catch {
    return null;
  }
}

/**
 * Compose the situational signal threaded into pool selection: the current date
 * plus the live NOW.md scratchpad. The date alone is a weak signal, but together
 * with the scratchpad it lets retrieval surface a page the message never names
 * (e.g. an anniversary that falls today). Always returns at least the date line
 * — this mirrors the `c_now`/NOW.md signal the v2 retriever uses.
 */
function buildSituationalContext(): string {
  const now = readNowContext();
  const today = `Today is ${new Date().toDateString()}.`;
  return now ? `${today}\n\n${now}` : today;
}

/**
 * Build a v3 {@link MemoryRoutingTurn} from the conversation's persisted messages.
 * `currentMessage` is the latest user message; `recentContext` is the tail of
 * the recent transcript; `situationalContext` carries the current date and the
 * live NOW.md scratchpad. Returns `null` when there is no user message to route
 * on (nothing to shadow this turn).
 */
function buildShadowTurn(
  conversationId: string,
  turnIndex: number,
): MemoryRoutingTurn | null {
  const rows = getMessages(conversationId);
  if (rows.length === 0) return null;

  let currentMessage = "";
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role === "user") {
      currentMessage = stringifyMessageContent(rows[i]!.content);
      if (currentMessage.length > 0) break;
    }
  }
  if (currentMessage.length === 0) return null;

  const recentContext = rows
    .slice(-RECENT_CONTEXT_MESSAGES)
    .map((r) => stringifyMessageContent(r.content))
    .filter((t) => t.length > 0)
    .join("\n");

  return {
    conversationId,
    turnNumber: turnIndex,
    currentMessage,
    recentContext,
    situationalContext: buildSituationalContext(),
  };
}

interface SelectionRow {
  slug: Slug;
  source: SelectionSource;
  pinned: number;
}

/**
 * Map an orchestrate result onto telemetry rows with per-lane source
 * attribution, by pool position: a selection of a stable-prefix page is
 * attributed `"core"` / `"hot"` (the lane that placed it in the pool), and any
 * other selection is attributed the finder lane that FIRST surfaced it
 * (`"needle"` / `"dense"` / `"edge"`, recorded at pool-build time). A finder
 * hit on a core/hot page therefore still logs as core/hot — the prefix is
 * where the candidate lived. (`"needle"` is the fallback if a selected slug is
 * somehow absent from every lane, which should not happen since every pooled
 * candidate comes from one.)
 */
export function attributeSelections(result: OrchestrateResult): SelectionRow[] {
  const core = new Set<Slug>(result.lanes.core);
  const hot = new Set<Slug>(result.lanes.hot);
  const finderLane = new Map(
    result.lanes.finder.map((c) => [c.slug, c.lane] as const),
  );
  return result.selections.map((sel) => ({
    slug: sel.slug,
    source: core.has(sel.slug)
      ? ("core" as const)
      : hot.has(sel.slug)
        ? ("hot" as const)
        : (finderLane.get(sel.slug) ?? "needle"),
    pinned: sel.pinned ? 1 : 0,
  }));
}

/** Write the attributed selection rows to `memory_v3_selections`. */
export function writeSelections(
  conversationId: string,
  turn: number,
  rows: SelectionRow[],
): void {
  if (rows.length === 0) return;
  const raw = getSqliteFrom(getDb());
  // PK is (conversation_id, turn, slug); OR REPLACE keeps the write
  // idempotent if the same turn is observed twice (e.g. a retried turn).
  const stmt = raw.query(/*sql*/ `
    INSERT OR REPLACE INTO memory_v3_selections (
      conversation_id, turn, slug, source, pinned, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  for (const row of rows) {
    stmt.run(conversationId, turn, row.slug, row.source, row.pinned, now);
  }
}

/**
 * Run v3 orchestration for one turn and log the selection set, returning the
 * orchestrate result so a live caller can render it. Never throws — all
 * failures are logged and swallowed (returning `null`) so the live turn is
 * unaffected. Returns `null` when there is no user message to route on.
 */
export async function observeTurn(
  conversationId: string,
  turnIndex: number,
): Promise<OrchestrateResult | null> {
  try {
    const turn = buildShadowTurn(conversationId, turnIndex);
    if (!turn) return null;

    const cfg = getConfig();
    const lanes = await getLanes(cfg);
    const v3 = cfg.memory.v3;
    const result = await orchestrate(turn, {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: lanes.denseConfig,
      edgeGraph: lanes.edgeGraph,
      coreSlugs: lanes.coreSlugs,
      hotSlugs: lanes.hotSlugs,
      needleK: v3.needleK,
      denseK: v3.denseK,
      edgeSeeds: v3.edge.seedCount,
      edgePerSeed: v3.edge.perSeed,
      edgeCap: v3.edge.cap,
    });

    const rows = attributeSelections(result);
    writeSelections(conversationId, turnIndex, rows);
    return result;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), conversationId },
      "memory-v3 orchestration failed (non-fatal)",
    );
    return null;
  }
}

/**
 * Test-facing shadow wrapper: gate on the shadow flag, then run v3
 * orchestration for one turn and log the selection set. Production injection
 * goes through `produce()` → {@link observeTurn} directly (which checks both
 * flags); this wrapper exists so tests can drive shadow observation in
 * isolation. Never throws — all failures are logged and swallowed so the live
 * turn is unaffected.
 */
export async function runShadowObservation(
  conversationId: string,
  turnIndex: number,
): Promise<void> {
  if (!isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, getConfig())) return;
  await observeTurn(conversationId, turnIndex);
}
