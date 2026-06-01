/**
 * Tests for the memory-v3-live v2-suppression branch in
 * `applyRuntimeInjections` (PR L6 of the memory-v3-live plan).
 *
 * When `suppressV2MemoryForV3` is on AND the v3 injector (id `memory-v3`,
 * placement `after-memory-prefix`) actually produces a block, runtime
 * assembly strips the v2 `<memory>` prefix from EVERY user message before
 * splicing the v3 block — so v3 becomes the sole `<memory>` source and history
 * is byte-stable for prompt caching.
 *
 * Keyed off whether v3 produced a block, NOT off the option alone: a v3
 * failure (`produce()` → null) leaves v2's block intact (fallback-to-v2).
 *
 * The flag-off path must be byte-for-byte identical to today — that is the
 * load-bearing regression guard.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  getInjectors,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  InjectionBlock,
  Injector,
  Plugin,
  TurnContext,
} from "../plugins/types.js";
import type { Message } from "../providers/types.js";

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

function wrapInPlugin(name: string, injectors: Injector[]): Plugin {
  return { manifest: { name, version: "0.0.1" }, injectors };
}

/**
 * A fake v3 injector that mirrors the real one's id + placement. The real
 * injector's `renderMemoryBlock` already wraps its content in
 * `<memory>\n…\n</memory>`, so the fake does too — `inner === null` means the
 * injector produced nothing this turn (error/empty selection).
 */
function v3Injector(inner: string | null): Injector {
  return {
    name: "memory-v3-shadow",
    order: 1000,
    async produce(): Promise<InjectionBlock | null> {
      if (inner === null) return null;
      return {
        id: "memory-v3",
        text: `<memory>\n${inner}\n</memory>`,
        placement: "after-memory-prefix",
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
    resetPluginRegistryForTests();
  });

  test("flag ON + v3 produced a block → v2 stripped from all turns, exactly one <memory> (the v3 block)", async () => {
    registerPlugin(wrapInPlugin("v3", [v3Injector("v3 working set")]));

    // History: a prior user turn that still carries a v2 block (rehydrated),
    // plus the current tail user turn with its own v2 block.
    const runMessages: Message[] = [
      userMsgWithV2Memory("old recalled fact", "earlier question"),
      {
        role: "assistant",
        content: [{ type: "text", text: "earlier answer" }],
      },
      userMsgWithV2Memory("fresh recalled fact", "current question"),
    ];

    const result = await applyRuntimeInjections(runMessages, {
      turnContext: makeTurnContext(),
      suppressV2MemoryForV3: true,
    });

    // Exactly one <memory> source across the WHOLE assembled context.
    const allTexts = result.messages.flatMap((m) =>
      m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text),
    );
    const memoryBlocks = allTexts.filter((t) => t.startsWith("<memory>"));
    expect(memoryBlocks).toHaveLength(1);
    // And it is the v3 block, not a v2 one.
    expect(memoryBlocks[0]).toBe("<memory>\nv3 working set\n</memory>");

    // The historical user turn no longer carries its v2 block (all-turns strip).
    const firstUser = result.messages[0];
    expect(
      firstUser.content.every(
        (b) => !(b.type === "text" && b.text.startsWith("<memory>")),
      ),
    ).toBe(true);

    // The v3 block lands at the head of the tail user message; original user
    // text is preserved right after it.
    const texts = tailTexts(result.messages);
    expect(texts[0]).toBe("<memory>\nv3 working set\n</memory>");
    expect(texts[1]).toBe("current question");
    expect(texts).toHaveLength(2);
  });

  test("flag ON but v3 produced NOTHING → v2 block left intact (fallback-to-v2)", async () => {
    registerPlugin(wrapInPlugin("v3", [v3Injector(null)]));

    const runMessages: Message[] = [
      userMsgWithV2Memory("fresh recalled fact", "current question"),
    ];

    const result = await applyRuntimeInjections(runMessages, {
      turnContext: makeTurnContext(),
      suppressV2MemoryForV3: true,
    });

    // v2's block survives — the turn still ships memory.
    const texts = tailTexts(result.messages);
    expect(texts[0]).toBe("<memory>\nfresh recalled fact\n</memory>");
    expect(texts[1]).toBe("current question");
    // No v3 block was added.
    expect(texts).toHaveLength(2);
  });

  test("flag OFF → byte-for-byte identical to today even when v3 would have produced a block", async () => {
    registerPlugin(wrapInPlugin("v3", [v3Injector("v3 working set")]));

    const runMessages: Message[] = [
      userMsgWithV2Memory("old recalled fact", "earlier question"),
      {
        role: "assistant",
        content: [{ type: "text", text: "earlier answer" }],
      },
      userMsgWithV2Memory("fresh recalled fact", "current question"),
    ];

    // With suppression off, the v3 injector still runs through the chain
    // (after-memory-prefix), but NO v2 stripping happens. This captures the
    // exact pre-flag assembly behavior: v2 prefix stays, v3 splices after it.
    const offResult = await applyRuntimeInjections(runMessages, {
      turnContext: makeTurnContext(),
      suppressV2MemoryForV3: false,
    });

    // The tail keeps v2's block AND gains v3's (the historical double-injection
    // the suppression PR exists to prevent) — proving suppression is the ONLY
    // behavior change and it is fully gated off here.
    const texts = tailTexts(offResult.messages);
    expect(texts[0]).toBe("<memory>\nfresh recalled fact\n</memory>");
    expect(texts[1]).toBe("<memory>\nv3 working set\n</memory>");
    expect(texts[2]).toBe("current question");

    // Historical user turn keeps its v2 block (no all-turns strip when off).
    const firstUserTexts = offResult.messages[0].content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    expect(firstUserTexts[0]).toBe("<memory>\nold recalled fact\n</memory>");

    // Strongest guard: omitting the option entirely yields the SAME result as
    // passing it false — the default path is untouched by this PR.
    resetPluginRegistryForTests();
    registerPlugin(wrapInPlugin("v3", [v3Injector("v3 working set")]));
    const defaultResult = await applyRuntimeInjections(runMessages, {
      turnContext: makeTurnContext(),
    });
    expect(defaultResult.messages).toEqual(offResult.messages);
  });

  test("no v3 injector registered + flag ON → no stripping, messages untouched", async () => {
    // No injector named memory-v3 at all (e.g. plugin not loaded): the
    // suppression branch keys off the produced block, so nothing is stripped.
    expect(getInjectors()).toHaveLength(0);

    const runMessages: Message[] = [
      userMsgWithV2Memory("fresh recalled fact", "current question"),
    ];

    const result = await applyRuntimeInjections(runMessages, {
      turnContext: makeTurnContext(),
      suppressV2MemoryForV3: true,
    });

    expect(result.messages).toEqual(runMessages);
  });
});
