/**
 * Tests for the memory-v3 step-0 branch in `applyRuntimeInjections`:
 * spotlight strip + v2 tail suppression.
 *
 * When the `memory-v3-live` flag is on AND the v3 injector (id `memory-v3`,
 * placement `after-memory-prefix`) produces a block — possibly EMPTY-TEXT on
 * an all-repeat turn — runtime assembly strips the v2 `<memory>` prefix from
 * the TAIL user message only before splicing the v3 block. Historical user
 * messages keep their memory blocks byte-identical (frozen v3 cards and
 * pre-cutover v2 blocks both ride the cached prefix); the old whole-layer
 * strip is gone.
 *
 * The ephemeral `<memory_spotlight>` block is strip-and-replaced every turn:
 * stale spotlights are removed from every user message unconditionally (a
 * scoped, single-id strip), and the spotlight injector's `append-user-tail`
 * block lands at the tail.
 *
 * v2 suppression stays keyed off whether v3 produced a block, NOT off the
 * flag alone: a v3 failure (`produce()` → null) leaves v2's block intact
 * (fallback-to-v2). The flag-off path must be byte-for-byte identical to
 * today — that is the load-bearing regression guard. `applyRuntimeInjections`
 * reads the flag itself, so these tests drive it through the override cache.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { wrapMemorySpotlightBlock } from "../memory/memory-marker.js";
import type {
  InjectionBlock,
  Injector,
  TurnContext,
} from "../plugins/types.js";
import type { Message } from "../providers/types.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

// Drive the suppression branch by controlling the static injector chain that
// `applyRuntimeInjections` walks. The slot is mutated per-test to stand in for
// the memory-v3 injectors producing (or not producing) blocks.
const injectorChainSlot: Injector[] = [];
mock.module("../plugins/defaults/memory-retrieval/injector-chain.js", () => ({
  getInjectorChain: () => injectorChainSlot,
}));

const { applyRuntimeInjections } =
  await import("../daemon/conversation-runtime-assembly.js");

function makeTurnContext(): TurnContext {
  return {
    requestId: "req-test-1",
    conversationId: "conv-test-1",
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
  };
}

/**
 * A fake v3 cards injector that mirrors the real one's id + placement. The
 * real injector wraps its content in `<memory>\n…\n</memory>`, so the fake
 * does too. `inner === null` means the injector produced nothing this turn
 * (error/empty selection); `inner === ""` mirrors an all-repeat turn (block
 * produced, empty text — nothing attached, but v2 is still suppressed).
 */
function v3Injector(inner: string | null): Injector {
  return {
    name: "memory-v3-shadow",
    order: 1000,
    async produce(): Promise<InjectionBlock | null> {
      if (inner === null) return null;
      return {
        id: "memory-v3",
        text: inner === "" ? "" : `<memory>\n${inner}\n</memory>`,
        placement: "after-memory-prefix",
      };
    },
  };
}

/** A fake v3 spotlight injector mirroring the real id + tail placement. */
function spotlightInjector(inner: string): Injector {
  return {
    name: "memory-v3-spotlight",
    order: 1001,
    async produce(): Promise<InjectionBlock | null> {
      return {
        id: "memory-v3-spotlight",
        text: wrapMemorySpotlightBlock(inner),
        placement: "append-user-tail",
      };
    },
  };
}

/** Build a user message whose tail carries a v2 `<memory>` prefix block. */
function userMsgWithV2Memory(memoryText: string, userText: string): Message {
  return {
    role: "user",
    content: [
      { type: "text", text: `<memory>\n${memoryText}\n</memory>` },
      { type: "text", text: userText },
    ],
  };
}

/** Extract the tail user message's text blocks. */
function tailTexts(messages: Message[]): string[] {
  const tail = messages[messages.length - 1];
  return tail.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text);
}

