/**
 * End-to-end integration test + measured footprint gate for the memory-v3
 * section-grain carry (frozen sections + pointer + uniform prune).
 *
 * SCOPE / ALTITUDE. A full daemon-assembly run is too heavy and too
 * mock-fragile for a unit test (same altitude call as the sibling
 * `live-integration.test.ts` / `shadow-integration.test.ts`). Instead this
 * drives a scripted 10-turn conversation through the REAL pipeline units:
 *
 *   orchestrate (core+hot stable prefix from real `loadCoreSet` /
 *     `computeHotSet`, real needle finder lane, pre-rendered prefix cards)
 *     → selectPool (real two-segment render + cache breakpoint; the PROVIDER
 *       is stubbed to return deterministic ids per scripted turn)
 *     → the real injectors (`memoryV3Injector` net-new sections +
 *       recordInjected + schedulePruneValve; `memoryV3PointerInjector`
 *       resident re-selections)
 *     → simulated runtime assembly (splice the section block and the fresh
 *       pointer onto the current user message; historical pointers stay)
 *       and metadata persistence (the user-prompt-submit hook's
 *       `memoryV3InjectedBlock` and `memoryV3PointerBlock` writes)
 *     → the real prune valve against the live history (conversation-registry
 *       stubbed to the simulated message arrays)
 *     → rehydration from the temp DB (mirroring `daemon/conversation.ts`'s
 *       metadata splice + pruned-section filter) for the restart contract
 *
 * and asserts the four contracts the carry ships on:
 *   1. CACHE: the selector input's stable prefix is byte-identical across all
 *      turns (and carries the cache breakpoint); per-turn persistent renders
 *      are net-new sections only (a page's matched section, its lead when it
 *      was selected without a match); prior turns' blocks stay frozen in
 *      history; re-selected resident sections are pointed at, not repeated.
 *   2. PRUNE: the valve trips when resident bytes exceed the cap, drops to
 *      target, evicts by recency with no lane exemptions (core and hot leads
 *      go first here), and a pruned section re-selected re-injects.
 *   3. FORK: a fork inherits the dedup record and renders no duplicate
 *      sections.
 *   4. RESTART: rebuilding history from the DB mid-script reproduces the live
 *      persistent layer byte-identically, with pruned sections still absent.
 *
 * The final test emits the measured per-turn footprint table (net-new section
 * bytes and pointer bytes as separate columns, plus resident bytes), the
 * evidence that steady-state per-turn fresh cost is net-new + pointer, not
 * O(working set).
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

import { setConfig } from "../../../../../__tests__/helpers/set-config.js";
import { ensureMemoryV3SelectionsSchema } from "../../../../../persistence/migrations/338-move-memory-v3-selections-to-memory-db.js";
import { ensureMemoryV3PoolsSchema } from "../../../../../persistence/migrations/377-add-memory-v3-pools.js";
import { ensureMemoryV3InjectedSectionsSchema } from "../../../../../persistence/migrations/378-add-memory-v3-injected-sections.js";
import * as schema from "../../../../../persistence/schema/index.js";
import {
  MEMORY_POINTER_PREFIX,
  MEMORY_POINTER_SUFFIX,
  unwrapMemoryBlock,
  wrapMemoryBlock,
} from "../../memory-marker.js";
import type { PageIndexEntry } from "../../substrate/page-index.js";
import { parsePageContent } from "../../substrate/page-store.js";
import { renderCard, renderedBytes } from "../card.js";
import { loadCoreSet } from "../core-set.js";
import type { EdgeGraph } from "../edge.js";
import { buildEdgeGraph } from "../edge.js";
import { renderV3SectionInjection } from "../page-content.js";
import { buildSectionNeedle } from "../section-needle.js";
import { buildSectionIndex } from "../sections.js";
import {
  isV3LiveBlock,
  markV3LiveBlock,
  MEMORY_V3_COMMIT_META_KEY,
  MEMORY_V3_POINTER_BLOCK_METADATA_KEY,
  type Section,
  type SectionIndex,
  type SectionRef,
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
const realMemoryConfig = { ...(await import("../../config.js")) };
const realDbConnection = {
  ...(await import("../../../../../persistence/db-connection.js")),
};
const realDense = { ...(await import("../dense.js")) };
const realPageContent = { ...(await import("../page-content.js")) };
const realConversationRegistry = {
  ...(await import("../../../../../daemon/conversation-registry.js")),
};

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
// Selection and section-store rows live on the dedicated memory connection,
// resolved via `getMemorySqlite` — stubbed to a second in-memory DB carrying
// the relocated tables' schema. Messages stay in main.
let memorySqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  memorySqlite = new Database(":memory:");
  ensureMemoryV3SelectionsSchema(memorySqlite);
  ensureMemoryV3InjectedSectionsSchema(memorySqlite);
  ensureMemoryV3PoolsSchema(memorySqlite);
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
  getMemorySqlite: () =>
    carryMockActive ? memorySqlite : realDbConnection.getMemorySqlite(),
  getMemoryDb: () =>
    carryMockActive
      ? drizzle(memorySqlite, { schema })
      : realDbConnection.getMemoryDb(),
}));

/** Mutable prune config: `null` until the script opens the valve window. */
let pruneConfig: {
  maxResidentBytes: number;
  targetResidentBytes: number;
} | null = null;
// The injector reads `memory.v3.live` (via `isMemoryV3Live`) through the real
// `getConfig()`; `beforeAll` seeds `memory.v3.live: true` for real.

