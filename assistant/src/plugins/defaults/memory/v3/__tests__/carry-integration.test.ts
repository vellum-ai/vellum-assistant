/**
 * End-to-end integration test + measured footprint gate for the memory-v3
 * cache-aware carry rework (the whole PR 1–10 composition).
 *
 * SCOPE / ALTITUDE. A full daemon-assembly run is too heavy and too
 * mock-fragile for a unit test (same altitude call as the sibling
 * `live-integration.test.ts` / `shadow-integration.test.ts`). Instead this
 * drives a scripted 10-turn conversation through the REAL pipeline units —
 *
 *   orchestrate (core+hot stable prefix from real `loadCoreSet` /
 *     `computeHotSet`, real needle finder lane, pre-rendered prefix cards)
 *     → selectPool (real two-segment render + cache breakpoint; the PROVIDER
 *       is stubbed to return deterministic ids per scripted turn)
 *     → the real injectors (`memoryV3Injector` net-new cards + recordInjected
 *       + schedulePruneValve; `memoryV3SpotlightInjector` ephemeral window)
 *     → simulated runtime assembly (splice the card block onto the current
 *       user message; scoped spotlight strip-and-replace via the real
 *       `stripSpotlightInjections`) and metadata persistence (the
 *       user-prompt-submit hook's `memoryV3InjectedBlock` write)
 *     → the real prune valve against the live history (conversation-registry
 *       stubbed to the simulated message arrays)
 *     → rehydration from the temp DB (mirroring `daemon/conversation.ts`'s
 *       metadata splice + pruned-section filter) for the restart contract
 *
 * — and asserts the four contracts the rework ships on:
 *   1. CACHE: the selector input's stable prefix is byte-identical across all
 *      turns (and carries the cache breakpoint); per-turn persistent renders
 *      are net-new cards only; prior turns' blocks stay frozen in history.
 *   2. PRUNE: the valve trips when resident bytes exceed the cap, drops to
 *      target, exempts core/hot, and a pruned slug re-selected re-injects.
 *   3. FORK: a fork inherits the dedup record and renders no duplicate cards.
 *   4. RESTART: rebuilding history from the DB mid-script reproduces the live
 *      persistent layer byte-identically, with pruned sections still absent.
 *
 * The final test emits the measured per-turn footprint table (net-new card
 * bytes and spotlight bytes as separate columns, plus resident bytes) — the
 * cutover-gate evidence that steady-state per-turn fresh cost is
 * net-new + spotlight, not O(working set).
 *
 * `mock.module` is process-global, so every stub delegates to the real
 * implementation unless this file's tests are running (`carryMockActive`) —
 * mirrors the sibling test files. Slugs/terms are generic placeholders.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
} from "@vellumai/plugin-api";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { stripSpotlightInjections } from "../../../../../context/strip-injections.js";
import { migrateAddMemoryV3Selections } from "../../../../../persistence/migrations/268-add-memory-v3-selections.js";
import { migrateAddMemoryV3EverInjected } from "../../../../../persistence/migrations/277-add-memory-v3-ever-injected.js";
import { migrateMemoryV3SelectionsMessageIdAndSections } from "../../../../../persistence/migrations/283-memory-v3-selections-message-id-and-sections.js";
import * as schema from "../../../../../persistence/schema/index.js";
import { unwrapMemoryBlock, wrapMemoryBlock } from "../../memory-marker.js";
import type { PageIndexEntry } from "../../v2/page-index.js";
import { cardBytes, renderCard } from "../card.js";
import { loadCoreSet } from "../core-set.js";
import type { EdgeGraph } from "../edge.js";
import { buildEdgeGraph } from "../edge.js";
import { buildSectionNeedle } from "../section-needle.js";
import { buildSectionIndex } from "../sections.js";
import {
  MEMORY_V3_COMMIT_META_KEY,
  type SectionIndex,
  type Slug,
} from "../types.js";

// ---------------------------------------------------------------------------
// Module stubs (installed before the dynamic imports below; each delegates to
// the real implementation while `carryMockActive` is false).
// ---------------------------------------------------------------------------

let carryMockActive = false;

const realPluginApi = await import("@vellumai/plugin-api");
const realFlags = {
  ...(await import("../../../../../config/assistant-feature-flags.js")),
};
const realConfigLoader = {
  ...(await import("../../../../../config/loader.js")),
};
const realDbConnection = {
  ...(await import("../../../../../persistence/db-connection.js")),
};
const realDense = { ...(await import("../dense.js")) };
const realPageContent = { ...(await import("../page-content.js")) };

let providerStub: Provider | null = null;
mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  getConfiguredProvider: async (
    ...args: Parameters<typeof realPluginApi.getConfiguredProvider>
  ) =>
    carryMockActive
      ? providerStub
      : realPluginApi.getConfiguredProvider(...args),
}));

mock.module("../../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => (prop === "child" ? () => ({}) : () => {}),
    }),
}));

// The dense lane is inert in this fixture — the needle drives the finder tail.
mock.module("../dense.js", () => ({
  ...realDense,
  denseLane: async (...args: Parameters<typeof realDense.denseLane>) =>
    carryMockActive ? [] : realDense.denseLane(...args),
  // Defensive: this fixture never sets denseK > 0, so orchestrate does not call
  // the scored lane today — but mirror the delegation so a future denseK > 0
  // test can't silently reach real Qdrant after the orchestrate swap.
  denseLaneScored: async (
    ...args: Parameters<typeof realDense.denseLaneScored>
  ) => (carryMockActive ? [] : realDense.denseLaneScored(...args)),
}));

let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3EverInjected(db);
  migrateAddMemoryV3Selections(db);
  migrateMemoryV3SelectionsMessageIdAndSections(db);
  // Minimal `messages` shape — metadata persistence, the prune valve's
  // v3-ownership scan, and the restart rehydration read only these columns.
  testSqlite.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  return db;
}
mock.module("../../../../../persistence/db-connection.js", () => ({
  ...realDbConnection,
  getDb: () => (carryMockActive ? testDb : realDbConnection.getDb()),
  getSqliteFrom: (db: unknown) =>
    carryMockActive
      ? testSqlite
      : realDbConnection.getSqliteFrom(
          db as Parameters<typeof realDbConnection.getSqliteFrom>[0],
        ),
}));

/** Mutable prune config: `null` until the script opens the valve window. */
let pruneConfig: {
  maxResidentBytes: number;
  targetResidentBytes: number;
} | null = null;
const SPOTLIGHT_N = 6;
const SPOTLIGHT_WINDOW_TURNS = 2;
mock.module("../../../../../config/loader.js", () => ({
  ...realConfigLoader,
  getConfig: () =>
    carryMockActive
      ? {
          memory: {
            v3: {
              live: true,
              spotlight: {
                n: SPOTLIGHT_N,
                windowTurns: SPOTLIGHT_WINDOW_TURNS,
              },
              prune: pruneConfig ?? undefined,
            },
          },
        }
      : realConfigLoader.getConfig(),
}));

