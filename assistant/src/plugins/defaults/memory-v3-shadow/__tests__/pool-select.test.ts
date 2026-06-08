/**
 * Tests for `pool-select.ts` — the single forced-tool selector over the unified
 * candidate pool.
 *
 * Coverage matrix:
 *   - Numbered candidates render with their descriptors (truncated).
 *   - Returned IDs map to the right candidate slugs by 1-based index, with
 *     `pinned` driven by `pinned_ids`.
 *   - Omitted `ids` → keep ALL candidates (recall-safe).
 *   - Explicit `ids: []` → keep none (deliberate abstention).
 *   - Out-of-range / duplicate IDs ignored without throwing.
 *   - No provider / missing tool_use / schema mismatch / throw → keep none
 *     (degrade to deterministic lanes), the last three after a re-prompt retry.
 *   - One forced-tool `select_pages` call on the v3 L2 call site, with NO cache
 *     breakpoint (the pool is dynamic per turn).
 *
 * The provider is stubbed so no network calls fire; mirrors selector.test.ts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolUseContent,
} from "../../../../providers/types.js";
import type { MemoryRoutingTurn } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks installed BEFORE the pool-select import so the module observes them at
// load time.
// ---------------------------------------------------------------------------

let providerStub: Provider | null = null;

interface ProviderCall {
  messages: Message[];
  options: SendMessageOptions | undefined;
}
const providerCalls: ProviderCall[] = [];

mock.module("../../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => providerStub,
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b): b is ToolUseContent => b.type === "tool_use"),
}));

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => (prop === "child" ? () => ({}) : () => {}),
    }),
}));

const { selectPool } = await import("../pool-select.js");
type PoolCandidate = Parameters<typeof selectPool>[0][number];

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

/** A 200 response that carries no tool_use — the malformed-but-successful case
 * the re-prompt retry exists to recover from. */
function noToolResponse(): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [{ type: "text", text: "no tool call" }],
  };
}

/** Provider returning a different response per call (the i-th call returns
 * responses[i], or the last entry once exhausted). */
function makeSequenceProvider(responses: ProviderResponse[]): Provider {
  let i = 0;
  return {
    name: "sequence",
    sendMessage: async (messages, options) => {
      providerCalls.push({ messages, options });
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    },
  };
}

/** Provider that records each call and then throws — the throw-after-retries
 * path (the provider's own RetryProvider has already exhausted its backoff). */
function makeThrowingProvider(): Provider {
  return {
    name: "throwing",
    sendMessage: async (messages, options) => {
      providerCalls.push({ messages, options });
      throw new Error("boom");
    },
  };
}

function makePool(): PoolCandidate[] {
  return [
    { slug: "page-a", descriptor: "section: the alpha rollout plan" },
    { slug: "page-b", descriptor: "section: beta metrics dashboard" },
    { slug: "topic-x", descriptor: "linked page about topic x" },
  ];
}

