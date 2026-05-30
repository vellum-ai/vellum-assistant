/**
 * Memory v3 — flag-gated shadow/live plugin.
 *
 * Registered as an {@link Injector} that runs the v3 orchestrator each turn and
 * records its selection set to `memory_v3_selections`. Two flags gate its
 * injection behavior:
 *
 *   - `memory-v3-shadow` (and live OFF): observation-only. `produce()` returns
 *     `null`, so v2 injection is bit-for-bit identical whether the flag is on
 *     or off — the only difference is the side-effect telemetry write.
 *   - `memory-v3-live`: live injection. `produce()` additionally renders the
 *     working-set selection into a `<memory>` block via {@link renderMemoryBlock}
 *     and returns it as an injection block at v2's dynamic-memory placement
 *     (`after-memory-prefix`). Selections are still logged.
 *   - both OFF: `produce()` returns `null` and skips orchestration entirely.
 *
 * On each turn (either flag on):
 *   1. Lazy-init the v3 lanes ONCE across the whole process (leaf tree, core
 *      set, BM25 needle, carry-forward working set), memoizing the init
 *      promise so concurrent first turns share a single build.
 *   2. Build a {@link TurnContext} from the conversation's recent messages.
 *   3. Run {@link orchestrate} and record its selection set to
 *      `memory_v3_selections` with a best-effort lane attribution.
 *
 * Everything after the flag read is wrapped in try/catch — any failure is
 * logged and swallowed so it can never affect the live turn. In live mode a
 * failure returns `null` (no v3 injection); v2 suppression keys off BOTH the
 * flag AND whether `produce()` actually returned a block, so a v3 failure (or
 * empty selection) falls back to v2 memory rather than dropping all memory.
 */

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import { getMessages } from "../../memory/conversation-crud.js";
import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { stringifyMessageContent } from "../../memory/message-content.js";
import { registerPlugin } from "../../plugins/registry.js";
import {
  type InjectionBlock,
  type Injector,
  type Plugin,
  PluginExecutionError,
  type TurnContext as PluginTurnContext,
} from "../../plugins/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { getPageIndex } from "../v2/page-index.js";
import { readPage, renderPageContent } from "../v2/page-store.js";
import { loadCore } from "./core.js";
import type { NeedleIndex } from "./needle.js";
import { buildNeedleIndex } from "./needle.js";
import type { OrchestrateResult } from "./orchestrate.js";
import { orchestrate } from "./orchestrate.js";
import { renderMemoryBlock } from "./render-injection.js";
import { coreSlugs, loadLeafTree, resolveDataDir } from "./tree.js";
import {
  type LeafPath,
  type LeafTree,
  MEMORY_V3_BLOCK_ID,
  type SelectionSource,
  type Slug,
  type TurnContext,
} from "./types.js";
import { WorkingSet } from "./working-set.js";

const MEMORY_V3_SHADOW = "memory-v3-shadow" as const;
const MEMORY_V3_LIVE = "memory-v3-live" as const;

const log = getLogger("memory-v3-shadow");

/** How many recent messages to fold into the shadow `recentContext` string. */
const RECENT_CONTEXT_MESSAGES = 6;

/**
 * The lazily-built, process-lifetime v3 lanes. The working set is stateful
 * (carry-forward across turns), so it is intentionally shared across every
 * shadow turn rather than rebuilt per turn — that is the whole point of the
 * carry-forward lane.
 */
export interface ShadowLanes {
  tree: LeafTree;
  core: Set<LeafPath>;
  needle: NeedleIndex;
  workingSet: WorkingSet;
}

/**
 * Memoized init promise. Caching the PROMISE (not the resolved value) means
 * concurrent first turns all await the same build instead of racing several
 * `loadLeafTree`/`buildNeedleIndex` passes.
 */
let lanesPromise: Promise<ShadowLanes> | null = null;

/** Test-only: drop the memoized lanes so a fresh init runs next turn. */
export function resetShadowLanesForTests(): void {
  lanesPromise = null;
}

/**
 * Pull a page's summary from the existing v2 page index. Missing summaries
 * (and any read failure) degrade to "" — the needle and L2 selector treat an
 * empty summary as "no signal" rather than throwing.
 */
async function pageSummary(slug: Slug): Promise<string> {
  try {
    const index = await getPageIndex(getWorkspaceDir());
    return index.bySlug.get(slug)?.summary ?? "";
  } catch {
    return "";
  }
}

/**
 * Render a selected page's full content for live injection. Mirrors the v2
 * dynamic-memory layout (`# memory/concepts/<slug>.md\n<frontmatter+body>`) so
 * the working-set block reads like v2's. A missing page (or any read failure)
 * degrades to "" — `renderMemoryBlock` still emits a line for the slug, and a
 * blank section is preferable to throwing into the turn.
 */
async function pageContent(slug: Slug): Promise<string> {
  try {
    const page = await readPage(getWorkspaceDir(), slug);
    if (!page) return "";
    const content = renderPageContent(page).trim();
    if (content.length === 0) return "";
    return `# memory/concepts/${slug}.md\n${content}`;
  } catch {
    return "";
  }
}

