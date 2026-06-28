/**
 * Tests for `V2MemoryProvider` — the {@link MemoryProvider} adapter over the
 * v2 concept-page system.
 *
 * The v2 injector reaches a SQLite handle, the embedding backend, and the
 * Qdrant client; a full end-to-end fixture is heavy and already exercised by
 * `v2/__tests__/injection.test.ts`. These tests assert the adapter's
 * contract: it satisfies `MemoryProvider`, surfaces the v2 remember-write
 * tools, gates injection on `memory.v2.enabled`, and maps a non-null v2
 * `<memory>` block onto a `prepend-user-tail` injection block by delegating
 * to `injectMemoryV2Block`.
 */
import { describe, expect, mock, test } from "bun:test";

import type { MemoryConfig } from "../../config/schemas/memory.js";
import type { Message } from "../../providers/types.js";
import type { MemoryProvider, MemoryProviderContext } from "./types.js";

// ---------------------------------------------------------------------------
// Module-level mocks — keep the adapter off real DB / workspace / v2 internals.
// ---------------------------------------------------------------------------

const injectCalls: Array<Record<string, unknown>> = [];
let injectResult: { block: string | null; toInject: string[] } = {
  block: null,
  toInject: [],
};

mock.module("../v2/injection.js", () => ({
  injectMemoryV2Block: async (params: Record<string, unknown>) => {
    injectCalls.push(params);
    return injectResult;
  },
}));

mock.module("../v2/now-text.js", () => ({
  loadNowText: async () => "NOW",
}));

const realDbConnection = await import("../../persistence/db-connection.js");
mock.module("../../persistence/db-connection.js", () => ({
  ...realDbConnection,
  getDb: () => ({}) as unknown,
}));

const realPlatform = await import("../../util/platform.js");
mock.module("../../util/platform.js", () => ({
  ...realPlatform,
  getWorkspaceDir: () => "/tmp/ws",
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ memory: { v2: { enabled: true } } }),
}));

const enqueueCalls: Array<Record<string, unknown>> = [];
mock.module("../memory-retrospective-enqueue.js", () => ({
  enqueueMemoryRetrospectiveIfEnabled: (args: Record<string, unknown>) => {
    enqueueCalls.push(args);
  },
}));

const { V2MemoryProvider } = await import("./v2-provider.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMemoryConfig(v2Enabled: boolean): MemoryConfig {
  return {
    v2: {
      enabled: v2Enabled,
      router: { historical_pairs: 3 },
    },
  } as unknown as MemoryConfig;
}

function makeCtx(v2Enabled: boolean): MemoryProviderContext {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ];
  return {
    conversationId: "conv-1",
    requestId: "req-1",
    messages,
    config: makeMemoryConfig(v2Enabled),
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("V2MemoryProvider", () => {
  test("satisfies MemoryProvider with id 'v2'", () => {
    const provider: MemoryProvider = V2MemoryProvider;
    expect(provider.id).toBe("v2");
  });

  test("provideTools surfaces the remember/recall write path", () => {
    const names = V2MemoryProvider.provideTools().map((t) => t.name);
    expect(names).toContain("remember");
    expect(names).toContain("recall");
  });

  test("retrieve* return no blocks when v2 is disabled", async () => {
    injectCalls.length = 0;
    const ctx = makeCtx(false);
    expect(await V2MemoryProvider.retrieveForContext(ctx)).toEqual([]);
    expect(await V2MemoryProvider.retrieveForTurn(ctx)).toEqual([]);
    // The injector is never reached when v2 is off.
    expect(injectCalls).toHaveLength(0);
  });

  test("retrieveForContext maps a v2 block to a prepend-user-tail injection block", async () => {
    injectCalls.length = 0;
    injectResult = { block: "<memory>\nfoo\n</memory>", toInject: ["foo"] };

    const blocks = await V2MemoryProvider.retrieveForContext(makeCtx(true));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      id: "memory-v2",
      text: "<memory>\nfoo\n</memory>",
      placement: "prepend-user-tail",
    });
    // Delegated to the v2 injector in context-load mode.
    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0].mode).toBe("context-load");
    expect(injectCalls[0].conversationId).toBe("conv-1");
  });

  test("retrieveForTurn delegates in per-turn mode and returns [] on a null block", async () => {
    injectCalls.length = 0;
    injectResult = { block: null, toInject: [] };

    const blocks = await V2MemoryProvider.retrieveForTurn(makeCtx(true));

    expect(blocks).toEqual([]);
    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0].mode).toBe("per-turn");
  });

  test("onTurnCommit enqueues the v2 consolidation/retrospective trigger", async () => {
    enqueueCalls.length = 0;
    await V2MemoryProvider.onTurnCommit(makeCtx(true));
    expect(enqueueCalls).toEqual([
      { conversationId: "conv-1", trigger: "lifecycle" },
    ]);
  });
});
