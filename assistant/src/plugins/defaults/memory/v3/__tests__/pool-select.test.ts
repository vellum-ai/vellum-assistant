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
 *   - Returned IDs map over the CONCATENATED numbering; out-of-range IDs and
 *     unknown input keys are ignored; selections merge per slug (a page can
 *     appear as a card and on several finder lines), each carrying the
 *     sections of its selected finder lines.
 *   - Omitted `ids` → keep ALL candidates (recall-safe, merged per slug).
 *   - A finder line with a section and contributing terms renders a
 *     keyword-in-context window under its heading; otherwise the head snippet.
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

import { createRequire } from "node:module";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "@vellumai/plugin-api";

import {
  estimatePromptTokensWithTools,
  estimateTextTokens,
} from "../../../../../context/token-estimator.js";
import { OpenRouterProvider } from "../../../../../providers/openrouter/client.js";
import { ProviderError } from "../../../../../util/errors.js";
import { stripOrphanedSurrogates } from "../../../../../util/unicode.js";
import { sectionHeadLine } from "../sections.js";
import type { MemoryRoutingTurn, Section } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks installed BEFORE the pool-select import so the module observes them at
// load time.
// ---------------------------------------------------------------------------

let providerStub: Provider | null = null;
let selectorContextMockActive = false;
let selectorMaxInputTokens = 200_000;
const registryReal = {
  ...(createRequire(import.meta.url)(
    "../../../../../providers/registry.js",
  ) as Record<string, unknown>),
};

interface ProviderCall {
  messages: Message[];
  options: SendMessageOptions | undefined;
}
const providerCalls: ProviderCall[] = [];
const warnCalls: Array<{ args: unknown[] }> = [];

const realPluginApi = await import("@vellumai/plugin-api");
mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  getConfiguredProvider: async () => providerStub,
  getEffectiveContextWindow: (
    ...args: Parameters<typeof realPluginApi.getEffectiveContextWindow>
  ) =>
    selectorContextMockActive
      ? {
          provider: providerStub?.name ?? "stub",
          model: providerStub?.defaultModel ?? "stub-model",
          maxInputTokens: selectorMaxInputTokens,
        }
      : realPluginApi.getEffectiveContextWindow(...args),
}));

mock.module("../../../../../providers/registry.js", () => ({
  ...registryReal,
  getProviderRoutingSource: (providerName: string) =>
    providerName === "managed" ? "managed-proxy" : "user-key",
}));

mock.module("../../../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: (...args: unknown[]) => warnCalls.push({ args }),
    child: () => ({
      info: () => {},
      warn: (...args: unknown[]) => warnCalls.push({ args }),
    }),
  }),
}));

const {
  selectPool,
  MemoryV3RetrievalUnavailableError,
  TYPE_SAFE_POOL_KEEP_NOUL,
} = await import("../pool-select.js");
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
    rawRequest: { model: "MiniMaxAI/MiniMax-M3" },
    rawResponse: { model: "accounts/fireworks/models/minimax-m3" },
    content: [{ type: "text", text: "no tool call" }],
  };
}

function wrongToolResponse(): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [{ type: "tool_use", id: "tu-1", name: "wrong_tool", input: {} }],
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
function makeThrowingProvider(message = "boom"): Provider {
  return {
    name: "throwing",
    sendMessage: async (messages, options) => {
      providerCalls.push({ messages, options });
      throw new Error(message);
    },
  };
}

const CARD_A =
  "# memory/concepts/page-a.md\nlead for page a\n\n[sections: §Alpha · §Beta]";
const CARD_B = "# memory/concepts/page-b.md\nlead for page b";

/** Two stable-prefix cards (`[1] page-a`, `[2] page-b`) and two finder lines
 * (`[3] topic-x`, `[4] page-a`, with the latter also in the prefix). */
function makePool(): SelectorPool {
  return {
    stable: [
      { slug: "page-a", card: CARD_A, lane: "core" },
      { slug: "page-b", card: CARD_B, lane: "hot" },
    ],
    finder: [
      {
        slug: "topic-x",
        descriptor: "section: about topic x",
        lane: "needle",
      },
      {
        slug: "page-a",
        descriptor: "section: the alpha rollout plan",
        lane: "dense",
      },
    ],
  };
}

/** A section as the section index would build it: synthetic head line plus
 *  body (the lead, titled `""`, is ordinal 0). */
