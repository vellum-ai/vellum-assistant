/**
 * Memory v3 — flag-gated, observation-only shadow plugin.
 *
 * Registered as an {@link Injector} whose `produce()` ALWAYS returns `null`, so
 * it can never modify the injected context, the run messages, or the response.
 * v2 injection is therefore bit-for-bit identical whether the
 * `memory-v3-shadow` flag is on or off — the only difference when the flag is
 * on is the side-effect telemetry write to `memory_v3_selections`.
 *
 * On each turn (flag on):
 *   1. Lazy-init the v3 lanes ONCE across the whole process (leaf tree, core
 *      set, BM25 needle, carry-forward working set), memoizing the init
 *      promise so concurrent first turns share a single build.
 *   2. Build a {@link TurnContext} from the conversation's recent messages.
 *   3. Run {@link orchestrate} and record its selection set to
 *      `memory_v3_selections` with a best-effort lane attribution.
 *
 * Everything after the flag read is wrapped in try/catch — a shadow failure is
 * logged and swallowed so it can never affect the live turn.
 */

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import { getMessages } from "../../memory/conversation-crud.js";
import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { stringifyMessageContent } from "../../memory/message-content.js";
import { registerPlugin } from "../../plugins/registry.js";
import {
  type Injector,
  type Plugin,
  PluginExecutionError,
  type TurnContext as PluginTurnContext,
} from "../../plugins/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { getPageIndex } from "../v2/page-index.js";
import { loadCore } from "./core.js";
import type { NeedleIndex } from "./needle.js";
import { buildNeedleIndex } from "./needle.js";
import type { OrchestrateResult } from "./orchestrate.js";
import { orchestrate } from "./orchestrate.js";
import { coreSlugs, loadLeafTree, resolveDataDir } from "./tree.js";
import type {
  LeafPath,
  LeafTree,
  SelectionSource,
  Slug,
  TurnContext,
} from "./types.js";
import { WorkingSet } from "./working-set.js";

const MEMORY_V3_SHADOW = "memory-v3-shadow" as const;

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
 * Core shadow observation: run v3 orchestration for one turn and log the
 * selection set. Exported for unit testing. Never throws — all failures are
 * logged and swallowed so the live turn is unaffected.
 */
export async function runShadowObservation(
  conversationId: string,
  turnIndex: number,
): Promise<void> {
  const config = getConfig();
  if (!isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config)) return;

  try {
    const turn = buildShadowTurn(conversationId, turnIndex);
    if (!turn) return;

    const lanes = await getLanes(config);
    const result = await orchestrate(turn, {
      tree: lanes.tree,
      core: lanes.core,
      needle: lanes.needle,
      workingSet: lanes.workingSet,
      pageSummary,
    });

    const rows = attributeSelections(lanes.tree, lanes.core, result);
    writeSelections(conversationId, turnIndex, rows);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), conversationId },
      "memory-v3 shadow observation failed (non-fatal)",
    );
  }
}

/**
 * The shadow injector. `produce()` runs the observation as a fire-and-forget
 * side effect and ALWAYS returns `null` so it contributes nothing to the
 * injected context. Observation is awaited so failures are caught here rather
 * than escaping as an unhandled rejection, but the return value is unused.
 */
const shadowInjector: Injector = {
  name: "memory-v3-shadow",
  // High order so it sorts last; irrelevant since it never emits a block, but
  // keeps it out of the way of content-producing injectors.
  order: 1000,
  async produce(ctx: PluginTurnContext) {
    await runShadowObservation(ctx.conversationId, ctx.turnIndex);
    return null;
  },
};

export const memoryV3ShadowPlugin: Plugin = {
  manifest: {
    name: "memory-v3-shadow",
    version: "0.0.1",
  },
  injectors: [shadowInjector],
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
