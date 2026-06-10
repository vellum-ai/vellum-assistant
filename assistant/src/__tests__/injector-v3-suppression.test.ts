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
 *
 * The strip discriminates v2's dynamic block by IDENTITY, not by prefix: v2's
 * `INJECTION_HEADER` and v3's `V3_CARDS_INJECTION_HEADER` are deliberately
 * byte-identical, and v2's router block leads with that header whenever any
 * summary section is present, so no prefix can tell the layers apart. The
 * identity — the exact text v2 prepended this turn — is read off the live
 * graph-memory handle, which these tests register and seed per test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import { wrapMemorySpotlightBlock } from "../memory/memory-marker.js";
import { INJECTION_HEADER } from "../memory/v2/injection.js";
import { V3_CARDS_INJECTION_HEADER } from "../plugins/defaults/memory-v3-shadow/render-injection.js";
import { MEMORY_V3_COMMIT_META_KEY } from "../plugins/defaults/memory-v3-shadow/types.js";
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

/** Live graph handles registered by the current test (disposed afterwards). */
const seededGraphs: ConversationGraphMemory[] = [];

/**
 * Register a live graph-memory handle for `conv-test-1` whose last retrieval
 * injected `text` — the identity the suppression strip resolves via
 * `getLiveGraphMemory(conversationId)?.lastInjectedBlockText`. The production
 * setter is `prepareMemory` (which needs a live DB), so the cached block is
 * seeded directly through the private field.
 */
function seedV2Identity(text: string | null): void {
  const graph = new ConversationGraphMemory("conv-test-1");
  (graph as unknown as { lastInjectedBlock: string | null }).lastInjectedBlock =
    text;
  seededGraphs.push(graph);
}

/**
 * A fake v3 cards injector that mirrors the real one's id + placement. The
 * real injector wraps its content in `<memory>\n…\n</memory>`, so the fake
 * does too. `inner === null` means the injector produced nothing this turn
 * (error/empty selection); `inner === ""` mirrors an all-repeat turn (block
 * produced, empty text — nothing attached, but v2 is still suppressed).
 */