function sectionOf(slug: string, title: string, body: string): Section {
  return {
    article: slug,
    title,
    text: `${sectionHeadLine(slug, title)}\n${body}`,
    ordinal: title === "" ? 0 : 1,
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

function warnPayloads(): Array<Record<string, unknown>> {
  return warnCalls
    .map((call) => call.args[0])
    .filter(
      (payload): payload is Record<string, unknown> =>
        payload !== null && typeof payload === "object",
    );
}

beforeEach(() => {
  providerStub = null;
  selectorContextMockActive = true;
  selectorMaxInputTokens = 200_000;
  providerCalls.length = 0;
  warnCalls.length = 0;
});

afterAll(() => {
  selectorContextMockActive = false;
});

// ---------------------------------------------------------------------------
// selectPool — id mapping over the concatenated numbering.
// ---------------------------------------------------------------------------

describe("selectPool — id mapping", () => {
  test("IDs map over cards then finder lines in selection order", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [3, 1] }));
    const result = await selectPool(makePool(), makeTurn("how's the rollout?"));
    expect(result.pages).toEqual([
      { slug: "topic-x", sections: [] },
      { slug: "page-a", sections: [] },
    ]);
    expect(result.keptAll).toBe(false);
  });

  test("a page selected as both card and finder line dedupes to one slug", async () => {
    // page-a is id 1 (card) AND id 4 (finder line).
    providerStub = makeProvider(toolUseResponse({ ids: [1, 4] }));
    const result = await selectPool(makePool(), makeTurn("the alpha plan"));
    expect(result.pages).toEqual([{ slug: "page-a", sections: [] }]);
    expect(result.keptAll).toBe(false);
  });

  test("unknown input keys are ignored and ids still selects", async () => {
    // The input schema is non-strict: a stray key alongside `ids` (e.g. one a
    // prompt override still asks the model for) neither fails parsing nor
    // changes the selection.
    providerStub = makeProvider(toolUseResponse({ ids: [2], extra_ids: [1] }));
    const result = await selectPool(makePool(), makeTurn("the metrics"));
    expect(result.pages).toEqual([{ slug: "page-b", sections: [] }]);
    expect(result.keptAll).toBe(false);
  });

  test("omitted ids keeps ALL candidates, deduped by slug (recall-safe), flags keptAll", async () => {
    providerStub = makeProvider(toolUseResponse({}));
    const result = await selectPool(makePool(), makeTurn("anything"));
    expect(result.pages).toEqual([
      { slug: "page-a", sections: [] },
      { slug: "page-b", sections: [] },
      { slug: "topic-x", sections: [] },
    ]);
    // The fallback fired — the model gave up judging, not "selected everything".
    expect(result.keptAll).toBe(true);
  });

  test("explicit empty ids keeps no candidates (abstention), not keptAll", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    const result = await selectPool(makePool(), makeTurn("nothing relevant"));
    expect(result.pages).toEqual([]);
    // An explicit [] is a judgment, not the recall-safe fallback.
    expect(result.keptAll).toBe(false);
  });

  test("out-of-range and duplicate IDs are ignored without throwing", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [2, 99, 0, -1, 2] }));
    const result = await selectPool(makePool(), makeTurn("the metrics"));
    expect(result.pages).toEqual([{ slug: "page-b", sections: [] }]);
    expect(result.keptAll).toBe(false);
  });

  test("empty pool returns no pages and never calls the provider", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    const result = await selectPool({ stable: [], finder: [] }, makeTurn("hi"));
    expect(result.pages).toEqual([]);
    expect(result.keptAll).toBe(false);
    expect(providerCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// selectPool — infrastructure failures THROW. A deliberate empty selection and
// an empty pool (covered above) still return normally; only a genuine infra
// failure throws so callers can log it distinctly from an empty selection.
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
    const payloads = warnPayloads();
    const attemptPayloads = payloads.filter(
      (payload) => payload.reason === "missing_tool_use",
    );
    expect(attemptPayloads).toHaveLength(3);
    expect(attemptPayloads[0]).toMatchObject({
      attempt: 1,
      reason: "missing_tool_use",
      providerName: "stub",
      candidateCount: 4,
      stableCount: 2,
      finderCount: 2,
      response: {
        model: "stub-model",
        stopReason: "end_turn",
        requestModel: "MiniMaxAI/MiniMax-M3",
        responseModel: "accounts/fireworks/models/minimax-m3",
        contentBlockTypes: ["text"],
        toolUseNames: [],
      },
    });
    const aggregatePayload = payloads.find((payload) =>
      Array.isArray(payload.failures),
    );
    expect(aggregatePayload?.providerName).toBe("stub");
    const failures = aggregatePayload?.failures as
      | Array<Record<string, unknown>>
      | undefined;
    expect(failures?.[0]).toMatchObject({ reason: "missing_tool_use" });
  });

  test("wrong tool_use name logs the unexpected name before throwing", async () => {
    providerStub = makeProvider(wrongToolResponse());
    await expect(selectPool(makePool(), makeTurn("x"))).rejects.toThrow(
      MemoryV3RetrievalUnavailableError,
    );
    expect(providerCalls).toHaveLength(3);
    expect(
      warnPayloads().filter(
        (payload) => payload.reason === "unexpected_tool_name",
      ),
    ).toEqual([
      expect.objectContaining({
        attempt: 1,
        reason: "unexpected_tool_name",
        providerName: "stub",
        toolName: "wrong_tool",
        response: expect.objectContaining({
          stopReason: "tool_use",
          contentBlockTypes: ["tool_use"],
          toolUseNames: ["wrong_tool"],
        }),
      }),
      expect.objectContaining({ attempt: 2 }),
      expect.objectContaining({ attempt: 3 }),
    ]);
  });

  test("schema mismatch → throws after retrying", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: "not-an-array" }));
    await expect(selectPool(makePool(), makeTurn("x"))).rejects.toThrow(
      MemoryV3RetrievalUnavailableError,
    );
    expect(providerCalls).toHaveLength(3);
    expect(
      warnPayloads().filter((payload) => payload.reason === "schema_mismatch"),
    ).toEqual([
      expect.objectContaining({
        attempt: 1,
        reason: "schema_mismatch",
        schemaIssues: [expect.objectContaining({ path: "ids" })],
      }),
      expect.objectContaining({ attempt: 2 }),
      expect.objectContaining({ attempt: 3 }),
    ]);
  });

  test("provider throw → throws after retrying", async () => {
    providerStub = makeThrowingProvider();
    await expect(selectPool(makePool(), makeTurn("x"))).rejects.toThrow(
      MemoryV3RetrievalUnavailableError,
    );
    expect(providerCalls).toHaveLength(3);
    expect(
      warnPayloads().filter((payload) => payload.reason === "provider_error"),
    ).toEqual([
      expect.objectContaining({
        attempt: 1,
        reason: "provider_error",
        providerName: "throwing",
        error: { name: "Error", message: "boom" },
      }),
      expect.objectContaining({ attempt: 2 }),
      expect.objectContaining({ attempt: 3 }),
    ]);
  });

  test("provider failure carries the exact budgeted pool and turn", async () => {
    selectorMaxInputTokens = 8_000;
    const pool: SelectorPool = {
      stable: Array.from({ length: 20 }, (_, index) => ({
        slug: `stable-${index}`,
        card: `stable card ${index} ${"x".repeat(4_000)}`,
        lane: index === 0 ? ("core" as const) : ("hot" as const),
      })),
      finder: [
        {
          slug: "finder-learned",
          descriptor: "learned association",
          lane: "learned",
        },
        {
          slug: "finder-needle",
          descriptor: "direct lexical hit",
          lane: "needle",
        },
      ],
    };
    const turn = {
      ...makeTurn("preserve this current message"),
      recentContext: `${"r".repeat(40_000)}RECENT-END`,
      situationalContext: `old situation ${"s".repeat(20_000)}`,
    };
    providerStub = makeThrowingProvider();

    let caught: unknown;
    try {
      await selectPool(pool, turn);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MemoryV3RetrievalUnavailableError);
    const failure = caught as InstanceType<
      typeof MemoryV3RetrievalUnavailableError
    >;
    expect(failure.pool?.stable[0]?.slug).toBe("stable-0");
    expect(
      (failure.pool?.stable.length ?? 0) + (failure.pool?.finder.length ?? 0),
    ).toBeLessThan(pool.stable.length + pool.finder.length);
    expect(
      failure.pool?.finder.map((candidate) => candidate.slug),
    ).not.toContain("finder-learned");
    expect(failure.turn?.currentMessage).toBe("preserve this current message");
    expect(failure.turn?.recentContext).toEndWith("RECENT-END");
    expect(failure.turn?.recentContext.length).toBeLessThan(
      turn.recentContext.length,
    );
    expect(failure.turn?.situationalContext).toBeUndefined();
  });

  test("throws without sending when no candidate can fit the context budget", async () => {
    selectorMaxInputTokens = 8_000;
    const pool: SelectorPool = {
      stable: [
        {
          slug: "oversized-core",
          card: `oversized core ${"x".repeat(40_000)}`,
          lane: "core",
        },
      ],
      finder: [],
    };
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));

    let caught: unknown;
    try {
      await selectPool(pool, makeTurn("anything"));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MemoryV3RetrievalUnavailableError);
    expect((caught as Error).message).toBe(
      "memory-v3 pool selector has no candidate that fits the context budget",
    );
    expect(providerCalls).toHaveLength(0);
    const failure = caught as InstanceType<
      typeof MemoryV3RetrievalUnavailableError
    >;
    expect(failure.pool).toEqual({ stable: [], finder: [] });
    expect(failure.turn?.currentMessage).toBe("anything");
    expect(failure.turn?.recentContext).toBe("");
  });

  test("managed provider 402 attaches a non-terminal credits notice", async () => {
    providerStub = {
      name: "managed",
      sendMessage: async (messages, options) => {
        providerCalls.push({ messages, options });
        throw new ProviderError(
          "Together AI API error (402): 402 status code (no body)",
          "managed",
          402,
        );
      },
    };
    let caught: unknown;
    try {
      await selectPool(makePool(), makeTurn("x"));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MemoryV3RetrievalUnavailableError);
    const notice = (
      caught as InstanceType<typeof MemoryV3RetrievalUnavailableError>
    ).conversationNotice;
    expect(notice).toEqual({
      source: "memory_v3",
      code: "PROVIDER_BILLING",
      userMessage:
        "You're out of credits. Add credits in Settings → Billing to continue.",
      errorCategory: "credits_exhausted",
    });
  });

  test("provider throw redacts sensitive message details in diagnostics", async () => {
    const providerSecret = ["sk-proj-", "a".repeat(40)].join("");
    const message = `provider rejected Authorization: Bearer ${providerSecret}`;
    providerStub = makeThrowingProvider(message);

    let thrown: unknown;
    try {
      await selectPool(makePool(), makeTurn("x"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MemoryV3RetrievalUnavailableError);
    expect((thrown as Error).message).not.toContain(providerSecret);
    expect((thrown as Error).message).toContain("[REDACTED]");

    const providerErrors = warnPayloads().filter(
      (payload) => payload.reason === "provider_error",
    );
    const error = providerErrors[0]?.error as
      | Record<string, unknown>
      | undefined;
    expect(error?.message).not.toContain(providerSecret);
    expect(error?.message).toContain("[REDACTED]");
  });

  test("a malformed response that recovers on retry returns its pages", async () => {
    providerStub = makeSequenceProvider([
      noToolResponse(),
      toolUseResponse({ ids: [2] }),
    ]);
    const result = await selectPool(makePool(), makeTurn("the metrics"));
    expect(result.pages).toEqual([{ slug: "page-b", sections: [] }]);
    expect(result.keptAll).toBe(false);
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
    expect(cfg?.selectionSeed).toBe("conv-xyz");
    expect(cfg?.tool_choice).toEqual({ type: "tool", name: "select_pages" });
    expect(cfg?.disableTurnStartCache).toBe(true);
    const tool = call.options?.tools?.[0];
    expect(tool?.name).toBe("select_pages");
    const inputSchema = tool?.input_schema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(inputSchema.properties ?? {})).toEqual(["ids"]);
  });

  test("keeps forced-tool requests within 80% of the resolved context window", async () => {
    selectorMaxInputTokens = 8_000;
    const oversizedPool: SelectorPool = {
      stable: Array.from({ length: 20 }, (_, index) => ({
        slug: `stable-${index}`,
        card: `stable card ${index} ${"x".repeat(4_000)}`,
        lane: index === 0 ? ("core" as const) : ("hot" as const),
      })),
      finder: [
        {
          slug: "finder-learned",
          descriptor: "learned association",
          lane: "learned",
        },
        { slug: "finder-edge", descriptor: "authored link", lane: "edge" },
        {
          slug: "finder-needle",
          descriptor: "direct lexical hit",
          lane: "needle",
        },
      ],
    };
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));

    const result = await selectPool(
      oversizedPool,
      makeTurn("preserve this generic current message"),
    );

    expect(providerCalls).toHaveLength(1);
    const call = providerCalls[0]!;
    const estimatedInputTokens = estimatePromptTokensWithTools(
      call.messages,
      call.options?.systemPrompt,
      call.options?.tools ?? [],
      providerStub.name,
    );
    expect(estimatedInputTokens).toBeLessThanOrEqual(6_400);
    const sent = JSON.stringify(call.messages);
    expect(sent).toContain("preserve this generic current message");
    expect(sent).toContain("stable card 0");
    expect(sent).toContain("finder-needle");
    expect(sent).not.toContain("finder-learned");
    expect(result.pool.stable[0]?.slug).toBe("stable-0");
    expect(result.pool.finder.map((candidate) => candidate.slug)).toContain(
      "finder-needle",
    );
    expect(result.pages[0]?.slug).toBe("stable-0");
  });

  test("skips a large core card that fits only by dropping the current message", async () => {
    selectorMaxInputTokens = 8_000;
    const currentMessage = `CURRENT-QUERY-${"q".repeat(8_000)}`;
    const pool: SelectorPool = {
      stable: [
        {
          slug: "query-erasing-core",
          card: `large core ${"x".repeat(20_000)}`,
          lane: "core",
        },
      ],
      finder: [
        {
          slug: "usable-needle",
          descriptor: "small direct hit",
          lane: "needle",
        },
      ],
    };
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));

    const result = await selectPool(pool, makeTurn(currentMessage));

    expect(providerCalls).toHaveLength(1);
    const sent = JSON.stringify(providerCalls[0]!.messages);
    expect(sent).toContain(currentMessage);
    expect(sent).not.toContain("query-erasing-core");
    expect(sent).toContain("usable-needle");
    expect(result.pool.stable).toEqual([]);
    expect(result.pool.finder.map((candidate) => candidate.slug)).toEqual([
      "usable-needle",
    ]);
    expect(result.turn.currentMessage).toBe(currentMessage);
    expect(result.pages).toEqual([{ slug: "usable-needle", sections: [] }]);
  });

  test("skips an individually oversized core card and still sends a smaller direct hit", async () => {
    selectorMaxInputTokens = 8_000;
    const pool: SelectorPool = {
      stable: [
        {
          slug: "oversized-core",
          card: `oversized core ${"x".repeat(40_000)}`,
          lane: "core",
        },
      ],
      finder: [
        {
          slug: "usable-needle",
          descriptor: "small direct hit",
          lane: "needle",
        },
      ],
    };
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));

    const result = await selectPool(pool, makeTurn("use the direct hit"));

    expect(providerCalls).toHaveLength(1);
    expect(JSON.stringify(providerCalls[0]!.messages)).not.toContain(
      "oversized-core",
    );
    expect(JSON.stringify(providerCalls[0]!.messages)).toContain(
      "usable-needle",
    );
    expect(result.pool).toEqual({
      stable: [],
      finder: [
        {
          slug: "usable-needle",
          descriptor: "small direct hit",
          lane: "needle",
        },
      ],
    });
    expect(result.pages).toEqual([{ slug: "usable-needle", sections: [] }]);
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
    expect(tail.text).toContain(
      "[3] (needle) topic-x \u2014 section: about topic x",
    );
    expect(tail.text).toContain(
      "[4] (dense) page-a \u2014 section: the alpha rollout plan",
    );
    expect(tail.text).toContain("<current_message>rollout?</current_message>");
    expect(tail.text).toContain("<recent_context>");
    expect(tail.cache_control).toBeUndefined();
    // No cards leak into the tail.
    expect(tail.text).not.toContain("<candidate_cards>");
  });

  test("finder lines render the surfacing lane tag", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    const pool = makePool();
    pool.finder = [
      { slug: "topic-x", descriptor: "section: about topic x", lane: "needle" },
      { slug: "page-a", descriptor: "", lane: "learned" },
    ];
    await selectPool(pool, makeTurn("rollout?"));

    const [, tail] = sentBlocks();
    expect(tail.text).toContain(
      "[3] (needle) topic-x \u2014 section: about topic x",
    );
    // Empty descriptor: lane tag still renders, dash omitted.
    expect(tail.text).toContain("[4] (learned) page-a");
  });

  test("the rendered prefix is byte-identical across turns; only the tail varies", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), makeTurn("first question"));

    // Same stable lanes, different finder hits + message (a new turn).
    const pool2 = makePool();
    pool2.finder = [
      {
        slug: "page-c",
        descriptor: "section: something else",
        lane: "needle",
      },
    ];
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
      {
        stable: [],
        finder: [{ slug: "page-a", descriptor: "d", lane: "needle" }],
      },
      makeTurn("x"),
    );
    const blocks = sentBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("[1] (needle) page-a \u2014 d");
    expect(blocks[0].cache_control).toBeUndefined();
  });

  test("long finder snippets are whitespace-collapsed and truncated (~300 chars)", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    const longDescriptor = `padded   ${"z".repeat(1000)}`;
    await selectPool(
      {
        stable: [],
        finder: [
          { slug: "page-a", descriptor: longDescriptor, lane: "needle" },
        ],
      },
      makeTurn("x"),
    );
    const [block] = sentBlocks();
    const line = block.text
      .split("\n")
      .find((l) => l.startsWith("[1] (needle) page-a \u2014 "))!;
    expect(line).toContain("...");
    expect(line).not.toContain("z".repeat(1000));
    // snippet cap (300) plus the numbered lane/slug prefix.
    expect(line.length).toBeLessThanOrEqual(
      300 + "[1] (needle) page-a \u2014 ".length,
    );
  });

  test("a finder candidate with an empty descriptor renders without a dangling dash", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(
      {
        stable: [],
        finder: [{ slug: "page-a", descriptor: "   ", lane: "needle" }],
      },
      makeTurn("x"),
    );
    const [block] = sentBlocks();
    expect(block.text).toContain("[1] (needle) page-a\n");
    expect(block.text).not.toContain("[1] (needle) page-a \u2014 ");
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

  test("system prompt is carry-aware and generous (persistence + no limit)", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    await selectPool(makePool(), makeTurn("x"));
    const prompt = providerCalls[0].options?.systemPrompt ?? "";
    // Carry-aware: previously selected pages persist automatically.
    expect(prompt).toMatch(/persist/);
    // Generous: explicitly no selection limit.
    expect(prompt).toMatch(/no limit/i);
  });
});

