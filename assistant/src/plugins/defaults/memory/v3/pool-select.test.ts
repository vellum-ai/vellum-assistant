/**
 * Tests for `pool-select.ts` `selectPool` — focused on error SURFACING:
 *   - a provider call that THROWS on every attempt surfaces the underlying
 *     provider error (e.g. an upstream HTTP 4xx) in the thrown
 *     `MemoryV3RetrievalUnavailableError` message, rather than the generic
 *     "no usable selection" string that hid it;
 *   - a 200 response carrying no usable `tool_use` still throws the generic
 *     "no usable selection" message;
 *   - happy paths preserved: explicit ids → selection, omitted ids → keepAll,
 *     empty pool → [].
 *
 * `mock.module` is process-global and leaks into sibling files in a directory
 * run, so the `@vellumai/plugin-api` stub DELEGATES to the real
 * `getConfiguredProvider` unless this test is actively running
 * (`selectMockActive`) — mirrors `prune.test.ts` / `ever-injected-store.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Provider,
  ProviderResponse,
} from "@vellumai/plugin-api";

import type { MemoryRoutingTurn, Slug } from "./types.js";

const realPluginApi = await import("@vellumai/plugin-api");

let selectMockActive = false;
let sendMessageImpl: (() => Promise<ProviderResponse>) | null = null;
// The messages of the most recent selector call, for asserting the rendered
// pool.
let lastMessages: unknown = null;

const mockProvider = {
  name: "mock-memory-v3-selector",
  async sendMessage(messages: unknown): Promise<ProviderResponse> {
    lastMessages = messages;
    if (!sendMessageImpl) {
      throw new Error("sendMessageImpl not configured");
    }
    return sendMessageImpl();
  },
} as unknown as Provider;

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  getConfiguredProvider: (
    ...args: Parameters<typeof realPluginApi.getConfiguredProvider>
  ) =>
    selectMockActive
      ? Promise.resolve(mockProvider)
      : realPluginApi.getConfiguredProvider(...args),
}));

const { MemoryV3RetrievalUnavailableError, renderFinderLine, selectPool } =
  await import("./pool-select.js");

function response(content: ContentBlock[]): ProviderResponse {
  return {
    content,
    model: "mock",
    usage: { inputTokens: 0, outputTokens: 0 },
  } as ProviderResponse;
}

const turn: MemoryRoutingTurn = {
  conversationId: "conv-1",
  turnNumber: 0,
  currentMessage: "echo something back",
  recentContext: "",
};

const pool: Parameters<typeof selectPool>[0] = {
  stable: [],
  finder: [
    { slug: "page-a" as Slug, descriptor: "a descriptor", lane: "needle" },
  ],
};

describe("selectPool", () => {
  beforeEach(() => {
    selectMockActive = true;
    sendMessageImpl = null;
  });
  afterAll(() => {
    selectMockActive = false;
  });

  test("a provider throw surfaces the underlying error in the thrown message", async () => {
    const upstream = "Together AI API error (400): 400 status code (no body)";
    sendMessageImpl = async () => {
      throw new Error(upstream);
    };
    let caught: unknown;
    try {
      await selectPool(pool, turn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryV3RetrievalUnavailableError);
    expect((caught as Error).message).toContain(
      "provider call failed after retries",
    );
    // The real upstream error is no longer hidden behind the generic message.
    expect((caught as Error).message).toContain(upstream);
  });

  test("a 200 with no usable tool_use throws the generic message", async () => {
    sendMessageImpl = async () =>
      response([{ type: "text", text: "I cannot call the tool." }]);
    let caught: unknown;
    try {
      await selectPool(pool, turn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryV3RetrievalUnavailableError);
    expect((caught as Error).message).toBe(
      "memory-v3 pool selector returned no usable selection after retries",
    );
  });

  test("explicit ids select the matching candidates", async () => {
    sendMessageImpl = async () =>
      response([
        {
          type: "tool_use",
          id: "call-1",
          name: "select_pages",
          input: { ids: [1] },
        },
      ]);
    expect(await selectPool(pool, turn)).toEqual({
      pages: [{ slug: "page-a", sections: [] }],
      keptAll: false,
      pool,
      turn,
    });
  });

  test("omitted ids keep all candidates (recall-safe) and flag keptAll", async () => {
    sendMessageImpl = async () =>
      response([
        { type: "tool_use", id: "call-1", name: "select_pages", input: {} },
      ]);
    expect(await selectPool(pool, turn)).toEqual({
      pages: [{ slug: "page-a", sections: [] }],
      keptAll: true,
      pool,
      turn,
    });
  });

  test("a finder line is shown as its pool number and renderFinderLine", async () => {
    sendMessageImpl = async () =>
      response([
        {
          type: "tool_use",
          id: "call-1",
          name: "select_pages",
          input: { ids: [] },
        },
      ]);
    const candidate: Parameters<typeof renderFinderLine>[0] = {
      slug: "page-a" as Slug,
      descriptor: "a descriptor",
      lane: "needle",
    };
    await selectPool(
      {
        stable: [{ slug: "page-s" as Slug, card: "card s", lane: "core" }],
        finder: [candidate],
      },
      turn,
    );
    const sent = JSON.stringify(lastMessages);
    expect(sent).toContain(
      JSON.stringify(`[2] ${renderFinderLine(candidate)}`).slice(1, -1),
    );
    expect(sent).toContain(JSON.stringify("[1] card s").slice(1, -1));
  });

  test("an empty candidate pool returns no selections", async () => {
    const emptyPool = { stable: [], finder: [] };
    expect(await selectPool(emptyPool, turn)).toEqual({
      pages: [],
      keptAll: false,
      pool: emptyPool,
      turn,
    });
  });
});
