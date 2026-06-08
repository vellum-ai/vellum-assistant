/**
 * Tests for `assistant/src/memory/v3/orchestrate.ts`.
 *
 * The orchestrator composes four lanes: L1 routing + BM25 needle (parallel) →
 * open set (routed ∪ core ∪ needle-owning leaves) → bounded per-leaf L2
 * selection → carry-forward working set (record + evict) → final injection.
 *
 * The provider is stubbed (no network). A single stub answers BOTH the L1
 * `open_leaves` call and the per-leaf L2 `select_pages` calls by inspecting the
 * forced tool name and, for L2, the `<leaf>...</leaf>` tag in the prompt. The
 * needle is a hand-built fake so we control its hits directly.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
} from "../../../../providers/types.js";
import type { NeedleIndex } from "../needle.js";
import type {
  LeafNode,
  LeafPath,
  LeafTree,
  MemoryRoutingTurn,
  Slug,
} from "../types.js";
import evalTurns from "./fixtures/eval-turns.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Provider mock installed BEFORE the orchestrator import so router.ts and
// selector.ts observe it at load time.
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

const { orchestrate, DEFAULT_NEEDLE_K } = await import("../orchestrate.js");
const { WorkingSet } = await import("../working-set.js");

// ---------------------------------------------------------------------------
// Fixture types + helpers.
// ---------------------------------------------------------------------------

interface LeafSelection {
  ids: number[];
  pinned_ids: number[];
}
interface EvalTurn {
  name: string;
  currentMessage: string;
  routeIds: number[];
  leafSelections: Record<LeafPath, LeafSelection>;
  expectedOpenedLeaves: LeafPath[];
  expectedFinalInjection: Slug[];
}
const TURNS = (evalTurns as { turns: EvalTurn[] }).turns;

function makeLeaf(path: LeafPath, members: Slug[]): LeafNode {
  return {
    path,
    frontmatter: { path, in_core: false },
    description: `description for ${path}`,
    members,
    domain: path.split("/")[0],
  };
}

/**
 * Synthetic tree. Sorted leaf order is [domain-a/topic-x, domain-a/topic-y],
 * so L1 id 1 → topic-x, id 2 → topic-y.
 */
function makeTree(): LeafTree {
  const leaves: LeafNode[] = [
    makeLeaf("domain-a/topic-x", ["page-a", "page-b"]),
    makeLeaf("domain-a/topic-y", ["page-c"]),
  ];
  const byPage = new Map<Slug, LeafPath[]>();
  for (const leaf of leaves) {
    for (const slug of leaf.members) {
      byPage.set(slug, [...(byPage.get(slug) ?? []), leaf.path]);
    }
  }
  return { leaves: new Map(leaves.map((n) => [n.path, n])), byPage };
}

const summaryOf = async (slug: Slug): Promise<string> => `summary of ${slug}`;

/** Needle that returns a fixed slug list, ignoring the query. */
function fakeNeedle(hits: Slug[]): NeedleIndex {
  return { query: (_text, k) => hits.slice(0, k) };
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

function toolUseResponse(
  name: string,
  input: Record<string, unknown>,
): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [{ type: "tool_use", id: "tu-1", name, input }],
  };
}

/** Last `<leaf>X</leaf>` tag found in an L2 request, or undefined. */
function leafFromMessages(messages: Message[]): LeafPath | undefined {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text") {
        const m = /<leaf>([^<]+)<\/leaf>/.exec(block.text);
        if (m) return m[1];
      }
    }
  }
  return undefined;
}

/**
 * Build a provider that answers L1 `open_leaves` with `routeIds` and each L2
 * `select_pages` call with the per-leaf selection from the fixture turn.
 */
function providerForTurn(turn: EvalTurn): Provider {
  return {
    name: "stub",
    sendMessage: async (messages, options) => {
      const toolName = options?.tools?.[0]?.name;
      if (toolName === "open_leaves") {
        return toolUseResponse("open_leaves", { ids: turn.routeIds });
      }
      // L2 select_pages — pick the selection for the leaf under selection.
      const leaf = leafFromMessages(messages);
      const sel = (leaf ? turn.leafSelections[leaf] : undefined) ?? {
        ids: [],
        pinned_ids: [],
      };
      return toolUseResponse("select_pages", {
        ids: sel.ids,
        pinned_ids: sel.pinned_ids,
      });
    },
  };
}

beforeEach(() => {
  providerStub = null;
});

// ---------------------------------------------------------------------------
// Integration: drive the whole fixture sequence through ONE shared WorkingSet.
// ---------------------------------------------------------------------------