// ---------------------------------------------------------------------------
// selectPool sections: a finder line carries its matched section, selecting
// the line selects that section, and selections merge per slug; a line with a
// section and contributing terms renders a keyword-in-context snippet.
// ---------------------------------------------------------------------------

describe("selectPool: sections and keyword-in-context snippets", () => {
  const alpha = sectionOf(
    "page-a",
    "Alpha",
    "the alpha rollout plan in detail",
  );
  const beta = sectionOf("page-a", "Beta", "the beta metrics review");

  /** `makePool` with page-a on two finder lines: ids 1-2 are the cards, 3 is
   *  topic-x, 4 is page-a § Alpha, 5 is page-a § Beta. */
  function sectionedPool(): SelectorPool {
    const pool = makePool();
    pool.finder = [
      {
        slug: "topic-x",
        descriptor: "section: about topic x",
        lane: "needle",
      },
      {
        slug: "page-a",
        descriptor: alpha.text,
        section: alpha,
        terms: ["rollout"],
        lane: "needle",
      },
      {
        slug: "page-a",
        descriptor: beta.text,
        section: beta,
        terms: ["metrics"],
        lane: "dense",
      },
    ];
    return pool;
  }

  function finderOnly(candidate: SelectorPool["finder"][number]): SelectorPool {
    return { stable: [], finder: [candidate] };
  }

  test("selecting a page's card alone carries no section", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [1] }));
    const result = await selectPool(sectionedPool(), makeTurn("page a?"));
    expect(result.pages).toEqual([{ slug: "page-a", sections: [] }]);
  });

  test("selecting a finder line selects its section, merged with the page's card", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [4, 1] }));
    const result = await selectPool(
      sectionedPool(),
      makeTurn("the alpha plan"),
    );
    expect(result.pages).toEqual([{ slug: "page-a", sections: [alpha] }]);
  });

  test("two finder lines of one page merge into one selection carrying both sections in pool order", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [5, 3, 4, 5] }));
    const result = await selectPool(
      sectionedPool(),
      makeTurn("alpha and beta"),
    );
    // Pages keep the order they were first picked; a page's sections follow
    // the pool, not the id order.
    expect(result.pages).toEqual([
      { slug: "page-a", sections: [alpha, beta] },
      { slug: "topic-x", sections: [] },
    ]);
  });

  test("keeping every candidate merges each page's finder sections", async () => {
    providerStub = makeProvider(toolUseResponse({}));
    const result = await selectPool(sectionedPool(), makeTurn("anything"));
    expect(result.pages).toEqual([
      { slug: "page-a", sections: [alpha, beta] },
      { slug: "page-b", sections: [] },
      { slug: "topic-x", sections: [] },
    ]);
    expect(result.keptAll).toBe(true);
  });

  test("a line with a section and a contributing term renders a window around the term under its heading", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    const filler =
      "filler words that push the match well past the head of the section ";
    const deep = sectionOf(
      "page-a",
      "Rollout",
      `${filler.repeat(6)}the Turnip milestone slipped a week ${filler.repeat(3)}`,
    );
    await selectPool(
      finderOnly({
        slug: "page-a",
        descriptor: deep.text,
        section: deep,
        terms: ["absent", "turnip"],
        lane: "needle",
      }),
      makeTurn("turnip?"),
    );
    const [block] = sentBlocks();
    const line = block.text
      .split("\n")
      .find((l) => l.startsWith("[1] (needle) page-a "))!;
    // The first term that occurs in the body (not `absent`) centers the
    // window; the match is case-insensitive and the head line is not shown.
    expect(line).toContain("§Rollout: … ");
    expect(line).toContain("Turnip milestone");
    expect(line).not.toContain("page-a - Rollout");
    expect(line.endsWith(" …")).toBe(true);
    // The window itself stays at the snippet cap (plus its ellipses).
    const windowStart = line.indexOf("… ") + "… ".length;
    expect(line.length - windowStart).toBeLessThanOrEqual(300 + " …".length);
  });

  test("a line whose terms do not occur in the section body falls back to the head snippet", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    await selectPool(
      finderOnly({
        slug: "page-a",
        descriptor: alpha.text,
        section: alpha,
        terms: ["missing"],
        lane: "needle",
      }),
      makeTurn("x"),
    );
    const [block] = sentBlocks();
    const line = block.text
      .split("\n")
      .find((l) => l.startsWith("[1] (needle) page-a "))!;
    expect(
      line.endsWith("page-a - Alpha the alpha rollout plan in detail"),
    ).toBe(true);
    expect(line).not.toContain("§");
  });

  test("a lead section renders its window without a heading prefix", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    const lead = sectionOf(
      "page-a",
      "",
      "the lead mentions the rollout early on",
    );
    await selectPool(
      finderOnly({
        slug: "page-a",
        descriptor: lead.text,
        section: lead,
        terms: ["rollout"],
        lane: "needle",
      }),
      makeTurn("x"),
    );
    const [block] = sentBlocks();
    const line = block.text
      .split("\n")
      .find((l) => l.startsWith("[1] (needle) page-a "))!;
    expect(line.endsWith("the lead mentions the rollout early on")).toBe(true);
    expect(line).not.toContain("§");
    expect(line).not.toContain("…");
  });

  test("a rare-term line tags its lane with the word and centers the window on it", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    const filler =
      "filler words that push the match well past the head of the section ";
    const inventory = sectionOf(
      "sample-notes",
      "Inventory",
      `${filler.repeat(6)}the weekly turnip totals ${filler.repeat(3)}`,
    );
    await selectPool(
      finderOnly({
        slug: "sample-notes",
        descriptor: inventory.text,
        section: inventory,
        terms: ["turnip"],
        lane: "rare",
      }),
      makeTurn("the weekly report lists the turnip"),
    );
    const [block] = sentBlocks();
    const line = block.text
      .split("\n")
      .find((l) => l.startsWith("[1] (rare: turnip) sample-notes "))!;
    expect(line).toContain("§Inventory: … ");
    expect(line).toContain("weekly turnip totals");
    // The selector is told what the tag means.
    expect(providerCalls[0]!.options?.systemPrompt).toContain("(rare: word)");
  });

  test("a bigram term matches its two words across punctuation", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    const notes = sectionOf(
      "page-a",
      "Notes",
      "we said: weekly, turnip is the label",
    );
    await selectPool(
      finderOnly({
        slug: "page-a",
        descriptor: notes.text,
        section: notes,
        terms: ["weekly_turnip"],
        lane: "needle",
      }),
      makeTurn("x"),
    );
    const [block] = sentBlocks();
    const line = block.text
      .split("\n")
      .find((l) => l.startsWith("[1] (needle) page-a "))!;
    expect(line.endsWith("§Notes: we said: weekly, turnip is the label")).toBe(
      true,
    );
  });
  test("a window whose edges land inside an emoji keeps both pairs whole and the request well-formed", async () => {
    providerStub = makeProvider(toolUseResponse({ ids: [] }));
    // 200 emoji (400 code units) on each side of the term, offset so that a
    // code-unit window centered on the term starts and ends mid-pair. A
    // window cut there carries half a pair on each edge, which strict
    // provider parsers reject once JSON.stringify escapes each orphan.
    const emoji = "😀".repeat(200);
    const body = `${emoji}y turnip  ${emoji}`;
    const term = body.indexOf("turnip");
    const naiveStart = term + 3 - 150;
    const naive = body.slice(naiveStart, naiveStart + 300);
    expect(stripOrphanedSurrogates(naive)).not.toBe(naive);
    const section = sectionOf("page-a", "Rollout", body);
    await selectPool(
      finderOnly({
        slug: "page-a",
        descriptor: section.text,
        section,
        terms: ["turnip"],
        lane: "needle",
      }),
      makeTurn("turnip?"),
    );
    const [block] = sentBlocks();
    expect(stripOrphanedSurrogates(block.text)).toBe(block.text);
    const line = block.text
      .split("\n")
      .find((l) => l.startsWith("[1] (needle) page-a "))!;
    expect(line).toContain("§Rollout: … ");
    expect(line).toContain("turnip");
    expect(line.endsWith(" …")).toBe(true);
    // The window stays bounded: at most one code unit shorter on each edge.
    const windowStart = line.indexOf("… ") + "… ".length;
    expect(line.length - windowStart).toBeLessThanOrEqual(300 + " …".length);
    expect(line.length - windowStart).toBeGreaterThanOrEqual(298 + " …".length);
  });
});