describe("memory-v3-live v2 suppression", () => {
  beforeEach(() => {
    injectorChainSlot.length = 0;
    // Clean baseline: no overrides → `memory-v3-live` resolves to its registry
    // default (off). Each test seeds the flag it needs.
    setOverridesForTesting({});
  });

  test("flag ON + v3 produced a block → TAIL v2 stripped, historical memory blocks frozen in place", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    injectorChainSlot.push(v3Injector("net-new cards"));

    // History: a prior user turn carrying a frozen memory block (a v3 card
    // block or a pre-cutover v2 block — same wrapper), plus the current tail
    // user turn with v2's freshly-prepended block.
    const historicalUser = userMsgWithV2Memory(
      "frozen card from turn 1",
      "earlier question",
    );
    const runMessages: Message[] = [
      historicalUser,
      {
        role: "assistant",
        content: [{ type: "text", text: "earlier answer" }],
      },
      userMsgWithV2Memory("fresh recalled fact", "current question"),
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    // The HISTORICAL user turn keeps its memory block byte-identical — the
    // frozen-card cache contract (no whole-layer strip).
    expect(result.messages[0].content).toEqual(historicalUser.content);

    // The tail's fresh v2 block is replaced by the v3 block; original user
    // text is preserved right after it.
    const texts = tailTexts(result.messages);
    expect(texts[0]).toBe("<memory>\nnet-new cards\n</memory>");
    expect(texts[1]).toBe("current question");
    expect(texts).toHaveLength(2);

    // The v3 block is captured for metadata persistence (UNWRAPPED) and the
    // turn is marked v3-active so the hook skips v2's metadata write.
    expect(result.blocks.memoryV3InjectedBlock).toBe("net-new cards");
    expect(result.blocks.memoryV3Active).toBe(true);
  });

  test("flag ON + EMPTY-TEXT v3 block (all-repeat turn) → tail v2 stripped, nothing attached", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    injectorChainSlot.push(v3Injector(""));

    const runMessages: Message[] = [
      userMsgWithV2Memory("fresh recalled fact", "current question"),
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    // v2's fresh block is gone and NO v3 content replaced it — the frozen
    // cards from prior turns already carry the memory.
    const texts = tailTexts(result.messages);
    expect(texts).toEqual(["current question"]);
    // No bytes to persist, but the turn is still v3-active (gates v2's
    // metadata write so the stripped block is not rehydrated on reload).
    expect(result.blocks.memoryV3InjectedBlock).toBeUndefined();
    expect(result.blocks.memoryV3Active).toBe(true);
  });

  test("stale spotlight blocks are stripped from EVERY user message; the new spotlight lands at the tail", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    injectorChainSlot.push(v3Injector(""), spotlightInjector("fresh sections"));

    const staleSpotlight = {
      type: "text" as const,
      text: wrapMemorySpotlightBlock("stale sections"),
    };
    const runMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "earlier question" }, staleSpotlight],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "earlier answer" }],
      },
      { role: "user", content: [{ type: "text", text: "current question" }] },
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    // The stale spotlight is gone from the historical turn…
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "earlier question" },
    ]);
    // …and exactly one fresh spotlight sits at the tail.
    const texts = tailTexts(result.messages);
    expect(texts).toEqual([
      "current question",
      wrapMemorySpotlightBlock("fresh sections"),
    ]);
  });

  test("flag ON but v3 produced NOTHING → v2 block left intact (fallback-to-v2)", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    injectorChainSlot.push(v3Injector(null));

    const runMessages: Message[] = [
      userMsgWithV2Memory("fresh recalled fact", "current question"),
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    // v2's block survives — the turn still ships memory.
    const texts = tailTexts(result.messages);
    expect(texts[0]).toBe("<memory>\nfresh recalled fact\n</memory>");
    expect(texts[1]).toBe("current question");
    // No v3 block was added.
    expect(texts).toHaveLength(2);
    expect(result.blocks.memoryV3Active).toBe(false);
  });

  test("flag OFF → byte-for-byte identical to today even when v3 would have produced a block", async () => {
    injectorChainSlot.push(v3Injector("v3 cards"));

    const runMessages: Message[] = [
      userMsgWithV2Memory("old recalled fact", "earlier question"),
      {
        role: "assistant",
        content: [{ type: "text", text: "earlier answer" }],
      },
      userMsgWithV2Memory("fresh recalled fact", "current question"),
    ];

    // With the flag off (registry default), the v3 injector still runs through
    // the chain (after-memory-prefix), but NO v2 stripping happens. This
    // captures the exact pre-flag assembly behavior: v2 prefix stays, v3
    // splices after it.
    const offResult = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    // The tail keeps v2's block AND gains v3's (the historical double-injection
    // the suppression exists to prevent) — proving suppression is the ONLY
    // behavior change and it is fully gated off here.
    const texts = tailTexts(offResult.messages);
    expect(texts[0]).toBe("<memory>\nfresh recalled fact\n</memory>");
    expect(texts[1]).toBe("<memory>\nv3 cards\n</memory>");
    expect(texts[2]).toBe("current question");

    // Historical user turn keeps its v2 block.
    const firstUserTexts = offResult.messages[0].content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    expect(firstUserTexts[0]).toBe("<memory>\nold recalled fact\n</memory>");
    expect(offResult.blocks.memoryV3Active).toBe(false);
  });

  test("no v3 injector registered + flag ON → no stripping, messages untouched", async () => {
    // No injector named memory-v3 at all (e.g. plugin not loaded): the
    // suppression branch keys off the produced block, so nothing is stripped.
    setOverridesForTesting({ "memory-v3-live": true });
    expect(injectorChainSlot).toHaveLength(0);

    const runMessages: Message[] = [
      userMsgWithV2Memory("fresh recalled fact", "current question"),
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    expect(result.messages).toEqual(runMessages);
  });
});
