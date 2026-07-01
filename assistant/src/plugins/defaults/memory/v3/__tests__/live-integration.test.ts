/**
 * Multi-turn integration test for the memory-v3 LIVE-injection path.
 *
 * SCOPE / ALTITUDE. A full daemon-assembly integration (plugin registry → flag
 * read → runtime assembly → provider call) is too heavy and too mock-fragile
 * for a unit test. Instead this composes the REAL v3 live-path units with a
 * mocked select provider + stubbed dense lane, synthetic fixtures, and a real
 * in-memory everInjected store:
 *
 *   orchestrate (cache-ordered pool → ONE selectPool call → this turn's
 *     selections)
 *     → net-new filter against the everInjected store (`getActiveSlugs`)
 *     → renderCard + renderCardsBlockInner (the frozen card block)
 *     → recordInjected
 *
 * That is the behavioral contract the live path wires together: the injector
 * renders only the turn's NET-NEW selections as cards, records them, and the
 * resulting block is FROZEN into history — prior turns' blocks are never
 * re-rendered or stripped (the cache contract; the old `stripAllMemoryInjections`
 * whole-layer replace is gone). The provider is stubbed (no network).
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
} from "@vellumai/plugin-api";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateAddMemoryV3EverInjected } from "../../../../../persistence/migrations/277-add-memory-v3-ever-injected.js";
import * as schema from "../../../../../persistence/schema/index.js";
import { wrapMemoryBlock } from "../../memory-marker.js";
import type { PageIndexEntry } from "../../v2/page-index.js";
import { cardBytes, renderCard } from "../card.js";
import type { EdgeGraph } from "../edge.js";
import { buildEdgeGraph } from "../edge.js";
import { buildSectionNeedle } from "../section-needle.js";
import { buildSectionIndex } from "../sections.js";
import type { MemoryRoutingTurn, SectionIndex, Slug } from "../types.js";

// ---------------------------------------------------------------------------
// Module stubs installed BEFORE the orchestrator import.
// ---------------------------------------------------------------------------

let providerStub: Provider | null = null;

mock.module("@vellumai/plugin-api", () => ({
  getConfiguredProvider: async () => providerStub,
}));

mock.module("../../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => (prop === "child" ? () => ({}) : () => {}),
    }),
}));

// The dense lane never hits in this fixture — the needle drives the pool. The
// stub DELEGATES to the real `denseLane` unless this file's tests are running
// (`denseMockActive`), so the process-global `mock.module` cannot leak fake
// behavior into dense.test.ts (which exercises the real lane).
const realDense = { ...(await import("../dense.js")) };
let denseMockActive = false;
mock.module("../dense.js", () => ({
  ...realDense,
  denseLane: async (...args: Parameters<typeof realDense.denseLane>) =>
    denseMockActive ? [] : realDense.denseLane(...args),
}));

// In-memory everInjected store backing the net-new dedup, swapped in only
// while this file's tests run.
const realDbConnection = {
  ...(await import("../../../../../persistence/db-connection.js")),
};
let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3EverInjected(db);
  return db;
}
mock.module("../../../../../persistence/db-connection.js", () => ({
  ...realDbConnection,
  getDb: () => (denseMockActive ? testDb : realDbConnection.getDb()),
  getSqliteFrom: (db: unknown) =>
    denseMockActive
      ? testSqlite
      : realDbConnection.getSqliteFrom(
          db as Parameters<typeof realDbConnection.getSqliteFrom>[0],
        ),
}));

const { orchestrate } = await import("../orchestrate.js");
const { renderCardsBlockInner, V3_CARDS_INJECTION_HEADER } =
  await import("../render-injection.js");
const { getActiveSlugs, recordInjected, residentBytes } =
  await import("../ever-injected-store.js");

// ---------------------------------------------------------------------------
// Fixtures: a tiny corpus whose section text contains a distinctive term per
// page so a query selects exactly that page via the needle.
// ---------------------------------------------------------------------------

const PAGES: Record<Slug, string> = {
  "page-a": "lead a\n## Body\napple content for page a",
  "page-b": "lead b\n## Body\nbanana content for page b",
  "page-c": "lead c\n## Body\ncherry content for page c",
};
const SLUGS = Object.keys(PAGES);

function makeEntries(): PageIndexEntry[] {
  return SLUGS.map((slug, i) => ({
    id: i + 1,
    slug,
    summary: `summary of ${slug}`,
    edges: [],
    leaves: [],
    modifiedAt: 0,
  }));
}

const config = {} as never;

async function buildLanes(): Promise<{
  sectionIndex: SectionIndex;
  needle: ReturnType<typeof buildSectionNeedle>;
  edgeGraph: EdgeGraph;
}> {
  const sectionIndex = await buildSectionIndex(SLUGS, async (s) => PAGES[s]!);
  const needle = buildSectionNeedle(sectionIndex);
  const edgeGraph = await buildEdgeGraph(
    makeEntries(),
    async (s) => PAGES[s]!, // no `links:` frontmatter → edge graph is empty
  );
  return { sectionIndex, needle, edgeGraph };
}

function makeTurn(
  turnNumber: number,
  currentMessage: string,
): MemoryRoutingTurn {
  return {
    conversationId: "conv-xyz",
    turnNumber,
    currentMessage,
    recentContext: "prior context",
  };
}

function toolUseResponse(input: Record<string, unknown>): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [{ type: "tool_use", id: "tu-1", name: "select_pages", input }],
  };
}

/**
 * Parse the two-segment selector input into the globally-numbered pool slug
 * list: stable-prefix cards (`<candidate_cards>`, identified by their
 * `[i] # memory/concepts/<slug>.md` header line) then finder lines
 * (`<candidates>`, `[i] slug — descriptor`).
 */
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