function makeTurn(currentMessage: string): MemoryRoutingTurn {
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
// selectPool — id mapping.
// ---------------------------------------------------------------------------

describe("selectPool — id mapping", () => {
  test("returned IDs map to candidate slugs, pinned driven by pinned_ids", async () => {
    providerStub = makeProvider(
      toolUseResponse({ ids: [3, 1], pinned_ids: [1] }),
    );
    const result = await selectPool(makePool(), makeTurn("how's the rollout?"));
    expect(result).toEqual([
      { slug: "topic-x", pinned: false },
      { slug: "page-a", pinned: true },
    ]);
  });

  test("omitted ids keeps ALL candidates (recall-safe)", async () => {
    providerStub = makeProvider(toolUseResponse({}));
    const result = await selectPool(makePool(), makeTurn("anything"));
    expect(result).toEqual([
      { slug: "page-a", pinned: false },
      { slug: "page-b", pinned: false },
      { slug: "topic-x", pinned: false },
    ]);
  });

  test("explicit empty ids keeps no candidates (abstention)", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    const result = await selectPool(makePool(), makeTurn("nothing relevant"));
    expect(result).toEqual([]);
  });

  test("out-of-range and duplicate IDs are ignored without throwing", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [2, 99, 0, -1, 2] }));
    const result = await selectPool(makePool(), makeTurn("the metrics"));
    expect(result).toEqual([{ slug: "page-b", pinned: false }]);
  });

  test("empty pool returns no pages and never calls the provider", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    const result = await selectPool([], makeTurn("hi"));
    expect(result).toEqual([]);
    expect(providerCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// selectPool — recall-safe fallbacks.
// ---------------------------------------------------------------------------

describe("selectPool — degradation on failure", () => {
  test("no provider → no pages, without calling the provider", async () => {
    providerStub = null;
    const result = await selectPool(makePool(), makeTurn("x"));
    expect(result).toEqual([]);
    expect(providerCalls).toHaveLength(0);
  });

  test("missing tool_use → no pages after retrying", async () => {
    providerStub = makeProvider(noToolResponse());
    const result = await selectPool(makePool(), makeTurn("x"));
    expect(result).toEqual([]);
    expect(providerCalls).toHaveLength(3);
  });

  test("schema mismatch → no pages after retrying", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: "not-an-array" }));
    const result = await selectPool(makePool(), makeTurn("x"));
    expect(result).toEqual([]);
    expect(providerCalls).toHaveLength(3);
  });

  test("provider throw → no pages after retrying", async () => {
    providerStub = makeThrowingProvider();
    const result = await selectPool(makePool(), makeTurn("x"));
    expect(result).toEqual([]);
    expect(providerCalls).toHaveLength(3);
  });

  test("a malformed response that recovers on retry returns its pages", async () => {
    providerStub = makeSequenceProvider([
      noToolResponse(),
      toolUseResponse({ ids: [2] }),
    ]);
    const result = await selectPool(makePool(), makeTurn("the metrics"));
    expect(result).toEqual([{ slug: "page-b", pinned: false }]);
    expect(providerCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// selectPool — request shape (no cache breakpoint; pool is dynamic per turn).
// ---------------------------------------------------------------------------

describe("selectPool — request shape", () => {
  test("forces tool_choice to select_pages with the v3 L2 call site", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), makeTurn("rollout?"));

    expect(providerCalls).toHaveLength(1);
    const [call] = providerCalls;
    const cfg = call.options?.config as Record<string, unknown>;
    expect(cfg?.callSite).toBe("memoryV3SelectL2");
    expect(cfg?.tool_choice).toEqual({ type: "tool", name: "select_pages" });
    expect(call.options?.tools?.[0]?.name).toBe("select_pages");
  });

  test("renders numbered candidates with descriptors and NO cache breakpoint", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), makeTurn("rollout?"));

    const content = providerCalls[0].messages[0].content as Array<{
      type: string;
      text: string;
      cache_control?: unknown;
    }>;
    // A single text block — the dynamic pool has no static prefix to cache.
    expect(content).toHaveLength(1);
    const [block] = content;
    expect(block.type).toBe("text");
    expect(block.text).toContain(
      "[1] page-a — section: the alpha rollout plan",
    );
    expect(block.text).toContain(
      "[2] page-b — section: beta metrics dashboard",
    );
    expect(block.text).toContain("[3] topic-x — linked page about topic x");
    expect(block.text).toContain("<current_message>rollout?</current_message>");
    expect(block.text).toContain("<recent_context>");
    expect(block.cache_control).toBeUndefined();
  });

  test("long descriptors are truncated in the candidate list", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    const longDescriptor = "z".repeat(1000);
    await selectPool(
      [{ slug: "page-a", descriptor: longDescriptor }],
      makeTurn("x"),
    );
    const text = (providerCalls[0].messages[0].content[0] as { text: string })
      .text;
    expect(text).toContain("...");
    expect(text).not.toContain("z".repeat(1000));
  });

  test("situational context renders in the user message when present", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), {
      ...makeTurn("rollout?"),
      situationalContext: "Today is Saturday. The launch is today.",
    });
    const text = (providerCalls[0].messages[0].content[0] as { text: string })
      .text;
    expect(text).toContain(
      "<situation>Today is Saturday. The launch is today.</situation>",
    );
  });

  test("system prompt mentions pinned (locks the pinning commitment)", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), makeTurn("x"));
    expect(providerCalls[0].options?.systemPrompt).toMatch(/pinned/);
  });
});
