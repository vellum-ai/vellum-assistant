/**
 * Tests for the plugin-driven runtime-injection chain (PR 21 of the
 * `agent-plugin-system` plan).
 *
 * Covers:
 *
 * 1. The seven default injectors registered by `defaultInjectorsPlugin` come
 *    back from `getInjectors()` in the documented order (workspace-context →
 *    unified-turn-context → pkb → now-md → subagent-status → slack-messages
 *    → thread-focus).
 * 2. A third-party-registered injector at `order: 25` slots between
 *    `unified-turn-context` (order 20) and `pkb` (order 30), proving the
 *    extensibility contract.
 * 3. `composeInjectorChain` concatenates non-null blocks with a blank-line
 *    separator and yields an empty string when every injector opts out — the
 *    latter matches pre-PR behavior for the golden-path conversation state
 *    (all defaults return `null` in this PR).
 * 4. `applyRuntimeInjections` with an empty `turnContext` chain leaves
 *    `blocks.injectorChainBlock` undefined, preserving the existing snapshot
 *    for conversations that don't opt into the chain.
 * 5. `applyRuntimeInjections` surfaces the composed chain output on
 *    `blocks.injectorChainBlock` when a third-party injector contributes
 *    content.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  applyRuntimeInjections,
  composeInjectorChain,
} from "../daemon/conversation-runtime-assembly.js";
import {
  DEFAULT_INJECTOR_ORDER,
  defaultInjectorsPlugin,
} from "../plugins/defaults/injectors.js";
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

/** A fake TurnContext sufficient for driving `composeInjectorChain`. */
function makeTurnContext(): TurnContext {
  return {
    requestId: "req-test-1",
    conversationId: "conv-test-1",
    turnIndex: 0,
    trust: {
      sourceChannel: "vellum",
      trustClass: "guardian",
    },
  };
}

/** Build a tiny valid plugin wrapping an array of injectors. */
function wrapInPlugin(name: string, injectors: Injector[]): Plugin {
  return {
    manifest: {
      name,
      version: "0.0.1",
      requires: { pluginRuntime: "v1" },
    },
    injectors,
  };
}

