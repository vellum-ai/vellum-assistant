/**
 * Multi-turn integration test for the memory-v3 LIVE-injection path.
 *
 * SCOPE / ALTITUDE. A full daemon-assembly integration (plugin registry → flag
 * read → runtime assembly → provider call) is too heavy and too mock-fragile
 * for a unit test. Instead this composes the REAL v3 live-path units with a
 * mocked select provider + stubbed dense lane and synthetic fixtures:
 *
 *   orchestrate (cache-ordered pool → ONE selectPool call → this turn's
 *     selections)
 *     → renderMemoryBlock (the rendered `<memory>` selections block)
 *     → stripAllMemoryInjections (all-turns history strip)
 *
 * That is exactly the behavioral contract the live path wires together: the
 * plugin's `produce()` renders this turn's `orchestrate(...).selections` via
 * `renderMemoryBlock`, and assembly strips `<memory>` from every historical
 * user message so exactly one block exists. INTERIM SHAPE: the block reflects
 * current-turn selections only — the working-set carry was removed from
 * orchestration; cross-turn persistence (net-new blocks frozen into history)
 * replaces it in a follow-up. The provider is stubbed (no network).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { stripAllMemoryInjections } from "../../../../memory/graph/conversation-graph-memory.js";
import type { PageIndexEntry } from "../../../../memory/v2/page-index.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
} from "../../../../providers/types.js";
import type { EdgeGraph } from "../edge.js";
import { buildEdgeGraph } from "../edge.js";
import { buildSectionNeedle } from "../section-needle.js";
import { buildSectionIndex } from "../sections.js";
import type { MemoryRoutingTurn, SectionIndex, Slug } from "../types.js";

// ---------------------------------------------------------------------------
// Module stubs installed BEFORE the orchestrator import.
// ---------------------------------------------------------------------------

let providerStub: Provider | null = null;

mock.module("../../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => providerStub,
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b) => b.type === "tool_use"),
}));

mock.module("../../../../util/logger.js", () => ({
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

const { orchestrate } = await import("../orchestrate.js");
const { renderMemoryBlock } = await import("../render-injection.js");

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
const contentOf = async (slug: Slug): Promise<string> => `body for ${slug}`;

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
          const m = /^\[(\d+)\] (\S+)(?: — |$)/.exec(line);
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

/** Run one turn through orchestrate + render this turn's selections. */
async function runTurn(
  turnNumber: number,
  query: string,
  keep: Slug[],
  pin: Slug[],
  deps: {
    lanes: Awaited<ReturnType<typeof buildLanes>>;
    core?: Slug[];
    hot?: Slug[];
  },
) {
  providerStub = selectProvider(keep, pin);
  const result = await orchestrate(makeTurn(turnNumber, query), {
    sectionIndex: deps.lanes.sectionIndex,
    needle: deps.lanes.needle,
    denseConfig: config,
    edgeGraph: deps.lanes.edgeGraph,
    coreSlugs: deps.core ?? [],
    hotSlugs: deps.hot ?? [],
  });
  const block = await renderMemoryBlock(
    result.selections.map((s) => s.slug),
    result.matchedSections,
    contentOf,
  );
  return { result, block };
}

/** Count `<memory>\n…\n</memory>` blocks in a rendered string. */
function countMemoryBlocks(text: string): number {
  return (text.match(/<memory>\n/g) ?? []).length;
}

beforeEach(() => {
  denseMockActive = true;
  providerStub = null;
});

afterAll(() => {
  denseMockActive = false;
});

// ---------------------------------------------------------------------------
// Selections-only block (interim shape): the rendered block reflects THIS
// turn's selections; a page selected on an earlier turn and not re-selected
// does not reappear — cross-turn persistence moves to the injector (net-new
// blocks frozen into history) in a follow-up.
// ---------------------------------------------------------------------------

describe("memory-v3 live — selections-only block", () => {
  test("a page selected in turn 1 is absent from turn 2's block unless re-selected", async () => {
    const lanes = await buildLanes();

    const t1 = await runTurn(1, "apple", ["page-a"], ["page-a"], { lanes });
    expect(t1.result.selections.map((s) => s.slug)).toContain("page-a");
    expect(t1.block).toContain("body for page-a");

    const t2 = await runTurn(2, "cherry", ["page-c"], [], { lanes });
    expect(t2.result.selections.map((s) => s.slug)).toEqual(["page-c"]);
    expect(t2.block).toContain("body for page-c");
    expect(t2.block).not.toContain("body for page-a");
  });

  test("a selected stable-prefix page renders in the block", async () => {
    const lanes = await buildLanes();
    // page-b is HOT; the query never matches it, but the selector keeps it
    // from the stable prefix and it renders like any other selection.
    const t1 = await runTurn(1, "apple", ["page-a", "page-b"], [], {
      lanes,
      hot: ["page-b"],
    });
    expect(t1.result.selections.map((s) => s.slug)).toEqual([
      "page-b",
      "page-a",
    ]);
    expect(t1.block).toContain("body for page-b");
    expect(t1.block).toContain("body for page-a");
  });
});

// ---------------------------------------------------------------------------
// Single source: orchestrate → render produces exactly one coherent `<memory>`
// block per turn.
// ---------------------------------------------------------------------------

describe("memory-v3 live — single memory source", () => {
  test("each turn renders exactly one <memory> block", async () => {
    const lanes = await buildLanes();

    const queries = ["apple", "banana", "cherry"];
    for (const [i, query] of queries.entries()) {
      const { block } = await runTurn(i + 1, query, [SLUGS[i]!], [], {
        lanes,
      });
      expect(countMemoryBlocks(block)).toBe(1);
      expect(block.startsWith("<memory>\n")).toBe(true);
      expect(block.endsWith("\n</memory>")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Strip-all: the rendered block injected into historical user messages is
// stripped each turn, leaving byte-stable history (only the live block differs).
// ---------------------------------------------------------------------------

describe("memory-v3 live — all-turns history strip", () => {
  test("historical <memory> blocks strip back to byte-stable user history", async () => {
    const lanes = await buildLanes();

    const baseHistory: Message[] = [
      { role: "user", content: [{ type: "text", text: "first user message" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [{ type: "text", text: "second user message" }],
      },
      { role: "assistant", content: [{ type: "text", text: "sure" }] },
      { role: "user", content: [{ type: "text", text: "third user message" }] },
    ];

    const memBlock = (text: string): ContentBlock => ({ type: "text", text });
    const queries = ["apple", "banana", "cherry"];
    let injected: Message[] = baseHistory;
    for (const [i, query] of queries.entries()) {
      const { block } = await runTurn(i + 1, query, [SLUGS[i]!], [], {
        lanes,
      });
      const stripped = stripAllMemoryInjections(injected);
      injected = stripped.map((m) =>
        m.role === "user"
          ? { ...m, content: [memBlock(block), ...m.content] }
          : m,
      );
    }

    const finalStripped = stripAllMemoryInjections(injected);
    expect(finalStripped).toEqual(baseHistory);
  });
});
