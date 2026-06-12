/**
 * Tests for `orchestrate.ts` (cache-ordered candidate pool).
 *
 * The orchestrator composes the stable-prefix lanes (curated core + frecency
 * hot, both computed at lane init and passed in) with three deterministic
 * finder lanes — the section-grain BM25 needle, the dense lane, and link-graph
 * edge expansion — into ONE cache-ordered pool, then runs a SINGLE forced-tool
 * select over it. The result is this turn's selections only; cross-turn
 * persistence is the injector's job, not the orchestrator's.
 *
 * The select provider is stubbed (no network); a single stub answers the one
 * `select_pages` call per turn by reading the numbered `<candidates>` block.
 * The dense lane is stubbed at the module boundary. The needle and edge graph
 * are real, built from tiny inline fixtures so the pool assembly is exercised
 * end-to-end.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { PageIndexEntry } from "../../../../memory/v2/page-index.js";
import type {
  Message,
  Provider,
  ProviderResponse,
} from "../../../../providers/types.js";
import { renderCard } from "../card.js";
import type { EdgeGraph } from "../edge.js";
import { buildEdgeGraph } from "../edge.js";
import type { OrchestrateDeps } from "../orchestrate.js";
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

interface Lanes {
  sectionIndex: SectionIndex;
  needle: ReturnType<typeof buildSectionNeedle>;
  edgeGraph: EdgeGraph;
}

async function buildLanes(): Promise<Lanes> {
  const sectionIndex = await buildSectionIndex(SLUGS, async (s) => PAGES[s]!);
  const needle = buildSectionNeedle(sectionIndex);
  const edgeGraph = await buildEdgeGraph(makeEntries(), async (s) => RAW[s]!);
  return { sectionIndex, needle, edgeGraph };
}

const config = {} as never;

/**
 * Orchestrate deps with empty stable-prefix lanes unless overridden. Mirrors
 * lane init: every core/hot slug gets a pre-rendered card (from the RAW
 * fixture when one exists) unless the test overrides `prefixCards` itself.
 */
function depsOf(
  lanes: Lanes,
  overrides: Partial<OrchestrateDeps> = {},
): OrchestrateDeps {
  const coreSlugs = overrides.coreSlugs ?? [];
  const hotSlugs = overrides.hotSlugs ?? [];
  const freshSlugs = overrides.freshSlugs ?? [];
  const prefixCards = new Map<Slug, string>(
    [...coreSlugs, ...hotSlugs, ...freshSlugs].map((slug) => [
      slug,
      renderCard(slug, RAW[slug] ?? ""),
    ]),
  );
  return {
    sectionIndex: lanes.sectionIndex,
    needle: lanes.needle,
    denseConfig: config,
    edgeGraph: lanes.edgeGraph,
    coreSlugs,
    hotSlugs,
    freshSlugs,
    prefixCards,
    ...overrides,
  };
}

function makeTurn(
  turnNumber: number,
  currentMessage: string,
  previousAssistantMessage?: string,
): MemoryRoutingTurn {
  return {
    conversationId: "conv-xyz",
    turnNumber,
    currentMessage,
    recentContext: "prior context",
    previousAssistantMessage,
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
 * Parse the two-segment selector input back into the globally-numbered pool:
 * stable-prefix cards (`<candidate_cards>`, identified by their
 * `[i] # memory/concepts/<slug>.md` header line) and finder lines
 * (`<candidates>`, `[i] slug — descriptor`). Also captures the raw stable
 * prefix block for byte-identity assertions.
 */
function parsePool(messages: Message[]): {
  slugs: Slug[];
  lines: string[];
  prefixBlock: string | null;
} {
  const entries: Array<{ id: number; slug: string; line: string }> = [];
  let prefixBlock: string | null = null;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "text") continue;
      const cards = /<candidate_cards>\n([\s\S]*?)\n<\/candidate_cards>/.exec(
        block.text,
      );
      if (cards) {
        prefixBlock = cards[0];
        for (const m of cards[1].matchAll(
          /^\[(\d+)\] # memory\/concepts\/(.+)\.md$/gm,
        )) {
          entries.push({ id: Number(m[1]), slug: m[2]!, line: m[0] });
        }
      }
      const finder = /<candidates>\n([\s\S]*?)\n<\/candidates>/.exec(
        block.text,
      );
      if (finder) {
        for (const line of finder[1].split("\n")) {
          const m = /^\[(\d+)\] (?:\([^)]*\) )?(\S+)(?: — |$)/.exec(line);
          if (m) entries.push({ id: Number(m[1]), slug: m[2]!, line });
        }
      }
    }
  }
  entries.sort((a, b) => a.id - b.id);
  return {
    slugs: entries.map((e) => e.slug),
    lines: entries.map((e) => e.line),
    prefixBlock,
  };
}