// ---------------------------------------------------------------------------
// selectPool: cataloged thinking and forced-tool compatibility.
// ---------------------------------------------------------------------------

describe("selectPool: cataloged thinking and forced-tool compatibility", () => {
  test("OpenRouter Kimi K2.6 omits the forced choice and yields a structured selection", async () => {
    // A real OpenAI chat-completions provider stands in for the cataloged
    // OpenRouter Kimi profile. The request succeeds without a reactive retry
    // because the forced select_pages choice is omitted before dispatch.
    const wireRequests: unknown[] = [];
    const kimi = new OpenRouterProvider(
      "test-key",
      "moonshotai/kimi-k2.6-20260420",
    );
    (kimi as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            wireRequests.push(JSON.parse(JSON.stringify(params)));
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call-1",
                            function: {
                              name: "select_pages",
                              arguments: '{"ids":[3]}',
                            },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 2 },
                };
              },
            };
          },
        },
      },
    };

    // The profile layer injects the thinking effort onto the call config in
    // production; emulate that here so the forced tool_choice rides alongside
    // reasoning on the wire.
    providerStub = {
      name: "kimi-openai-compat",
      sendMessage: (messages: Message[], options?: SendMessageOptions) =>
        kimi.sendMessage(messages, {
          ...options,
          config: {
            ...options?.config,
            effort: "high",
            thinking: { enabled: true },
          },
        }),
    };

    const selection = await selectPool(makePool(), makeTurn("rollout?"));

    // The preflight path avoids an incompatible first request, and the
    // pool-level re-prompt loop never engages.
    expect(wireRequests).toHaveLength(1);
    const first = wireRequests[0] as {
      tool_choice?: unknown;
      reasoning?: { effort?: string; summary?: string };
    };
    expect(first.tool_choice).toBeUndefined();
    expect(first.reasoning).toMatchObject({
      effort: "high",
      summary: "detailed",
    });
    expect(warnPayloads().filter((p) => p.reason === "provider_error")).toEqual(
      [],
    );

    // Structured selection survived: ids [3] is the topic-x finder line.
    expect(selection.keptAll).toBe(false);
    expect(selection.pages).toEqual([{ slug: "topic-x", sections: [] }]);
  });
});

