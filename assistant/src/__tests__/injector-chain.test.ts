/**
 * Tests for the plugin-driven runtime-injection chain (PR 21 of the
 * `agent-plugin-system` plan).
 *
 * Covers:
 *
 * 1. The ten default injectors registered by `defaultInjectorsPlugin` come
 *    back from `getInjectors()` in the documented order
 *    (disk-pressure-warning → workspace-context → unified-turn-context →
 *    pkb-context → pkb-reminder → memory-v2-static → now-md →
 *    subagent-status → slack-messages → thread-focus).
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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// This test exercises v1 PKB injection. `config.memory.v2.enabled`
// (default `true`) makes the PKB injector go silent — force it off here
// so the v1 injection chain assertions stay meaningful.
const realLoader = await import("../config/loader.js");
const realGetConfig = realLoader.getConfig;
mock.module("../config/loader.js", () => ({
  ...realLoader,
  getConfig: () => {
    const real = realGetConfig();
    return {
      ...real,
      memory: { ...real.memory, v2: { ...real.memory.v2, enabled: false } },
    };
  },
}));

const { applyRuntimeInjections, composeInjectorChain } =
  await import("../daemon/conversation-runtime-assembly.js");
const { DEFAULT_INJECTOR_ORDER, defaultInjectorsPlugin } =
  await import("../plugins/defaults/injectors/register.js");
import {
  registerConversationWorkspace,
  unregisterConversationWorkspace,
  type WorkspaceConversationContext,
} from "../daemon/conversation-workspace.js";
import { buildPkbReminder } from "../daemon/pkb-reminder-builder.js";
import { getPkbRoot } from "../memory/pkb/types.js";
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
import { getWorkspacePromptPath } from "../util/platform.js";

// `makeTurnContext` and the workspace registry seed share this id so the
// `workspace-context` injector resolves the seeded block for the turn.
const TEST_CONVERSATION_ID = "conv-test-1";

/** A fake TurnContext sufficient for driving `composeInjectorChain`. */
function makeTurnContext(): TurnContext {
  return {
    requestId: "req-test-1",
    conversationId: TEST_CONVERSATION_ID,
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
    },
    injectors,
  };
}

// The pkb-context and pkb-reminder injectors both derive PKB-active state from
// the workspace itself — `readPkbContext()` returning content behind the
// personal-memory trust gate — rather than from a threaded flag. Seed the file
// with exactly the content the test expects so the `<knowledge_base>` block
// renders deterministically; clear it between tests so suites that assert the
// PKB injectors are absent stay unaffected.
function seedPkbContent(content: string): void {
  const root = getPkbRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "INDEX.md"), content, "utf-8");
}

function clearPkbContent(): void {
  rmSync(getPkbRoot(), { recursive: true, force: true });
}

// The now-md injector sources NOW.md from the workspace itself — behind the
// personal-memory trust gate and the `scratchpadInjection` config toggle —
// rather than from a threaded option. Seed the file so the injector fires;
// clear it between tests so suites that assert NOW.md is absent stay
// unaffected.
function seedNowScratchpad(content: string): void {
  const nowPath = getWorkspacePromptPath("NOW.md");
  mkdirSync(dirname(nowPath), { recursive: true });
  writeFileSync(nowPath, content, "utf-8");
}

function clearNowScratchpad(): void {
  rmSync(getWorkspacePromptPath("NOW.md"), { force: true });
}

// The workspace-context injector sources its block from the per-conversation
// workspace registry keyed by `conversationId`. Register a non-dirty context
// under the id `makeTurnContext()` uses so the injector emits the block;
// unregister between tests so suites that assert the workspace block is absent
// stay unaffected.
let registeredWorkspace: WorkspaceConversationContext | null = null;

function seedWorkspaceContext(text: string): void {
  registeredWorkspace = {
    conversationId: TEST_CONVERSATION_ID,
    workingDir: "/sandbox",
    workspaceTopLevelContext: text,
    workspaceTopLevelDirty: false,
  };
  registerConversationWorkspace(registeredWorkspace);
}

function clearWorkspaceContext(): void {
  if (registeredWorkspace) {
    unregisterConversationWorkspace(registeredWorkspace);
    registeredWorkspace = null;
  }
}

