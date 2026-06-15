/**
 * Tests for `pool-select.ts` — the single forced-tool selector over the
 * two-segment candidate pool (stable-prefix cards + dynamic finder tail).
 *
 * Coverage matrix:
 *   - Segment ordering: the stable prefix (full cards, `[1]…[m]`) renders as
 *     its own content block carrying the `cache_control` breakpoint; the
 *     dynamic tail (finder lines `[m+1]…` + per-turn context) follows in an
 *     un-cached block.
 *   - Numbering stability: for identical stable lanes the rendered prefix
 *     block is byte-identical across renders; only the tail varies.
 *   - Returned IDs map over the CONCATENATED numbering, with `pinned` driven
 *     by `pinned_ids`; out-of-range IDs dropped; selections deduped by slug
 *     (a page can appear as both a card and a finder line; pinned flags OR).
 *   - Omitted `ids` → keep ALL candidates (recall-safe, slug-deduped).
 *   - Explicit `ids: []` → keep none (deliberate abstention) — a normal result.
 *   - Empty candidate pool → keep none (nothing to select).
 *   - Finder snippets are whitespace-collapsed and truncated (~300 chars).
 *   - No provider / missing tool_use / schema mismatch / provider throw → throw
 *     MemoryV3RetrievalUnavailableError (an INFRA failure, deliberately DISTINCT
 *     from a deliberate empty selection), the last three after a re-prompt retry.
 *   - One forced-tool `select_pages` call on the v3 L2 call site with
 *     `disableTurnStartCache` (the tail varies per turn — the provider's
 *     auto-anchor would never hit).
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

const { selectPool, MemoryV3RetrievalUnavailableError } =
  await import("../pool-select.js");
type SelectorPool = Parameters<typeof selectPool>[0];

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

const CARD_A =
  "# memory/concepts/page-a.md\nlead for page a\n\n[sections: §Alpha · §Beta]";
const CARD_B = "# memory/concepts/page-b.md\nlead for page b";

/** Two stable-prefix cards (`[1] page-a`, `[2] page-b`) and two finder lines
 * (`[3] topic-x`, `[4] page-a` — a finder hit on a stable-prefix page). */
function makePool(): SelectorPool {
  return {
    stable: [
      { slug: "page-a", card: CARD_A },
      { slug: "page-b", card: CARD_B },
    ],
    finder: [
      { slug: "topic-x", descriptor: "section: about topic x" },
      { slug: "page-a", descriptor: "section: the alpha rollout plan" },
    ],
  };
}

function makeTurn(currentMessage: string): MemoryRoutingTurn {
  return {
    conversationId: "conv-xyz",
    turnNumber: 1,
    currentMessage,
    recentContext: "earlier we talked about the timeline",
  };
}

interface RenderedBlock {
  type: string;
  text: string;
  cache_control?: { type: string; ttl?: string };
}

function sentBlocks(callIndex = 0): RenderedBlock[] {
  return providerCalls[callIndex]!.messages[0]!
    .content as unknown as RenderedBlock[];
}

beforeEach(() => {
  providerStub = null;
  providerCalls.length = 0;
});

// ---------------------------------------------------------------------------
// selectPool — id mapping over the concatenated numbering.
// ---------------------------------------------------------------------------