/** Provider that selects (and optionally pins) the pooled candidates in `keep`. */
function selectProvider(keep: Slug[], pin: Slug[] = []): Provider {
  return {
    name: "stub",
    sendMessage: async (messages) => {
      const pool = candidateSlugs(messages);
      const ids: number[] = [];
      const pinned_ids: number[] = [];
      pool.forEach((slug, i) => {
        if (keep.includes(slug)) ids.push(i + 1);
        if (pin.includes(slug)) pinned_ids.push(i + 1);
      });
      return toolUseResponse({ ids, pinned_ids });
    },
  };
}

/**
 * Run one turn through the live composition: orchestrate → net-new filter
 * against the store → card render → record. Returns the wrapped block ("" when
 * the turn had no net-new cards) — the same shape the injector attaches.
 */
async function runTurn(
  conversationId: string,
  turnNumber: number,
  query: string,
  keep: Slug[],
  deps: { lanes: Awaited<ReturnType<typeof buildLanes>> },
): Promise<{ block: string; netNew: Slug[] }> {
  providerStub = selectProvider(keep);
  const result = await orchestrate(makeTurn(turnNumber, query), {
    sectionIndex: deps.lanes.sectionIndex,
    needle: deps.lanes.needle,
    denseConfig: config,
    edgeGraph: deps.lanes.edgeGraph,
    coreSlugs: [],
    hotSlugs: [],
    freshSlugs: [],
    prefixCards: new Map(),
  });
  const active = getActiveSlugs(conversationId);
  const netNew = result.selections
    .map((s) => s.slug)
    .filter((slug) => !active.has(slug));
  const cards = netNew.map((slug) => renderCard(slug, PAGES[slug]!));
  recordInjected(
    conversationId,
    cards.map((card, i) => ({ slug: netNew[i]!, bytes: cardBytes(card) })),
  );
  const inner = renderCardsBlockInner(cards);
  return { block: inner.length === 0 ? "" : wrapMemoryBlock(inner), netNew };
}

beforeEach(() => {
  denseMockActive = true;
  providerStub = null;
  testDb = makeDb();
});

afterAll(() => {
  denseMockActive = false;
});

