/**
 * Multi-turn integration test for the memory-v3 LIVE-injection path.
 *
 * SCOPE / ALTITUDE. A full daemon-assembly integration (plugin registry → flag
 * read → runtime assembly → provider call) is too heavy and too mock-fragile
 * for a unit test. Instead this composes the REAL v3 live-path units with a
 * mocked select provider + stubbed dense lane and synthetic fixtures:
 *
 *   orchestrate (needle ∪ dense ∪ edge → selectPool over a shared WorkingSet)
 *     → renderMemoryBlock (the rendered `<memory>` working-set block)
 *     → stripAllMemoryInjections (all-turns history strip)
 *
 * That is exactly the behavioral contract the live path wires together: the
 * plugin's `produce()` renders `orchestrate(...).finalInjection` via
 * `renderMemoryBlock`, and assembly strips `<memory>` from every historical user
 * message so exactly one block exists. Driving these real units across turns
 * exercises carry-forward, eviction, single-source, and strip-all end-to-end at
 * the v3 layer without the daemon. The provider is stubbed (no network).
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
const { WorkingSet } = await import("../working-set.js");
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

/** Parse the numbered `<candidates>` block into an ordered slug list. */
function candidateSlugs(messages: Message[]): Slug[] {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "text") continue;
      const m = /<candidates>\n([\s\S]*?)\n<\/candidates>/.exec(block.text);
      if (!m) continue;
      return m[1]
        .split("\n")
        .map((line) => /^\[\d+\] (\S+) —/.exec(line)?.[1])
        .filter((s): s is string => !!s);
    }
  }
  return [];
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

/** Run one turn through orchestrate over the shared working set + render it. */
async function runTurn(
  turnNumber: number,
  query: string,
  keep: Slug[],
  pin: Slug[],
  deps: {
    lanes: Awaited<ReturnType<typeof buildLanes>>;
    workingSet: InstanceType<typeof WorkingSet>;
  },
) {
  providerStub = selectProvider(keep, pin);
  const result = await orchestrate(makeTurn(turnNumber, query), {
    sectionIndex: deps.lanes.sectionIndex,
    needle: deps.lanes.needle,
    denseConfig: config,
    edgeGraph: deps.lanes.edgeGraph,
    workingSet: deps.workingSet,
  });
  const block = await renderMemoryBlock(
    result.finalInjection,
    result.sectionBySlug,
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
// Carry-forward: a page pinned in turn 1 appears in turn 2's injected block
// WITHOUT being re-selected in turn 2 (same WorkingSet reused across turns).
// ---------------------------------------------------------------------------

describe("memory-v3 live — carry-forward across turns", () => {
  test("a page pinned in turn 1 is injected in turn 2 without re-selection", async () => {
    const lanes = await buildLanes();
    const workingSet = new WorkingSet();

    const t1 = await runTurn(1, "apple", ["page-a"], ["page-a"], {
      lanes,
      workingSet,
    });
    expect(t1.result.currentSelections.map((s) => s.slug)).toContain("page-a");
    expect(t1.block).toContain("body for page-a");

    const t2 = await runTurn(2, "cherry", ["page-c"], [], {
      lanes,
      workingSet,
    });
    expect(t2.result.currentSelections.map((s) => s.slug)).not.toContain(
      "page-a",
    );
    expect(t2.result.finalInjection).toContain("page-a");
    expect(t2.block).toContain("body for page-a");
  });
});

// ---------------------------------------------------------------------------
// Eviction reflected: a non-pinned page selected only early ages past the
// eviction window and drops out of a later turn's injected block.
// ---------------------------------------------------------------------------

describe("memory-v3 live — eviction reflected in the injected block", () => {
  test("a stale non-pinned page drops out; the pinned page persists", async () => {
    const lanes = await buildLanes();
    // Small window: a non-pinned entry unseen for >2 turns evicts. page-b is
    // selected only in turn 1, so by turn 4 (4-1=3 > 2) it ages out; pinned
    // page-a never evicts; page-c is re-selected every later turn.
    const workingSet = new WorkingSet(150, 2);

    const t1 = await runTurn(
      1,
      "apple banana",
      ["page-a", "page-b"],
      ["page-a"],
      { lanes, workingSet },
    );
    expect(t1.result.finalInjection).toContain("page-b");
    expect(t1.block).toContain("body for page-b");

    // Turns 2–3 keep page-b inside the window (3-1=2, not > 2); re-select page-c.
    await runTurn(2, "cherry", ["page-c"], [], { lanes, workingSet });
    const t3 = await runTurn(3, "cherry", ["page-c"], [], {
      lanes,
      workingSet,
    });
    expect(t3.result.finalInjection).toContain("page-b");

    // Turn 4: page-b is now stale (4-1=3 > 2) and must be gone from the block;
    // pinned page-a and freshly-selected page-c remain.
    const t4 = await runTurn(4, "cherry", ["page-c"], [], {
      lanes,
      workingSet,
    });
    expect(t4.result.finalInjection).not.toContain("page-b");
    expect(t4.block).not.toContain("body for page-b");
    expect(t4.result.finalInjection).toContain("page-a");
    expect(t4.result.finalInjection).toContain("page-c");
  });
});

// ---------------------------------------------------------------------------
// Single source: orchestrate → render produces exactly one coherent `<memory>`
// block per turn.
// ---------------------------------------------------------------------------

describe("memory-v3 live — single memory source", () => {
  test("each turn renders exactly one <memory> block", async () => {
    const lanes = await buildLanes();
    const workingSet = new WorkingSet();

    const queries = ["apple", "banana", "cherry"];
    for (const [i, query] of queries.entries()) {
      const { block } = await runTurn(i + 1, query, [SLUGS[i]!], [], {
        lanes,
        workingSet,
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
    const workingSet = new WorkingSet();

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
        workingSet,
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
