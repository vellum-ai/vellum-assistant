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
import { renderCard } from "./card.js";
import { loadCoreSet } from "./core-set.js";
import type { EdgeGraph } from "./edge.js";
import { buildEdgeGraph } from "./edge.js";
import { computeFreshSet } from "./fresh-set.js";
import { computeHotSet } from "./hot-set.js";
import { computeLearnedEdgeGraph } from "./learned-edges.js";
import type { OrchestrateResult } from "./orchestrate.js";
import { orchestrate } from "./orchestrate.js";
import { MemoryV3RetrievalUnavailableError } from "./pool-select.js";
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

/** How many trailing characters of the previous assistant reply feed the
 *  reply-query finder pass. */
const REPLY_QUERY_TAIL_CHARS = 2500;

/** Selection-log scan window for the learned-edge graph. At the default
 *  30-day half-life, rows beyond ~3 half-lives carry negligible weight — the
 *  window bounds the scan, not the math. */
const LEARNED_EDGES_WINDOW_DAYS = 90;

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
  /** Modification-recency fresh set in recency order: core and hot excluded,
   *  filtered to pages in the section index. */
  freshSlugs: string[];
  /** Learned-edge graph: co-selection NPMI associations over the selection
   *  log, rebuilt with the lanes (the consolidation cadence). */
  learnedGraph: EdgeGraph;
  /** Pre-rendered FULL cards for the stable-prefix (core+hot+fresh) slugs,
   *  keyed by slug. Frozen at lane build so the selector's stable prefix is
   *  byte-identical across turns until the next invalidation. */
  prefixCards: Map<Slug, string>;
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

  // Fresh is the modification-recency top-K over the page index with core and
  // hot excluded (fresh never duplicates the rest of the prefix). Page mtimes
  // move at consolidation — the same event that invalidates the lanes — so the
  // set is recomputed exactly when it can have changed.
  const freshSlugs = computeFreshSet(pageIndex.entries, {
    k: config.memory.v3.freshSet.k,
    excludeSlugs: new Set([...coreSlugs, ...hotSlugs]),
  }).filter((slug) => sectionIndex.byArticle.has(slug));

  // Pre-render the stable-prefix cards ONCE per lane build: the selector's
  // stable prefix must be byte-identical across turns to ride the provider KV
  // cache, so the cards are frozen here (lane invalidation at consolidation is
  // the recompute point) instead of being re-read per turn. Capability slugs
  // render their capability content; disk pages render raw (frontmatter +
  // body) so `kind: index` pages surface their `links:` map in the card TOC.
  // Each card carries its lane annotation; fresh cards additionally carry the
  // page's last-modified time (an absolute stamp — it only changes when the
  // page does, so the card stays byte-stable between lane recomputes).
  const modifiedAtBySlug = new Map(
    pageIndex.entries.map((entry) => [entry.slug, entry.modifiedAt]),
  );
  const laneAnnotation = (slug: Slug, lane: "core" | "hot" | "fresh") => {
    if (lane !== "fresh") return `[lane: ${lane}]`;
    const modifiedAt = modifiedAtBySlug.get(slug);
    if (
      modifiedAt === undefined ||
      !Number.isFinite(modifiedAt) ||
      modifiedAt <= 0
    ) {
      return "[lane: fresh]";
    }
    const stamp = new Date(modifiedAt)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    return `[lane: fresh · updated ${stamp} UTC]`;
  };
  const prefixCards = new Map<Slug, string>();
  for (const [lane, slugs] of [
    ["core", coreSlugs],
    ["hot", hotSlugs],
    ["fresh", freshSlugs],
  ] as const) {
    for (const slug of slugs) {
      const raw = await capabilityOrDiskBody(
        slug,
        async (s) => (await loadPage(s))?.raw ?? "",
      );
      prefixCards.set(slug, renderCard(slug, raw, laneAnnotation(slug, lane)));
    }
  }

  const edgeGraph = await buildEdgeGraph(pageIndex.entries, pageRaw, {
    hubDegree: config.memory.v3.edge.hubDegree,
  });
  // The learned graph reads the same selection log as the hot set; section-
  // index membership is the existence filter (capability slugs included —
  // they are first-class pages there).
  const learned = config.memory.v3.learnedEdges;
  const learnedGraph = computeLearnedEdgeGraph(
    { db: getDb() },
    {
      halfLifeMs: learned.halfLifeDays * DAY_MS,
      minCount: learned.minCount,
      npmiFloor: learned.npmiFloor,
      maxPerPage: learned.maxPerPage,
      now: Date.now(),
      windowMs: LEARNED_EDGES_WINDOW_DAYS * DAY_MS,
      knownSlugs: new Set(sectionIndex.byArticle.keys()),
    },
  );
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
    learnedGraph,
    coreSlugs,
    hotSlugs,
    freshSlugs,
    prefixCards,
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
  const at = new Date();
  // Clock time matters, not just the date: fresh cards carry absolute
  // `updated <time>` stamps, and hour-grain windows ("while I was asleep",
  // "this morning") are only computable against a current-time anchor —
  // measured on a state-recall turn, the anchor alone moved selection more
  // than prompt steering did.
  const today = `Today is ${at.toDateString()}, ${at.toISOString().slice(11, 16)} UTC.`;
  return now ? `${today}\n\n${now}` : today;
}

