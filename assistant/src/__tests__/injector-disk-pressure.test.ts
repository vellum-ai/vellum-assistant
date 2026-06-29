import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import * as dateContext from "../daemon/date-context.js";

// `applyRuntimeInjections` computes the `<turn_context>` `current_time` live via
// `formatTurnTimestamp`; pin it so the rendered block matches the deterministic
// `buildUnifiedTurnContextBlock` expectation below. The rest of the module
// (timezone canonicalization/resolution) keeps its real behavior.
const FIXED_TURN_TIMESTAMP = "2026-04-02T12:00:00Z";
mock.module("../daemon/date-context.js", () => ({
  ...dateContext,
  formatTurnTimestamp: () => FIXED_TURN_TIMESTAMP,
}));

import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import type { ChannelCapabilities } from "../daemon/conversation-runtime-assembly.js";
import {
  applyRuntimeInjections,
  stripInjectionsForCompaction,
} from "../daemon/conversation-runtime-assembly.js";
import {
  type SlackMessageMetadata,
  writeSlackMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations, messages } from "../persistence/schema/index.js";
import { registerDefaultPluginInjectors } from "../plugins/defaults/index.js";
import { DEFAULT_INJECTOR_ORDER } from "../plugins/defaults/injector-order.js";
import { buildUnifiedTurnContextBlock } from "../plugins/defaults/turn-context/unified-turn-context.js";
import {
  DISK_PRESSURE_WARNING_PROMPT,
  workspaceInjectors,
} from "../plugins/defaults/workspace/injectors.js";
import type { Injector, TurnContext } from "../plugins/types.js";
import type { Message } from "../providers/types.js";

// `applyRuntimeInjections` self-resolves the Slack active-thread focus block
// from the persisted message rows, so the schema must exist for Slack-channel
// turns; with no seeded rows the focus loader resolves to null.
await initializeDb();

// `makeContext` and the workspace registry seed share this id so the
// `workspace-context` injector resolves the seeded block for the turn.
const TEST_CONVERSATION_ID = "conv-test";

function findInjector(name: string): Injector {
  const injector = workspaceInjectors.find(
    (candidate) => candidate.name === name,
  );
  if (!injector) {
    throw new Error(`injector '${name}' not registered`);
  }
  return injector;
}

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: TEST_CONVERSATION_ID,
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
    ...overrides,
  };
}

function tailTexts(messages: Message[]): string[] {
  const tail = messages[messages.length - 1];
  if (!tail || tail.role !== "user") return [];
  return tail.content
    .filter((block): block is { type: "text"; text: string } => {
      return block.type === "text";
    })
    .map((block) => block.text);
}

const diskPressureInjector = findInjector("disk-pressure-warning");

// The disk-pressure-warning and workspace-context injectors both read their
// per-conversation state off the live `Conversation` looked up by
// `conversationId`. Seed a single fake instance under the id `makeContext()`
// uses, carrying the disk-pressure flag and the workspace top-level cache, so a
// turn can exercise both; the seed helpers mutate and re-register the same
// instance. An empty (non-dirty) workspace cache resolves to no block, so
// disk-pressure-only tests don't trigger a directory scan.
let liveConversation: {
  conversationId: string;
  workingDir: string;
  workspaceTopLevelContext: string | null;
  workspaceTopLevelDirty: boolean;
  diskPressureCleanupModeActive: boolean;
  channelCapabilities?: ChannelCapabilities;
  trustContext?: { trustClass: string };
  currentTurnTemporalSnapshot?: {
    clientTimezone: string | null;
  };
  currentTurnInterfaceContext?: {
    userMessageInterface: string;
    assistantMessageInterface: string;
  };
};

function resetLiveConversation(): void {
  liveConversation = {
    conversationId: TEST_CONVERSATION_ID,
    workingDir: "/workspace",
    workspaceTopLevelContext: "",
    workspaceTopLevelDirty: false,
    diskPressureCleanupModeActive: false,
    trustContext: { trustClass: "guardian" },
    // The unified-turn-context injector sources the interface label from the
    // live conversation's turn interface context; match the expected blocks.
    currentTurnInterfaceContext: {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    },
  };
}

// `applyRuntimeInjections` gates the `<turn_context>` block on the live
// conversation's frozen temporal snapshot (computing `current_time` live), so
// seed it for tests that assert the unified-turn-context block is present.
function seedTemporalSnapshot(): void {
  liveConversation.currentTurnTemporalSnapshot = {
    clientTimezone: null,
  };
  setConversation(TEST_CONVERSATION_ID, liveConversation as never);
}

function seedChannelCapabilities(caps: ChannelCapabilities): void {
  liveConversation.channelCapabilities = caps;
  setConversation(TEST_CONVERSATION_ID, liveConversation as never);
}

function seedDiskPressure(cleanupModeActive: boolean): void {
  liveConversation.diskPressureCleanupModeActive = cleanupModeActive;
  setConversation(TEST_CONVERSATION_ID, liveConversation as never);
}

function seedWorkspaceContext(text: string): void {
  liveConversation.workspaceTopLevelContext = text;
  liveConversation.workspaceTopLevelDirty = false;
  setConversation(TEST_CONVERSATION_ID, liveConversation as never);
}

// Persist Slack-channel rows for the turn conversation so
// `applyRuntimeInjections` self-resolves the chronological transcript from
// conversation state, exactly as production does (the slack-messages injector
// reads the live conversation rather than receiving a pre-built transcript).
const SLACK_CHANNEL_ID = "C0123CHANNEL";
function seedSlackChannelRows(
  rows: Array<{
    id: string;
    text: string;
    channelTs: string;
    displayName: string;
    createdAt: number;
  }>,
): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({ id: TEST_CONVERSATION_ID, createdAt: now, updatedAt: now })
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
        conversationId: TEST_CONVERSATION_ID,
        role: "user",
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