describe("orchestrate — fixture sequence (carry-forward)", () => {
  test("each turn's finalInjection matches the fixture", async () => {
    const tree = makeTree();
    const workingSet = new WorkingSet();
    const needle = fakeNeedle([]);

    for (const turn of TURNS) {
      providerStub = providerForTurn(turn);
      const result = await orchestrate(
        makeTurn(TURNS.indexOf(turn) + 1, turn.currentMessage),
        { tree, core: new Set(), needle, workingSet, pageSummary: summaryOf },
      );
      expect(result.openedLeaves).toEqual(turn.expectedOpenedLeaves);
      expect(result.finalInjection).toEqual(turn.expectedFinalInjection);
    }
  });

  test("a slug pinned in turn 1 carries into turn 2 without re-selection", async () => {
    const tree = makeTree();
    const workingSet = new WorkingSet();
    const needle = fakeNeedle([]);

    // Turn 1 selects+pins page-a.
    providerStub = providerForTurn(TURNS[0]);
    await orchestrate(makeTurn(1, TURNS[0].currentMessage), {
      tree,
      core: new Set(),
      needle,
      workingSet,
      pageSummary: summaryOf,
    });

    // Turn 2 opens a DIFFERENT leaf and never re-selects page-a.
    providerStub = providerForTurn(TURNS[1]);
    const t2 = await orchestrate(makeTurn(2, TURNS[1].currentMessage), {
      tree,
      core: new Set(),
      needle,
      workingSet,
      pageSummary: summaryOf,
    });

    expect(t2.currentSelections.map((s) => s.slug)).not.toContain("page-a");
    expect(t2.finalInjection).toContain("page-a");
  });

  test("carry-forward survives a turn whose selections fill the cap", async () => {
    const tree = makeTree();
    // Cap of 1: under a naive record-then-cap order this turn's own selection
    // would evict the carried page before injection. Snapshotting the carry
    // BEFORE recording this turn keeps the earlier page in the injection.
    const workingSet = new WorkingSet(1);
    const needle = fakeNeedle([]);
    const stub = (selectIds: number[]): Provider => ({
      name: "stub",
      sendMessage: async (_messages, options) =>
        options?.tools?.[0]?.name === "open_leaves"
          ? toolUseResponse("open_leaves", { ids: [1] })
          : toolUseResponse("select_pages", { ids: selectIds, pinned_ids: [] }),
    });

    providerStub = stub([1]); // turn 1 → page-a
    await orchestrate(makeTurn(1, "page a"), {
      tree,
      core: new Set(),
      needle,
      workingSet,
      pageSummary: summaryOf,
    });

    providerStub = stub([2]); // turn 2 → page-b, never re-selects page-a
    const t2 = await orchestrate(makeTurn(2, "page b"), {
      tree,
      core: new Set(),
      needle,
      workingSet,
      pageSummary: summaryOf,
    });

    expect(t2.currentSelections.map((s) => s.slug)).toEqual(["page-b"]);
    expect(t2.finalInjection).toContain("page-a"); // carried despite the cap
  });
});

// ---------------------------------------------------------------------------
// Lane composition: needle and core fold into the open set.
// ---------------------------------------------------------------------------

describe("orchestrate — open set composition", () => {
  test("needle hits add their owning leaves to the open set", async () => {
    const tree = makeTree();
    // L1 routes only topic-x; the needle hit page-c lives in topic-y, so the
    // open set must include topic-y too.
    providerStub = {
      name: "stub",
      sendMessage: async (messages, options) => {
        if (options?.tools?.[0]?.name === "open_leaves") {
          return toolUseResponse("open_leaves", { ids: [1] });
        }
        const leaf = leafFromMessages(messages);
        const ids = leaf === "domain-a/topic-y" ? [1] : [];
        return toolUseResponse("select_pages", { ids, pinned_ids: [] });
      },
    };
    const result = await orchestrate(makeTurn(1, "anything"), {
      tree,
      core: new Set(),
      needle: fakeNeedle(["page-c"]),
      workingSet: new WorkingSet(),
      pageSummary: summaryOf,
    });
    expect(result.openedLeaves).toContain("domain-a/topic-y");
    expect(result.finalInjection).toContain("page-c");
  });

  test("core leaves are always opened even when routing abstains", async () => {
    const tree = makeTree();
    // L1 abstains (empty ids); only the core leaf should open.
    providerStub = {
      name: "stub",
      sendMessage: async (messages, options) => {
        if (options?.tools?.[0]?.name === "open_leaves") {
          return toolUseResponse("open_leaves", { ids: [] });
        }
        const leaf = leafFromMessages(messages);
        const ids = leaf === "domain-a/topic-y" ? [1] : [];
        return toolUseResponse("select_pages", { ids, pinned_ids: [] });
      },
    };
    const result = await orchestrate(makeTurn(1, "nothing topical"), {
      tree,
      core: new Set(["domain-a/topic-y"]),
      needle: fakeNeedle([]),
      workingSet: new WorkingSet(),
      pageSummary: summaryOf,
    });
    expect(result.openedLeaves).toEqual(["domain-a/topic-y"]);
    // page-c (topic-y member) is core, so the working set must NOT retain it.
    expect(result.workingSetUnion.has("page-c")).toBe(false);
    // It still injects this turn via the current selection.
    expect(result.finalInjection).toContain("page-c");
  });
});