async function initLanes(config: AssistantConfig): Promise<ShadowLanes> {
  const dataDir = resolveDataDir();
  const tree = await loadLeafTree(dataDir);
  const core = await loadCore(dataDir);

  const needle = await buildNeedleIndex(tree, pageSummary);
  const workingSet = new WorkingSet(
    config.memory.v3.workingSet.maxPages,
    config.memory.v3.workingSet.evictWindow,
  );

  return { tree, core, needle, workingSet };
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
 * Build a v3 {@link TurnContext} from the conversation's persisted messages.
 * `currentMessage` is the latest user message; `recentContext` is the tail of
 * the recent transcript. Returns `null` when there is no user message to route
 * on (nothing to shadow this turn).
 */
function buildShadowTurn(
  conversationId: string,
  turnIndex: number,
): TurnContext | null {
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
  };
}

interface SelectionRow {
  slug: Slug;
  source: SelectionSource;
  pinned: number;
}

/**
 * Map an orchestrate result onto telemetry rows with best-effort lane
 * attribution.
 *
 * - A current selection whose page belongs to a core leaf → `"core+l2"`,
 *   otherwise `"l1+l2"`.
 * - A slug in `finalInjection` but NOT re-selected this turn → `"carry-forward"`.
 *
 * Precise needle attribution is a documented follow-up: the needle lane only
 * widens the open set, so a needle-surfaced page that survives L2 selection is
 * indistinguishable here from an L1-routed one. This coarse mapping is
 * acceptable for v0 shadow telemetry.
 */
function attributeSelections(
  tree: LeafTree,
  core: Set<LeafPath>,
  result: OrchestrateResult,
): SelectionRow[] {
  const coreOwnedSlugs = coreSlugs(tree, core);

  const rows: SelectionRow[] = [];
  const seen = new Set<Slug>();
  for (const sel of result.currentSelections) {
    seen.add(sel.slug);
    rows.push({
      slug: sel.slug,
      source: coreOwnedSlugs.has(sel.slug) ? "core+l2" : "l1+l2",
      pinned: sel.pinned ? 1 : 0,
    });
  }
  for (const slug of result.finalInjection) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    rows.push({ slug, source: "carry-forward", pinned: 0 });
  }
  return rows;
}

/** Write the attributed selection rows to `memory_v3_selections`. */
function writeSelections(
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
async function observeTurn(
  conversationId: string,
  turnIndex: number,
): Promise<OrchestrateResult | null> {
  try {
    const turn = buildShadowTurn(conversationId, turnIndex);
    if (!turn) return null;

    const lanes = await getLanes(getConfig());
    const result = await orchestrate(turn, {
      tree: lanes.tree,
      core: lanes.core,
      needle: lanes.needle,
      workingSet: lanes.workingSet,
      pageSummary,
    });

    const rows = attributeSelections(lanes.tree, lanes.core, result);
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

/**
 * The v3 injector. Reads both flags:
 *   - `memory-v3-live` on → orchestrate, log, render the working-set selection
 *     into a `<memory>` block, and return it at v2's dynamic-memory placement.
 *   - `memory-v3-shadow` on (live off) → orchestrate + log only, return `null`.
 *   - both off → return `null` (no orchestration).
 *
 * Empty selection and any failure return `null` (no v3 injection). v2
 * suppression keys off BOTH the flag AND this return value, so a `null` here
 * (failure or empty selection) falls back to v2 memory rather than dropping all
 * memory.
 */
const memoryV3Injector: Injector = {
  name: "memory-v3-shadow",
  // High order so it sorts last; the live `<memory>` block uses the
  // after-memory-prefix placement so it lands at the memory boundary regardless
  // of this sort key, which only orders content-producing injectors.
  order: 1000,
  async produce(ctx: PluginTurnContext): Promise<InjectionBlock | null> {
    const config = getConfig();
    const live = isAssistantFeatureFlagEnabled(MEMORY_V3_LIVE, config);
    const shadow = isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config);
    if (!live && !shadow) return null;

    const result = await observeTurn(ctx.conversationId, ctx.turnIndex);
    if (!live || !result) return null;

    try {
      // `renderMemoryBlock` returns "" for an empty selection; inject nothing.
      const text = await renderMemoryBlock(result.finalInjection, pageContent);
      if (text.length === 0) return null;
      return {
        id: MEMORY_V3_BLOCK_ID,
        text,
        // Mirror v2's dynamic `<memory>` block placement.
        placement: "after-memory-prefix",
      };
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId: ctx.conversationId,
        },
        "memory-v3 live render failed (non-fatal) — falling back to v2",
      );
      return null;
    }
  },
};

export const memoryV3ShadowPlugin: Plugin = {
  manifest: {
    name: "memory-v3-shadow",
    version: "0.0.1",
  },
  injectors: [memoryV3Injector],
};

// Module-load side effect: register at import time so the registry is
// populated even for callers that skip `bootstrapPlugins()`. Idempotent via
// the swallowed duplicate-name check — mirrors the other default plugins.
try {
  registerPlugin(memoryV3ShadowPlugin);
} catch (err) {
  if (
    err instanceof PluginExecutionError &&
    err.message.includes("already registered")
  ) {
    // already registered — expected when both index.ts and the direct file
    // are imported in the same process
  } else {
    throw err;
  }
}