describe("injector chain", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    clearPkbContent();
    clearNowScratchpad();
    clearWorkspaceContext();
  });

  test("defaultInjectorsPlugin registers the defaults in the documented order", () => {
    registerPlugin(defaultInjectorsPlugin);

    const names = getInjectors().map((i) => i.name);
    expect(names).toEqual([
      "disk-pressure-warning",
      "workspace-context",
      "background-turn",
      "unified-turn-context",
      "pkb-context",
      "pkb-reminder",
      "memory-v2-static",
      "now-md",
      "active-documents",
      "document-comments",
      "subagent-status",
      "slack-messages",
      "thread-focus",
    ]);
  });

  test("default injector order constants match the registered order values", () => {
    registerPlugin(defaultInjectorsPlugin);

    const byName = new Map(getInjectors().map((i) => [i.name, i.order]));
    expect(byName.get("disk-pressure-warning")).toBe(
      DEFAULT_INJECTOR_ORDER.diskPressureWarning,
    );
    expect(byName.get("workspace-context")).toBe(
      DEFAULT_INJECTOR_ORDER.workspaceContext,
    );
    expect(byName.get("background-turn")).toBe(
      DEFAULT_INJECTOR_ORDER.backgroundTurn,
    );
    expect(byName.get("unified-turn-context")).toBe(
      DEFAULT_INJECTOR_ORDER.unifiedTurnContext,
    );
    expect(byName.get("pkb-context")).toBe(DEFAULT_INJECTOR_ORDER.pkbContext);
    expect(byName.get("pkb-reminder")).toBe(DEFAULT_INJECTOR_ORDER.pkbReminder);
    expect(byName.get("memory-v2-static")).toBe(
      DEFAULT_INJECTOR_ORDER.memoryV2Static,
    );
    expect(byName.get("now-md")).toBe(DEFAULT_INJECTOR_ORDER.nowMd);
    expect(byName.get("active-documents")).toBe(
      DEFAULT_INJECTOR_ORDER.activeDocuments,
    );
    expect(byName.get("subagent-status")).toBe(
      DEFAULT_INJECTOR_ORDER.subagentStatus,
    );
    expect(byName.get("slack-messages")).toBe(
      DEFAULT_INJECTOR_ORDER.slackMessages,
    );
    expect(byName.get("thread-focus")).toBe(DEFAULT_INJECTOR_ORDER.threadFocus);
  });

  test("a third-party injector at order 25 slots between unified-turn-context (20) and pkb-context (30)", () => {
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
      "disk-pressure-warning", // 5
      "workspace-context", // 10
      "background-turn", // 15
      "unified-turn-context", // 20
      "plugin-25", // 25 — slots in
      "pkb-context", // 30
      "pkb-reminder", // 35
      "memory-v2-static", // 38
      "now-md", // 40
      "active-documents", // 45
      "document-comments", // 46
      "subagent-status", // 50
      "slack-messages", // 60
      "thread-focus", // 70
    ]);
  });

  test("composeInjectorChain returns empty string when every injector opts out", async () => {
    // The default chain is the golden-path: all ten defaults return `null`
    // on an empty turn context, so the composed block is an empty string.
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

  test("applyRuntimeInjections without turnContext still runs the chain under a synthesized context", async () => {
    // Post-G2.1 semantics: the default chain is the canonical injection
    // path, so `applyRuntimeInjections` must drive it even when the caller
    // doesn't pass a `turnContext`. Test/legacy call sites that rely on
    // option fields to opt into injections continue to work because the
    // synthesized fallback exposes `injectionInputs` built from `options`.
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

    const result = await applyRuntimeInjections(runMessages, {});

    // Third-party injector runs even without a caller-supplied turnContext.
    expect(result.blocks.injectorChainBlock).toBe("THIRD_PARTY_BLOCK");
  });

  // ── Integration tests ───────────────────────────────────────────────
  //
  // These assertions exercise the real per-turn injection pipeline with
  // the default chain active, verifying that each default injector emits
  // the expected content and that a third-party injector registered at a
  // fractional `order` slots into the correct position in the final
  // user-tail content.

  test("golden-path: default chain injects workspace + unified-turn + PKB + NOW + subagent in the correct positions", async () => {
    // Canonical golden-path conversation state: full mode, non-Slack
    // channel, workspace context + unified-turn + PKB + NOW + subagent
    // all active. The expected final tail content ordering is:
    //
    //   [workspace]            ← prepend order 10 (topmost)
    //   [unified-turn]         ← prepend order 20
    //   [now-md]               ← after-memory-prefix order 40 (highest order, closest to memory)
    //   [pkb-reminder]         ← after-memory-prefix order 35
    //   [pkb-context]          ← after-memory-prefix order 30
    //   [user text]
    //   [subagent]             ← append order 50
    //
    // No memory prefix blocks in this scenario, so after-memory-prefix
    // lands right at the head of the user-text cluster. The pkb-context and
    // pkb-reminder injectors both fire off the seeded PKB content under the
    // guardian trust on `makeTurnContext()` — pkb-context renders the seeded
    // `<knowledge_base>` body, pkb-reminder the flat `<system_reminder>`
    // (no graph handle is registered, so it has no search hints).
    registerPlugin(defaultInjectorsPlugin);

    const pkbContent = "essentials of the project";
    seedPkbContent(pkbContent);
    const nowContent = "Current focus: shipping G2.1";
    seedNowScratchpad(nowContent);

    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "What next?" }] },
    ];

    const workspaceText =
      "<workspace>\nRoot: /sandbox\nDirectories: src, lib\n</workspace>";
    const unifiedTurn =
      "<turn_context>\ncurrent_time: 2026-04-22\ninterface: macos\n</turn_context>";
    const subagentBlock =
      '<active_subagents>\n- [running] "worker" (sub-1) | elapsed: 5s\n</active_subagents>';

    seedWorkspaceContext(workspaceText);
    const result = await applyRuntimeInjections(runMessages, {
      turnContext: makeTurnContext(),
      unifiedTurnContext: unifiedTurn,
      subagentStatusBlock: subagentBlock,
    });

    // Extract the tail user message content as a list of text strings.
    const tail = result.messages[result.messages.length - 1];
    expect(tail.role).toBe("user");
    const texts = tail.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    // Positional assertions — each block lands where the injector's
    // placement says it does.
    expect(texts[0]).toBe(workspaceText); // prepend order 10
    expect(texts[1]).toBe(unifiedTurn); // prepend order 20
    // NOW, pkb-reminder and pkb-context are all after-memory-prefix; higher
    // order splices closer to the memory prefix, so NOW sits above the
    // reminder, which sits above the knowledge_base.
    expect(texts[2]).toBe(
      `<NOW.md Always keep this up to date; keep under 10 lines>\n${nowContent}\n</NOW.md>`,
    );
    expect(texts[3]).toBe(buildPkbReminder([])); // pkb-reminder order 35
    expect(texts[4]).toBe(`<knowledge_base>\n${pkbContent}\n</knowledge_base>`);
    expect(texts[5]).toBe("What next?"); // user's typed text
    expect(texts[6]).toBe(subagentBlock); // append order 50
    expect(texts).toHaveLength(7);

    // Block metadata captures for DB persistence — one field per default
    // injector whose output the loader rehydrates from message metadata.
    expect(result.blocks.workspaceBlock).toBe(workspaceText);
    expect(result.blocks.unifiedTurnContext).toBe(unifiedTurn);
    expect(result.blocks.nowScratchpadBlock).toBe(
      `<NOW.md Always keep this up to date; keep under 10 lines>\n${nowContent}\n</NOW.md>`,
    );
    expect(result.blocks.pkbContextBlock).toBe(
      `<knowledge_base>\n${pkbContent}\n</knowledge_base>`,
    );
  });

  test("third-party prepend injector at order 15 lands between workspace (10) and unified-turn-context (20) in the final message", async () => {
    // Proves the extensibility contract end-to-end: a plugin-registered
    // injector at `order: 15` with `placement: "prepend-user-tail"` slots
    // between the workspace prepend (order 10) and the unified-turn
    // prepend (order 20). Because descending-order application for
    // prepends puts the lowest-`order` injector topmost, workspace ends
    // up on top, then plugin@15, then unified-turn.
    registerPlugin(defaultInjectorsPlugin);
    registerPlugin(
      wrapInPlugin("third-party-15-prepend", [
        {
          name: "plugin-15",
          order: 15, // between workspace (10) and unified-turn (20)
          async produce(): Promise<InjectionBlock> {
            return {
              id: "plugin-15",
              text: "<plugin_block_15/>",
              placement: "prepend-user-tail",
            };
          },
        },
      ]),
    );

    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];

    const workspaceText = "<workspace>\nRoot: /sandbox\n</workspace>";
    const unifiedTurn =
      "<turn_context>\ncurrent_time: 2026-04-22\n</turn_context>";

    seedWorkspaceContext(workspaceText);
    const result = await applyRuntimeInjections(runMessages, {
      turnContext: makeTurnContext(),
      unifiedTurnContext: unifiedTurn,
    });

    const tail = result.messages[result.messages.length - 1];
    expect(tail.role).toBe("user");
    const texts = tail.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    // Descending-order application for prepends puts the lowest-`order`
    // injector topmost, so order 10 (workspace) ends up on top, then
    // plugin@15 below it, then unified-turn (order 20) below that.
    expect(texts[0]).toBe(workspaceText);
    expect(texts[1]).toBe("<plugin_block_15/>");
    expect(texts[2]).toBe(unifiedTurn);
    expect(texts[3]).toBe("hi");
  });

  test("slack-messages injector replaces runMessages when a chronological transcript is provided", async () => {
    // End-to-end verification for the `replace-run-messages` placement:
    // a Slack channel turn with a pre-rendered chronological transcript
    // swaps the incoming `runMessages` for the transcript before the
    // after-memory/append placements run. Memory-prefix blocks from the
    // original tail are re-prepended onto the new tail so PKB / NOW
    // splices still find them.
    registerPlugin(defaultInjectorsPlugin);

    const originalRun: Message[] = [
      {
        role: "user",
        content: [
          // A memory prefix block that must be carried over to the Slack
          // transcript's tail so after-memory splices still fire.
          {
            type: "text",
            text: "<memory __injected>\nrecalled fact\n</memory>",
          },
          { type: "text", text: "What's happening?" },
        ],
      },
    ];
    const slackTranscript: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "[12:00 alice]: kickoff" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "[12:05 @user]: What's happening?" }],
      },
    ];

    const result = await applyRuntimeInjections(originalRun, {
      turnContext: makeTurnContext(),
      channelCapabilities: {
        channel: "slack",
        dashboardCapable: false,
        supportsDynamicUi: false,
        supportsVoiceInput: false,
        chatType: "channel",
      },
      slackChronologicalMessages: slackTranscript,
    });

    // The swap replaced the run-messages wholesale but preserved the
    // memory-prefix blocks onto the new tail user message.
    expect(result.messages).toHaveLength(2);
    const slackTail = result.messages[result.messages.length - 1];
    expect(slackTail.role).toBe("user");
    const texts = slackTail.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    // Hardcoded channelCapabilities injection prepends first (Slack is a
    // constrained channel), then the carried memory-prefix blocks, then
    // the slack transcript's original user text.
    expect(texts.some((t) => t.startsWith("<channel_capabilities>"))).toBe(
      true,
    );
    expect(texts).toContain("<memory __injected>\nrecalled fact\n</memory>");
    expect(texts[texts.length - 1]).toBe("[12:05 @user]: What's happening?");
  });

  test("minimal mode: only unified-turn-context survives; workspace/PKB/NOW/subagent are skipped", async () => {
    // Validates the `minimal` injection-mode gating. Every default
    // injector except `unified-turn-context` checks `mode === "full"` and
    // opts out in minimal mode, so the tail should carry only the turn
    // context prepend plus any non-injector hardcoded content (none
    // here).
    registerPlugin(defaultInjectorsPlugin);

    const result = await applyRuntimeInjections(
      [
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
      ],
      {
        turnContext: makeTurnContext(),
        mode: "minimal",
        unifiedTurnContext: "<turn_context>...</turn_context>",
        subagentStatusBlock: "<active_subagents>...</active_subagents>",
      },
    );

    const tail = result.messages[result.messages.length - 1];
    const texts = tail.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    expect(texts).toEqual(["<turn_context>...</turn_context>", "hi"]);
    expect(result.blocks.unifiedTurnContext).toBe(
      "<turn_context>...</turn_context>",
    );
    expect(result.blocks.workspaceBlock).toBeUndefined();
    expect(result.blocks.pkbContextBlock).toBeUndefined();
    expect(result.blocks.nowScratchpadBlock).toBeUndefined();
  });
});