// ---------------------------------------------------------------------------
// selectPool: TypeSafe System One noul-per-candidate path.
// ---------------------------------------------------------------------------

function typesafeResponse(answers: Record<string, unknown>): ProviderResponse {
  return {
    model: "jev-latest",
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [{ type: "text", text: JSON.stringify(answers, null, 2) }],
    rawResponse: { answers },
  };
}

function makeTypesafeProvider(response: ProviderResponse): Provider {
  return {
    name: "typesafe",
    sendMessage: async (messages, options) => {
      providerCalls.push({ messages, options });
      return response;
    },
  };
}

function noulAnswer(noul: number): { type: "noul"; noul: number } {
  return { type: "noul", noul };
}

describe("selectPool: TypeSafe System One", () => {
  test("keeps selector requests within 80% of the resolved context window while preserving the newest candidates", async () => {
    selectorMaxInputTokens = 32_000;
    const oversizedPool: SelectorPool = {
      stable: Array.from({ length: 40 }, (_, index) => ({
        slug: `stable-${index}`,
        card: `stable card ${index} ${"x".repeat(5_000)}`,
        lane: index === 0 ? ("core" as const) : ("hot" as const),
      })),
      finder: [
        { slug: "finder-needle", descriptor: "needle", lane: "needle" },
        { slug: "finder-dense", descriptor: "dense", lane: "dense" },
        { slug: "finder-edge", descriptor: "edge", lane: "edge" },
        { slug: "finder-learned", descriptor: "learned", lane: "learned" },
      ],
    };
    let retainedSlugs: string[] = [];
    providerStub = {
      name: "typesafe",
      defaultModel: "jev-latest",
      sendMessage: async (messages, options) => {
        providerCalls.push({ messages, options });
        const payload = JSON.parse(
          (messages[0]!.content[0] as { text: string }).text,
        ) as {
          state: {
            candidates: Record<string, { slug: string; text: string }>;
            current_message: string;
          };
          questions: Record<string, unknown>;
        };
        retainedSlugs = Object.values(payload.state.candidates).map(
          (candidate) => candidate.slug,
        );
        const answers = Object.fromEntries(
          retainedSlugs.map((_, index) => [
            String(index + 1),
            noulAnswer(
              index === 0 || index === retainedSlugs.length - 1 ? 1 : 0,
            ),
          ]),
        );
        return typesafeResponse(answers);
      },
    };

    const currentMessage = "preserve this current message";
    const result = await selectPool(oversizedPool, makeTurn(currentMessage));

    expect(providerCalls).toHaveLength(1);
    const payloadText = (
      providerCalls[0]!.messages[0]!.content[0] as { text: string }
    ).text;
    const payload = JSON.parse(payloadText) as {
      state: {
        candidates: Record<string, { slug: string; text: string }>;
        current_message: string;
      };
      questions: Record<string, unknown>;
    };
    const estimatedWireTokens = estimateTextTokens(
      JSON.stringify({
        state: payload.state,
        model: "jev-latest",
        questions: payload.questions,
      }),
    );
    expect(estimatedWireTokens).toBeLessThanOrEqual(25_600);
    expect(payload.state.current_message).toBe(currentMessage);
    expect(retainedSlugs.length).toBeLessThan(44);
    expect(retainedSlugs).toContain("stable-0");
    expect(retainedSlugs).toContain("finder-needle");
    expect(retainedSlugs).toContain("finder-dense");
    expect(retainedSlugs).not.toContain("finder-learned");
    expect(Object.keys(payload.questions)).toHaveLength(retainedSlugs.length);
    expect(result.pool.stable[0]?.slug).toBe("stable-0");
    expect(result.pool.finder.map((candidate) => candidate.slug)).toEqual([
      "finder-needle",
      "finder-dense",
    ]);
    expect(result.pages).toEqual([
      { slug: retainedSlugs[0], sections: [] },
      { slug: retainedSlugs[retainedSlugs.length - 1], sections: [] },
    ]);
    expect(result.keptAll).toBe(false);
  });

  test("drops the trailing current-message duplicate before trimming recent context", async () => {
    selectorMaxInputTokens = 8_000;
    let payload: {
      state: {
        current_message: string;
        recent_context: string;
        situation?: string;
      };
    } | null = null;
    providerStub = {
      name: "typesafe",
      defaultModel: "jev-latest",
      sendMessage: async (messages, options) => {
        providerCalls.push({ messages, options });
        payload = JSON.parse(
          (messages[0]!.content[0] as { text: string }).text,
        ) as typeof payload;
        return typesafeResponse({
          "1": noulAnswer(1),
          "2": noulAnswer(0),
          "3": noulAnswer(0),
          "4": noulAnswer(0),
        });
      },
    };
    const currentMessage = `current query ${"q".repeat(2_000)}`;
    const previousAssistant = `preceding assistant reply ${"a".repeat(2_000)}`;
    const turn = {
      ...makeTurn(currentMessage),
      recentContext: `${previousAssistant}\n${currentMessage}`,
      situationalContext: `old situation ${"s".repeat(30_000)}`,
    };

    const result = await selectPool(makePool(), turn);

    expect(payload).not.toBeNull();
    expect(payload!.state.current_message).toBe(currentMessage);
    expect(payload!.state.recent_context).toBe(previousAssistant);
    expect(payload!.state.recent_context).not.toContain(currentMessage);
    expect(payload!.state.situation?.length ?? 0).toBeLessThan(
      turn.situationalContext.length,
    );
    expect(result.turn.currentMessage).toBe(currentMessage);
    expect(result.turn.recentContext).toBe(previousAssistant);
  });

  test("preserves the current message and newest recent-context suffix when turn context is oversized", async () => {
    selectorMaxInputTokens = 8_000;
    let payload: {
      state: {
        candidates: Record<string, { slug: string; text: string }>;
        current_message: string;
        recent_context: string;
        situation?: string;
      };
      questions: Record<string, unknown>;
    } | null = null;
    providerStub = {
      name: "typesafe",
      defaultModel: "jev-latest",
      sendMessage: async (messages, options) => {
        providerCalls.push({ messages, options });
        payload = JSON.parse(
          (messages[0]!.content[0] as { text: string }).text,
        ) as typeof payload;
        const ids = Object.keys(payload!.state.candidates);
        return typesafeResponse(
          Object.fromEntries(ids.map((id) => [id, noulAnswer(1)])),
        );
      },
    };
    const currentMessage = "keep the complete current message";
    const recentSuffix = "RECENT-CONTEXT-END";
    const turn = {
      ...makeTurn(currentMessage),
      recentContext: `${"r".repeat(40_000)}${recentSuffix}`,
      situationalContext: `old situation ${"s".repeat(20_000)}`,
    };

    await selectPool(makePool(), turn);

    expect(payload).not.toBeNull();
    expect(payload!.state.current_message).toBe(currentMessage);
    expect(payload!.state.recent_context).toEndWith(recentSuffix);
    expect(payload!.state.recent_context.length).toBeLessThan(
      turn.recentContext.length,
    );
    expect(payload!.state.situation).toBeUndefined();
    const estimatedWireTokens = estimateTextTokens(
      JSON.stringify({
        state: payload!.state,
        model: "jev-latest",
        questions: payload!.questions,
      }),
    );
    expect(estimatedWireTokens).toBeLessThanOrEqual(6_400);
  });

  test("sends one noul per candidate and no select_pages tool", async () => {
    providerStub = makeTypesafeProvider(
      typesafeResponse({
        "1": noulAnswer(0.9),
        "2": noulAnswer(0.1),
        "3": noulAnswer(0.8),
        "4": noulAnswer(0.2),
      }),
    );

    await selectPool(makePool(), makeTurn("rollout?"));

    expect(providerCalls).toHaveLength(1);
    const [call] = providerCalls;
    expect(call.options?.tools).toBeUndefined();
    expect(
      (call.options?.config as Record<string, unknown> | undefined)
        ?.tool_choice,
    ).toBeUndefined();
    expect(
      (call.options?.config as Record<string, unknown> | undefined)?.callSite,
    ).toBe("memoryV3SelectL2");
    expect(
      (call.options?.config as Record<string, unknown> | undefined)
        ?.selectionSeed,
    ).toBe("conv-xyz");

    const payload = JSON.parse(
      (call.messages[0]!.content[0] as { text: string }).text,
    ) as {
      state: {
        candidates: Record<string, { slug: string; text: string }>;
        current_message: string;
        selector_instructions: string;
      };
      questions: Record<string, { type: string; instructions: string }>;
    };
    expect(Object.keys(payload.questions)).toEqual(["1", "2", "3", "4"]);
    expect(payload.questions["1"]?.type).toBe("noul");
    expect(payload.questions["1"]?.instructions).toContain("`candidates.1`");
    expect(payload.state.candidates["1"]?.slug).toBe("page-a");
    expect(payload.state.candidates["1"]?.text).toBe(CARD_A);
    expect(payload.state.candidates["3"]?.slug).toBe("topic-x");
    expect(payload.state.current_message).toBe("rollout?");
    expect(payload.state.selector_instructions.length).toBeGreaterThan(0);
  });

  test("keeps candidates at or above the inclusive noul threshold", async () => {
    providerStub = makeTypesafeProvider(
      typesafeResponse({
        "1": noulAnswer(TYPE_SAFE_POOL_KEEP_NOUL),
        "2": noulAnswer(TYPE_SAFE_POOL_KEEP_NOUL - 0.01),
        "3": noulAnswer(0.91),
        "4": noulAnswer(0.12),
      }),
    );

    const result = await selectPool(makePool(), makeTurn("rollout?"));
    expect(result.keptAll).toBe(false);
    expect(result.pages).toEqual([
      { slug: "page-a", sections: [] },
      { slug: "topic-x", sections: [] },
    ]);
  });

  test("an all-below-threshold pool is a deliberate empty selection", async () => {
    providerStub = makeTypesafeProvider(
      typesafeResponse({
        "1": noulAnswer(0.1),
        "2": noulAnswer(0.2),
        "3": noulAnswer(0.05),
        "4": noulAnswer(0.3),
      }),
    );

    const pool = makePool();
    const turn = makeTurn("nothing relevant");
    const result = await selectPool(pool, turn);
    expect(result).toEqual({
      pages: [],
      keptAll: false,
      pool,
      turn,
    });
  });

  test("unusable answers throw after the re-prompt retry", async () => {
    providerStub = makeTypesafeProvider({
      model: "jev-latest",
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      content: [{ type: "text", text: "not-json" }],
    });

    await expect(selectPool(makePool(), makeTurn("x"))).rejects.toThrow(
      MemoryV3RetrievalUnavailableError,
    );
    expect(providerCalls).toHaveLength(3);
  });
});
