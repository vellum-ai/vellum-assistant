/**
 * Tests for `orchestrate.ts` (section-lane pipeline).
 *
 * The orchestrator composes three deterministic candidate lanes — the
 * section-grain BM25 needle, the dense lane, and link-graph edge expansion —
 * into ONE unified pool, appends the synthetic capability slugs, runs a SINGLE
 * forced-tool select over the pool, then carries forward the working set.
 *
 * The select provider is stubbed (no network); a single stub answers the one
 * `select_pages` call per turn by reading the numbered `<candidates>` block.
 * The dense lane is stubbed at the module boundary. The needle and edge graph
 * are real, built from tiny inline fixtures so the pool union is exercised
 * end-to-end.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { PageIndexEntry } from "../../../../memory/v2/page-index.js";
import type {
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
// Module stubs installed BEFORE the orchestrator import so pool-select and the
// dense lane observe them at load time.
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

// The dense lane is stubbed: each test sets `denseHits` to control which
// articles (+ matched ordinals) the dense lane returns. The stub DELEGATES to
// the real `denseLane` unless this file's tests are running (`denseMockActive`),
// so the process-global `mock.module` cannot leak fake behavior into
// dense.test.ts (which exercises the real lane). Spread the real module so
// every other export (`OVERSAMPLE`) stays present.
const realDense = { ...(await import("../dense.js")) };
let denseMockActive = false;
let denseHits: Array<{ article: Slug; section: number }> = [];
mock.module("../dense.js", () => ({
  ...realDense,
  denseLane: async (...args: Parameters<typeof realDense.denseLane>) =>
    denseMockActive ? denseHits : realDense.denseLane(...args),
}));

const { orchestrate, DEFAULT_NEEDLE_K, DEFAULT_DENSE_K } =
  await import("../orchestrate.js");
const { WorkingSet } = await import("../working-set.js");

// ---------------------------------------------------------------------------
// Fixtures: a tiny corpus of pages with bodies + `links:` frontmatter.
// ---------------------------------------------------------------------------

const PAGES: Record<Slug, string> = {
  "topic-a": "lead for topic a\n## Details\napple banana about topic a",
  "topic-b": "lead for topic b\n## More\ncherry date about topic b",
  "topic-c": "lead for topic c\n## Notes\nelderberry fig about topic c",
  "topic-d": "lead for topic d\n## Notes\ngrape about topic d",
};

/** Raw page = frontmatter (with `links:`) + body. */
const RAW: Record<Slug, string> = {
  "topic-a": `---\nlinks:\n  - "topic-d — the curated edge from a to d"\n---\n${PAGES["topic-a"]}`,
  "topic-b": `---\nedges: []\n---\n${PAGES["topic-b"]}`,
  "topic-c": `---\nedges: []\n---\n${PAGES["topic-c"]}`,
  "topic-d": `---\nedges: []\n---\n${PAGES["topic-d"]}`,
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

async function buildLanes(): Promise<{
  sectionIndex: SectionIndex;
  needle: ReturnType<typeof buildSectionNeedle>;
  edgeGraph: EdgeGraph;
}> {
  const sectionIndex = await buildSectionIndex(SLUGS, async (s) => PAGES[s]!);
  const needle = buildSectionNeedle(sectionIndex);
  const edgeGraph = await buildEdgeGraph(makeEntries(), async (s) => RAW[s]!);
  return { sectionIndex, needle, edgeGraph };
}

const config = {} as never;

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

/** Parse the numbered `<candidates>` block back into an ordered slug list. */
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

/**
 * Provider that selects the pool candidates whose slug is in `keep` (mapping
 * each back to its 1-based id), pinning those in `pin`. Captures the rendered
 * candidate list for pool assertions.
 */
let lastPool: Slug[] = [];
let selectCalls = 0;
function selectProvider(keep: Slug[], pin: Slug[] = []): Provider {
  return {
    name: "stub",
    sendMessage: async (messages) => {
      selectCalls++;
      const pool = candidateSlugs(messages);
      lastPool = pool;
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

beforeEach(() => {
  denseMockActive = true;
  providerStub = null;
  denseHits = [];
  lastPool = [];
  selectCalls = 0;
});

afterAll(() => {
  denseMockActive = false;
});

// ---------------------------------------------------------------------------
// Pool composition: the candidate pool is the union of the lanes + capabilities.
// ---------------------------------------------------------------------------

describe("orchestrate — candidate pool composition", () => {
  test("pool unions needle ∪ dense ∪ edge ∪ capabilities; one select runs", async () => {
    const lanes = await buildLanes();
    // "apple" hits topic-a (needle). Dense returns topic-b. topic-a links to
    // topic-d (edge). Capability slug always appended.
    denseHits = [{ article: "topic-b", section: 0 }];
    providerStub = selectProvider([]); // selection is irrelevant to pool union

    await orchestrate(makeTurn(1, "apple"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet: new WorkingSet(),
      capabilitySlugs: ["skills/example"],
    });

    expect(selectCalls).toBe(1);
    expect(new Set(lastPool)).toEqual(
      new Set(["topic-a", "topic-b", "topic-d", "skills/example"]),
    );
  });

  test("edge curated link description becomes the edge candidate's descriptor", async () => {
    const lanes = await buildLanes();
    let descriptorLine = "";
    providerStub = {
      name: "stub",
      sendMessage: async (messages) => {
        for (const msg of messages) {
          for (const block of msg.content) {
            if (block.type !== "text") continue;
            const m = /\[\d+\] topic-d — ([^\n]+)/.exec(block.text);
            if (m) descriptorLine = m[1]!;
          }
        }
        return toolUseResponse({ ids: [] });
      },
    };

    await orchestrate(makeTurn(1, "apple"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet: new WorkingSet(),
      capabilitySlugs: [],
    });

    expect(descriptorLine).toContain("the curated edge from a to d");
  });

  test("needleK and denseK default to their constants", async () => {
    const lanes = await buildLanes();
    let needleK = -1;
    const needle = {
      query: (_t: string, k: number) => {
        needleK = k;
        return [];
      },
      bestSection: () => -1,
    };
    providerStub = selectProvider([]);
    await orchestrate(makeTurn(1, "x"), {
      sectionIndex: lanes.sectionIndex,
      needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet: new WorkingSet(),
      capabilitySlugs: [],
    });
    expect(needleK).toBe(DEFAULT_NEEDLE_K);
    expect(DEFAULT_DENSE_K).toBe(100);
  });

  test("sectionBySlug is populated from matched lane sections", async () => {
    const lanes = await buildLanes();
    denseHits = [];
    providerStub = selectProvider(["topic-a"]);
    const result = await orchestrate(makeTurn(1, "apple"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet: new WorkingSet(),
      capabilitySlugs: [],
    });
    // topic-a matched "apple" in its `## Details` section.
    expect(result.sectionBySlug.get("topic-a")?.article).toBe("topic-a");
    expect(result.sectionBySlug.get("topic-a")?.text).toContain("apple");
  });
});

// ---------------------------------------------------------------------------
// Carry-forward: same working-set semantics as the prior tree pipeline.
// ---------------------------------------------------------------------------

describe("orchestrate — carry-forward", () => {
  test("a page selected+pinned in turn 1 carries into turn 2 without re-selection", async () => {
    const lanes = await buildLanes();
    const workingSet = new WorkingSet();

    // Turn 1 selects+pins topic-a.
    providerStub = selectProvider(["topic-a"], ["topic-a"]);
    await orchestrate(makeTurn(1, "apple"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet,
      capabilitySlugs: [],
    });

    // Turn 2 selects a DIFFERENT page and never re-selects topic-a.
    denseHits = [{ article: "topic-b", section: 0 }];
    providerStub = selectProvider(["topic-b"]);
    const t2 = await orchestrate(makeTurn(2, "cherry"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet,
      capabilitySlugs: [],
    });

    expect(t2.currentSelections.map((s) => s.slug)).not.toContain("topic-a");
    expect(t2.finalInjection).toContain("topic-a");
  });

  test("carry-forward survives a turn whose selections fill the cap", async () => {
    const lanes = await buildLanes();
    // Cap of 1: under a naive record-then-cap order this turn's own selection
    // would evict the carried page before injection. Snapshotting the carry
    // BEFORE recording this turn keeps the earlier page in the injection.
    const workingSet = new WorkingSet(1);

    providerStub = selectProvider(["topic-a"]); // turn 1 → topic-a
    await orchestrate(makeTurn(1, "apple"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet,
      capabilitySlugs: [],
    });

    denseHits = [{ article: "topic-b", section: 0 }];
    providerStub = selectProvider(["topic-b"]); // turn 2 → topic-b
    const t2 = await orchestrate(makeTurn(2, "cherry"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet,
      capabilitySlugs: [],
    });

    expect(t2.currentSelections.map((s) => s.slug)).toEqual(["topic-b"]);
    expect(t2.finalInjection).toContain("topic-a"); // carried despite the cap
  });

  test("a stale non-pinned page ages out of the carry-forward window", async () => {
    const lanes = await buildLanes();
    // window 2: a non-pinned entry unseen for >2 turns evicts.
    const workingSet = new WorkingSet(150, 2);

    providerStub = selectProvider(["topic-a"]); // turn 1 selects topic-a
    const t1 = await orchestrate(makeTurn(1, "apple"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet,
      capabilitySlugs: [],
    });
    expect(t1.finalInjection).toContain("topic-a");

    // Turns 2–4 never re-select topic-a. By turn 4 (4-1=3 > 2) it ages out.
    providerStub = selectProvider([]);
    await orchestrate(makeTurn(2, "x"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet,
      capabilitySlugs: [],
    });
    await orchestrate(makeTurn(3, "x"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet,
      capabilitySlugs: [],
    });
    const t4 = await orchestrate(makeTurn(4, "x"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet,
      capabilitySlugs: [],
    });
    expect(t4.finalInjection).not.toContain("topic-a");
  });

  test("pinned current-turn selections land in the working set", async () => {
    const lanes = await buildLanes();
    const ws = new WorkingSet();
    providerStub = selectProvider(["topic-a"], ["topic-a"]);
    await orchestrate(makeTurn(1, "apple"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet: ws,
      capabilitySlugs: [],
    });
    expect(ws.union().has("topic-a")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Degradation: an empty pool and a provider-unavailable path are recall-safe.
// ---------------------------------------------------------------------------

describe("orchestrate — degradation", () => {
  test("an empty pool yields no selections and an empty injection", async () => {
    const lanes = await buildLanes();
    providerStub = selectProvider([]);
    const result = await orchestrate(makeTurn(1, "zzzzz no-match"), {
      sectionIndex: lanes.sectionIndex,
      needle: { query: () => [], bestSection: () => -1 },
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet: new WorkingSet(),
      capabilitySlugs: [],
    });
    expect(result.currentSelections).toEqual([]);
    expect(result.finalInjection).toEqual([]);
  });

  test("omitted ids keeps ALL pooled candidates (recall-safe)", async () => {
    const lanes = await buildLanes();
    denseHits = [{ article: "topic-b", section: 0 }];
    providerStub = {
      name: "stub",
      sendMessage: async () => toolUseResponse({}), // omitted ids → keep all
    };
    const result = await orchestrate(makeTurn(1, "apple"), {
      sectionIndex: lanes.sectionIndex,
      needle: lanes.needle,
      denseConfig: config,
      edgeGraph: lanes.edgeGraph,
      workingSet: new WorkingSet(),
      capabilitySlugs: ["skills/example"],
    });
    expect(new Set(result.finalInjection)).toEqual(
      new Set(["topic-a", "topic-b", "topic-d", "skills/example"]),
    );
  });
});