// ---------------------------------------------------------------------------
// Edge cases.
// ---------------------------------------------------------------------------

describe("orchestrate — edge cases", () => {
  test("empty needle results do not break orchestration", async () => {
    const tree = makeTree();
    providerStub = providerForTurn(TURNS[0]);
    const result = await orchestrate(makeTurn(1, "tell me about page a"), {
      tree,
      core: new Set(),
      needle: fakeNeedle([]),
      workingSet: new WorkingSet(),
      pageSummary: summaryOf,
    });
    expect(result.openedLeaves).toEqual(["domain-a/topic-x"]);
    expect(result.finalInjection).toEqual(["page-a", "page-b"]);
  });

  test("omitted L1 ids opens only the deterministic lanes, not the whole tree", async () => {
    const tree = makeTree();
    // L1 omits ids → routeL1 opens NO routed leaves; only the needle/core lanes
    // drive the open set, so the whole tree is never fanned out (topic-y, which
    // nothing routes or needles to, stays closed).
    providerStub = {
      name: "stub",
      sendMessage: async (_messages, options) => {
        if (options?.tools?.[0]?.name === "open_leaves") {
          return toolUseResponse("open_leaves", {}); // omitted ids → []
        }
        return toolUseResponse("select_pages", {}); // omitted → all members
      },
    };
    const result = await orchestrate(makeTurn(1, "x"), {
      tree,
      core: new Set(),
      needle: fakeNeedle(["page-a"]), // needle opens domain-a/topic-x only
      workingSet: new WorkingSet(),
      pageSummary: summaryOf,
    });
    expect(result.openedLeaves).toEqual(["domain-a/topic-x"]);
    expect(result.finalInjection).toEqual(["page-a", "page-b"]);
  });

  test("pinned current-turn selections land in the working set", async () => {
    const tree = makeTree();
    providerStub = providerForTurn(TURNS[0]); // pins page-a
    const ws = new WorkingSet();
    await orchestrate(makeTurn(1, "tell me about page a"), {
      tree,
      core: new Set(),
      needle: fakeNeedle([]),
      workingSet: ws,
      pageSummary: summaryOf,
    });
    expect(ws.union().has("page-a")).toBe(true);
    expect(ws.union().has("page-b")).toBe(true);
  });

  test("a page in multiple opened leaves is deduped with pinned ORed", async () => {
    // Build a tree where page-shared belongs to BOTH leaves; pin it in one.
    const leaves: LeafNode[] = [
      makeLeaf("domain-a/topic-x", ["page-shared"]),
      makeLeaf("domain-a/topic-y", ["page-shared"]),
    ];
    const byPage = new Map<Slug, LeafPath[]>([
      ["page-shared", ["domain-a/topic-x", "domain-a/topic-y"]],
    ]);
    const tree: LeafTree = {
      leaves: new Map(leaves.map((n) => [n.path, n])),
      byPage,
    };
    providerStub = {
      name: "stub",
      sendMessage: async (messages, options) => {
        if (options?.tools?.[0]?.name === "open_leaves") {
          return toolUseResponse("open_leaves", { ids: [1, 2] });
        }
        const leaf = leafFromMessages(messages);
        // Pin only in topic-x; select (unpinned) in topic-y.
        const pinned_ids = leaf === "domain-a/topic-x" ? [1] : [];
        return toolUseResponse("select_pages", { ids: [1], pinned_ids });
      },
    };
    const result = await orchestrate(makeTurn(1, "x"), {
      tree,
      core: new Set(),
      needle: fakeNeedle([]),
      workingSet: new WorkingSet(),
      pageSummary: summaryOf,
    });
    // One deduped selection, pinned because it was pinned in topic-x.
    expect(result.currentSelections).toEqual([
      { slug: "page-shared", pinned: true },
    ]);
    expect(result.finalInjection).toEqual(["page-shared"]);
  });

  test("needleK defaults to DEFAULT_NEEDLE_K", async () => {
    const tree = makeTree();
    let seenK = -1;
    const needle: NeedleIndex = {
      query: (_text, k) => {
        seenK = k;
        return [];
      },
    };
    providerStub = providerForTurn(TURNS[0]);
    await orchestrate(makeTurn(1, "x"), {
      tree,
      core: new Set(),
      needle,
      workingSet: new WorkingSet(),
      pageSummary: summaryOf,
    });
    expect(seenK).toBe(DEFAULT_NEEDLE_K);
  });
});
