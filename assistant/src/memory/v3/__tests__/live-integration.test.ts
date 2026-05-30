/**
 * Multi-turn integration test for the memory-v3 LIVE-injection path.
 *
 * SCOPE / ALTITUDE. A full daemon-assembly integration (plugin registry → flag
 * read → runtime assembly → provider call) is too heavy and too mock-fragile
 * for a unit test. Instead this composes the REAL v3 live-path units with a
 * mocked routing/selection provider and synthetic fixtures:
 *
 *   orchestrate (routeL1 + selectAcrossLeaves over a shared WorkingSet)
 *     → renderMemoryBlock (the rendered `<memory>` working-set block)
 *     → stripAllMemoryInjections (all-turns history strip)
 *
 * That is exactly the behavioral contract the live path wires together: the
 * plugin's `produce()` renders `orchestrate(...).finalInjection` via
 * `renderMemoryBlock`, and assembly strips `<memory>` from every historical user
 * message so exactly one block exists. Driving these real units across turns
 * exercises carry-forward, eviction, single-source, and strip-all end-to-end at
 * the v3 layer without the daemon. The provider is stubbed (no network).
 *
 * Mock-leak safety: the only `mock.module` here stub the provider + logger,
 * which are pure inputs to orchestrate and carry no real behavior siblings
 * depend on (orchestrate.test.ts installs the identical stubs). No
 * snapshot-real-modules dance is needed because nothing is partially stubbed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
} from "../../../providers/types.js";
import { stripAllMemoryInjections } from "../../graph/conversation-graph-memory.js";
import type { NeedleIndex } from "../needle.js";
import type {
  LeafNode,
  LeafPath,
  LeafTree,
  Slug,
  TurnContext,
} from "../types.js";
import liveTurns from "./fixtures/live-turns.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Provider mock installed BEFORE the orchestrator import so router.ts and
// selector.ts observe it at load time. Mirrors orchestrate.test.ts.
// ---------------------------------------------------------------------------

let providerStub: Provider | null = null;

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => providerStub,
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b) => b.type === "tool_use"),
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => (prop === "child" ? () => ({}) : () => {}),
    }),
}));

const { orchestrate } = await import("../orchestrate.js");
const { WorkingSet } = await import("../working-set.js");
const { renderMemoryBlock } = await import("../render-injection.js");

// ---------------------------------------------------------------------------
// Fixture types + helpers.
// ---------------------------------------------------------------------------

interface LeafSelection {
  ids: number[];
  pinned_ids: number[];
}
interface LiveTurn {
  name: string;
  currentMessage: string;
  routeIds: number[];
  leafSelections: Record<LeafPath, LeafSelection>;
}
const TURNS = (liveTurns as unknown as { turns: LiveTurn[] }).turns;

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
/** Deterministic per-slug body so the rendered `<memory>` block is assertable. */
const contentOf = async (slug: Slug): Promise<string> => `body for ${slug}`;

/** Needle that never hits — routing alone drives the open set in this fixture. */
const emptyNeedle: NeedleIndex = { query: () => [] };