mock.module("../../../../../config/assistant-feature-flags.js", () => ({
  ...realFlags,
  isAssistantFeatureFlagEnabled: (
    key: string,
    config: Parameters<typeof realFlags.isAssistantFeatureFlagEnabled>[1],
  ) => {
    if (!carryMockActive) {
      return realFlags.isAssistantFeatureFlagEnabled(
        key as Parameters<typeof realFlags.isAssistantFeatureFlagEnabled>[0],
        config,
      );
    }
    return key === "memory-v3-live";
  },
}));

// Cards render from the in-memory fixture corpus via the REAL renderer, so
// injected bytes are exactly what `renderCard` produces for these pages.
mock.module("../page-content.js", () => ({
  ...realPageContent,
  renderV3CardContent: async (slug: Slug) =>
    carryMockActive
      ? RAW[slug]
        ? renderCard(slug, RAW[slug])
        : ""
      : realPageContent.renderV3CardContent(slug),
}));

// The prune valve resolves the live conversation through the daemon registry.
// Route it at the simulated per-conversation histories (and keep the heavy
// daemon module graph out of this test process — same call as injection.test.ts).
const histories = new Map<string, Message[]>();
mock.module("../../../../../daemon/conversation-registry.js", () => ({
  findConversationOrSubagent: (conversationId: string) => {
    const messages = histories.get(conversationId);
    return messages ? { messages } : undefined;
  },
}));

// Real orchestration is wired under the injectors' `observeTurn` seam: each
// scripted turn runs the REAL `orchestrate` over the fixture lanes and logs
// selections through the shadow plugin's REAL attribution/writer (so hot-set
// frecency and the prune valve's recency ranking see real rows), then
// normalizes the rows' `created_at` to a per-turn stamp so recency ranking is
// deterministic regardless of wall-clock resolution.
const { orchestrate } = await import("../orchestrate.js");
const realShadowPlugin = { ...(await import("../shadow-plugin.js")) };

/** The scripted query per (conversation, turn) — the selector's `keep` list
 *  lives in the module-level `keep` the provider stub reads. */
const scriptedTurns = new Map<string, string>();

async function scriptedObserveTurn(conversationId: string, turnIndex: number) {
  if (!carryMockActive) {
    return realShadowPlugin.observeTurn(conversationId, turnIndex);
  }
  const query = scriptedTurns.get(`${conversationId}:${turnIndex}`);
  if (query === undefined) {
    throw new Error(`no scripted turn for ${conversationId}:${turnIndex}`);
  }
  const result = await orchestrate(
    {
      conversationId,
      turnNumber: turnIndex,
      currentMessage: query,
      recentContext: "prior context",
    },
    {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: {} as never,
      edgeGraph: lanes.edgeGraph,
      coreSlugs: lanes.coreSlugs,
      hotSlugs: lanes.hotSlugs,
      freshSlugs: [],
      prefixCards: lanes.prefixCards,
    },
  );
  realShadowPlugin.writeSelections(
    conversationId,
    turnIndex,
    realShadowPlugin.attributeSelections(result),
  );
  testSqlite
    .query(
      /*sql*/ `
      UPDATE memory_v3_selections SET created_at = ?
      WHERE conversation_id = ? AND turn = ?
    `,
    )
    .run(BASE + turnIndex * 1000, conversationId, turnIndex);
  return result;
}

mock.module("../shadow-plugin.js", () => ({
  ...realShadowPlugin,
  observeTurn: scriptedObserveTurn,
}));

const {
  memoryV3Injector,
  memoryV3SpotlightInjector,
  resetMemoryV3InjectorStateForTests,
} = await import("../injector.js");
const {
  forkEverInjected,
  getActiveSlugs,
  getInjected,
  getPrunedSlugs,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  residentBytes,
} = await import("../ever-injected-store.js");
const { filterPrunedCardSections, flushPruneValveForTests, parseCardSections } =
  await import("../prune.js");