describe("selectPool — id mapping", () => {
  test("IDs map over cards then finder lines, pinned driven by pinned_ids", async () => {
    providerStub = makeProvider(
      toolUseResponse({ ids: [3, 1], pinned_ids: [1] }),
    );
    const result = await selectPool(makePool(), makeTurn("how's the rollout?"));
    expect(result).toEqual([
      { slug: "topic-x", pinned: false },
      { slug: "page-a", pinned: true },
    ]);
  });

  test("a page selected as both card and finder line dedupes to one slug, pinned ORed", async () => {
    // page-a is id 1 (card) AND id 4 (finder line); pinned only via the
    // finder-line id.
    providerStub = makeProvider(
      toolUseResponse({ ids: [1, 4], pinned_ids: [4] }),
    );
    const result = await selectPool(makePool(), makeTurn("the alpha plan"));
    expect(result).toEqual([{ slug: "page-a", pinned: true }]);
  });

  test("omitted ids keeps ALL candidates, deduped by slug (recall-safe)", async () => {
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
    const result = await selectPool({ stable: [], finder: [] }, makeTurn("hi"));
    expect(result).toEqual([]);
    expect(providerCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// selectPool — infrastructure failures THROW (no silent degradation). A
// deliberate empty selection and an empty pool (covered above) still return
// normally; only a genuine infra failure throws so the LIVE injector can
// hard-fail the turn instead of shipping it with no memory.
// ---------------------------------------------------------------------------

describe("selectPool — infrastructure failures throw", () => {
  test("no provider → throws without calling the provider", async () => {
    providerStub = null;
    await expect(selectPool(makePool(), makeTurn("x"))).rejects.toThrow(
      MemoryV3RetrievalUnavailableError,
    );
    expect(providerCalls).toHaveLength(0);
  });

  test("missing tool_use → throws after retrying", async () => {
    providerStub = makeProvider(noToolResponse());
    await expect(selectPool(makePool(), makeTurn("x"))).rejects.toThrow(
      MemoryV3RetrievalUnavailableError,
    );
    expect(providerCalls).toHaveLength(3);
  });

  test("schema mismatch → throws after retrying", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: "not-an-array" }));
    await expect(selectPool(makePool(), makeTurn("x"))).rejects.toThrow(
      MemoryV3RetrievalUnavailableError,
    );
    expect(providerCalls).toHaveLength(3);
  });

  test("provider throw → throws after retrying", async () => {
    providerStub = makeThrowingProvider();
    await expect(selectPool(makePool(), makeTurn("x"))).rejects.toThrow(
      MemoryV3RetrievalUnavailableError,
    );
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
// selectPool — request shape: stable-prefix cards block with the cache
// breakpoint, dynamic tail block without.
// ---------------------------------------------------------------------------

describe("selectPool — request shape", () => {
  test("forces tool_choice to select_pages on the v3 L2 call site with disableTurnStartCache", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), makeTurn("rollout?"));

    expect(providerCalls).toHaveLength(1);
    const [call] = providerCalls;
    const cfg = call.options?.config as Record<string, unknown>;
    expect(cfg?.callSite).toBe("memoryV3SelectL2");
    expect(cfg?.tool_choice).toEqual({ type: "tool", name: "select_pages" });
    expect(cfg?.disableTurnStartCache).toBe(true);
    expect(call.options?.tools?.[0]?.name).toBe("select_pages");
  });

  test("stable prefix renders full cards in its own block carrying cache_control", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), makeTurn("rollout?"));

    const blocks = sentBlocks();
    expect(blocks).toHaveLength(2);

    const [prefix, tail] = blocks;
    expect(prefix.type).toBe("text");
    // FULL cards, numbered in pool order, inside the cards segment.
    expect(prefix.text).toContain(`[1] ${CARD_A}`);
    expect(prefix.text).toContain(`[2] ${CARD_B}`);
    expect(prefix.text.startsWith("<candidate_cards>\n")).toBe(true);
    expect(prefix.text.endsWith("\n</candidate_cards>")).toBe(true);
    // The breakpoint rides THIS block (preserved by toAnthropicBlockSafe).
    expect(prefix.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // The tail continues the numbering after the cards and is NOT cached.
    expect(tail.type).toBe("text");
    expect(tail.text).toContain("[3] topic-x — section: about topic x");
    expect(tail.text).toContain("[4] page-a — section: the alpha rollout plan");
    expect(tail.text).toContain("<current_message>rollout?</current_message>");
    expect(tail.text).toContain("<recent_context>");
    expect(tail.cache_control).toBeUndefined();
    // No cards leak into the tail.
    expect(tail.text).not.toContain("<candidate_cards>");
  });

  test("finder lines render the surfacing lane tag when one is supplied", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    const pool = makePool();
    pool.finder = [
      { slug: "topic-x", descriptor: "section: about topic x", lane: "needle" },
      { slug: "page-a", descriptor: "", lane: "learned" },
    ];
    await selectPool(pool, makeTurn("rollout?"));

    const [, tail] = sentBlocks();
    expect(tail.text).toContain(
      "[3] (needle) topic-x — section: about topic x",
    );
    // Empty descriptor: lane tag still renders, dash omitted.
    expect(tail.text).toContain("[4] (learned) page-a");
  });

  test("the rendered prefix is byte-identical across turns; only the tail varies", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), makeTurn("first question"));

    // Same stable lanes, different finder hits + message (a new turn).
    const pool2 = makePool();
    pool2.finder = [{ slug: "page-c", descriptor: "section: something else" }];
    await selectPool(pool2, makeTurn("second question"));

    const [prefix1, tail1] = sentBlocks(0);
    const [prefix2, tail2] = sentBlocks(1);
    expect(prefix2.text).toBe(prefix1.text);
    expect(prefix2.cache_control).toEqual(prefix1.cache_control!);
    expect(tail2.text).not.toBe(tail1.text);
  });

  test("an empty stable prefix renders a single un-cached block", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(
      { stable: [], finder: [{ slug: "page-a", descriptor: "d" }] },
      makeTurn("x"),
    );
    const blocks = sentBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("[1] page-a — d");
    expect(blocks[0].cache_control).toBeUndefined();
  });

  test("long finder snippets are whitespace-collapsed and truncated (~300 chars)", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    const longDescriptor = `padded   ${"z".repeat(1000)}`;
    await selectPool(
      { stable: [], finder: [{ slug: "page-a", descriptor: longDescriptor }] },
      makeTurn("x"),
    );
    const [block] = sentBlocks();
    const line = block.text
      .split("\n")
      .find((l) => l.startsWith("[1] page-a — "))!;
    expect(line).toContain("...");
    expect(line).not.toContain("z".repeat(1000));
    // snippet cap (300) + the `[1] page-a — ` prefix.
    expect(line.length).toBeLessThanOrEqual(300 + "[1] page-a — ".length);
  });

  test("a finder candidate with an empty descriptor renders without a dangling dash", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(
      { stable: [], finder: [{ slug: "page-a", descriptor: "   " }] },
      makeTurn("x"),
    );
    const [block] = sentBlocks();
    expect(block.text).toContain("[1] page-a\n");
    expect(block.text).not.toContain("[1] page-a — ");
  });

  test("situational context renders in the tail when present", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), {
      ...makeTurn("rollout?"),
      situationalContext: "Today is Saturday. The launch is today.",
    });
    const blocks = sentBlocks();
    expect(blocks[1].text).toContain(
      "<situation>Today is Saturday. The launch is today.</situation>",
    );
  });

  test("system prompt is carry-aware and generous (persistence + pinned + no limit)", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), makeTurn("x"));
    const prompt = providerCalls[0].options?.systemPrompt ?? "";
    // Carry-aware: previously selected pages persist automatically.
    expect(prompt).toMatch(/persist/);
    // Generous: explicitly no selection limit.
    expect(prompt).toMatch(/no limit/i);
    // Pinning commitment.
    expect(prompt).toMatch(/pinned/);
  });
});