describe("disk-pressure-warning injector", () => {
  beforeEach(() => {
    registerDefaultPluginInjectors();
    clearConversations();
    resetLiveConversation();
    const db = getDb();
    db.delete(messages)
      .where(eq(messages.conversationId, TEST_CONVERSATION_ID))
      .run();
    db.delete(conversations)
      .where(eq(conversations.id, TEST_CONVERSATION_ID))
      .run();
  });

  test("emits the concise cleanup skill prompt during disk pressure cleanup mode", async () => {
    seedDiskPressure(true);
    const block = await diskPressureInjector.produce(makeContext());

    expect(block).toEqual({
      id: "disk-pressure-warning",
      text: DISK_PRESSURE_WARNING_PROMPT,
      placement: "prepend-user-tail",
    });
    expect(diskPressureInjector.order).toBe(
      DEFAULT_INJECTOR_ORDER.diskPressureWarning,
    );
    expect(DISK_PRESSURE_WARNING_PROMPT).toBe(`<disk_pressure_warning>
Storage is critically low and normal work is suspended until space is freed.

Your first user-visible paragraph must warn the user that storage is critically low and normal work is suspended.

Before taking cleanup actions, call \`skill_load\` with \`skill: "system-storage-cleanup"\` and follow the cleanup skill.

Unrelated work remains blocked until disk usage drops below the critical threshold or the guardian explicitly overrides the lock. Background processes and trusted-contact messages remain blocked while this cleanup mode is active.
</disk_pressure_warning>`);
    expect(DISK_PRESSURE_WARNING_PROMPT).toContain("skill_load");
    expect(DISK_PRESSURE_WARNING_PROMPT).toContain("system-storage-cleanup");
    expect(DISK_PRESSURE_WARNING_PROMPT).not.toContain(
      "Prefer safe inspection steps first",
    );
  });

  test("omits the prompt when no cleanup context is registered or it is inactive", async () => {
    await expect(
      diskPressureInjector.produce(makeContext()),
    ).resolves.toBeNull();

    seedDiskPressure(false);
    await expect(
      diskPressureInjector.produce(makeContext()),
    ).resolves.toBeNull();
  });

  test("prepends ahead of workspace and unified turn context in full mode", async () => {
    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "clean up space" }] },
    ];
    const workspace = "<workspace>\nRoot: /workspace\n</workspace>";
    const turnContext = buildUnifiedTurnContextBlock({
      timestamp: "2026-04-02T12:00:00Z",
      interfaceName: "macos",
    });

    seedWorkspaceContext(workspace);
    seedDiskPressure(true);
    seedTemporalSnapshot();
    const result = await applyRuntimeInjections(runMessages, {
      ...makeContext(),
    });

    expect(tailTexts(result.messages).slice(0, 4)).toEqual([
      DISK_PRESSURE_WARNING_PROMPT,
      workspace,
      turnContext,
      "clean up space",
    ]);
    expect(
      result.blocks.injectorChainBlock?.startsWith(
        DISK_PRESSURE_WARNING_PROMPT,
      ),
    ).toBe(true);
  });

  test("survives minimal mode as safety-critical context", async () => {
    const turnContext = buildUnifiedTurnContextBlock({
      timestamp: "2026-04-02T12:00:00Z",
      interfaceName: "macos",
    });
    seedDiskPressure(true);
    seedTemporalSnapshot();
    const result = await applyRuntimeInjections(
      [{ role: "user", content: [{ type: "text", text: "status" }] }],
      {
        ...makeContext(),
        mode: "minimal",
      },
    );

    expect(tailTexts(result.messages)).toEqual([
      DISK_PRESSURE_WARNING_PROMPT,
      turnContext,
      "status",
    ]);
  });

  test("applies after Slack chronological transcript replacement", async () => {
    const originalRun: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "latest raw user text" }],
      },
    ];

    seedSlackChannelRows([
      {
        id: "dp-1",
        text: "earlier",
        channelTs: "1700000000.000001",
        displayName: "user",
        createdAt: 1700000000_000,
      },
      {
        id: "dp-2",
        text: "cleanup?",
        channelTs: "1700000005.000001",
        displayName: "user",
        createdAt: 1700000005_000,
      },
    ]);
    seedDiskPressure(true);
    seedChannelCapabilities({
      channel: "slack",
      dashboardCapable: false,
      supportsDynamicUi: false,
      supportsVoiceInput: false,
      chatType: "channel",
    });
    const result = await applyRuntimeInjections(originalRun, {
      ...makeContext(),
    });

    expect(result.messages).toHaveLength(2);
    const texts = tailTexts(result.messages);
    expect(texts[0]).toBe(DISK_PRESSURE_WARNING_PROMPT);
    expect(
      texts.some((text) => text.startsWith("<channel_capabilities>")),
    ).toBe(true);
    expect(texts[texts.length - 1]).toContain("cleanup?");
  });

  test("compaction strip plus re-apply does not duplicate the warning", async () => {
    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "find large files" }] },
    ];

    seedDiskPressure(true);
    const first = await applyRuntimeInjections(runMessages, {
      ...makeContext(),
    });
    const stripped = stripInjectionsForCompaction(first.messages);
    expect(tailTexts(stripped)).toEqual(["find large files"]);

    const second = await applyRuntimeInjections(stripped, {
      ...makeContext(),
    });
    expect(
      tailTexts(second.messages).filter(
        (text) => text === DISK_PRESSURE_WARNING_PROMPT,
      ),
    ).toHaveLength(1);
  });
});