// ---------------------------------------------------------------------------
// Net-new accumulation: each turn renders ONLY pages not already frozen into
// history; an all-repeat turn renders nothing new.
// ---------------------------------------------------------------------------

describe("memory-v3 live — net-new card accumulation", () => {
  test("turn 2 re-selecting turn 1's page renders zero new cards", async () => {
    const lanes = await buildLanes();

    const t1 = await runTurn("conv-1", 1, "apple", ["page-a"], { lanes });
    expect(t1.netNew).toEqual(["page-a"]);
    expect(t1.block).toContain("# memory/concepts/page-a.md");
    expect(t1.block).toContain("lead a");

    // All-repeat turn: no new persistent bytes.
    const t2 = await runTurn("conv-1", 2, "apple", ["page-a"], { lanes });
    expect(t2.netNew).toEqual([]);
    expect(t2.block).toBe("");
    expect(residentBytes("conv-1")).toBeGreaterThan(0);
  });

  test("a topic shift renders only the newly-selected page's card", async () => {
    const lanes = await buildLanes();

    await runTurn("conv-1", 1, "apple", ["page-a"], { lanes });
    const t2 = await runTurn("conv-1", 2, "cherry", ["page-a", "page-c"], {
      lanes,
    });
    expect(t2.netNew).toEqual(["page-c"]);
    expect(t2.block).toContain("# memory/concepts/page-c.md");
    expect(t2.block).not.toContain("# memory/concepts/page-a.md");
  });

  test("each non-empty turn block is one <memory> block with the read-affordance header", async () => {
    const lanes = await buildLanes();
    const queries = ["apple", "banana", "cherry"];
    for (const [i, query] of queries.entries()) {
      const { block } = await runTurn("conv-1", i + 1, query, [SLUGS[i]!], {
        lanes,
      });
      expect((block.match(/<memory>\n/g) ?? []).length).toBe(1);
      expect(block.startsWith("<memory>\n")).toBe(true);
      expect(block.endsWith("\n</memory>")).toBe(true);
      expect(block).toContain(V3_CARDS_INJECTION_HEADER);
    }
  });
});

// ---------------------------------------------------------------------------
// Frozen history: blocks splice onto their own turn's user message and are
// NEVER touched on later turns — prior messages stay byte-identical (the
// cache contract that replaced the old all-turns strip).
// ---------------------------------------------------------------------------

describe("memory-v3 live — frozen card blocks in history", () => {
  test("prior turns' messages stay byte-identical as new turns inject", async () => {
    const lanes = await buildLanes();
    const memBlock = (text: string): ContentBlock => ({ type: "text", text });

    const history: Message[] = [];
    const snapshots: string[] = [];
    const queries = ["apple", "banana", "cherry"];
    for (const [i, query] of queries.entries()) {
      history.push({
        role: "user",
        content: [{ type: "text", text: `user message ${i + 1}` }],
      });
      const { block } = await runTurn("conv-1", i + 1, query, [SLUGS[i]!], {
        lanes,
      });
      // The injector splices the block onto the CURRENT tail only; prior
      // messages are never revisited.
      if (block.length > 0) {
        const tail = history[history.length - 1]!;
        tail.content = [memBlock(block), ...tail.content];
      }
      snapshots.push(JSON.stringify(history.slice(0, -1)));
      history.push({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      });
    }

    // Every snapshot of the pre-tail history is a byte-prefix of the final
    // history: nothing a later turn did rewrote an earlier message.
    const finalJson = JSON.stringify(history);
    for (const snapshot of snapshots) {
      expect(finalJson.startsWith(snapshot.slice(0, -1))).toBe(true);
    }

    // Accumulation: all three turns' cards are present, one block per turn.
    const allText = history
      .flatMap((m) => m.content)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    expect((allText.match(/<memory>\n/g) ?? []).length).toBe(3);
    for (const slug of SLUGS) {
      expect(allText).toContain(`# memory/concepts/${slug}.md`);
    }
  });
});