function makeTurn(turnNumber: number, currentMessage: string): TurnContext {
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
function providerForTurn(turn: LiveTurn): Provider {
  return {
    name: "stub",
    sendMessage: async (messages, options) => {
      const toolName = options?.tools?.[0]?.name;
      if (toolName === "open_leaves") {
        return toolUseResponse("open_leaves", { ids: turn.routeIds });
      }
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

/** Run one turn through orchestrate over the shared working set + render it. */
async function runTurn(
  turn: LiveTurn,
  turnNumber: number,
  deps: { tree: LeafTree; workingSet: InstanceType<typeof WorkingSet> },
) {
  providerStub = providerForTurn(turn);
  const result = await orchestrate(makeTurn(turnNumber, turn.currentMessage), {
    tree: deps.tree,
    core: new Set(),
    needle: emptyNeedle,
    workingSet: deps.workingSet,
    pageSummary: summaryOf,
  });
  const block = await renderMemoryBlock(result.finalInjection, contentOf);
  return { result, block };
}

/** Count `<memory>\n…\n</memory>` blocks in a rendered string. */
function countMemoryBlocks(text: string): number {
  return (text.match(/<memory>\n/g) ?? []).length;
}

beforeEach(() => {
  providerStub = null;
});

// ---------------------------------------------------------------------------
// Carry-forward: a page pinned in turn 1 appears in turn 2's injected block
// WITHOUT being re-selected in turn 2 (same WorkingSet reused across turns).
// ---------------------------------------------------------------------------

describe("memory-v3 live — carry-forward across turns", () => {
  test("a page pinned in turn 1 is injected in turn 2 without re-selection", async () => {
    const tree = makeTree();
    const workingSet = new WorkingSet();

    const t1 = await runTurn(TURNS[0], 1, { tree, workingSet });
    // page-a was selected (and pinned) this turn and rendered into the block.
    expect(t1.result.currentSelections.map((s) => s.slug)).toContain("page-a");
    expect(t1.block).toContain("body for page-a");

    const t2 = await runTurn(TURNS[1], 2, { tree, workingSet });
    // Turn 2 opens a DIFFERENT leaf (topic-y) and never re-selects page-a…
    expect(t2.result.currentSelections.map((s) => s.slug)).not.toContain(
      "page-a",
    );
    // …yet page-a carries forward into the injected block via the working set.
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
    const tree = makeTree();
    // Small window: a non-pinned entry unseen for >2 turns evicts. page-b is
    // selected only in turn 1, so by turn 4 (4-1=3 > 2) it ages out; pinned
    // page-a never evicts; page-c is re-selected every later turn.
    const workingSet = new WorkingSet(150, 2);

    const t1 = await runTurn(TURNS[0], 1, { tree, workingSet });
    expect(t1.result.finalInjection).toContain("page-b");
    expect(t1.block).toContain("body for page-b");

    // Turns 2–3 keep page-b inside the window (3-1=2, not > 2).
    await runTurn(TURNS[1], 2, { tree, workingSet });
    const t3 = await runTurn(TURNS[2], 3, { tree, workingSet });
    expect(t3.result.finalInjection).toContain("page-b");

    // Turn 4: page-b is now stale (4-1=3 > 2) and must be gone from the block;
    // pinned page-a and freshly-selected page-c remain.
    const t4 = await runTurn(TURNS[3], 4, { tree, workingSet });
    expect(t4.result.finalInjection).not.toContain("page-b");
    expect(t4.block).not.toContain("body for page-b");
    expect(t4.result.finalInjection).toContain("page-a");
    expect(t4.result.finalInjection).toContain("page-c");
  });
});

// ---------------------------------------------------------------------------
// Single source: orchestrate → render produces exactly one coherent `<memory>`
// block per turn. (Assembly-level v2 suppression is covered by the assembly
// tests; here we assert the v3 producer never emits more than one block.)
// ---------------------------------------------------------------------------

describe("memory-v3 live — single memory source", () => {
  test("each turn renders exactly one <memory> block", async () => {
    const tree = makeTree();
    const workingSet = new WorkingSet();

    for (const [i, turn] of TURNS.entries()) {
      const { block } = await runTurn(turn, i + 1, { tree, workingSet });
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
    const tree = makeTree();
    const workingSet = new WorkingSet();

    // The canonical (un-injected) user history the strip must converge to.
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

    // Simulate prior turns having injected a v3 `<memory>` block onto EVERY
    // historical user message (prepended, as the live path does).
    const memBlock = (text: string): ContentBlock => ({ type: "text", text });
    let injected: Message[] = baseHistory;
    for (let turnNumber = 1; turnNumber <= TURNS.length; turnNumber++) {
      const { block } = await runTurn(TURNS[turnNumber - 1], turnNumber, {
        tree,
        workingSet,
      });
      // Re-inject this turn's freshly-rendered block onto each user message,
      // after stripping the prior turn's block (what the live assembly does).
      const stripped = stripAllMemoryInjections(injected);
      injected = stripped.map((m) =>
        m.role === "user"
          ? { ...m, content: [memBlock(block), ...m.content] }
          : m,
      );
    }

    // After a final all-turns strip, history is byte-identical to the canonical
    // base — every injected block was recognized and removed.
    const finalStripped = stripAllMemoryInjections(injected);
    expect(finalStripped).toEqual(baseHistory);
  });
});
