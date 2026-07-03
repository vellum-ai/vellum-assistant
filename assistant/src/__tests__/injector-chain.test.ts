/**
 * Tests for the static runtime-injection chain.
 *
 * Covers:
 *
 * 1. The registered default injectors are listed in the
 *    documented order (disk-pressure-warning → workspace-context →
 *    background-turn → unified-turn-context → config-quarantine-notice →
 *    pkb-context → pkb-reminder → memory-v2-static → now-md →
 *    active-documents → document-comments → subagent-status →
 *    slack-messages → thread-focus).
 * 2. The assembled {@link injectorChain} sorts the defaults together with the
 *    memory-v3 injector by ascending `order`, so memory-v3 (order 1000) lands
 *    last.
 * 3. `composeInjectorChain` yields an empty string when every injector opts out
 *    — the golden-path conversation state where all defaults return `null`.
 * 4. `applyRuntimeInjections` splices each default injector's block into the
 *    correct position in the per-turn message array, and gates blocks by
 *    injection mode.
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

// `applyRuntimeInjections` computes the `<turn_context>` `current_time` live
// via `formatTurnTimestamp`; pin it so the rendered block matches the
// deterministic `buildUnifiedTurnContextBlock` expectations below. The rest of
// the module (timezone canonicalization/resolution) keeps its real behavior.
const FIXED_TURN_TIMESTAMP = "2026-04-22";
const realDateContext = await import("../daemon/date-context.js");
mock.module("../daemon/date-context.js", () => ({
  ...realDateContext,
  formatTurnTimestamp: () => FIXED_TURN_TIMESTAMP,
}));

const {
  applyRuntimeInjections,
  buildSubagentStatusBlock,
  composeInjectorChain,
} = await import("../daemon/conversation-runtime-assembly.js");
const { DEFAULT_INJECTOR_ORDER } =
  await import("../plugins/defaults/injector-order.js");
const { getRegisteredInjectors } =
  await import("../plugins/injector-registry.js");
const { registerDefaultPluginInjectors } =
  await import("../plugins/defaults/index.js");
import { eq } from "drizzle-orm";

import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import { buildPkbReminder } from "../daemon/pkb-reminder-builder.js";
import {
  type SlackMessageMetadata,
  writeSlackMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations, messages } from "../persistence/schema/index.js";
import { getPkbRoot } from "../plugins/defaults/memory/pkb/types.js";
import { buildUnifiedTurnContextBlock } from "../plugins/defaults/turn-context/unified-turn-context.js";
import type { TurnContext } from "../plugins/types.js";
import type { Message } from "../providers/types.js";
import { getSubagentManager } from "../subagent/index.js";
import type { SubagentState } from "../subagent/types.js";
import { getWorkspacePromptPath } from "../util/platform.js";

// `applyRuntimeInjections` self-resolves the Slack active-thread focus block
// from the persisted message rows, so the schema must exist for Slack-channel
// turns; with no seeded rows the focus loader resolves to null.
await initializeDb();

// `makeTurnContext` and the workspace registry seed share this id so the
// `workspace-context` injector resolves the seeded block for the turn.
const TEST_CONVERSATION_ID = "conv-test-1";
// Conversation id the fallback-context test registers its live conversation
// under; passed explicitly now that `applyRuntimeInjections` requires the
// caller to name the conversation it resolves through.
const FALLBACK_CONVERSATION_ID = "runtime-assembly-fallback";

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

// The workspace-context injector sources its block off the live `Conversation`
// looked up by `conversationId`. Seed a fake instance carrying a non-dirty
// workspace cache under the id `makeTurnContext()` uses so the injector emits
// the block; `clearConversations()` between tests keeps suites that assert the
// workspace block is absent unaffected.
function seedWorkspaceContext(
  text: string,
  currentTurnTemporalSnapshot?: {
    clientTimezone: string | null;
  },
  interfaceName?: string,
): void {
  setConversation(TEST_CONVERSATION_ID, {
    conversationId: TEST_CONVERSATION_ID,
    workingDir: "/sandbox",
    workspaceTopLevelContext: text,
    workspaceTopLevelDirty: false,
    currentTurnTemporalSnapshot,
    currentTurnInterfaceContext: interfaceName
      ? {
          userMessageInterface: interfaceName,
          assistantMessageInterface: interfaceName,
        }
      : undefined,
  } as never);
}

// `applyRuntimeInjections` gates the `<turn_context>` block on the live
// conversation's frozen `currentTurnTemporalSnapshot` (computing `current_time`
// live). Tests that drive the chain without a caller-supplied `turnContext`
// fall back to the runtime-assembly fallback conversation, so seed the snapshot
// there.
function seedFallbackTemporalSnapshot(): void {
  setConversation("runtime-assembly-fallback", {
    conversationId: "runtime-assembly-fallback",
    workingDir: "/sandbox",
    workspaceTopLevelContext: "",
    workspaceTopLevelDirty: false,
    currentTurnTemporalSnapshot: { clientTimezone: null },
  } as never);
}

// Persist Slack-channel rows for the turn conversation so
// `applyRuntimeInjections` self-resolves the chronological transcript from
// conversation state, exactly as production does (the slack-messages injector
// reads the live conversation rather than receiving a pre-built transcript).
const SLACK_CHANNEL_ID = "C0123CHANNEL";
function seedSlackChannelRows(
  conversationId: string,
  rows: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    channelTs: string;
    displayName: string;
    createdAt: number;
  }>,
): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({ id: conversationId, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  for (const r of rows) {
    const meta: SlackMessageMetadata = {
      source: "slack",
      channelId: SLACK_CHANNEL_ID,
      channelTs: r.channelTs,
      eventKind: "message",
      displayName: r.displayName,
    } as SlackMessageMetadata;
    db.insert(messages)
      .values({
        id: r.id,
        conversationId,
        role: r.role,
        content: JSON.stringify([{ type: "text", text: r.text }]),
        createdAt: r.createdAt,
        metadata: JSON.stringify({
          provenanceTrustClass: "guardian",
          slackMeta: writeSlackMetadata(meta),
        }),
      })
      .run();
  }
}

// `applyRuntimeInjections` self-resolves the `<active_subagents>` block from the
// global subagent manager keyed by the conversation, so tests seed children
// directly into the manager's private maps rather than threading a pre-built
// block through options.
interface SubagentManagerTestInternals {
  subagents: Map<string, { state: SubagentState }>;
  parentToChildren: Map<string, Set<string>>;
}

function makeSubagentState(
  id: string,
  label: string,
  status: SubagentState["status"],
): SubagentState {
  return {
    config: {
      id,
      parentConversationId: TEST_CONVERSATION_ID,
      label,
      objective: "obj",
    },
    status,
    conversationId: `conv-${id}`,
    isFork: false,
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    completedAt: status === "completed" ? Date.now() : undefined,
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  };
}

function seedSubagentChild(
  parentConversationId: string,
  state: SubagentState,
): void {
  const internals =
    getSubagentManager() as unknown as SubagentManagerTestInternals;
  internals.subagents.set(state.config.id, { state });
  const ids =
    internals.parentToChildren.get(parentConversationId) ?? new Set<string>();
  ids.add(state.config.id);
  internals.parentToChildren.set(parentConversationId, ids);
}

function clearSeededSubagents(): void {
  const internals =
    getSubagentManager() as unknown as SubagentManagerTestInternals;
  internals.subagents.clear();
  internals.parentToChildren.clear();
}

describe("injector chain", () => {
  beforeEach(() => {
    registerDefaultPluginInjectors();
    clearPkbContent();
    clearNowScratchpad();
    clearConversations();
    clearSeededSubagents();
    const db = getDb();
    db.delete(messages)
      .where(eq(messages.conversationId, TEST_CONVERSATION_ID))
      .run();
    db.delete(conversations)
      .where(eq(conversations.id, TEST_CONVERSATION_ID))
      .run();
  });

  test("the registered defaults appear in the documented order", () => {
    // The non-v3 defaults (order < 1000) come from the memory plugin and the
    // domain plugins; the registry unions and sorts them.
    const names = getRegisteredInjectors()
      .filter((i) => i.order < 1000)
      .map((i) => i.name);
    expect(names).toEqual([
      "disk-pressure-warning",
      "workspace-context",
      "background-turn",
      "unified-turn-context",
      "config-quarantine-notice",
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

  test("default injector order constants match the listed order values", () => {
    const byName = new Map(
      getRegisteredInjectors().map((i) => [i.name, i.order]),
    );
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
    expect(byName.get("config-quarantine-notice")).toBe(
      DEFAULT_INJECTOR_ORDER.configQuarantineNotice,
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

  test("the injector chain sorts the defaults plus the memory-v3 injectors by ascending order", () => {
    // The assembled chain merges the defaults with the two memory-v3
    // injectors and sorts by `order`, so the cards injector (order 1000) and
    // the spotlight injector (order 1001) sit last, in that order.
    const chain = getRegisteredInjectors();
    const orders = chain.map((i) => i.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    // The two memory-v3 injectors (order 1000 / 1001) sort last, in that order.
    expect(chain.map((i) => i.name).slice(-2)).toEqual([
      "memory-v3-shadow",
      "memory-v3-spotlight",
    ]);
  });

  test("composeInjectorChain returns empty string when every injector opts out", async () => {
    // The default chain is the golden-path: every default returns `null` on an
    // empty turn context, so the composed block is an empty string.
    const composed = await composeInjectorChain(makeTurnContext());
    expect(composed).toBe("");
  });

  // ── Integration tests ───────────────────────────────────────────────
  //
  // These assertions exercise the real per-turn injection pipeline with
  // the static chain active, verifying that each default injector emits
  // the expected content in the correct position in the final user-tail
  // content.

  test("applyRuntimeInjections leaves injectorChainBlock undefined when defaults opt out", async () => {
    // Golden-path snapshot: with the static chain (all defaults returning
    // `null`), `applyRuntimeInjections` reports no chain output, so the
    // historical `blocks` shape is preserved byte-for-byte for any
    // conversation that doesn't drive a known injector.
    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
    });

    expect(result.blocks.injectorChainBlock).toBeUndefined();
    // Sanity: the message array is untouched when no options fire (no
    // hardcoded branches apply, and the chain contributed nothing).
    expect(result.messages).toEqual(runMessages);
  });

  test("applyRuntimeInjections without turnContext still runs the chain under a synthesized context", async () => {
    // The static chain is the canonical injection path, so
    // `applyRuntimeInjections` must drive it even when the caller doesn't
    // pass a `turnContext`. With no caller-supplied context the assembly
    // falls back to the runtime-assembly fallback conversation id, so the
    // live-sourced unified turn context resolves off that conversation.
    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];

    // The fallback conversation has no per-turn or origin interface, so the
    // unified-turn-context injector resolves the interface label to the `web`
    // default.
    const synthesizedBlock = buildUnifiedTurnContextBlock({
      timestamp: FIXED_TURN_TIMESTAMP,
      interfaceName: "web",
    });
    seedFallbackTemporalSnapshot();
    const result = await applyRuntimeInjections(runMessages, {
      conversationId: FALLBACK_CONVERSATION_ID,
    });

    // The unified-turn-context injector fires even without a caller-supplied
    // turnContext, proving the chain runs under the synthesized context.
    expect(result.blocks.unifiedTurnContext).toBe(synthesizedBlock);
  });

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
    const pkbContent = "essentials of the project";
    seedPkbContent(pkbContent);
    const nowContent = "Current focus: shipping G2.1";
    seedNowScratchpad(nowContent);

    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "What next?" }] },
    ];

    const workspaceText =
      "<workspace>\nRoot: /sandbox\nDirectories: src, lib\n</workspace>";
    // The interface label flows through the options bag; the timestamp is
    // computed live at injection time.
    const unifiedTurn = buildUnifiedTurnContextBlock({
      timestamp: FIXED_TURN_TIMESTAMP,
      interfaceName: "macos",
    });
    // A completed child renders deterministically (no elapsed clock), so the
    // block the injector self-resolves matches `buildSubagentStatusBlock`.
    const subagentChild = makeSubagentState("sub-1", "worker", "completed");
    seedSubagentChild(TEST_CONVERSATION_ID, subagentChild);
    const subagentBlock = buildSubagentStatusBlock([subagentChild])!;

    seedWorkspaceContext(workspaceText, { clientTimezone: null }, "macos");
    const result = await applyRuntimeInjections(runMessages, {
      ...makeTurnContext(),
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

  test("slack-messages injector replaces runMessages with the self-resolved transcript", async () => {
    // End-to-end verification for the `replace-run-messages` placement: a
    // Slack channel turn swaps the incoming `runMessages` for the
    // self-resolved chronological transcript before the after-memory/append
    // placements run. Memory-prefix blocks from the original tail are
    // re-prepended onto the new tail so PKB / NOW splices still find them.
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
    seedSlackChannelRows(TEST_CONVERSATION_ID, [
      {
        id: "s1",
        role: "user",
        text: "kickoff",
        channelTs: "1700000000.000001",
        displayName: "alice",
        createdAt: 1700000000_000,
      },
      {
        id: "s2",
        role: "user",
        text: "What's happening?",
        channelTs: "1700000005.000001",
        displayName: "user",
        createdAt: 1700000005_000,
      },
    ]);
    setConversation(TEST_CONVERSATION_ID, {
      conversationId: TEST_CONVERSATION_ID,
      workingDir: "/sandbox",
      workspaceTopLevelContext: "",
      workspaceTopLevelDirty: false,
      trustContext: { trustClass: "guardian" },
      channelCapabilities: {
        channel: "slack",
        dashboardCapable: false,
        supportsDynamicUi: false,
        supportsVoiceInput: false,
        chatType: "channel",
      },
    } as never);
    const result = await applyRuntimeInjections(originalRun, {
      ...makeTurnContext(),
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
    expect(texts[texts.length - 1]).toContain("What's happening?");
  });

  test("minimal mode: only unified-turn-context survives; workspace/PKB/NOW/subagent are skipped", async () => {
    // Validates the `minimal` injection-mode gating. Every default
    // injector except `unified-turn-context` checks `mode === "full"` and
    // opts out in minimal mode, so the tail should carry only the turn
    // context prepend plus any non-injector hardcoded content (none
    // here).
    // Empty workspace text keeps that injector inert while the unified
    // turn-context timestamp flows through the conversation's frozen temporal
    // snapshot. The interface label is sourced from the live conversation,
    // which has no per-turn or origin interface here and so resolves to the
    // `web` default. A live child subagent is seeded so the subagent-status
    // injector has a block to skip.
    const minimalTurnBlock = buildUnifiedTurnContextBlock({
      timestamp: FIXED_TURN_TIMESTAMP,
      interfaceName: "web",
    });
    seedWorkspaceContext("", { clientTimezone: null });
    seedSubagentChild(
      TEST_CONVERSATION_ID,
      makeSubagentState("sub-1", "worker", "running"),
    );
    const result = await applyRuntimeInjections(
      [
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
      ],
      {
        ...makeTurnContext(),
        mode: "minimal",
      },
    );

    const tail = result.messages[result.messages.length - 1];
    const texts = tail.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    expect(texts).toEqual([minimalTurnBlock, "hi"]);
    expect(result.blocks.unifiedTurnContext).toBe(minimalTurnBlock);
    expect(result.blocks.workspaceBlock).toBeUndefined();
    expect(result.blocks.pkbContextBlock).toBeUndefined();
    expect(result.blocks.nowScratchpadBlock).toBeUndefined();
  });
});
