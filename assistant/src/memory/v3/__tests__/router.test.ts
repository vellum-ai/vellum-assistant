/**
 * Tests for `assistant/src/memory/v3/router.ts`.
 *
 * Coverage matrix:
 *   - Returned IDs map to the right leaves by 1-based index, in model order.
 *   - Omitted `ids` → ALL leaves (recall-safe).
 *   - Explicit `ids: []` → no leaves (deliberate abstention).
 *   - Out-of-range / duplicate IDs ignored, no throw.
 *   - No provider / missing tool_use / schema mismatch / throw → ALL leaves.
 *   - The rendered leaf block is byte-identical across two calls with
 *     different queries (the cache invariant).
 *   - The system prompt mentions "register" (locks the routing commitment).
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
import type { LeafNode, LeafPath, LeafTree, TurnContext } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks installed BEFORE the router import so the module observes them at
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

const { routeL1, renderLeafBlock } = await import("../router.js");

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
    content: [{ type: "tool_use", id: "tu-1", name: "open_leaves", input }],
  };
}

function makeLeaf(path: LeafPath, description: string): LeafNode {
  return {
    path,
    frontmatter: { path, in_core: false },
    description,
    members: [],
    domain: path.split("/")[0],
  };
}

/** Tree whose leaves are intentionally inserted out of sorted order so the
 * tests verify the router sorts by path (not insertion order) before
 * assigning 1-based IDs. Sorted → [people/alice, people/bob, projects/atlas]. */
function makeTree(): LeafTree {
  const entries: LeafNode[] = [
    makeLeaf("projects/atlas", "The Atlas project roadmap and status."),
    makeLeaf("people/bob", "Bob — colleague, prefers async."),
    makeLeaf("people/alice", "Alice — manager, weekly 1:1s."),
  ];
  return {
    leaves: new Map(entries.map((n) => [n.path, n])),
    byPage: new Map(),
  };
}

const SORTED_PATHS = ["people/alice", "people/bob", "projects/atlas"];

function makeTurn(currentMessage: string): TurnContext {
  return {
    conversationId: "conv-xyz",
    turnNumber: 1,
    currentMessage,
    recentContext: "earlier we talked about the timeline",
  };
}

beforeEach(() => {
  providerStub = null;
  providerCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("routeL1 — id mapping", () => {
  test("returned IDs map to leaves by 1-based index, in model order", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [3, 1] }));
    const result = await routeL1(makeTurn("how's atlas?"), makeTree());
    expect(result).toEqual(["projects/atlas", "people/alice"]);
  });

  test("omitted ids opens ALL leaves (recall-safe)", async () => {
    providerStub = makeProvider(toolUseResponse({}));
    const result = await routeL1(makeTurn("anything"), makeTree());
    expect(result).toEqual(SORTED_PATHS);
  });

  test("explicit empty ids opens no leaves (abstention)", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    const result = await routeL1(makeTurn("nothing relevant"), makeTree());
    expect(result).toEqual([]);
  });

  test("out-of-range and duplicate IDs are ignored without throwing", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [2, 99, 0, -1, 2] }));
    const result = await routeL1(makeTurn("bob?"), makeTree());
    expect(result).toEqual(["people/bob"]);
  });

  test("empty tree returns no leaves and never calls the provider", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    const result = await routeL1(makeTurn("hi"), {
      leaves: new Map(),
      byPage: new Map(),
    });
    expect(result).toEqual([]);
    expect(providerCalls).toHaveLength(0);
  });
});

describe("routeL1 — recall-safe fallbacks", () => {
  test("no provider → ALL leaves", async () => {
    providerStub = null;
    const result = await routeL1(makeTurn("x"), makeTree());
    expect(result).toEqual(SORTED_PATHS);
  });

  test("missing tool_use → ALL leaves", async () => {
    providerStub = makeProvider({
      model: "stub-model",
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      content: [{ type: "text", text: "no tool call" }],
    });
    const result = await routeL1(makeTurn("x"), makeTree());
    expect(result).toEqual(SORTED_PATHS);
  });

  test("schema mismatch → ALL leaves", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: "not-an-array" }));
    const result = await routeL1(makeTurn("x"), makeTree());
    expect(result).toEqual(SORTED_PATHS);
  });

  test("provider throw → ALL leaves", async () => {
    providerStub = {
      name: "throwing",
      sendMessage: async () => {
        throw new Error("boom");
      },
    };
    const result = await routeL1(makeTurn("x"), makeTree());
    expect(result).toEqual(SORTED_PATHS);
  });
});

describe("routeL1 — request shape", () => {
  test("forces tool_choice to open_leaves with the v3 call site", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await routeL1(makeTurn("alice?"), makeTree());

    expect(providerCalls).toHaveLength(1);
    const [call] = providerCalls;
    const cfg = call.options?.config as Record<string, unknown>;
    expect(cfg?.callSite).toBe("memoryV3RouteL1");
    expect(cfg?.tool_choice).toEqual({ type: "tool", name: "open_leaves" });
    expect(call.options?.tools?.[0]?.name).toBe("open_leaves");
  });

  test("leaf block is the first content block with an ephemeral cache breakpoint", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await routeL1(makeTurn("alice?"), makeTree());

    const [blockA, blockB] = providerCalls[0].messages[0].content as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(blockA.type).toBe("text");
    expect(blockA.text).toContain("<leaves>");
    expect(blockA.cache_control).toEqual({ type: "ephemeral" });

    expect(blockB.type).toBe("text");
    expect(blockB.text).toContain("<current_message>alice?</current_message>");
    expect(blockB.text).toContain("<recent_context>");
    expect(blockB.cache_control).toBeUndefined();
  });

  test("system prompt mentions register (locks the routing commitment)", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await routeL1(makeTurn("x"), makeTree());
    expect(providerCalls[0].options?.systemPrompt).toMatch(/register/);
  });
});

describe("renderLeafBlock — cache invariant", () => {
  test("is byte-identical across two calls with different queries", async () => {
    const tree = makeTree();
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));

    await routeL1(makeTurn("first query about alice"), tree);
    await routeL1(makeTurn("totally different query about atlas"), tree);

    const prefixA = (
      providerCalls[0].messages[0].content[0] as { text: string }
    ).text;
    const prefixB = (
      providerCalls[1].messages[0].content[0] as { text: string }
    ).text;
    expect(prefixA).toBe(prefixB);
    // And it equals the pure renderer's output.
    expect(prefixA).toBe(renderLeafBlock(tree));
  });

  test("renders leaves sorted by path with 1-based numbering", () => {
    const block = renderLeafBlock(makeTree());
    expect(block).toContain("[1] people/alice — ");
    expect(block).toContain("[2] people/bob — ");
    expect(block).toContain("[3] projects/atlas — ");
  });
});