const { renderCardsBlockInner, V3_CARDS_INJECTION_HEADER } =
  await import("../render-injection.js");
const { computeHotSet } = await import("../hot-set.js");

// ---------------------------------------------------------------------------
// Fixture corpus: 20 generic pages, each with a distinctive term so a needle
// query selects exactly the intended pages. `page-a`/`page-b` carry padded
// leads so the prune window (which must free their two cards) stays
// deterministic (their bytes exceed turn 7's incoming cards).
// ---------------------------------------------------------------------------

const PAGE_TERMS: Record<Slug, string> = {
  "core-alpha": "tamarind",
  "core-beta": "ugli",
  "hot-one": "quince",
  "hot-two": "raspberry",
  "hot-three": "strawberry",
  "page-a": "apple",
  "page-b": "banana",
  "page-c": "cherry",
  "page-d": "dragonfruit",
  "page-e": "elderberry",
  "page-f": "fig",
  "page-g": "guava",
  "page-h": "honeydew",
  "page-i": "imbe",
  "page-j": "jackfruit",
  "page-k": "kiwi",
  "page-l": "lemon",
  "page-m": "mango",
  "page-n": "nectarine",
  "page-o": "olive",
};
const ALL_SLUGS = Object.keys(PAGE_TERMS);

const LONG_LEAD_PAD =
  " This page carries a deliberately longer descriptive lead so its card" +
  " outweighs later cards and the scripted prune window frees exactly this" +
  " page when the valve trips.";

function pageText(slug: Slug): string {
  const term = PAGE_TERMS[slug]!;
  const pad = slug === "page-a" || slug === "page-b" ? LONG_LEAD_PAD : "";
  return (
    `lead for ${slug} covering ${term}.${pad}\n\n` +
    `## Detail\n${term} detail material for ${slug}\n\n` +
    `## Notes\ngeneral notes for ${slug}`
  );
}

const RAW: Record<Slug, string> = Object.fromEntries(
  ALL_SLUGS.map((slug) => [slug, pageText(slug)]),
);

/** A slug's card exactly as the real renderer produces it from the fixture. */
function card(slug: Slug): string {
  return renderCard(slug, RAW[slug]!);
}

const CORE_SLUGS: Slug[] = ["core-alpha", "core-beta"];
const HOT_SLUGS: Slug[] = ["hot-one", "hot-two", "hot-three"];

const CONV = "conv-carry";
const FORK_CONV = "conv-carry-fork";
/** Fixed epoch base for all timestamps (determinism). */
const BASE = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface FixtureLanes {
  sectionIndex: SectionIndex;
  needle: ReturnType<typeof buildSectionNeedle>;
  edgeGraph: EdgeGraph;
  coreSlugs: Slug[];
  hotSlugs: Slug[];
  prefixCards: Map<Slug, string>;
}
let lanes: FixtureLanes;
let workspaceDir: string;

/** Build the lanes exactly as `initLanes` does: real core-set load (curated
 *  file in a temp workspace), real frecency hot set over seeded selection
 *  rows, real section index/needle/edge graph, pre-rendered prefix cards. */
async function buildFixtureLanes(): Promise<FixtureLanes> {
  workspaceDir = mkdtempSync(join(tmpdir(), "carry-integration-"));
  mkdirSync(join(workspaceDir, "memory"), { recursive: true });
  writeFileSync(
    join(workspaceDir, "memory", "core-pages.md"),
    [
      "# Core pages (maintainer-curated)",
      "- [[core-alpha]]",
      "- core-beta",
      "Prose annotation lines are ignored by the loader.",
      "",
    ].join("\n"),
  );

  // Seed a selections history (a PRIOR conversation) making three slugs hot,
  // with distinct frecency so the hot order is deterministic.
  const seed = testSqlite.query(/*sql*/ `
    INSERT INTO memory_v3_selections
      (conversation_id, turn, slug, source, pinned, created_at)
    VALUES (?, ?, ?, 'needle', 0, ?)
  `);
  const seedCounts: Array<[Slug, number]> = [
    ["hot-one", 3],
    ["hot-two", 2],
    ["hot-three", 1],
  ];
  for (const [slug, count] of seedCounts) {
    for (let turn = 1; turn <= count; turn++) {
      seed.run("conv-seed", turn, slug, BASE - 60_000);
    }
  }

  const sectionIndex = await buildSectionIndex(
    ALL_SLUGS,
    async (slug) => RAW[slug]!,
  );
  const needle = buildSectionNeedle(sectionIndex);
  const entries: PageIndexEntry[] = ALL_SLUGS.map((slug, i) => ({
    id: i + 1,
    slug,
    summary: `summary of ${slug}`,
    edges: [],
    leaves: [],
    modifiedAt: 0,
  }));
  const edgeGraph = await buildEdgeGraph(entries, async (slug) => RAW[slug]!);

  const coreSlugs = loadCoreSet(workspaceDir).filter((slug) =>
    sectionIndex.byArticle.has(slug),
  );
  const hotSlugs = computeHotSet(
    { db: testDb },
    {
      k: 3,
      halfLifeMs: 14 * DAY_MS,
      now: BASE,
      excludeSlugs: new Set(coreSlugs),
    },
  )
    .map((entry) => entry.slug)
    .filter((slug) => sectionIndex.byArticle.has(slug));

  const prefixCards = new Map<Slug, string>(
    [...coreSlugs, ...hotSlugs].map((slug) => [slug, card(slug)]),
  );
  return { sectionIndex, needle, edgeGraph, coreSlugs, hotSlugs, prefixCards };
}