// Memory code resolves its config through the plugin's own accessor, not
// getConfig(); the prune valve reads its bounds there — stub the same
// conditional slice.
mock.module("../../config.js", () => ({
  getMemoryConfig: () =>
    carryMockActive
      ? { v3: { live: true, prune: pruneConfig ?? undefined } }
      : realMemoryConfig.getMemoryConfig(),
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

// Pages resolve from the in-memory fixture corpus (the disk read is the only
// stubbed step), so leads split by the same rules as the lanes' section index
// and injected bytes are exactly what `renderV3SectionInjection` produces
// for these pages.
mock.module("../page-content.js", () => ({
  ...realPageContent,
  readConceptPage: async (slug: Slug) =>
    carryMockActive
      ? parsePageContent(slug, RAW[slug] ?? "")
      : realPageContent.readConceptPage(slug),
}));

// The prune valve resolves the live conversation through the daemon registry.
// Route it at the simulated per-conversation histories (and keep the heavy
// daemon module graph out of this test process — same call as injection.test.ts).
const histories = new Map<string, Message[]>();
mock.module("../../../../../daemon/conversation-registry.js", () => ({
  ...realConversationRegistry,
  findConversationOrSubagent: (conversationId: string) => {
    const messages = histories.get(conversationId);
    return messages ? { messages } : undefined;
  },
}));

// Real orchestration is wired under the injectors' `observeTurn` seam: each
// scripted turn runs the REAL `orchestrate` over the fixture lanes and logs
// selections through the shadow plugin's REAL attribution/writer (so hot-set
// frecency and the prune valve's recency ranking see real rows, section titles
// included), then normalizes the rows' `created_at` to a per-turn stamp so
// recency ranking is deterministic regardless of wall-clock resolution.
const { orchestrate } = await import("../orchestrate.js");
const { buildPoolRecord } = await import("../pool-log-store.js");
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
  realShadowPlugin.writeTurnLog(
    conversationId,
    turnIndex,
    realShadowPlugin.attributeSelections(result),
    buildPoolRecord(result),
  );
  memorySqlite
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
  memoryV3PointerInjector,
  resetMemoryV3InjectorStateForTests,
} = await import("../injector.js");
const {
  clearConversation,
  forkEverInjected,
  getActiveSections,
  getInjected,
  getKnownCardBytes,
  getPrunedSections,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  residentBytes,
} = await import("../ever-injected-store.js");
const {
  filterResidentPointerEntries,
  filterResidentSections,
  flushPruneValveForTests,
  newestCopyIndexes,
  persistedV3BlockInner,
  stripPrunedSectionsFromMessages,
} = await import("../prune.js");
const { parseInjectedSections } =
  await import("../../substrate/injected-block-slugs.js");
const { renderInjectionBlockInner, V3_INJECTION_HEADER } =
  await import("../render-injection.js");
const { computeHotSet } = await import("../hot-set.js");

// ---------------------------------------------------------------------------
// Fixture corpus: 20 generic pages, each with a lead plus two sections
// (`## Detail`, `## Notes`) carrying one distinctive term each so a needle
// query selects exactly the intended page AND section. Leads carry no query
// terms. `core-beta` / `hot-one` carry padded leads so the prune window
// (which must free their two leads) stays deterministic (their bytes exceed
// turn 7's incoming sections).
// ---------------------------------------------------------------------------

const PAGE_TERMS: Record<Slug, [detail: string, notes: string]> = {
  "core-alpha": ["tamarind", "chutney"],
  "core-beta": ["ugli", "candy"],
  "hot-one": ["quince", "jelly"],
  "hot-two": ["raspberry", "vinegar"],
  "hot-three": ["strawberry", "shortcake"],
  "page-a": ["apple", "cider"],
  "page-b": ["banana", "bread"],
  "page-c": ["cherry", "pie"],
  "page-d": ["dragonfruit", "sorbet"],
  "page-e": ["elderberry", "cordial"],
  "page-f": ["fig", "newton"],
  "page-g": ["guava", "paste"],
  "page-h": ["honeydew", "cubes"],
  "page-i": ["imbe", "syrup"],
  "page-j": ["jackfruit", "curry"],
  "page-k": ["kiwi", "tart"],
  "page-l": ["lemon", "zest"],
  "page-m": ["mango", "lassi"],
  "page-n": ["nectarine", "cobbler"],
  "page-o": ["olive", "tapenade"],
};
const ALL_SLUGS = Object.keys(PAGE_TERMS);

const LONG_LEAD_PAD =
  " This page carries a deliberately longer descriptive lead so its lead" +
  " outweighs later sections and the scripted prune window frees exactly" +
  " this lead when the valve trips.";

function pageText(slug: Slug): string {
  const [detail, notes] = PAGE_TERMS[slug]!;
  const pad = slug === "core-beta" || slug === "hot-one" ? LONG_LEAD_PAD : "";
  return (
    `# ${slug}\nlead for ${slug}.${pad}\n\n` +
    `## Detail\n${detail} detail material for ${slug}\n\n` +
    `## Notes\n${notes} notes for ${slug}`
  );
}

const RAW: Record<Slug, string> = Object.fromEntries(
  ALL_SLUGS.map((slug) => [slug, pageText(slug)]),
);

/** A slug's selector card exactly as the real renderer produces it. */
function card(slug: Slug): string {
  return renderCard(slug, RAW[slug]!);
}

const CORE_SLUGS: Slug[] = ["core-alpha", "core-beta"];
const HOT_SLUGS: Slug[] = ["hot-one", "hot-two", "hot-three"];

const CONV = "conv-carry";
const FORK_CONV = "conv-carry-fork";
/** Conversations for the compaction contract (restart and live paths). */
const COMPACT_CONV = "conv-carry-compact";
const COMPACT_LIVE_CONV = "conv-carry-compact-live";
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

/** A page's section by title from the fixture index (`""` = the lead). */
function sectionOf(slug: Slug, title: string): Section {
  const indices = lanes.sectionIndex.byArticle.get(slug)!;
  const section = indices
    .map((i) => lanes.sectionIndex.sections[i]!)
    .find((s) => s.title === title);
  if (!section) {
    throw new Error(`no section "${title}" on ${slug}`);
  }
  return section;
}

/** A section's injected render exactly as the injector attaches it. */
function render(slug: Slug, title: string): string {
  return renderV3SectionInjection(slug, sectionOf(slug, title));
}

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
  const seed = memorySqlite.query(/*sql*/ `
    INSERT INTO memory_v3_selections
      (conversation_id, turn, slug, source, created_at)
    VALUES (?, ?, ?, 'needle', ?)
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
    freshAt: null,
  }));
  const edgeGraph = await buildEdgeGraph(entries, async (slug) => RAW[slug]!);

  const coreSlugs = loadCoreSet(workspaceDir).filter((slug) =>
    sectionIndex.byArticle.has(slug),
  );
  const hotSlugs = computeHotSet({
    k: 3,
    halfLifeMs: 14 * DAY_MS,
    now: BASE,
    excludeSlugs: new Set(coreSlugs),
  })
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
      if (block.type !== "text") {
        continue;
      }
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
          if (m) {
            entries.push({ id: Number(m[1]), slug: m[2]! });
          }
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
        if (keep.includes(slug)) {
          ids.push(i + 1);
        }
      });
      return toolUseResponse({ ids });
    },
  };
}

// ---------------------------------------------------------------------------
// Turn driver: simulates exactly what runtime assembly + the user-prompt-submit
// hook do around the injectors each turn (see the module doc).
// ---------------------------------------------------------------------------

/** `slug§key` id of a section ref. */
function refId(ref: SectionRef): string {
  return `${ref.slug}§${ref.key}`;
}

function refIds(set: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const ids = new Set<string>();
  for (const [slug, keys] of set) {
    for (const key of keys) {
      ids.add(refId({ slug, key }));
    }
  }
  return ids;
}

function isPointerText(text: string): boolean {
  return (
    text.startsWith(MEMORY_POINTER_PREFIX) &&
    text.endsWith(MEMORY_POINTER_SUFFIX)
  );
}

interface TurnRecord {
  turn: number;
  netNew: Set<string>;
  netNewBytes: number;
  blockText: string;
  sectionsPlacement: string;
  pointerText: string;
  pointerBytes: number;
  pointerPlacement: string;
  residentBytes: number;
  pruned: Set<string>;
  /** JSON of the live history's PERSISTENT layer after the turn (frozen
   *  blocks; the ephemeral pointer excluded). */
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

/** The persistent view of a history. Frozen sections AND each turn's
 *  pointer persist on the message they were sent with, so this is the whole
 *  history: nothing a later turn does rewrites an earlier message. */
function persistentView(history: Message[]): string {
  return JSON.stringify(history);
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

  // Runtime assembly's Step 0 strips a leftover pointer from the TAIL only
  // (a mid-turn re-entry); a fresh user message carries none, so it is a
  // no-op here, and every historical pointer stays where it was sent.

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

  const activeBefore = refIds(getActiveSections(convId));
  const sections = await memoryV3Injector.produce(ctx);
  if (!sections) {
    throw new Error(`turn ${turnIndex}: sections injector returned null`);
  }
  // Runtime assembly invokes the block's attachment-commit callback at its
  // user-tail commit point, this is where the section store records the
  // turn's sections (and the prune valve is scheduled).
  const commit = sections.meta?.[MEMORY_V3_COMMIT_META_KEY];
  if (typeof commit === "function") {
    (commit as () => void)();
  }
  const netNew = new Set(
    [...refIds(getActiveSections(convId))].filter(
      (id) => !activeBefore.has(id),
    ),
  );
  const netNewBytes = getInjected(convId)
    .filter((row) => netNew.has(refId(row)))
    .reduce((sum, row) => sum + row.bytes, 0);

  // Runtime assembly: a non-empty section block splices onto the CURRENT user
  // message; the user-prompt-submit hook persists the unwrapped inner text
  // under the v3 metadata key (assembly captures it unwrapped).
  if (sections.text.length > 0) {
    const tail = history[history.length - 1]!;
    tail.content = [
      markV3LiveBlock({ type: "text", text: sections.text }),
      ...tail.content,
    ];
  }

  // The pointer splices after the frozen sections (after-memory-prefix).
  // Historical user messages keep the pointer they already carry.
  const pointer = await memoryV3PointerInjector.produce(ctx);
  if (pointer && pointer.text.length > 0) {
    const tail = history[history.length - 1]!;
    const prefixCount = sections.text.length > 0 ? 1 : 0;
    tail.content = [
      ...tail.content.slice(0, prefixCount),
      { type: "text", text: pointer.text },
      ...tail.content.slice(prefixCount),
    ];
  }

  // The user-prompt-submit hook persists the section block unwrapped and
  // the pointer wrapped, each under its own metadata key.
  const metadata: Record<string, string> = {};
  if (sections.text.length > 0) {
    metadata[MEMORY_V3_INJECTED_BLOCK_METADATA_KEY] = unwrapMemoryBlock(
      sections.text,
    );
  }
  if (pointer?.text) {
    metadata[MEMORY_V3_POINTER_BLOCK_METADATA_KEY] = pointer.text;
  }
  if (Object.keys(metadata).length > 0) {
    testSqlite
      .query(/*sql*/ `UPDATE messages SET metadata = ? WHERE id = ?`)
      .run(JSON.stringify(metadata), userRowId);
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
    netNew,
    netNewBytes,
    blockText: sections.text,
    sectionsPlacement: sections.placement ?? "",
    pointerText: pointer?.text ?? "",
    pointerBytes: pointer ? renderedBytes(pointer.text) : 0,
    pointerPlacement: pointer?.placement ?? "",
    residentBytes: residentBytes(convId),
    pruned: refIds(getPrunedSections(convId)),
    snapshot: persistentView(history),
  };
}

/** A mid-turn compaction as the daemon performs it, on the mirror: the
 *  durable base is injection-stripped (every frozen v3 block leaves the live
 *  history) and the section store is reset (`onCompacted`). Persisted rows
 *  keep their metadata; `rehydrateFromDb` skips it for rows older than the
 *  compaction, as `loadFromDb` does past `historyStrippedAt`. */
function compactMidTurn(convId: string): void {
  for (const message of histories.get(convId)!) {
    message.content = message.content.filter(
      (block) => !(block.type === "text" && isV3LiveBlock(block)),
    );
  }
  clearConversation(convId);
}

/** The post-compaction hook's re-injection of a turn already produced: the
 *  memoized selections re-render against the reset store and splice onto
 *  the tail, and, as runtime assembly does for a `reinjection` assembly, the
 *  block's commit is not invoked and nothing is persisted. Returns the refs
 *  the block carries. */
async function reinjectTurn(
  convId: string,
  turnIndex: number,
): Promise<Set<string>> {
  const history = histories.get(convId)!;
  const sections = await memoryV3Injector.produce({
    requestId: `req-${turnIndex}`,
    conversationId: convId,
    turnIndex,
    trust: {
      sourceChannel: "vellum" as const,
      trustClass: "guardian" as const,
    },
  });
  if (!sections) {
    throw new Error(
      `re-injection ${turnIndex}: sections injector returned null`,
    );
  }
  if (sections.text.length > 0) {
    const tail = history[history.length - 1]!;
    tail.content = [
      markV3LiveBlock({ type: "text", text: sections.text }),
      ...tail.content,
    ];
  }
  return new Set(
    parseInjectedSections(unwrapMemoryBlock(sections.text)).sections.map(refId),
  );
}

/** Rebuild a conversation's history from the temp DB — mirrors the
 *  `daemon/conversation.ts` v3 rehydration splice: splice the persisted
 *  pointer back as sent, then re-wrap the persisted section block, keep only
 *  resident sections (not pruned, and each section's newest persisted copy),
 *  skip a block left empty, and prepend onto the stored content (prepends
 *  invert, so the layout is [sections, pointer, ...]). A row older than
 *  `historyStrippedAt` (a compaction's marker) skips metadata rehydration,
 *  as `loadFromDb` does. */
function rehydrateFromDb(
  convId: string,
  historyStrippedAt: number | null = null,
): Message[] {
  const rows = testSqlite
    .query(
      /*sql*/ `
      SELECT role, content, metadata, created_at FROM messages
      WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC
    `,
    )
    .all(convId) as Array<{
    role: "user" | "assistant";
    content: string;
    metadata: string | null;
    created_at: number;
  }>;
  const pruned = getPrunedSections(convId);
  const knownCardBytes = getKnownCardBytes(convId);
  const preStripped = (row: (typeof rows)[number]): boolean =>
    historyStrippedAt !== null && row.created_at < historyStrippedAt;
  const blockOf = (row: (typeof rows)[number]): string | null =>
    row.role === "user" && !preStripped(row)
      ? persistedV3BlockInner(row.metadata)
      : null;
  const newest = newestCopyIndexes(rows.map(blockOf), knownCardBytes);
  return rows.map((row, index) => {
    let content = JSON.parse(row.content) as ContentBlock[];
    if (row.role === "user" && row.metadata && !preStripped(row)) {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      const pointer = meta[MEMORY_V3_POINTER_BLOCK_METADATA_KEY];
      if (typeof pointer === "string") {
        const resident = filterResidentPointerEntries(
          pointer,
          index,
          pruned,
          newest,
        );
        if (resident.length > 0) {
          content = [{ type: "text", text: resident }, ...content];
        }
      }
      const inner = blockOf(row);
      if (inner !== null) {
        const resident = filterResidentSections(
          inner,
          index,
          pruned,
          newest,
          knownCardBytes,
        );
        if (resident.length > 0) {
          content = [
            markV3LiveBlock({ type: "text", text: wrapMemoryBlock(resident) }),
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
/** The same comparison taken after turn 10, once a pruned lead has been
 *  re-injected (turn 9): the restart that must not revive its old copy. */
let finalLiveJson = "";
let finalRehydratedJson = "";

/** Per-turn script: query terms drive the needle (each term names one page's
 *  `Detail` or `Notes` section); `keep` is the deterministic selector output
 *  (subset of stable prefix ∪ needle hits); `expectNetNew` the `slug§key`
 *  refs the turn must inject. */
const SCRIPT: Array<{ query: string; keep: Slug[]; expectNetNew: string[] }> = [
  // 1: first turn: core + hot pages selected via the stable prefix (no
  //     finder match → their leads), plus one finder page's matched section.
  {
    query: "apple",
    keep: ["core-alpha", "core-beta", "hot-one", "page-a"],
    expectNetNew: ["core-alpha§", "core-beta§", "hot-one§", "page-a§Detail"],
  },
  // 2: a finder hit on a HOT page (raspberry) injects its matched section,
  //     not its lead.
  {
    query: "banana raspberry",
    keep: ["hot-two", "page-b"],
    expectNetNew: ["hot-two§Detail", "page-b§Detail"],
  },
  // 3: the same page as turn 1, a DIFFERENT section (cider → Notes).
  { query: "cider", keep: ["page-a"], expectNetNew: ["page-a§Notes"] },
  // 4 — topic shift: four fresh pages.
  {
    query: "cherry dragonfruit elderberry fig",
    keep: ["page-c", "page-d", "page-e", "page-f"],
    expectNetNew: [
      "page-c§Detail",
      "page-d§Detail",
      "page-e§Detail",
      "page-f§Detail",
    ],
  },
  // 5: ALL-REPEAT turn: turn 1's section and a core lead re-selected →
  //     zero new bytes, both pointed at.
  { query: "apple", keep: ["page-a", "core-alpha"], expectNetNew: [] },
  // 6: steady accumulation.
  {
    query: "guava honeydew imbe",
    keep: ["page-g", "page-h", "page-i"],
    expectNetNew: ["page-g§Detail", "page-h§Detail", "page-i§Detail"],
  },
  // 7: the prune valve trips after this turn (window configured in beforeAll).
  {
    query: "jackfruit kiwi lemon",
    keep: ["page-j", "page-k", "page-l"],
    expectNetNew: ["page-j§Detail", "page-k§Detail", "page-l§Detail"],
  },
  // 8 — one more page; the restart + fork checkpoints follow this turn.
  { query: "olive", keep: ["page-o"], expectNetNew: ["page-o§Detail"] },
  // 9: a PRUNED lead (core-beta, selected from the stable prefix with no
  //     finder hit) re-selected re-injects.
  { query: "hello", keep: ["core-beta"], expectNetNew: ["core-beta§"] },
  // 10: final all-repeat turn (steady state: fresh cost is pointer-only).
  { query: "cherry", keep: ["page-c", "core-alpha"], expectNetNew: [] },
];

beforeAll(async () => {
  carryMockActive = true;
  // The injector gates on `memory.v3.live` (read via real `getConfig()`),
  // which defaults false — seed it true so the live path runs.
  setConfig("memory", { v3: { live: true } });
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
  // EXACTLY core-beta's and hot-one's leads (the least-recently-selected
  // sections; their padded leads make them outweigh turn 7's incoming
  // sections, so target < max holds).
  const residentAfter6 = residentBytes(CONV);
  const incoming =
    renderedBytes(render("page-j", "Detail")) +
    renderedBytes(render("page-k", "Detail")) +
    renderedBytes(render("page-l", "Detail"));
  const bytesFreedExpected =
    renderedBytes(render("core-beta", "")) +
    renderedBytes(render("hot-one", ""));
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
  // injectors' in-memory state (orchestration memo), a real daemon restart
  // does both.
  restartLiveJson = persistentView(histories.get(CONV)!);
  const rehydrated = rehydrateFromDb(CONV);
  restartRehydratedJson = JSON.stringify(rehydrated);
  histories.set(CONV, rehydrated);
  resetMemoryV3InjectorStateForTests();

  // FORK checkpoint: copy the messages (metadata blocks ride along, as in a
  // real fork) and the section record (the `forkConversation()` hook), then
  // load the fork like a fresh conversation and run one turn on it.
  testSqlite
    .query(
      /*sql*/ `
      INSERT INTO messages (id, conversation_id, role, content, metadata, created_at)
      SELECT id || '-fork', ?, role, content, metadata, created_at
      FROM messages WHERE conversation_id = ?
    `,
    )
    .run(FORK_CONV, CONV);
  forkEverInjected(CONV, FORK_CONV);
  histories.set(FORK_CONV, rehydrateFromDb(FORK_CONV));
  forkRecord = await runTurn(FORK_CONV, 9, "strawberry guava", [
    "page-g",
    "hot-three",
  ]);

  // Turns 9–10 on the (restarted) parent.
  records.push(await runTurn(CONV, 9, SCRIPT[8]!.query, SCRIPT[8]!.keep));
  records.push(await runTurn(CONV, 10, SCRIPT[9]!.query, SCRIPT[9]!.keep));

  // SECOND RESTART checkpoint, after core-beta's pruned lead re-injected on
  // turn 9: its turn-1 copy still sits in that message's metadata, and the
  // rehydrated history must hold only the turn-9 copy the live one does.
  finalLiveJson = persistentView(histories.get(CONV)!);
  finalRehydratedJson = JSON.stringify(rehydrateFromDb(CONV));
});

afterAll(async () => {
  await flushPruneValveForTests();
  carryMockActive = false;
  if (workspaceDir) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
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

  test("per-turn persistent render is net-new sections only; all-repeat turns render zero bytes", () => {
    for (const [i, record] of records.entries()) {
      const expected = SCRIPT[i]!.expectNetNew;
      expect(record.sectionsPlacement).toBe("after-memory-prefix");
      expect(record.netNew).toEqual(new Set(expected));
      if (expected.length === 0) {
        // All-repeat turn: the block is still produced (v2 suppression) but
        // carries no bytes.
        expect(record.blockText).toBe("");
        expect(record.netNewBytes).toBe(0);
        continue;
      }
      // The block contains exactly the net-new sections, each byte-identical
      // to a fresh render, behind the shared read-affordance header.
      const inner = unwrapMemoryBlock(record.blockText);
      const parsed = parseInjectedSections(inner);
      expect(parsed.preamble).toBe(V3_INJECTION_HEADER);
      expect(new Set(parsed.sections.map(refId))).toEqual(new Set(expected));
      for (const section of parsed.sections) {
        expect(section.text).toBe(render(section.slug, section.key));
      }
      expect(record.netNewBytes).toBe(
        parsed.sections.reduce((sum, s) => sum + renderedBytes(s.text), 0),
      );
    }
  });

  test("turn 1's block is byte-exact in selection order (stable prefix leads first, then the finder section)", () => {
    expect(records[0]!.blockText).toBe(
      wrapMemoryBlock(
        renderInjectionBlockInner([
          render("core-alpha", ""),
          render("core-beta", ""),
          render("hot-one", ""),
          render("page-a", "Detail"),
        ]),
      ),
    );
  });

  test("a finder hit on a stable-prefix (hot) page injects its matched section, not its lead", () => {
    expect(records[1]!.blockText).toContain(
      "# memory/concepts/hot-two.md § Detail\nraspberry detail material for hot-two",
    );
    expect(records[1]!.blockText).not.toContain("lead for hot-two");
  });

  test("a page selected with a new section on turn 3 injects that section beside its earlier one", () => {
    expect(records[2]!.blockText).toBe(
      wrapMemoryBlock(renderInjectionBlockInner([render("page-a", "Notes")])),
    );
    expect(records[2]!.blockText).not.toContain("§ Detail");
  });

  test("prior turns' blocks stay frozen in history (byte-prefix), except the prune valve's one amortized strip", () => {
    // Pre-prune (turns 1–6): each persistent snapshot is a byte-prefix of the
    // next (the ephemeral pointer is excluded from the persistent view).
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
    // Turn 7's strip touched EXACTLY the pruned sections: turn 1's block lost
    // core-beta's and hot-one's leads (byte-exact remainder); turn 2's block
    // is untouched.
    const after7 = JSON.parse(records[6]!.snapshot) as Message[];
    const turn1Block = (after7[0]!.content[0] as { text: string }).text;
    expect(turn1Block).toBe(
      wrapMemoryBlock(
        renderInjectionBlockInner([
          render("core-alpha", ""),
          render("page-a", "Detail"),
        ]),
      ),
    );
    const turn2Block = (after7[2]!.content[0] as { text: string }).text;
    expect(turn2Block).toBe(records[1]!.blockText);
  });

  test("accounting: resident bytes equal cumulative net-new section bytes minus pruned bytes", () => {
    let expected = 0;
    for (const record of records) {
      expected += record.netNewBytes;
      if (record.turn === 7) {
        expected -= pruneWindow.bytesFreedExpected;
      }
      expect(record.residentBytes).toBe(expected);
    }
  });
});

describe("memory-v3 carry integration: pointer contract", () => {
  test("a turn with resident re-selections gets a pointer listing exactly those sections as paths", () => {
    const turn5 = records[4]!;
    expect(turn5.pointerText.startsWith("<memory_pointer>\n")).toBe(true);
    expect(turn5.pointerText.endsWith("\n</memory_pointer>")).toBe(true);
    expect(turn5.pointerPlacement).toBe("after-memory-prefix");
    expect(turn5.pointerText).toContain(
      "\nmemory/concepts/page-a.md § Detail\n",
    );
    expect(turn5.pointerText).toContain("\nmemory/concepts/core-alpha.md\n");
    // Paths only: no section bodies.
    expect(turn5.pointerText).not.toContain("apple detail material");
    expect(turn5.pointerText).not.toContain("lead for core-alpha");
    // Nothing else was re-selected.
    expect(
      (turn5.pointerText.match(/^memory\/concepts\//gm) ?? []).length,
    ).toBe(2);
  });

  test("turns whose selections are all net-new get no pointer", () => {
    for (const turn of [1, 4, 6, 7, 8]) {
      expect(records[turn - 1]!.pointerText).toBe("");
    }
  });

  test("each turn persists its pointer on that user message and keeps historical copies", () => {
    for (const record of records) {
      expect(record.blockText).not.toContain("<memory_pointer>");
    }
    // Turns 5 and 10 pointed at resident sections; their rows carry the
    // wrapped block under the pointer metadata key.
    const pointerRows = (
      testSqlite
        .query(
          /*sql*/ `
          SELECT id FROM messages
          WHERE conversation_id = ? AND metadata LIKE '%' || ? || '%'
          ORDER BY created_at ASC
        `,
        )
        .all(CONV, MEMORY_V3_POINTER_BLOCK_METADATA_KEY) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    expect(pointerRows).toEqual([`${CONV}-m5-user`, `${CONV}-m10-user`]);
    // The live history keeps both: turn 5's pointer rode the restart via its
    // metadata (message index 2 * (turn - 1)), and turn 10's is on the tail
    // user message. No later turn rewrote turn 5's message.
    const live = histories.get(CONV)!;
    const pointerCarriers = live
      .map((message, index) => ({ message, index }))
      .filter(({ message }) =>
        message.content.some((b) => b.type === "text" && isPointerText(b.text)),
      )
      .map(({ index }) => index);
    expect(pointerCarriers).toEqual([2 * (5 - 1), live.length - 2]);
    const turn5Pointer = live[2 * (5 - 1)]!.content.find(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && isPointerText(b.text),
    );
    expect(turn5Pointer?.text).toBe(records[4]!.pointerText);
  });
});

describe("memory-v3 carry integration — prune contract", () => {
  test("the valve trips at turn 7: resident drops to target; core and hot leads are evicted by recency like any other", () => {
    // Nothing pruned through turn 6.
    for (let i = 0; i < 6; i++) {
      expect(records[i]!.pruned.size).toBe(0);
    }
    // Turn 7: exactly the two least-recently-selected sections, a core
    // page's lead and a hot page's lead. core-alpha's lead (re-selected on
    // turn 5) and page-a's Detail (re-selected on turn 5) survive.
    expect(records[6]!.pruned).toEqual(new Set(["core-beta§", "hot-one§"]));
    expect(records[6]!.residentBytes).toBe(pruneWindow.target);
    expect(records[6]!.residentBytes).toBeLessThanOrEqual(pruneWindow.max);
    const activeAfter7 = refIds(getActiveSections(CONV));
    expect(activeAfter7.has("core-alpha§")).toBe(true);
    expect(activeAfter7.has("page-a§Detail")).toBe(true);
    expect(activeAfter7.has("hot-two§Detail")).toBe(true);
  });

  test("a pruned lead re-selected at turn 9 re-injects as a fresh entry", () => {
    const turn9 = records[8]!;
    expect(turn9.netNew).toEqual(new Set(["core-beta§"]));
    expect(turn9.blockText).toBe(
      wrapMemoryBlock(renderInjectionBlockInner([render("core-beta", "")])),
    );
    // core-beta's lead is active again; hot-one's stays pruned.
    expect(turn9.pruned).toEqual(new Set(["hot-one§"]));
    expect(refIds(getActiveSections(CONV)).has("core-beta§")).toBe(true);
  });
});

describe("memory-v3 carry integration — restart contract", () => {
  test("rehydrating from the DB reproduces the live persistent layer byte-identically", () => {
    expect(restartRehydratedJson).toBe(restartLiveJson);
  });

  test("after a pruned lead is re-injected, a restart rehydrates the live layer byte-identically: one copy, on the re-injecting turn's message", () => {
    expect(finalRehydratedJson).toBe(finalLiveJson);
    const rehydrated = JSON.parse(finalRehydratedJson) as Message[];
    const entry = render("core-beta", "");
    const carriers = rehydrated
      .map((message, index) => ({
        index,
        text: message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
      }))
      .filter(({ text }) => text.includes(entry))
      .map(({ index }) => index);
    // Turn 9's user message (turns are user/assistant pairs) and nothing
    // else: the turn-1 block's copy, still in its metadata, is superseded.
    expect(carriers).toEqual([16]);
    const turn1 = rehydrated[0]!.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    expect(turn1).not.toContain("# memory/concepts/core-beta.md");
    const turn1Metadata = testSqlite
      .query(
        /*sql*/ `
        SELECT metadata FROM messages
        WHERE conversation_id = ? AND id = ?
      `,
      )
      .get(CONV, `${CONV}-m1-user`) as { metadata: string };
    expect(turn1Metadata.metadata).toContain("# memory/concepts/core-beta.md");
  });

  test("pruned sections are absent from the rehydrated history (metadata stays intact)", () => {
    const rehydrated = JSON.parse(restartRehydratedJson) as Message[];
    const blockText = rehydrated
      .flatMap((m) => m.content)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .filter(
        (b) =>
          b.text.startsWith("<memory>\n") && b.text.endsWith("\n</memory>"),
      )
      .map((b) => b.text)
      .join("\n");
    expect(blockText).not.toContain("# memory/concepts/core-beta.md");
    expect(blockText).not.toContain("# memory/concepts/hot-one.md");
    // Resident sections survive the round trip.
    expect(blockText).toContain(render("page-c", "Detail"));
    expect(blockText).toContain(render("page-a", "Notes"));
    // …and the persisted metadata still carries the pruned leads (the filter
    // is rehydration-time, never a metadata rewrite).
    const metadata = testSqlite
      .query(
        /*sql*/ `
        SELECT metadata FROM messages
        WHERE conversation_id = ? AND id = ?
      `,
      )
      .get(CONV, `${CONV}-m1-user`) as { metadata: string };
    expect(metadata.metadata).toContain("# memory/concepts/core-beta.md");
  });
});

describe("memory-v3 carry integration — fork contract", () => {
  test("a fork inherits the dedup record: inherited sections are pointed at, only new ones render", () => {
    // page-g's Detail was injected on the parent before the fork; hot-three's
    // Detail (a finder hit on a hot page) never was.
    expect(forkRecord.netNew).toEqual(new Set(["hot-three§Detail"]));
    expect(forkRecord.blockText).toBe(
      wrapMemoryBlock(
        renderInjectionBlockInner([render("hot-three", "Detail")]),
      ),
    );
    expect(forkRecord.pointerText).toContain(
      "memory/concepts/page-g.md § Detail",
    );
    // Inherited active and pruned state both copied (full-fork semantics).
    const forkActive = refIds(getActiveSections(FORK_CONV));
    expect(forkActive.has("page-g§Detail")).toBe(true);
    expect(forkActive.has("core-alpha§")).toBe(true);
    expect(refIds(getPrunedSections(FORK_CONV))).toEqual(
      new Set(["core-beta§", "hot-one§"]),
    );
    // The fork's rehydrated history carries the inherited page-g section
    // exactly once (from the copied metadata), not a re-render.
    const forkText = histories
      .get(FORK_CONV)!
      .flatMap((m) => m.content)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    expect(forkText.split(render("page-g", "Detail")).length - 1).toBe(1);
  });
});

describe("memory-v3 carry integration — footprint gate", () => {
  test("steady-state per-turn fresh cost is net-new + pointer, not the working set", () => {
    // The all-repeat turns pay ZERO persistent bytes while the resident
    // working set stays in the thousands, the cache win the carry ships.
    const turn5 = records[4]!;
    const turn10 = records[9]!;
    expect(turn5.netNewBytes).toBe(0);
    expect(turn10.netNewBytes).toBe(0);
    expect(turn10.pointerBytes).toBeGreaterThan(0);
    // The resident working set holds the whole accumulated section footprint
    // (15+ active pages here) while the turn pays only the pointer.
    expect(getActiveSections(CONV).size).toBeGreaterThanOrEqual(15);
    expect(turn10.netNewBytes + turn10.pointerBytes).toBeLessThan(
      turn10.residentBytes,
    );

    // The measured footprint table, the PR-body artifact. Fresh (uncached)
    // per-turn cost = net-new + pointer; resident = the accumulated frozen
    // section footprint riding the provider prefix cache.
    const lines = [
      "| turn | net-new sections | net-new bytes | pointer bytes | fresh bytes (net-new + pointer) | resident bytes | note |",
      "|---|---|---|---|---|---|---|",
      ...records.map((r) => {
        const note =
          r.turn === 3
            ? "second section of a resident page"
            : r.turn === 5
              ? "all-repeat turn (pointer only)"
              : r.turn === 7
                ? `prune valve fired (−${pruneWindow.bytesFreedExpected}B)`
                : r.turn === 9
                  ? "pruned lead re-injected"
                  : r.turn === 10
                    ? "all-repeat (steady state)"
                    : "";
        return `| ${r.turn} | ${r.netNew.size} | ${r.netNewBytes} | ${r.pointerBytes} | ${r.netNewBytes + r.pointerBytes} | ${r.residentBytes} | ${note} |`;
      }),
    ];
    console.log(
      `\nmemory-v3 carry footprint (measured):\n${lines.join("\n")}\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// Compaction contract: a mid-turn compaction's re-injection never claims
// residency, so the store and the persisted history agree across a restart.
// ---------------------------------------------------------------------------

describe("memory-v3 carry integration: compaction contract", () => {
  const KEEP: Slug[] = ["core-alpha", "core-beta", "hot-one", "page-a"];
  const REFS = new Set([
    "core-alpha§",
    "core-beta§",
    "hot-one§",
    "page-a§Detail",
  ]);

  /** Turn 1 injects the four sections, then a tool call continues the turn
   *  (its result is a persisted user row, as in the daemon), and a compaction
   *  lands mid-turn before the reply. Returns the compaction's marker. */
  async function injectThenCompactMidTurn(convId: string): Promise<number> {
    histories.set(convId, []);
    const first = await runTurn(convId, 1, "apple", KEEP);
    expect(first.netNew).toEqual(REFS);
    expect(refIds(getActiveSections(convId))).toEqual(REFS);

    const toolResult: ContentBlock[] = [
      { type: "text", text: "tool result 1" },
    ];
    insertMessageRow(
      convId,
      `${convId}-m1-tool-result`,
      "user",
      toolResult,
      BASE + 1000 + 700,
    );
    histories.get(convId)!.push({ role: "user", content: [...toolResult] });
    const compactedAt = BASE + 1000 + 800;
    compactMidTurn(convId);

    // The post-compaction hook re-injects every selection of the turn onto
    // the tool-result tail; the store claims none of them.
    expect(await reinjectTurn(convId, 1)).toEqual(REFS);
    expect(refIds(getActiveSections(convId)).size).toBe(0);
    return compactedAt;
  }

  function v3Blocks(history: Message[]): number {
    return history.reduce(
      (count, message) =>
        count +
        message.content.filter(
          (block) => block.type === "text" && isV3LiveBlock(block),
        ).length,
      0,
    );
  }

  test("after a restart the re-injected sections are gone from history, unclaimed in the store, and inject net-new on the next turn", async () => {
    const compactedAt = await injectThenCompactMidTurn(COMPACT_CONV);

    // Restart: every row predates the compaction, so nothing rehydrates.
    const rehydrated = rehydrateFromDb(COMPACT_CONV, compactedAt);
    expect(v3Blocks(rehydrated)).toBe(0);
    histories.set(COMPACT_CONV, rehydrated);
    resetMemoryV3InjectorStateForTests();

    // The next turn's same selections inject net-new onto its own persisted
    // user message, and the store claims exactly them.
    const next = await runTurn(COMPACT_CONV, 2, "apple", KEEP);
    expect(next.netNew).toEqual(REFS);
    expect(next.pointerText).toBe("");
    expect(refIds(getActiveSections(COMPACT_CONV))).toEqual(REFS);
    expect(v3Blocks(histories.get(COMPACT_CONV)!)).toBe(1);

    // A restart after that reproduces the live persistent layer.
    expect(JSON.stringify(rehydrateFromDb(COMPACT_CONV, compactedAt))).toBe(
      persistentView(histories.get(COMPACT_CONV)!),
    );
  });

  test("without a restart the re-injected copy is superseded by the next turn's persisted copy at the following assembly", async () => {
    const compactedAt = await injectThenCompactMidTurn(COMPACT_LIVE_CONV);
    const history = histories.get(COMPACT_LIVE_CONV)!;
    const toolResultMessage = history[history.length - 1]!;
    expect(v3Blocks([toolResultMessage])).toBe(1);

    // The next turn injects the unclaimed sections net-new; the live history
    // briefly holds the re-entry copy as well.
    const next = await runTurn(COMPACT_LIVE_CONV, 2, "apple", KEEP);
    expect(next.netNew).toEqual(REFS);
    expect(v3Blocks(history)).toBe(2);

    // Runtime assembly Step 0 on the following turn applies the newest-copy
    // rule to the owned blocks: the re-entry copy goes, the persisted one
    // stays, and the live layer matches what a restart rehydrates.
    stripPrunedSectionsFromMessages(
      history,
      getPrunedSections(COMPACT_LIVE_CONV),
      getKnownCardBytes(COMPACT_LIVE_CONV),
    );
    expect(v3Blocks([toolResultMessage])).toBe(0);
    expect(v3Blocks(history)).toBe(1);
    expect(
      JSON.stringify(rehydrateFromDb(COMPACT_LIVE_CONV, compactedAt)),
    ).toBe(persistentView(history));
  });
});