function v3Injector(inner: string | null, commit?: () => void): Injector {
  return {
    name: "memory-v3-shadow",
    order: 1000,
    async produce(): Promise<InjectionBlock | null> {
      if (inner === null) return null;
      return {
        id: "memory-v3",
        text: inner === "" ? "" : `<memory>\n${inner}\n</memory>`,
        placement: "after-memory-prefix",
        ...(commit ? { meta: { [MEMORY_V3_COMMIT_META_KEY]: commit } } : {}),
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

  afterEach(() => {
    for (const graph of seededGraphs) graph.dispose();
    seededGraphs.length = 0;
  });

  test("flag ON + v3 produced a block → TAIL v2 stripped, historical memory blocks frozen in place", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    injectorChainSlot.push(v3Injector("net-new cards"));
    seedV2Identity("fresh recalled fact");

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
    seedV2Identity("fresh recalled fact");

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

  test("convergence re-entry: a tail leading with this turn's frozen v3 cards (and <info>) is NOT stripped", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    // Re-entry shape: the memo returns the same selections, every slug is now
    // in the everInjected store, so the injector produces an EMPTY block —
    // while the tail still carries the v3 card block frozen on first entry
    // (leading the content because no workspace / <turn_context> prepend
    // fired this turn) plus the <info> static block. The graph handle still
    // holds this turn's v2 identity (stripped on first entry, so absent from
    // the tail) — it must not match the frozen cards.
    injectorChainSlot.push(v3Injector(""));
    seedV2Identity("fresh recalled fact");

    const frozenV3Block = `<memory>\n${V3_CARDS_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\nhead\n</memory>`;
    const infoBlock = "<info>\nstatic memory\n</info>";
    const runMessages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: infoBlock },
          { type: "text", text: frozenV3Block },
          { type: "text", text: "current question" },
        ],
      },
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    // The just-frozen cards and the static block survive re-entry — only
    // v2's fresh dynamic prefix (absent here; stripped on first entry) is
    // ever removed.
    expect(tailTexts(result.messages)).toEqual([
      infoBlock,
      frozenV3Block,
      "current question",
    ]);
  });

  test("first entry with a v2 prefix AND a frozen v3 block strips ONLY the v2 block", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    injectorChainSlot.push(v3Injector(""));
    seedV2Identity("fresh recalled fact");

    const frozenV3Block = `<memory>\n${V3_CARDS_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\nhead\n</memory>`;
    const runMessages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "<memory>\nfresh recalled fact\n</memory>" },
          { type: "text", text: frozenV3Block },
          { type: "text", text: "current question" },
        ],
      },
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    expect(tailTexts(result.messages)).toEqual([
      frozenV3Block,
      "current question",
    ]);
  });

  test("REGRESSION: a v2 block leading with the REAL summary header (byte-identical to v3's) is stripped; v3 cards and <info> survive (first entry)", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    injectorChainSlot.push(v3Injector(""));

    // The collision this guards: v2's router block leads with
    // INJECTION_HEADER whenever any summary section is present — the dominant
    // production case — and v3's card header is deliberately the same bytes.
    expect(INJECTION_HEADER).toBe(V3_CARDS_INJECTION_HEADER);

    const v2Inner = `${INJECTION_HEADER}\n\n## memory/concepts/page-b.md\nsummary of page b`;
    seedV2Identity(v2Inner);

    const frozenV3Block = `<memory>\n${V3_CARDS_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\nhead\n</memory>`;
    const infoBlock = "<info>\nstatic memory\n</info>";
    const runMessages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: `<memory>\n${v2Inner}\n</memory>` },
          { type: "text", text: frozenV3Block },
          { type: "text", text: infoBlock },
          { type: "text", text: "current question" },
        ],
      },
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    // Despite sharing v3's header prefix, v2's block is gone (identity
    // match); the v3 cards and <info> blocks are byte-identical in place.
    expect(tailTexts(result.messages)).toEqual([
      frozenV3Block,
      infoBlock,
      "current question",
    ]);
  });

  test("REGRESSION: re-entry with a header-bearing v2 identity keeps the first entry's frozen v3 cards", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    // Re-entry: produce() returns the EMPTY block (cards already claimed by
    // the store) while the tail carries the FIRST entry's v3 block — and the
    // graph handle still holds the summary-bearing v2 identity from this
    // turn's retrieval. Identity must be matched against the v2 block, never
    // against "whatever leads with the shared header".
    injectorChainSlot.push(v3Injector(""));

    const v2Inner = `${INJECTION_HEADER}\n\n## memory/concepts/page-b.md\nsummary of page b`;
    seedV2Identity(v2Inner);

    const frozenV3Block = `<memory>\n${V3_CARDS_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\nhead\n</memory>`;
    const runMessages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: frozenV3Block },
          { type: "text", text: "current question" },
        ],
      },
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    expect(tailTexts(result.messages)).toEqual([
      frozenV3Block,
      "current question",
    ]);
  });

  test("v2 memory-image groups and legacy <memory __injected> blocks are stripped even without an identity", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    injectorChainSlot.push(v3Injector("net-new cards"));
    // No live graph handle: identity unknown (null). Image groups and legacy
    // blocks are unambiguously v2's and are stripped regardless; the shared
    // `<memory>` wrapper is left alone without an identity to match.
    const runMessages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "<memory_image __injected>\na chart" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "aGk=" },
          },
          { type: "text", text: "</memory_image>" },
          { type: "text", text: "<memory __injected>\nlegacy recalled fact" },
          { type: "text", text: "current question" },
        ],
      },
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    const texts = tailTexts(result.messages);
    expect(texts).toEqual([
      "<memory>\nnet-new cards\n</memory>",
      "current question",
    ]);
    // The injected image is gone too (the 3-block group strips as a unit).
    expect(
      result.messages[result.messages.length - 1].content.some(
        (b) => b.type === "image",
      ),
    ).toBe(false);
  });

  test("the v3 block's attachment-commit callback fires on a user tail", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    const commit = mock(() => {});
    injectorChainSlot.push(v3Injector("net-new cards", commit));

    const runMessages: Message[] = [
      userMsgWithV2Memory("fresh recalled fact", "current question"),
    ];
    await applyRuntimeInjections(runMessages, { ...makeTurnContext() });

    expect(commit).toHaveBeenCalledTimes(1);
  });

  test("the commit callback is SKIPPED when the tail is not a user message (block never attaches)", async () => {
    setOverridesForTesting({ "memory-v3-live": true });
    const commit = mock(() => {});
    injectorChainSlot.push(v3Injector("net-new cards", commit));

    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ];
    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    // Neither attached nor captured nor committed: the store must not claim
    // cards that never reached history.
    expect(commit).not.toHaveBeenCalled();
    expect(result.blocks.memoryV3InjectedBlock).toBeUndefined();
    expect(result.messages[1].content).toEqual([
      { type: "text", text: "answer" },
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