// ---------------------------------------------------------------------------
// Selector provider stub: selects the scripted `keep` slugs by pool id and
// captures the rendered stable-prefix block (text + cache_control) per call.
// ---------------------------------------------------------------------------

let keep: Slug[] = [];
let selectCalls = 0;
const stablePrefixCaptures: Array<{
  text: string;
  cacheControl: unknown;
} | null> = [];

function toolUseResponse(input: Record<string, unknown>): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [{ type: "tool_use", id: "tu-1", name: "select_pages", input }],
  };
}

/** Parse the two-segment selector input into the globally-numbered pool slug
 *  list (same helper as the sibling integration tests). */
function candidateSlugs(messages: Message[]): Slug[] {
  const entries: Array<{ id: number; slug: string }> = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "text") continue;
      const cards = /<candidate_cards>\n([\s\S]*?)\n<\/candidate_cards>/.exec(
        block.text,
      );
      if (cards) {
        for (const m of cards[1].matchAll(
          /^\[(\d+)\] # memory\/concepts\/(.+)\.md$/gm,
        )) {
          entries.push({ id: Number(m[1]), slug: m[2]! });
        }
      }
      const finder = /<candidates>\n([\s\S]*?)\n<\/candidates>/.exec(
        block.text,
      );
      if (finder) {
        for (const line of finder[1].split("\n")) {
          const m = /^\[(\d+)\] (?:\([^)]*\) )?(\S+)(?: — |$)/.exec(line);
          if (m) entries.push({ id: Number(m[1]), slug: m[2]! });
        }
      }
    }
  }
  return entries.sort((a, b) => a.id - b.id).map((e) => e.slug);
}

function makeProviderStub(): Provider {
  return {
    name: "stub",
    sendMessage: async (messages) => {
      selectCalls += 1;
      const first = messages[0]!.content[0] as
        | (ContentBlock & { cache_control?: unknown })
        | undefined;
      stablePrefixCaptures.push(
        first && first.type === "text" && first.cache_control
          ? { text: first.text, cacheControl: first.cache_control }
          : null,
      );
      const ids: number[] = [];
      candidateSlugs(messages).forEach((slug, i) => {
        if (keep.includes(slug)) ids.push(i + 1);
      });
      return toolUseResponse({ ids });
    },
  };
}

// ---------------------------------------------------------------------------
// Turn driver: simulates exactly what runtime assembly + the user-prompt-submit
// hook do around the injectors each turn (see the module doc).
// ---------------------------------------------------------------------------

interface TurnRecord {
  turn: number;
  netNewSlugs: Slug[];
  netNewBytes: number;
  blockText: string;
  cardsPlacement: string;
  spotlightText: string;
  spotlightBytes: number;
  spotlightEntries: number;
  spotlightPlacement: string;
  residentBytes: number;
  prunedSlugs: Set<string>;
  /** JSON of the spotlight-stripped (persistent-layer) history after the turn. */
  snapshot: string;
}

function insertMessageRow(
  convId: string,
  id: string,
  role: "user" | "assistant",
  content: ContentBlock[],
  createdAt: number,
): void {
  testSqlite
    .query(
      /*sql*/ `
      INSERT INTO messages (id, conversation_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `,
    )
    .run(id, convId, role, JSON.stringify(content), createdAt);
}

function persistentView(history: Message[]): string {
  return JSON.stringify(stripSpotlightInjections(history));
}