/**
 * Build a v3 {@link MemoryRoutingTurn} from the conversation's persisted messages.
 * `currentMessage` is the latest user message; `previousAssistantMessage` is
 * the tail of the last assistant reply BEFORE that message (the reply-query
 * pass's input — absent on a conversation's first turn); `recentContext` is
 * the tail of the recent transcript; `situationalContext` carries the current
 * date and the live NOW.md scratchpad. Returns `null` when there is no user
 * message to route on (nothing to shadow this turn).
 */
function buildShadowTurn(
  conversationId: string,
  turnIndex: number,
): MemoryRoutingTurn | null {
  const rows = getMessages(conversationId);
  if (rows.length === 0) return null;

  let currentMessage = "";
  let currentIndex = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role === "user") {
      currentMessage = stringifyMessageContent(rows[i]!.content);
      if (currentMessage.length > 0) {
        currentIndex = i;
        break;
      }
    }
  }
  if (currentMessage.length === 0) return null;

  // The last assistant reply before the routed user message. Only the tail is
  // kept: replies run long, and the live threads — what the lanes should
  // retrieve on — concentrate at the end.
  let previousAssistantMessage: string | undefined;
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (rows[i]!.role !== "assistant") continue;
    const text = stringifyMessageContent(rows[i]!.content);
    if (text.length > 0) {
      previousAssistantMessage = text.slice(-REPLY_QUERY_TAIL_CHARS);
      break;
    }
  }

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
    previousAssistantMessage,
  };
}

interface SelectionRow {
  slug: Slug;
  source: SelectionSource;
  pinned: number;
  /** Ordinal of the matched section a finder lane surfaced; null for
   *  core/hot/fresh/edge selections with no matched section. */
  sectionOrdinal: number | null;
  /** Heading of the matched section; null when there is no matched section. */
  sectionTitle: string | null;
}

/**
 * Map an orchestrate result onto telemetry rows with per-lane source
 * attribution, by pool position: a selection of a stable-prefix page is
 * attributed `"core"` / `"hot"` / `"fresh"` (the lane that placed it in the
 * pool), and any other selection is attributed the finder lane that FIRST
 * surfaced it (`"needle"` / `"dense"` / `"edge"`, recorded at pool-build
 * time). A finder hit on a stable-prefix page therefore still logs as its
 * prefix lane — the prefix is where the candidate lived. (`"needle"` is the
 * fallback if a selected slug is somehow absent from every lane, which should
 * not happen since every pooled candidate comes from one.)
 */