describe("injector chain", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("defaultInjectorsPlugin registers the seven defaults in the documented order", () => {
    registerPlugin(defaultInjectorsPlugin);

    const names = getInjectors().map((i) => i.name);
    expect(names).toEqual([
      "workspace-context",
      "unified-turn-context",
      "pkb",
      "now-md",
      "subagent-status",
      "slack-messages",
      "thread-focus",
    ]);
  });

  test("default injector order constants match the registered order values", () => {
    registerPlugin(defaultInjectorsPlugin);

    const byName = new Map(getInjectors().map((i) => [i.name, i.order]));
    expect(byName.get("workspace-context")).toBe(
      DEFAULT_INJECTOR_ORDER.workspaceContext,
    );
    expect(byName.get("unified-turn-context")).toBe(
      DEFAULT_INJECTOR_ORDER.unifiedTurnContext,
    );
    expect(byName.get("pkb")).toBe(DEFAULT_INJECTOR_ORDER.pkb);
    expect(byName.get("now-md")).toBe(DEFAULT_INJECTOR_ORDER.nowMd);
    expect(byName.get("subagent-status")).toBe(
      DEFAULT_INJECTOR_ORDER.subagentStatus,
    );
    expect(byName.get("slack-messages")).toBe(
      DEFAULT_INJECTOR_ORDER.slackMessages,
    );
    expect(byName.get("thread-focus")).toBe(DEFAULT_INJECTOR_ORDER.threadFocus);
  });

  test("a third-party injector at order 25 slots between unified-turn-context (20) and pkb (30)", () => {
    registerPlugin(defaultInjectorsPlugin);

    const middleInjector: Injector = {
      name: "plugin-25",
      order: 25,
      async produce() {
        return null;
      },
    };
    registerPlugin(wrapInPlugin("third-party", [middleInjector]));

    const names = getInjectors().map((i) => i.name);
    expect(names).toEqual([
      "workspace-context", // 10
      "unified-turn-context", // 20
      "plugin-25", // 25 — slots in
      "pkb", // 30
      "now-md", // 40
      "subagent-status", // 50
      "slack-messages", // 60
      "thread-focus", // 70
    ]);
  });

  test("composeInjectorChain returns empty string when every injector opts out", async () => {
    // The default chain is the golden-path: all seven defaults return `null`
    // in this PR, so the composed block is an empty string, matching the
    // pre-PR behavior where no chain existed at all.
    registerPlugin(defaultInjectorsPlugin);

    const composed = await composeInjectorChain(makeTurnContext());
    expect(composed).toBe("");
  });

  test("composeInjectorChain returns empty string when registry is empty", async () => {
    // No plugins registered — the chain is a no-op and must return an empty
    // string (not throw, not undefined). Callers rely on this to treat the
    // chain as purely additive.
    const composed = await composeInjectorChain(makeTurnContext());
    expect(composed).toBe("");
  });

  test("composeInjectorChain concatenates non-null blocks in order with blank-line separators", async () => {
    const first: Injector = {
      name: "a",
      order: 5,
      async produce(): Promise<InjectionBlock> {
        return { id: "a", text: "BLOCK_A" };
      },
    };
    const second: Injector = {
      name: "b",
      order: 15,
      async produce(): Promise<InjectionBlock> {
        return { id: "b", text: "BLOCK_B" };
      },
    };
    const skipped: Injector = {
      name: "c",
      order: 25,
      async produce() {
        return null;
      },
    };
    // Register the higher-order one first to prove the chain sorts by `order`
    // rather than registration order.
    registerPlugin(wrapInPlugin("higher", [second]));
    registerPlugin(wrapInPlugin("lower", [first]));
    registerPlugin(wrapInPlugin("opts-out", [skipped]));

    const composed = await composeInjectorChain(makeTurnContext());
    expect(composed).toBe("BLOCK_A\n\nBLOCK_B");
  });

  test("composeInjectorChain skips blocks with empty text", async () => {
    const emitEmpty: Injector = {
      name: "empty",
      order: 10,
      async produce(): Promise<InjectionBlock> {
        return { id: "empty", text: "" };
      },
    };
    const emitReal: Injector = {
      name: "real",
      order: 20,
      async produce(): Promise<InjectionBlock> {
        return { id: "real", text: "CONTENT" };
      },
    };
    registerPlugin(wrapInPlugin("plugin", [emitEmpty, emitReal]));

    const composed = await composeInjectorChain(makeTurnContext());
    expect(composed).toBe("CONTENT");
  });

  test("applyRuntimeInjections leaves injectorChainBlock undefined when defaults opt out", async () => {
    // Golden-path snapshot: with only default injectors (all returning
    // `null`), `applyRuntimeInjections` reports no chain output, so the
    // historical `blocks` shape is preserved byte-for-byte for any
    // conversation that doesn't involve third-party injectors.
    registerPlugin(defaultInjectorsPlugin);

    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    const result = await applyRuntimeInjections(runMessages, {
      turnContext: makeTurnContext(),
    });

    expect(result.blocks.injectorChainBlock).toBeUndefined();
    // Sanity: the message array is untouched when no options fire (no
    // hardcoded branches apply, and the chain contributed nothing).
    expect(result.messages).toEqual(runMessages);
  });

  test("applyRuntimeInjections surfaces third-party injector output on blocks.injectorChainBlock", async () => {
    registerPlugin(defaultInjectorsPlugin);
    registerPlugin(
      wrapInPlugin("third-party-25", [
        {
          name: "plugin-25",
          order: 25,
          async produce(): Promise<InjectionBlock> {
            return { id: "plugin-25", text: "THIRD_PARTY_BLOCK" };
          },
        },
      ]),
    );

    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];

    const result = await applyRuntimeInjections(runMessages, {
      turnContext: makeTurnContext(),
    });

    expect(result.blocks.injectorChainBlock).toBe("THIRD_PARTY_BLOCK");
  });

  test("applyRuntimeInjections without turnContext skips the chain entirely", async () => {
    // Backwards compatibility: callers that predate PR 21 don't pass
    // `turnContext`. The chain must be inert in that case so pre-existing
    // call sites keep producing identical output.
    registerPlugin(defaultInjectorsPlugin);
    registerPlugin(
      wrapInPlugin("third-party-25", [
        {
          name: "plugin-25",
          order: 25,
          async produce(): Promise<InjectionBlock> {
            return { id: "plugin-25", text: "SHOULD_BE_SKIPPED" };
          },
        },
      ]),
    );

    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];

    const result = await applyRuntimeInjections(runMessages, {});

    expect(result.blocks.injectorChainBlock).toBeUndefined();
  });
});