async function runTurn(
  convId: string,
  turnIndex: number,
  query: string,
  keepList: Slug[],
): Promise<TurnRecord> {
  const history = histories.get(convId)!;
  scriptedTurns.set(`${convId}:${turnIndex}`, query);
  keep = keepList;

  const userRowId = `${convId}-m${turnIndex}-user`;
  const userContent: ContentBlock[] = [
    { type: "text", text: `user message ${turnIndex}: ${query}` },
  ];
  insertMessageRow(
    convId,
    userRowId,
    "user",
    userContent,
    BASE + turnIndex * 1000,
  );
  history.push({ role: "user", content: [...userContent] });

  const ctx = {
    requestId: `req-${turnIndex}`,
    conversationId: convId,
    turnIndex,
    trust: {
      sourceChannel: "vellum" as const,
      trustClass: "guardian" as const,
    },
  };

  const activeBefore = getActiveSlugs(convId);
  const cards = await memoryV3Injector.produce(ctx);
  if (!cards)
    throw new Error(`turn ${turnIndex}: cards injector returned null`);
  // Runtime assembly invokes the block's attachment-commit callback at its
  // user-tail commit point — this is where the everInjected store records
  // the turn's cards (and the prune valve is scheduled).
  const commit = cards.meta?.[MEMORY_V3_COMMIT_META_KEY];
  if (typeof commit === "function") (commit as () => void)();
  const netNewSlugs = [...getActiveSlugs(convId)].filter(
    (slug) => !activeBefore.has(slug),
  );
  const injected = getInjected(convId);
  const netNewBytes = netNewSlugs.reduce(
    (sum, slug) => sum + injected.get(slug)!.bytes,
    0,
  );

  // Runtime assembly: a non-empty card block splices onto the CURRENT user
  // message; the user-prompt-submit hook persists the unwrapped inner text
  // under the v3 metadata key (assembly captures it unwrapped).
  if (cards.text.length > 0) {
    const tail = history[history.length - 1]!;
    tail.content = [{ type: "text", text: cards.text }, ...tail.content];
    testSqlite
      .query(/*sql*/ `UPDATE messages SET metadata = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          [MEMORY_V3_INJECTED_BLOCK_METADATA_KEY]: unwrapMemoryBlock(
            cards.text,
          ),
        }),
        userRowId,
      );
  }

  // Spotlight: scoped strip of the stale block (real assembly helper), then
  // re-attach the fresh one. Real assembly splices it after the memory cards
  // (after-memory-prefix); this sim appends to the tail because only the
  // block's presence, content, placement value, and strip-and-replace are
  // asserted here — not its exact position within the message.
  const spotlight = await memoryV3SpotlightInjector.produce(ctx);
  const stripped = stripSpotlightInjections(history);
  history.splice(0, history.length, ...stripped);
  if (spotlight) {
    const tail = history[history.length - 1]!;
    tail.content = [...tail.content, { type: "text", text: spotlight.text }];
  }

  const replyContent: ContentBlock[] = [
    { type: "text", text: `reply ${turnIndex}` },
  ];
  insertMessageRow(
    convId,
    `${convId}-m${turnIndex}-assistant`,
    "assistant",
    replyContent,
    BASE + turnIndex * 1000 + 500,
  );
  history.push({ role: "assistant", content: replyContent });

  // End of turn: the deferred prune valve (scheduled by the injector) runs.
  await flushPruneValveForTests();

  return {
    turn: turnIndex,
    netNewSlugs,
    netNewBytes,
    blockText: cards.text,
    cardsPlacement: cards.placement ?? "",
    spotlightText: spotlight?.text ?? "",
    spotlightBytes: spotlight ? Buffer.byteLength(spotlight.text, "utf8") : 0,
    spotlightEntries: spotlight
      ? (spotlight.text.match(/^## memory\/concepts\//gm) ?? []).length
      : 0,
    spotlightPlacement: spotlight?.placement ?? "",
    residentBytes: residentBytes(convId),
    prunedSlugs: getPrunedSlugs(convId),
    snapshot: persistentView(history),
  };
}

/** Rebuild a conversation's history from the temp DB — mirrors the
 *  `daemon/conversation.ts` v3 rehydration splice: re-wrap the persisted
 *  metadata block, filter pruned slugs' card sections, skip an all-pruned
 *  block, and prepend onto the stored content. */
function rehydrateFromDb(convId: string): Message[] {
  const rows = testSqlite
    .query(
      /*sql*/ `
      SELECT role, content, metadata FROM messages
      WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC
    `,
    )
    .all(convId) as Array<{
    role: "user" | "assistant";
    content: string;
    metadata: string | null;
  }>;
  const pruned = getPrunedSlugs(convId);
  return rows.map((row) => {
    let content = JSON.parse(row.content) as ContentBlock[];
    if (row.role === "user" && row.metadata) {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      const block = meta[MEMORY_V3_INJECTED_BLOCK_METADATA_KEY];
      if (typeof block === "string") {
        const resident = filterPrunedCardSections(
          unwrapMemoryBlock(block),
          pruned,
        );
        if (resident.length > 0) {
          content = [
            { type: "text", text: wrapMemoryBlock(resident) },
            ...content,
          ];
        }
      }
    }
    return { role: row.role, content };
  });
}

// ---------------------------------------------------------------------------
// The scripted 10-turn run (+ fork, + restart) executed once; tests assert on
// the collected artifacts.
// ---------------------------------------------------------------------------

const records: TurnRecord[] = [];
let forkRecord: TurnRecord;
let pruneWindow: { max: number; target: number; bytesFreedExpected: number };
let restartLiveJson = "";
let restartRehydratedJson = "";

/** Per-turn script: query terms drive the needle; `keep` is the deterministic
 *  selector output (subset of stable prefix ∪ needle hits). */
const SCRIPT: Array<{ query: string; keep: Slug[]; expectNetNew: Slug[] }> = [
  // 1 — first turn: core + hot pages selected via the stable prefix, plus one
  //     finder page.
  {
    query: "apple",
    keep: ["core-alpha", "core-beta", "hot-one", "page-a"],
    expectNetNew: ["core-alpha", "core-beta", "hot-one", "page-a"],
  },
  // 2 — finder hit on a HOT page (raspberry) keeps its matched section.
  {
    query: "banana raspberry",
    keep: ["hot-two", "page-b"],
    expectNetNew: ["hot-two", "page-b"],
  },
  // 3 — ALL-REPEAT turn: every selection already resident → zero new bytes.
  {
    query: "apple banana",
    keep: ["page-a", "page-b", "core-alpha"],
    expectNetNew: [],
  },
  // 4 — topic shift: four fresh pages.
  {
    query: "cherry dragonfruit elderberry fig",
    keep: ["page-c", "page-d", "page-e", "page-f"],
    expectNetNew: ["page-c", "page-d", "page-e", "page-f"],
  },
  // 5–6 — steady accumulation.
  {
    query: "guava honeydew imbe",
    keep: ["page-g", "page-h", "page-i"],
    expectNetNew: ["page-g", "page-h", "page-i"],
  },
  {
    query: "jackfruit kiwi lemon",
    keep: ["page-j", "page-k", "page-l"],
    expectNetNew: ["page-j", "page-k", "page-l"],
  },
  // 7 — the prune valve trips after this turn (window configured in beforeAll).
  {
    query: "mango nectarine",
    keep: ["page-m", "page-n"],
    expectNetNew: ["page-m", "page-n"],
  },
  // 8 — one more page; the restart + fork checkpoints follow this turn.
  { query: "olive", keep: ["page-o"], expectNetNew: ["page-o"] },
  // 9 — a PRUNED slug re-selected re-injects as a fresh card.
  { query: "apple", keep: ["page-a"], expectNetNew: ["page-a"] },
  // 10 — final all-repeat turn (steady state: fresh cost is spotlight-only).
  { query: "cherry", keep: ["page-c", "core-beta"], expectNetNew: [] },
];

beforeAll(async () => {
  carryMockActive = true;
  testDb = makeDb();
  providerStub = makeProviderStub();
  resetMemoryV3InjectorStateForTests();
  records.length = 0;
  stablePrefixCaptures.length = 0;
  selectCalls = 0;
  pruneConfig = null;
  histories.clear();
  scriptedTurns.clear();

  lanes = await buildFixtureLanes();
  histories.set(CONV, []);

  // Turns 1–6.
  for (let turn = 1; turn <= 6; turn++) {
    const step = SCRIPT[turn - 1]!;
    records.push(await runTurn(CONV, turn, step.query, step.keep));
  }

  // Open the prune window so turn 7 tips over the cap and one pass frees
  // EXACTLY page-a + page-b (the least-recently-selected non-exempt cards;
  // their padded leads make them outweigh turn 7's incoming cards, so
  // target < max holds).
  const residentAfter6 = residentBytes(CONV);
  const incoming = cardBytes(card("page-m")) + cardBytes(card("page-n"));
  const bytesFreedExpected =
    cardBytes(card("page-a")) + cardBytes(card("page-b"));
  pruneWindow = {
    max: residentAfter6,
    target: residentAfter6 + incoming - bytesFreedExpected,
    bytesFreedExpected,
  };
  pruneConfig = {
    maxResidentBytes: pruneWindow.max,
    targetResidentBytes: pruneWindow.target,
  };
  records.push(await runTurn(CONV, 7, SCRIPT[6]!.query, SCRIPT[6]!.keep));
  // Close the valve window so the remaining turns exercise re-injection
  // without a second prune.
  pruneConfig = null;

  records.push(await runTurn(CONV, 8, SCRIPT[7]!.query, SCRIPT[7]!.keep));

  // RESTART checkpoint: rebuild history from the DB, compare against the live
  // persistent layer, then ADOPT the rehydrated history and reset the
  // injectors' in-memory state (orchestration memo + spotlight ring) — a real
  // daemon restart does both.
  restartLiveJson = persistentView(histories.get(CONV)!);
  const rehydrated = rehydrateFromDb(CONV);
  restartRehydratedJson = JSON.stringify(rehydrated);
  histories.set(CONV, rehydrated);
  resetMemoryV3InjectorStateForTests();

  // FORK checkpoint: copy the messages (metadata blocks ride along, as in a
  // real fork) and the everInjected record (the `forkConversation()` hook),
  // then load the fork like a fresh conversation and run one turn on it.
  testSqlite
    .query(
      /*sql*/ `
      INSERT INTO messages (id, conversation_id, role, content, metadata, created_at)
      SELECT id || '-fork', ?, role, content, metadata, created_at
      FROM messages WHERE conversation_id = ?
    `,
    )
    .run(FORK_CONV, CONV);
  forkEverInjected(testDb, CONV, FORK_CONV);
  histories.set(FORK_CONV, rehydrateFromDb(FORK_CONV));
  forkRecord = await runTurn(FORK_CONV, 9, "strawberry guava", [
    "page-g",
    "hot-three",
  ]);

  // Turns 9–10 on the (restarted) parent.
  records.push(await runTurn(CONV, 9, SCRIPT[8]!.query, SCRIPT[8]!.keep));
  records.push(await runTurn(CONV, 10, SCRIPT[9]!.query, SCRIPT[9]!.keep));
});

afterAll(async () => {
  await flushPruneValveForTests();
  carryMockActive = false;
  if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Contract assertions.
// ---------------------------------------------------------------------------

describe("memory-v3 carry integration — cache contract", () => {
  test("lanes: curated core in file order; frecency hot set in score order", () => {
    expect(lanes.coreSlugs).toEqual(CORE_SLUGS);
    expect(lanes.hotSlugs).toEqual(HOT_SLUGS);
  });

  test("selector stable prefix is byte-identical across all 10 turns and carries the cache breakpoint", () => {
    // 10 parent turns + 1 fork turn, one selector call each.
    expect(selectCalls).toBe(11);
    expect(stablePrefixCaptures).toHaveLength(11);
    const first = stablePrefixCaptures[0];
    expect(first).not.toBeNull();
    expect(first!.cacheControl).toEqual({ type: "ephemeral", ttl: "1h" });
    for (const capture of stablePrefixCaptures) {
      expect(capture).not.toBeNull();
      expect(capture!.text).toBe(first!.text);
      expect(capture!.cacheControl).toEqual(first!.cacheControl);
    }
    // The prefix is the five core+hot FULL cards, numbered in lane order.
    const prefixSlugs = [...CORE_SLUGS, ...HOT_SLUGS];
    for (const [i, slug] of prefixSlugs.entries()) {
      expect(first!.text).toContain(`[${i + 1}] ${card(slug)}`);
    }
  });

  test("per-turn persistent render is net-new cards only; all-repeat turns render zero bytes", () => {
    for (const [i, record] of records.entries()) {
      const expected = SCRIPT[i]!.expectNetNew;
      expect(record.cardsPlacement).toBe("after-memory-prefix");
      expect(new Set(record.netNewSlugs)).toEqual(new Set(expected));
      if (expected.length === 0) {
        // All-repeat turn: the block is still produced (v2 suppression) but
        // carries no bytes.
        expect(record.blockText).toBe("");
        expect(record.netNewBytes).toBe(0);
        continue;
      }
      // The block contains exactly the net-new cards, each byte-identical to
      // a fresh render, behind the shared read-affordance header.
      const inner = unwrapMemoryBlock(record.blockText);
      const parsed = parseCardSections(inner);
      expect(parsed.preamble).toBe(V3_CARDS_INJECTION_HEADER);
      expect(new Set(parsed.sections.map((s) => s.slug))).toEqual(
        new Set(expected),
      );
      for (const section of parsed.sections) {
        expect(section.text).toBe(card(section.slug));
      }
      expect(record.netNewBytes).toBe(
        expected.reduce((sum, slug) => sum + cardBytes(card(slug)), 0),
      );
    }
  });

  test("turn 1's block is byte-exact in selection order (stable prefix first, then finder)", () => {
    expect(records[0]!.blockText).toBe(
      wrapMemoryBlock(
        renderCardsBlockInner([
          card("core-alpha"),
          card("core-beta"),
          card("hot-one"),
          card("page-a"),
        ]),
      ),
    );
  });

  test("prior turns' blocks stay frozen in history (byte-prefix), except the prune valve's one amortized strip", () => {
    // Pre-prune (turns 1–6): each snapshot is a byte-prefix of the next.
    for (let i = 0; i < 5; i++) {
      expect(
        records[i + 1]!.snapshot.startsWith(records[i]!.snapshot.slice(0, -1)),
      ).toBe(true);
    }
    // Post-prune (turns 8–10, spanning the restart): frozen again.
    for (let i = 7; i < 9; i++) {
      expect(
        records[i + 1]!.snapshot.startsWith(records[i]!.snapshot.slice(0, -1)),
      ).toBe(true);
    }
    // Turn 7's strip touched EXACTLY the pruned cards: turn 1's block lost
    // page-a (byte-exact remainder), turn 2's lost page-b.
    const after7 = JSON.parse(records[6]!.snapshot) as Message[];
    const turn1Block = (after7[0]!.content[0] as { text: string }).text;
    expect(turn1Block).toBe(
      wrapMemoryBlock(
        renderCardsBlockInner([
          card("core-alpha"),
          card("core-beta"),
          card("hot-one"),
        ]),
      ),
    );
    const turn2Block = (after7[2]!.content[0] as { text: string }).text;
    expect(turn2Block).toBe(
      wrapMemoryBlock(renderCardsBlockInner([card("hot-two")])),
    );
  });

  test("accounting: resident bytes equal cumulative net-new card bytes minus pruned bytes", () => {
    let expected = 0;
    for (const record of records) {
      expected += record.netNewBytes;
      if (record.turn === 7) expected -= pruneWindow.bytesFreedExpected;
      expect(record.residentBytes).toBe(expected);
    }
  });
});

describe("memory-v3 carry integration — spotlight contract", () => {
  test("spotlight is present every turn, after the memory cards, bounded by n × (window + 1)", () => {
    for (const record of records) {
      expect(record.spotlightText.startsWith("<memory_spotlight>\n")).toBe(
        true,
      );
      expect(record.spotlightText.endsWith("\n</memory_spotlight>")).toBe(true);
      expect(record.spotlightPlacement).toBe("after-memory-prefix");
      expect(record.spotlightEntries).toBeGreaterThanOrEqual(1);
      expect(record.spotlightEntries).toBeLessThanOrEqual(
        SPOTLIGHT_N * (SPOTLIGHT_WINDOW_TURNS + 1),
      );
    }
  });

  test("a finder hit on a stable-prefix (hot) page spotlights its matched section", () => {
    expect(records[1]!.spotlightText).toContain(
      "## memory/concepts/hot-two.md § ",
    );
  });

  test("spotlight entries age out of the window instead of accumulating", () => {
    // Turn 6's window covers turns 4–6 only: turn 1–3 entries (e.g. page-a)
    // are gone.
    expect(records[5]!.spotlightText).not.toContain("page-a.md");
  });

  test("the spotlight never reaches the persistent layer (blocks, metadata, history)", () => {
    for (const record of records) {
      expect(record.blockText).not.toContain("<memory_spotlight>");
      // The persistent-layer snapshot is spotlight-stripped by construction;
      // the raw live history must carry exactly ONE spotlight block (the
      // current turn's).
    }
    const metadataRows = testSqlite
      .query(
        /*sql*/ `
        SELECT metadata FROM messages
        WHERE conversation_id = ? AND metadata IS NOT NULL
      `,
      )
      .all(CONV) as Array<{ metadata: string }>;
    expect(metadataRows.length).toBeGreaterThan(0);
    for (const row of metadataRows) {
      expect(row.metadata).not.toContain("memory_spotlight");
    }
    const liveSpotlights = histories
      .get(CONV)!
      .flatMap((m) => m.content)
      .filter(
        (b): b is { type: "text"; text: string } =>
          b.type === "text" && b.text.startsWith("<memory_spotlight>\n"),
      );
    expect(liveSpotlights).toHaveLength(1);
  });
});

describe("memory-v3 carry integration — prune contract", () => {
  test("the valve trips at turn 7: resident drops to target, core/hot survive", () => {
    // Nothing pruned through turn 6.
    for (let i = 0; i < 6; i++) {
      expect(records[i]!.prunedSlugs.size).toBe(0);
    }
    // Turn 7: exactly the two least-recently-selected non-exempt cards.
    expect(records[6]!.prunedSlugs).toEqual(new Set(["page-a", "page-b"]));
    expect(records[6]!.residentBytes).toBe(pruneWindow.target);
    expect(records[6]!.residentBytes).toBeLessThanOrEqual(pruneWindow.max);
    // Core and hot lane members were exempt and remain active.
    const activeAfter7 = getActiveSlugs(CONV);
    for (const slug of [...CORE_SLUGS, ...HOT_SLUGS.slice(0, 2)]) {
      expect(activeAfter7.has(slug)).toBe(true);
    }
  });

  test("a pruned slug re-selected at turn 9 re-injects as a fresh card", () => {
    const turn9 = records[8]!;
    expect(turn9.netNewSlugs).toEqual(["page-a"]);
    expect(turn9.blockText).toBe(
      wrapMemoryBlock(renderCardsBlockInner([card("page-a")])),
    );
    // page-a is active again; page-b stays pruned.
    expect(turn9.prunedSlugs).toEqual(new Set(["page-b"]));
    expect(getActiveSlugs(CONV).has("page-a")).toBe(true);
  });
});

describe("memory-v3 carry integration — restart contract", () => {
  test("rehydrating from the DB reproduces the live persistent layer byte-identically", () => {
    expect(restartRehydratedJson).toBe(restartLiveJson);
  });

  test("pruned sections are absent from the rehydrated history (metadata stays intact)", () => {
    const rehydrated = JSON.parse(restartRehydratedJson) as Message[];
    const allText = rehydrated
      .flatMap((m) => m.content)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    expect(allText).not.toContain("# memory/concepts/page-a.md");
    expect(allText).not.toContain("# memory/concepts/page-b.md");
    // Resident cards survive the round trip…
    expect(allText).toContain(card("page-c"));
    // …and the persisted metadata still carries the pruned cards (the filter
    // is rehydration-time, never a metadata rewrite).
    const metadata = testSqlite
      .query(
        /*sql*/ `
        SELECT metadata FROM messages
        WHERE conversation_id = ? AND id = ?
      `,
      )
      .get(CONV, `${CONV}-m1-user`) as { metadata: string };
    expect(metadata.metadata).toContain("# memory/concepts/page-a.md");
  });
});

describe("memory-v3 carry integration — fork contract", () => {
  test("a fork inherits the dedup record and renders no duplicate cards for inherited slugs", () => {
    // page-g was injected on the parent before the fork; hot-three never was.
    expect(forkRecord.netNewSlugs).toEqual(["hot-three"]);
    expect(forkRecord.blockText).toBe(
      wrapMemoryBlock(renderCardsBlockInner([card("hot-three")])),
    );
    // Inherited active and pruned state both copied (full-fork semantics).
    const forkActive = getActiveSlugs(FORK_CONV);
    expect(forkActive.has("page-g")).toBe(true);
    expect(forkActive.has("core-alpha")).toBe(true);
    expect(getPrunedSlugs(FORK_CONV)).toEqual(new Set(["page-a", "page-b"]));
    // The fork's rehydrated history carries the inherited page-g card exactly
    // once (from the copied metadata), not a re-render.
    const forkText = histories
      .get(FORK_CONV)!
      .flatMap((m) => m.content)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    expect(forkText.split(card("page-g")).length - 1).toBe(1);
  });
});

describe("memory-v3 carry integration — footprint gate", () => {
  test("steady-state per-turn fresh cost is net-new + spotlight, not the working set", () => {
    // The all-repeat turns pay ZERO persistent bytes while the resident
    // working set stays in the thousands — the cache win the rework ships.
    const turn3 = records[2]!;
    const turn10 = records[9]!;
    expect(turn3.netNewBytes).toBe(0);
    expect(turn10.netNewBytes).toBe(0);
    expect(turn10.spotlightBytes).toBeGreaterThan(0);
    // The resident working set holds the whole accumulated card footprint
    // (15+ active pages here) while the turn pays only the spotlight.
    expect(getActiveSlugs(CONV).size).toBeGreaterThanOrEqual(15);
    expect(turn10.netNewBytes + turn10.spotlightBytes).toBeLessThan(
      turn10.residentBytes,
    );

    // The measured footprint table — the PR-body cutover-gate artifact.
    // Fresh (uncached) per-turn cost = net-new + spotlight; resident = the
    // accumulated frozen-card footprint riding the provider prefix cache.
    const lines = [
      "| turn | net-new cards | net-new bytes | spotlight bytes | fresh bytes (net-new + spotlight) | resident bytes | note |",
      "|---|---|---|---|---|---|---|",
      ...records.map((r) => {
        const note =
          r.turn === 3
            ? "all-repeat turn"
            : r.turn === 7
              ? `prune valve fired (−${pruneWindow.bytesFreedExpected}B)`
              : r.turn === 9
                ? "pruned slug re-injected"
                : r.turn === 10
                  ? "all-repeat (steady state)"
                  : "";
        return `| ${r.turn} | ${r.netNewSlugs.length} | ${r.netNewBytes} | ${r.spotlightBytes} | ${r.netNewBytes + r.spotlightBytes} | ${r.residentBytes} | ${note} |`;
      }),
    ];
    console.log(
      `\nmemory-v3 carry footprint (measured):\n${lines.join("\n")}\n`,
    );
  });
});
