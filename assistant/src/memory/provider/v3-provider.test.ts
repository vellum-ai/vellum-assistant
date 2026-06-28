/**
 * {@link V3MemoryProvider} adapter tests.
 *
 * The adapter is a thin delegation layer over the real v3 injectors. These
 * tests stub `memory-v3-shadow/injector.js` so they can assert the adapter's
 * contract structurally (a full corpus fixture is heavy and already covered by
 * the shadow plugin's own `injection.test.ts`): the adapter maps the provider
 * context onto the injectors' {@link TurnContext}, returns the cards + spotlight
 * blocks in injector order, drops nulls, and preserves the frozen net-new card
 * block — including the deferred-commit meta key that carries v3's
 * carry-forward (everInjected) semantics — exactly as the injector produced it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustContext } from "../../daemon/trust-context.js";
import {
  MEMORY_V3_BLOCK_ID,
  MEMORY_V3_COMMIT_META_KEY,
  MEMORY_V3_SPOTLIGHT_BLOCK_ID,
} from "../../plugins/defaults/memory-v3-shadow/types.js";
import type { InjectionBlock, TurnContext } from "../../plugins/types.js";
import { ROUTES as MEMORY_V3_ROUTES } from "../../runtime/routes/memory-v3-routes.js";

// ─── injector stubs ──────────────────────────────────────────────────────────

let cardsBlock: InjectionBlock | null = null;
let spotlightBlock: InjectionBlock | null = null;
const cardsContexts: TurnContext[] = [];
const spotlightContexts: TurnContext[] = [];

mock.module("../../plugins/defaults/memory-v3-shadow/injector.js", () => ({
  memoryV3Injector: {
    name: "memory-v3-shadow",
    order: 1000,
    produce: async (ctx: TurnContext) => {
      cardsContexts.push(ctx);
      return cardsBlock;
    },
  },
  memoryV3SpotlightInjector: {
    name: "memory-v3-spotlight",
    order: 1001,
    produce: async (ctx: TurnContext) => {
      spotlightContexts.push(ctx);
      return spotlightBlock;
    },
  },
}));

const { V3MemoryProvider } = await import("./v3-provider.js");
const { MemoryConfigSchema } = await import("../../config/schemas/memory.js");
const { rememberTool, recallTool } =
  await import("../../tools/memory/register.js");

// ─── fixtures ────────────────────────────────────────────────────────────────

const TRUST: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

const MEMORY_CONFIG = MemoryConfigSchema.parse({});

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: "conv-1",
    requestId: "req-1",
    messages: [],
    config: MEMORY_CONFIG,
    turnIndex: 3,
    trust: TRUST,
    ...overrides,
  } as never;
}

/** A frozen net-new card block as the real cards injector emits it: the
 *  `<memory>` block id plus the deferred-commit meta key that drives v3's
 *  carry-forward everInjected write. */
function freshCardsBlock(): InjectionBlock {
  const commit = mock(() => {});
  return {
    id: MEMORY_V3_BLOCK_ID,
    text: "<memory __injected>\ncard body\n</memory>",
    placement: "after-memory-prefix",
    meta: { [MEMORY_V3_COMMIT_META_KEY]: commit },
  };
}

function spotlightBlockFixture(): InjectionBlock {
  return {
    id: MEMORY_V3_SPOTLIGHT_BLOCK_ID,
    text: "<memory_spotlight>\nsection\n</memory_spotlight>",
    placement: "after-memory-prefix",
  };
}

beforeEach(() => {
  cardsBlock = null;
  spotlightBlock = null;
  cardsContexts.length = 0;
  spotlightContexts.length = 0;
});

afterEach(() => {
  mock.restore();
});

// ─── adapter conformance ─────────────────────────────────────────────────────

describe("V3MemoryProvider", () => {
  test("satisfies MemoryProvider with id 'v3'", () => {
    expect(V3MemoryProvider.id).toBe("v3");
  });

  test("retrieveForContext contributes nothing (v3 has no context-load prefix)", async () => {
    cardsBlock = freshCardsBlock();
    spotlightBlock = spotlightBlockFixture();
    expect(await V3MemoryProvider.retrieveForContext(ctx())).toEqual([]);
    expect(cardsContexts).toHaveLength(0);
  });

  test("retrieveForTurn maps the provider context onto the injectors' TurnContext", async () => {
    await V3MemoryProvider.retrieveForTurn(ctx());
    expect(cardsContexts).toHaveLength(1);
    expect(cardsContexts[0]).toMatchObject({
      requestId: "req-1",
      conversationId: "conv-1",
      turnIndex: 3,
      trust: TRUST,
    });
    expect(spotlightContexts[0]).toMatchObject({
      conversationId: "conv-1",
      turnIndex: 3,
    });
  });

  test("retrieveForTurn returns cards then spotlight, preserving frozen-card structure", async () => {
    const cards = freshCardsBlock();
    cardsBlock = cards;
    spotlightBlock = spotlightBlockFixture();

    const blocks = await V3MemoryProvider.retrieveForTurn(ctx());

    expect(blocks).toHaveLength(2);
    // Order: cards (injector order 1000) before spotlight (1001).
    expect(blocks[0]!.id).toBe(MEMORY_V3_BLOCK_ID);
    expect(blocks[1]!.id).toBe(MEMORY_V3_SPOTLIGHT_BLOCK_ID);
    // The frozen card block rides through byte-identical, carry-forward commit
    // callback intact.
    expect(blocks[0]).toBe(cards);
    expect(blocks[0]!.meta?.[MEMORY_V3_COMMIT_META_KEY]).toBe(
      cards.meta![MEMORY_V3_COMMIT_META_KEY],
    );
  });

  test("retrieveForTurn drops null injector results", async () => {
    cardsBlock = null;
    spotlightBlock = spotlightBlockFixture();
    const blocks = await V3MemoryProvider.retrieveForTurn(ctx());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.id).toBe(MEMORY_V3_SPOTLIGHT_BLOCK_ID);
  });

  test("provideTools exposes the shared remember/recall instances (matching v2/graph), preserving base behavior for v3-live installs; provideRoutes returns the v3 maintenance routes", () => {
    const tools = V3MemoryProvider.provideTools();
    // Same instances v2/graph return — remember/recall handlers are
    // provider-agnostic and write to the shared corpus v3 consolidation consumes.
    expect(tools).toEqual([rememberTool, recallTool]);
    expect(tools.map((t) => t.name)).toEqual(["remember", "recall"]);
    expect(V3MemoryProvider.provideRoutes()).toBe(MEMORY_V3_ROUTES);
  });

  test("onTurnCommit / init / shutdown are no-ops", async () => {
    await expect(V3MemoryProvider.onTurnCommit(ctx())).resolves.toBeUndefined();
    await expect(V3MemoryProvider.init()).resolves.toBeUndefined();
    await expect(V3MemoryProvider.shutdown()).resolves.toBeUndefined();
  });
});