export function attributeSelections(result: OrchestrateResult): SelectionRow[] {
  const core = new Set<Slug>(result.lanes.core);
  const hot = new Set<Slug>(result.lanes.hot);
  const fresh = new Set<Slug>(result.lanes.fresh);
  const finderLane = new Map(
    result.lanes.finder.map((c) => [c.slug, c.lane] as const),
  );
  return result.selections.map((sel) => {
    // The matched section is populated only for finder-lane hits (including
    // hits on core/hot pages); core/hot/fresh/edge-only selections have none.
    const section = result.matchedSections.get(sel.slug);
    return {
      slug: sel.slug,
      source: core.has(sel.slug)
        ? ("core" as const)
        : hot.has(sel.slug)
          ? ("hot" as const)
          : fresh.has(sel.slug)
            ? ("fresh" as const)
            : (finderLane.get(sel.slug) ?? "needle"),
      pinned: sel.pinned ? 1 : 0,
      sectionOrdinal: section?.ordinal ?? null,
      sectionTitle: section?.title ?? null,
    };
  });
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
  // `message_id` is written NULL here (the assistant message does not exist at
  // injection time) and stamped at turn end by
  // `backfillMemoryV3SelectionMessageId`.
  const stmt = raw.query(/*sql*/ `
    INSERT OR REPLACE INTO memory_v3_selections (
      conversation_id, turn, slug, source, pinned, created_at,
      message_id, section_ordinal, section_title
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  const now = Date.now();
  for (const row of rows) {
    stmt.run(
      conversationId,
      turn,
      row.slug,
      row.source,
      row.pinned,
      now,
      row.sectionOrdinal,
      row.sectionTitle,
    );
  }
}

/**
 * Stamp the turn's assistant message id onto the selection rows just written
 * for it. Mirrors the v2 activation-log backfill: `writeSelections` writes
 * `message_id = NULL` at injection time, and this runs at turn end once the
 * assistant message exists. Relies on the single-threaded-per-conversation turn
 * invariant — every NULL-`message_id` row for the conversation belongs to the
 * turn that just finished. Lets the inspector look v3 selections up by the
 * turn's message ids (robust against v2/v3 turn-counter drift).
 */
export function backfillMemoryV3SelectionMessageId(
  conversationId: string,
  assistantMessageId: string,
): void {
  getSqliteFrom(getDb())
    .query(
      /*sql*/ `UPDATE memory_v3_selections SET message_id = ?
               WHERE conversation_id = ? AND message_id IS NULL`,
    )
    .run(assistantMessageId, conversationId);
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
    if (cfg.memory.enabled === false) return null;
    const lanes = await getLanes(cfg);
    const v3 = cfg.memory.v3;
    const result = await orchestrate(turn, {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: lanes.denseConfig,
      edgeGraph: lanes.edgeGraph,
      coreSlugs: lanes.coreSlugs,
      hotSlugs: lanes.hotSlugs,
      freshSlugs: lanes.freshSlugs,
      prefixCards: lanes.prefixCards,
      needleK: v3.needleK,
      denseK: v3.denseK,
      replyQueryK: v3.replyQueryK,
      edgeSeeds: v3.edge.seedCount,
      edgePerSeed: v3.edge.perSeed,
      edgeCap: v3.edge.cap,
      learnedGraph: lanes.learnedGraph,
      learnedPerSeed: v3.learnedEdges.perSeed,
      learnedCap: v3.learnedEdges.cap,
    });

    // A zero-selection turn over a non-trivial pool is unusual enough to be
    // worth a breadcrumb (observed on meta-prompt-shaped system turns): the
    // turn itself proceeds normally — cards already in context still serve it.
    if (result.selections.length === 0) {
      log.info(
        {
          conversationId,
          core: result.lanes.core.length,
          hot: result.lanes.hot.length,
          fresh: result.lanes.fresh.length,
          finder: result.lanes.finder.length,
        },
        "memory-v3: selector returned zero selections",
      );
    }

    const rows = attributeSelections(result);
    writeSelections(conversationId, turnIndex, rows);
    return result;
  } catch (err) {
    // An INFRASTRUCTURE failure (the selector lost its provider — e.g. a
    // transient CES credential blip) must NOT be silently swallowed: re-throw
    // so the LIVE injector hard-fails the turn (a clean, retryable failure)
    // rather than shipping it with no `<memory>` block. The shadow/observation
    // callers (the injector in shadow mode, runShadowObservation) catch this
    // and swallow it, so observation never fails a turn. Other (non-infra)
    // errors stay non-fatal and degrade to no v3 block, as before.
    if (err instanceof MemoryV3RetrievalUnavailableError) {
      throw err;
    }
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
  const config = getConfig();
  if (config.memory.enabled === false) return;
  if (!isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config)) return;
  try {
    await observeTurn(conversationId, turnIndex);
  } catch {
    // Shadow observation is fire-and-forget and must NEVER fail a turn.
    // `observeTurn` now re-throws infra failures so the LIVE injector can
    // hard-fail on them; here (observation only) we swallow them.
  }
}
