/**
 * Tests for `assistant/src/memory/v3/selector.ts`.
 *
 * Coverage matrix:
 *   - Returned IDs map to the right member slugs by 1-based index, with
 *     `pinned` driven by `pinned_ids`.
 *   - Omitted `ids` → ALL members of the leaf (recall-safe).
 *   - Explicit `ids: []` → no pages (deliberate abstention).
 *   - No provider / missing tool_use / schema mismatch / throw → ALL members.
 *   - The per-leaf `<pages>` prefix is byte-identical across two calls with
 *     different turns (the cache invariant).
 *   - `selectAcrossLeaves` flattens per-leaf results and never exceeds the
 *     configured concurrency.
 *
 * The provider is stubbed so no network calls fire.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolUseContent,
} from "../../../providers/types.js";
import type {
  LeafNode,
  LeafPath,
  LeafTree,
  Slug,
  TurnContext,
} from "../types.js";

// ---------------------------------------------------------------------------
// Mocks installed BEFORE the selector import so the module observes them at
// load time.
// ---------------------------------------------------------------------------

let providerStub: Provider | null = null;

interface ProviderCall {
  messages: Message[];
  options: SendMessageOptions | undefined;
}
const providerCalls: ProviderCall[] = [];

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => providerStub,
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b): b is ToolUseContent => b.type === "tool_use"),
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => (prop === "child" ? () => ({}) : () => {}),
    }),
}));

const { selectFromLeaf, selectAcrossLeaves } = await import("../selector.js");

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeProvider(response: ProviderResponse): Provider {
  return {
    name: "stub",
    sendMessage: async (messages, options) => {
      providerCalls.push({ messages, options });
      return response;
    },
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

function makeLeaf(path: LeafPath, members: Slug[]): LeafNode {
  return {
    path,
    frontmatter: { path, in_core: false },
    description: `description for ${path}`,
    members,
    domain: path.split("/")[0],
  };
}

/** Tree with two leaves; `people/alice` has three member pages. */
function makeTree(): LeafTree {
  const leaves: LeafNode[] = [
    makeLeaf("people/alice", ["alice-bio", "alice-1on1", "alice-feedback"]),
    makeLeaf("projects/atlas", ["atlas-roadmap", "atlas-status"]),
  ];
  const byPage = new Map<Slug, LeafPath[]>();
  for (const leaf of leaves) {
    for (const slug of leaf.members) {
      byPage.set(slug, [...(byPage.get(slug) ?? []), leaf.path]);
    }
  }
  return {
    leaves: new Map(leaves.map((n) => [n.path, n])),
    byPage,
  };
}

const ALICE_MEMBERS = ["alice-bio", "alice-1on1", "alice-feedback"];

function makeTurn(currentMessage: string): TurnContext {
  return {
    conversationId: "conv-xyz",
    turnNumber: 1,
    currentMessage,
    recentContext: "earlier we talked about the timeline",
  };
}

/** Deterministic summary stub so the rendered prefix is reproducible. */
const summaryOf = async (slug: Slug): Promise<string> => `summary of ${slug}`;

beforeEach(() => {
  providerStub = null;
  providerCalls.length = 0;
});

// ---------------------------------------------------------------------------
// selectFromLeaf — id mapping.
// ---------------------------------------------------------------------------

describe("selectFromLeaf — id mapping", () => {
  test("returned IDs map to member slugs, pinned driven by pinned_ids", async () => {
    providerStub = makeProvider(
      toolUseResponse({ ids: [3, 1], pinned_ids: [1] }),
    );
    const result = await selectFromLeaf(
      "people/alice",
      makeTurn("how's alice?"),
      makeTree(),
      summaryOf,
    );
    expect(result).toEqual([
      { slug: "alice-feedback", pinned: false },
      { slug: "alice-bio", pinned: true },
    ]);
  });

  test("omitted ids selects ALL members (recall-safe)", async () => {
    providerStub = makeProvider(toolUseResponse({}));
    const result = await selectFromLeaf(
      "people/alice",
      makeTurn("anything"),
      makeTree(),
      summaryOf,
    );
    expect(result).toEqual(
      ALICE_MEMBERS.map((slug) => ({ slug, pinned: false })),
    );
  });

  test("explicit empty ids selects no pages (abstention)", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    const result = await selectFromLeaf(
      "people/alice",
      makeTurn("nothing relevant"),
      makeTree(),
      summaryOf,
    );
    expect(result).toEqual([]);
  });

  test("out-of-range and duplicate IDs are ignored without throwing", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [2, 99, 0, -1, 2] }));
    const result = await selectFromLeaf(
      "people/alice",
      makeTurn("the 1:1"),
      makeTree(),
      summaryOf,
    );
    expect(result).toEqual([{ slug: "alice-1on1", pinned: false }]);
  });

  test("empty leaf returns no pages and never calls the provider", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    const result = await selectFromLeaf(
      "people/empty",
      makeTurn("hi"),
      {
        leaves: new Map([["people/empty", makeLeaf("people/empty", [])]]),
        byPage: new Map(),
      },
      summaryOf,
    );
    expect(result).toEqual([]);
    expect(providerCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// selectFromLeaf — recall-safe fallbacks.
// ---------------------------------------------------------------------------

describe("selectFromLeaf — recall-safe fallbacks", () => {
  const allAlice = ALICE_MEMBERS.map((slug) => ({ slug, pinned: false }));

  test("no provider → ALL members", async () => {
    providerStub = null;
    const result = await selectFromLeaf(
      "people/alice",
      makeTurn("x"),
      makeTree(),
      summaryOf,
    );
    expect(result).toEqual(allAlice);
  });

  test("missing tool_use → ALL members", async () => {
    providerStub = makeProvider({
      model: "stub-model",
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      content: [{ type: "text", text: "no tool call" }],
    });
    const result = await selectFromLeaf(
      "people/alice",
      makeTurn("x"),
      makeTree(),
      summaryOf,
    );
    expect(result).toEqual(allAlice);
  });

  test("schema mismatch → ALL members", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: "not-an-array" }));
    const result = await selectFromLeaf(
      "people/alice",
      makeTurn("x"),
      makeTree(),
      summaryOf,
    );
    expect(result).toEqual(allAlice);
  });

  test("provider throw → ALL members", async () => {
    providerStub = {
      name: "throwing",
      sendMessage: async () => {
        throw new Error("boom");
      },
    };
    const result = await selectFromLeaf(
      "people/alice",
      makeTurn("x"),
      makeTree(),
      summaryOf,
    );
    expect(result).toEqual(allAlice);
  });
});