/**
 * Provider that selects the pool candidates whose slug is in `keep` (mapping
 * each back to its 1-based id), pinning those in `pin`. Captures the rendered
 * candidate list (slugs and raw lines) for pool assertions.
 */
let lastPool: Slug[] = [];
let lastPoolLines: string[] = [];
let lastPrefixBlock: string | null = null;
let selectCalls = 0;
function selectProvider(keep: Slug[], pin: Slug[] = []): Provider {
  return {
    name: "stub",
    sendMessage: async (messages) => {
      selectCalls++;
      const parsed = parsePool(messages);
      lastPool = parsed.slugs;
      lastPoolLines = parsed.lines;
      lastPrefixBlock = parsed.prefixBlock;
      const ids: number[] = [];
      const pinned_ids: number[] = [];
      parsed.slugs.forEach((slug, i) => {
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
  lastPoolLines = [];
  lastPrefixBlock = null;
  selectCalls = 0;
});

afterAll(() => {
  denseMockActive = false;
});

// ---------------------------------------------------------------------------
// Pool composition: the candidate pool is the cache-ordered union of the
// lanes. Synthetic capability pages are not always-added — they enter through
// a lane (see the dedicated test below).
// ---------------------------------------------------------------------------

describe("orchestrate — candidate pool composition", () => {
  test("pool unions needle ∪ dense ∪ edge; one select runs", async () => {
    const lanes = await buildLanes();
    // "apple" hits topic-a (needle). Dense returns topic-b. topic-a links to
    // topic-d (edge).
    denseHits = [{ article: "topic-b", section: 0 }];
    providerStub = selectProvider([]); // selection is irrelevant to pool union

    await orchestrate(makeTurn(1, "apple"), depsOf(lanes));

    expect(selectCalls).toBe(1);
    expect(new Set(lastPool)).toEqual(
      new Set(["topic-a", "topic-b", "topic-d"]),
    );
  });

  test("a synthetic capability page enters the pool via the needle lane", async () => {
    // A capability slug indexed with body content (the section index treats it
    // like any other page) is ranked by the real needle when the query matches
    // its text — this is how synthetic pages reach the pool now that they are no
    // longer always-added.
    const CAP: Slug = "skills/example";
    const sectionIndex = await buildSectionIndex([...SLUGS, CAP], async (s) =>
      s === CAP
        ? "# Skill: example\nuse the kumquat skill to do the thing"
        : PAGES[s]!,
    );
    const needle = buildSectionNeedle(sectionIndex);
    const edgeGraph = await buildEdgeGraph(makeEntries(), async (s) => RAW[s]!);

    providerStub = selectProvider([]); // selection irrelevant to pool union
    await orchestrate(
      makeTurn(1, "kumquat"),
      depsOf({ sectionIndex, needle, edgeGraph }),
    );

    // The needle ranked the capability page on the "kumquat" term, so it is in
    // the candidate pool.
    expect(lastPool).toContain(CAP);
  });

  test("edge curated link description becomes the edge candidate's descriptor", async () => {
    const lanes = await buildLanes();
    providerStub = selectProvider([]);

    await orchestrate(makeTurn(1, "apple"), depsOf(lanes));

    const line = lastPoolLines.find((l) => / topic-d — /.test(l));
    expect(line).toContain("the curated edge from a to d");
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
    await orchestrate(makeTurn(1, "x"), depsOf(lanes, { needle }));
    expect(needleK).toBe(DEFAULT_NEEDLE_K);
    expect(DEFAULT_DENSE_K).toBe(100);
  });

  test("matchedSections is populated from matched lane sections", async () => {
    const lanes = await buildLanes();
    denseHits = [];
    providerStub = selectProvider(["topic-a"]);
    const result = await orchestrate(makeTurn(1, "apple"), depsOf(lanes));
    // topic-a matched "apple" in its `## Details` section.
    expect(result.matchedSections.get("topic-a")?.article).toBe("topic-a");
    expect(result.matchedSections.get("topic-a")?.text).toContain("apple");
  });
});

// ---------------------------------------------------------------------------
// Cache order: the pool's stable prefix is core (file order) then hot (score
// order); finder candidates follow, deduped against the prefix. The prefix is
// byte-identical across turns while the lanes are unchanged — that is the
// whole point of the ordering (selector-input KV cache).
// ---------------------------------------------------------------------------

describe("orchestrate — cache-ordered pool (core + hot + finders)", () => {
  test("pool order is core, then hot, then finder candidates", async () => {
    const lanes = await buildLanes();
    // Core and hot pages do not match "apple"; the needle surfaces topic-a.
    // topic-a links to topic-d, but topic-d is HOT (stable prefix), so the
    // edge lane does not re-surface it.
    denseHits = [{ article: "topic-b", section: 0 }];
    providerStub = selectProvider([]);

    const result = await orchestrate(
      makeTurn(1, "apple"),
      depsOf(lanes, { coreSlugs: ["topic-c"], hotSlugs: ["topic-d"] }),
    );

    expect(lastPool).toEqual(["topic-c", "topic-d", "topic-a", "topic-b"]);
    expect(result.lanes.core).toEqual(["topic-c"]);
    expect(result.lanes.hot).toEqual(["topic-d"]);
    // The edge lane skipped topic-d (already in the stable prefix).
    expect(result.lanes.finder.map((c) => c.slug)).toEqual([
      "topic-a",
      "topic-b",
    ]);
  });

  test("fresh follows hot in the pool and dedups against core/hot", async () => {
    const lanes = await buildLanes();
    denseHits = [];
    providerStub = selectProvider([]);

    const result = await orchestrate(
      makeTurn(1, "apple"),
      depsOf(lanes, {
        coreSlugs: ["topic-c"],
        hotSlugs: ["topic-d"],
        // topic-c (core) and topic-d (hot) are defensively dropped; only
        // topic-b earns a fresh slot.
        freshSlugs: ["topic-c", "topic-d", "topic-b"],
      }),
    );

    expect(lastPool).toEqual(["topic-c", "topic-d", "topic-b", "topic-a"]);
    expect(result.lanes.fresh).toEqual(["topic-b"]);
  });

  test('reply-query hits join the finder tail tagged "reply", after primary lanes and before edge', async () => {
    const lanes = await buildLanes();
    denseHits = [];
    providerStub = selectProvider([]);

    // Primary query matches topic-a; the previous reply matches topic-b. The
    // edge lane expands topic-a's curated link to topic-d.
    const result = await orchestrate(
      makeTurn(1, "apple", "cherry date"),
      depsOf(lanes, { replyQueryK: 5 }),
    );

    expect(result.lanes.finder.map((c) => [c.slug, c.lane])).toEqual([
      ["topic-a", "needle"],
      ["topic-b", "reply"],
      ["topic-d", "edge"],
    ]);
    // The reply-matched section is recorded for injection/spotlight.
    expect(result.matchedSections.has("topic-b")).toBe(true);
  });

  test("a slug both queries surface keeps its primary-lane attribution", async () => {
    const lanes = await buildLanes();
    denseHits = [];
    providerStub = selectProvider([]);

    const result = await orchestrate(
      makeTurn(1, "apple", "apple banana"),
      depsOf(lanes, { replyQueryK: 5 }),
    );

    const topicA = result.lanes.finder.filter((c) => c.slug === "topic-a");
    expect(topicA).toHaveLength(1);
    expect(topicA[0]!.lane).toBe("needle");
  });

  test("no previous assistant message → no reply-lane candidates", async () => {
    const lanes = await buildLanes();
    denseHits = [];
    providerStub = selectProvider([]);

    const result = await orchestrate(
      makeTurn(1, "apple"),
      depsOf(lanes, { replyQueryK: 5 }),
    );

    expect(result.lanes.finder.some((c) => c.lane === "reply")).toBe(false);
  });

  test("replyQueryK = 0 disables the pass even with a previous reply", async () => {
    const lanes = await buildLanes();
    denseHits = [];
    providerStub = selectProvider([]);

    const result = await orchestrate(
      makeTurn(1, "apple", "cherry date"),
      depsOf(lanes, { replyQueryK: 0 }),
    );

    expect(result.lanes.finder.some((c) => c.lane === "reply")).toBe(false);
  });

  test('learned-edge expansion surfaces association neighbours tagged "learned", after the static edge lane', async () => {
    const lanes = await buildLanes();
    denseHits = [];
    providerStub = selectProvider([]);

    // Needle("apple") surfaces topic-a; static links expand a → d; the
    // learned graph associates a → c (no authored link exists).
    const learnedGraph = {
      adjacency: new Map([["topic-a", new Map([["topic-c", undefined]])]]),
      hubs: new Set<Slug>(),
      slugs: new Set(SLUGS),
    };
    const result = await orchestrate(
      makeTurn(1, "apple"),
      depsOf(lanes, { learnedGraph, learnedPerSeed: 3, learnedCap: 20 }),
    );

    expect(result.lanes.finder.map((c) => [c.slug, c.lane])).toEqual([
      ["topic-a", "needle"],
      ["topic-d", "edge"],
      ["topic-c", "learned"],
    ]);
    // Association, not lexical relevance, surfaced topic-c — no matched
    // section is recorded (injection falls back to the full page).
    expect(result.matchedSections.has("topic-c")).toBe(false);
  });

  test("learnedCap = 0 disables the learned pass", async () => {
    const lanes = await buildLanes();
    denseHits = [];
    providerStub = selectProvider([]);

    const learnedGraph = {
      adjacency: new Map([["topic-a", new Map([["topic-c", undefined]])]]),
      hubs: new Set<Slug>(),
      slugs: new Set(SLUGS),
    };
    const result = await orchestrate(
      makeTurn(1, "apple"),
      depsOf(lanes, { learnedGraph, learnedCap: 0 }),
    );

    expect(result.lanes.finder.some((c) => c.lane === "learned")).toBe(false);
  });

  test("the rendered stable prefix is byte-identical across turns with different queries", async () => {
    const lanes = await buildLanes();
    const deps = depsOf(lanes, {
      coreSlugs: ["topic-c"],
      hotSlugs: ["topic-b"],
    });

    providerStub = selectProvider([]);
    await orchestrate(makeTurn(1, "apple"), deps);
    const prefix1 = lastPrefixBlock;

    await orchestrate(makeTurn(2, "grape"), deps);
    const prefix2 = lastPrefixBlock;

    // Stable-prefix cards are pre-rendered and query-independent, so the
    // whole rendered cards block matches byte-for-byte across turns.
    expect(prefix1).not.toBeNull();
    expect(prefix2).toBe(prefix1!);
    expect(prefix1).toContain("topic-c");
    expect(prefix1).toContain("topic-b");
  });

  test("stable-prefix candidates render their pre-rendered cards verbatim", async () => {
    const lanes = await buildLanes();
    providerStub = selectProvider([]);

    await orchestrate(
      makeTurn(1, "zzzz"),
      depsOf(lanes, {
        coreSlugs: ["topic-c"],
        hotSlugs: ["topic-d"],
        prefixCards: new Map([
          [
            "topic-c",
            "# memory/concepts/topic-c.md\nlead for topic c\n\n[sections: §Notes]",
          ],
          ["topic-d", "# memory/concepts/topic-d.md\nlead for topic d"],
        ]),
      }),
    );

    expect(lastPrefixBlock).toContain(
      "[1] # memory/concepts/topic-c.md\nlead for topic c\n\n[sections: §Notes]",
    );
    expect(lastPrefixBlock).toContain(
      "[2] # memory/concepts/topic-d.md\nlead for topic d",
    );
  });

  test("a stable-prefix slug with no pre-rendered card throws (never silently degrades)", async () => {
    const lanes = await buildLanes();
    providerStub = selectProvider([]);

    await expect(
      orchestrate(
        makeTurn(1, "zzzz"),
        depsOf(lanes, {
          coreSlugs: ["topic-c"],
          hotSlugs: ["topic-d"],
          // topic-d is missing — a lane-init bug; a degraded card would break
          // the byte-stable-prefix contract, so orchestrate must throw.
          prefixCards: new Map([["topic-c", renderCard("topic-c", "")]]),
        }),
      ),
    ).rejects.toThrow('no pre-rendered card for stable-prefix slug "topic-d"');
  });

  test("a finder hit on a core page repeats as a finder line and dedupes on selection", async () => {
    const lanes = await buildLanes();
    // topic-a is CORE and the needle also hits it on "apple". The stub keeps
    // BOTH occurrences (card id + finder-line id).
    providerStub = selectProvider(["topic-a"]);

    const result = await orchestrate(
      makeTurn(1, "apple"),
      depsOf(lanes, { coreSlugs: ["topic-a"] }),
    );

    // The pool lists topic-a twice — once as the stable-prefix card, once as
    // a finder line carrying its CURRENT matched section (the tail is not
    // deduped against the prefix, by design: filtering would not change the
    // prefix here, but the snippet line is the page's current relevance).
    expect(lastPool.filter((s) => s === "topic-a")).toHaveLength(2);
    expect(lastPool[0]).toBe("topic-a");
    // The finder line shows the matched-section snippet.
    expect(
      lastPoolLines.find((l) => /^\[2\] (?:\([^)]*\) )?topic-a — /.test(l)),
    ).toContain("apple");
    // Selecting both ids still yields ONE selection (slug dedup), the finder
    // lane records the hit, and the matched section survives downstream.
    expect(result.selections).toEqual([{ slug: "topic-a", pinned: false }]);
    expect(result.lanes.finder.map((c) => c.slug)).toContain("topic-a");
    expect(result.matchedSections.get("topic-a")?.text).toContain("apple");
  });

  test("a hot slug duplicated into core is defensively dropped from hot", async () => {
    const lanes = await buildLanes();
    providerStub = selectProvider([]);

    const result = await orchestrate(
      makeTurn(1, "zzzz"),
      depsOf(lanes, {
        coreSlugs: ["topic-c"],
        hotSlugs: ["topic-c", "topic-d"],
      }),
    );

    expect(result.lanes.core).toEqual(["topic-c"]);
    expect(result.lanes.hot).toEqual(["topic-d"]);
    expect(lastPool).toEqual(["topic-c", "topic-d"]);
  });

  test("selections are current-turn only — no carried set is unioned in", async () => {
    const lanes = await buildLanes();
    const deps = depsOf(lanes, { coreSlugs: ["topic-c"] });

    // Turn 1 selects topic-a.
    providerStub = selectProvider(["topic-a"]);
    const t1 = await orchestrate(makeTurn(1, "apple"), deps);
    expect(t1.selections.map((s) => s.slug)).toEqual(["topic-a"]);

    // Turn 2 selects only topic-b; topic-a does NOT reappear (cross-turn
    // persistence is the injector's job now, not orchestration's).
    denseHits = [{ article: "topic-b", section: 0 }];
    providerStub = selectProvider(["topic-b"]);
    const t2 = await orchestrate(makeTurn(2, "cherry"), deps);
    expect(t2.selections.map((s) => s.slug)).toEqual(["topic-b"]);
  });

  test("pinned flags survive selection dedup", async () => {
    const lanes = await buildLanes();
    providerStub = selectProvider(["topic-a"], ["topic-a"]);
    const result = await orchestrate(makeTurn(1, "apple"), depsOf(lanes));
    expect(result.selections).toEqual([{ slug: "topic-a", pinned: true }]);
  });
});

// ---------------------------------------------------------------------------
// Edge-only injection: a page surfaced ONLY by the edge lane (the query did not
// lexically hit it) records NO matched section, so injection falls back to the
// FULL page (the curated `links` description — not the often-empty lead the
// query never hit — is what made the candidate relevant). The best-section text
// is kept only as the select-pool descriptor fallback.
// ---------------------------------------------------------------------------

describe("orchestrate — edge-only injection", () => {
  test("an edge-only page records NO matchedSections entry (→ full-page inject)", async () => {
    const lanes = await buildLanes();
    // "apple" hits topic-a (needle); topic-a links to topic-d (edge-only — the
    // query never hits topic-d). Select topic-d so it is in the result.
    denseHits = [];
    providerStub = selectProvider(["topic-d"]);
    const result = await orchestrate(makeTurn(1, "apple"), depsOf(lanes));

    // topic-d was selected, but with NO matched section — so
    // `renderV3SectionContent(slug, undefined)` falls back to the full page.
    expect(result.selections.map((s) => s.slug)).toContain("topic-d");
    expect(result.matchedSections.has("topic-d")).toBe(false);
  });

  test("an edge-only page with no curated description falls back to bestSection text as the descriptor", async () => {
    // A bare `links:` entry (no ` — `) carries NO description, so the edge
    // candidate's descriptor falls back to the page's best section against the
    // query. The query never hits dst-page, so bestSection returns its lead;
    // that lead text becomes the descriptor (and the page is still injected in
    // full, with no matchedSections entry).
    const pages: Record<Slug, string> = {
      "src-page": "lead for src\n## Body\nalpha bravo about src",
      "dst-page": "lead content for dst page\n## Extra\nnothing relevant here",
    };
    const raw: Record<Slug, string> = {
      // bare slug — no ` — ` separator → undefined curated description.
      "src-page": `---\nlinks:\n  - "dst-page"\n---\n${pages["src-page"]}`,
      "dst-page": `---\nedges: []\n---\n${pages["dst-page"]}`,
    };
    const slugs = Object.keys(pages);
    const entries: PageIndexEntry[] = slugs.map((slug, i) => ({
      id: i + 1,
      slug,
      summary: `summary of ${slug}`,
      edges: [],
      leaves: [],
      modifiedAt: 0,
    }));
    const sectionIndex = await buildSectionIndex(slugs, async (s) => pages[s]!);
    const needle = buildSectionNeedle(sectionIndex);
    const edgeGraph = await buildEdgeGraph(entries, async (s) => raw[s]!);

    providerStub = selectProvider([]);

    // "alpha" hits src-page (needle); src-page links to dst-page (edge-only, no
    // curated description).
    const result = await orchestrate(
      makeTurn(1, "alpha"),
      depsOf({ sectionIndex, needle, edgeGraph }),
    );

    // Descriptor fell back to dst-page's lead text; still no matched section.
    const line = lastPoolLines.find((l) => / dst-page — /.test(l));
    expect(line).toContain("lead content for dst page");
    expect(result.matchedSections.has("dst-page")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dense liveness: a dense hit whose article is no longer in the live section
// index (its page was deleted; its Qdrant points linger) is dropped from the
// pool, so a deleted page can never be surfaced via the dense lane.
// ---------------------------------------------------------------------------

describe("orchestrate — dense liveness filter", () => {
  test("a dense hit absent from sectionIndex.byArticle is dropped from the pool", async () => {
    const lanes = await buildLanes();
    // Dense returns a live page (topic-b) AND a deleted page (gone-page) whose
    // points still linger in Qdrant but which is absent from the section index.
    denseHits = [
      { article: "topic-b", section: 0 },
      { article: "gone-page", section: 0 },
    ];
    providerStub = selectProvider([]); // selection irrelevant to pool membership
    const result = await orchestrate(makeTurn(1, "apple"), depsOf(lanes));

    // The live dense hit is pooled; the deleted page is dropped entirely.
    expect(lastPool).toContain("topic-b");
    expect(lastPool).not.toContain("gone-page");
    expect(result.lanes.finder.map((c) => c.slug)).not.toContain("gone-page");
  });

  test("a dense hit with an unresolvable ordinal falls back to the lead-section snippet", async () => {
    const lanes = await buildLanes();
    // Ordinal 99 resolves to no section, so the candidate carries no match
    // text — its finder line falls back to the page's lead-section text.
    denseHits = [{ article: "topic-b", section: 99 }];
    providerStub = selectProvider([]);
    await orchestrate(makeTurn(1, "zzzz"), depsOf(lanes));

    const line = lastPoolLines.find((l) => / topic-b — /.test(l));
    expect(line).toContain("lead for topic b");
  });
});

// ---------------------------------------------------------------------------
// Lane provenance: each finder candidate records the lane that FIRST surfaced
// it (needle → dense → edge precedence), exposed via `result.lanes.finder` so
// the selection telemetry can attribute true sources.
// ---------------------------------------------------------------------------

describe("orchestrate — finder lane provenance", () => {
  test("each finder candidate is tagged with its surfacing lane", async () => {
    const lanes = await buildLanes();
    // "apple" hits topic-a (needle). Dense returns topic-b. topic-a links to
    // topic-d (edge). So each lane contributes exactly one distinct slug.
    denseHits = [{ article: "topic-b", section: 0 }];
    providerStub = selectProvider([]); // selection irrelevant to pool provenance
    const result = await orchestrate(makeTurn(1, "apple"), depsOf(lanes));

    const laneOf = new Map(result.lanes.finder.map((c) => [c.slug, c.lane]));
    expect(laneOf.get("topic-a")).toBe("needle");
    expect(laneOf.get("topic-b")).toBe("dense");
    expect(laneOf.get("topic-d")).toBe("edge");
  });

  test("a slug surfaced by needle AND dense keeps the needle lane (first wins)", async () => {
    const lanes = await buildLanes();
    // topic-a is surfaced by the needle on "apple"; dense ALSO returns topic-a.
    // Needle runs first, so the recorded lane stays needle.
    denseHits = [{ article: "topic-a", section: 0 }];
    providerStub = selectProvider([]);
    const result = await orchestrate(makeTurn(1, "apple"), depsOf(lanes));

    const entries = result.lanes.finder.filter((c) => c.slug === "topic-a");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lane).toBe("needle");
  });
});

// ---------------------------------------------------------------------------
// Degradation: an empty pool and the recall-safe omitted-ids path.
// ---------------------------------------------------------------------------

describe("orchestrate — degradation", () => {
  test("an empty pool yields no selections", async () => {
    const lanes = await buildLanes();
    providerStub = selectProvider([]);
    const result = await orchestrate(
      makeTurn(1, "zzzzz no-match"),
      depsOf(lanes, { needle: { query: () => [], bestSection: () => -1 } }),
    );
    expect(result.selections).toEqual([]);
    expect(result.lanes.finder).toEqual([]);
  });

  test("omitted ids keeps ALL pooled candidates (recall-safe)", async () => {
    const lanes = await buildLanes();
    denseHits = [{ article: "topic-b", section: 0 }];
    providerStub = {
      name: "stub",
      sendMessage: async () => toolUseResponse({}), // omitted ids → keep all
    };
    const result = await orchestrate(
      makeTurn(1, "apple"),
      depsOf(lanes, { coreSlugs: ["topic-c"] }),
    );
    expect(new Set(result.selections.map((s) => s.slug))).toEqual(
      new Set(["topic-c", "topic-a", "topic-b", "topic-d"]),
    );
  });
});