// ---------------------------------------------------------------------------
// selectFromLeaf — request shape and cache invariant.
// ---------------------------------------------------------------------------

describe("selectFromLeaf — request shape", () => {
  test("forces tool_choice to select_pages with the v3 L2 call site", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectFromLeaf(
      "people/alice",
      makeTurn("alice?"),
      makeTree(),
      summaryOf,
    );

    expect(providerCalls).toHaveLength(1);
    const [call] = providerCalls;
    const cfg = call.options?.config as Record<string, unknown>;
    expect(cfg?.callSite).toBe("memoryV3SelectL2");
    expect(cfg?.tool_choice).toEqual({ type: "tool", name: "select_pages" });
    expect(call.options?.tools?.[0]?.name).toBe("select_pages");
  });

  test("pages block is the first content block with an ephemeral cache breakpoint", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectFromLeaf(
      "people/alice",
      makeTurn("alice?"),
      makeTree(),
      summaryOf,
    );

    const [blockA, blockB] = providerCalls[0].messages[0].content as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(blockA.type).toBe("text");
    expect(blockA.text).toContain("<leaf>people/alice</leaf>");
    expect(blockA.text).toContain("<pages>");
    expect(blockA.text).toContain("[1] alice-bio — summary of alice-bio");
    expect(blockA.cache_control).toEqual({ type: "ephemeral" });

    expect(blockB.type).toBe("text");
    expect(blockB.text).toContain("<current_message>alice?</current_message>");
    expect(blockB.text).toContain("<recent_context>");
    expect(blockB.cache_control).toBeUndefined();
  });

  test("system prompt mentions pinned (locks the pinning commitment)", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectFromLeaf("people/alice", makeTurn("x"), makeTree(), summaryOf);
    expect(providerCalls[0].options?.systemPrompt).toMatch(/pinned/);
  });
});

describe("selectFromLeaf — per-leaf cache invariant", () => {
  test("the pages prefix is byte-identical across two calls with different turns", async () => {
    const tree = makeTree();
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));

    await selectFromLeaf(
      "people/alice",
      makeTurn("first query"),
      tree,
      summaryOf,
    );
    await selectFromLeaf(
      "people/alice",
      makeTurn("totally different second query"),
      tree,
      summaryOf,
    );

    const prefixA = (
      providerCalls[0].messages[0].content[0] as { text: string }
    ).text;
    const prefixB = (
      providerCalls[1].messages[0].content[0] as { text: string }
    ).text;
    expect(prefixA).toBe(prefixB);
  });
});

// ---------------------------------------------------------------------------
// selectAcrossLeaves — fan-out and bounded concurrency.
// ---------------------------------------------------------------------------

describe("selectAcrossLeaves", () => {
  test("flattens per-leaf selections", async () => {
    // The selector forces the tool, so omitted ids → all members per leaf.
    providerStub = makeProvider(toolUseResponse({}));
    const result = await selectAcrossLeaves(
      ["people/alice", "projects/atlas"],
      makeTurn("x"),
      makeTree(),
      summaryOf,
    );
    expect(result.map((p) => p.slug)).toEqual([
      "alice-bio",
      "alice-1on1",
      "alice-feedback",
      "atlas-roadmap",
      "atlas-status",
    ]);
  });

  test("never exceeds the configured concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    providerStub = {
      name: "tracking",
      sendMessage: async () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return toolUseResponse({ ids: [] });
      },
    };

    // Build a tree with eight single-member leaves so there are eight calls.
    const leaves: LeafNode[] = Array.from({ length: 8 }, (_, i) =>
      makeLeaf(`misc/leaf-${i}`, [`page-${i}`]),
    );
    const tree: LeafTree = {
      leaves: new Map(leaves.map((n) => [n.path, n])),
      byPage: new Map(),
    };
    const paths = leaves.map((l) => l.path);

    await selectAcrossLeaves(paths, makeTurn("x"), tree, summaryOf, 3);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(calls).toBe(8);
  });
});
