import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  applyRuntimeInjections,
  stripInjectionsForCompaction,
} from "../daemon/conversation-runtime-assembly.js";
import {
  registerConversationWorkspace,
  unregisterConversationWorkspace,
  type WorkspaceConversationContext,
} from "../daemon/conversation-workspace.js";
import {
  DEFAULT_INJECTOR_ORDER,
  defaultInjectors,
  DISK_PRESSURE_WARNING_PROMPT,
} from "../plugins/defaults/memory-retrieval/injectors.js";
import type { Injector, TurnContext } from "../plugins/types.js";
import type { Message } from "../providers/types.js";

// `makeContext` and the workspace registry seed share this id so the
// `workspace-context` injector resolves the seeded block for the turn.
const TEST_CONVERSATION_ID = "conv-test";

function findInjector(name: string): Injector {
  const injector = defaultInjectors.find(
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

// The disk-pressure-warning injector reads the cleanup-mode flag off the live
// `Conversation` looked up by `conversationId`. Register a fake conversation
// carrying only that flag under the id `makeContext()` uses so the injector
// emits the block; `clearConversations()` between tests keeps suites that
// assert the block is absent unaffected.
function seedDiskPressure(cleanupModeActive: boolean): void {
  setConversation(TEST_CONVERSATION_ID, {
    diskPressureCleanupModeActive: cleanupModeActive,
  } as never);
}

// The workspace-context injector sources its block from the per-conversation
// workspace registry keyed by `conversationId`. Register a non-dirty context
// under the id `makeContext()` uses so the injector emits the block;
// unregister between tests so suites that assert the block is absent stay
// unaffected.
let registeredWorkspace: WorkspaceConversationContext | null = null;

function seedWorkspaceContext(text: string): void {
  registeredWorkspace = {
    conversationId: TEST_CONVERSATION_ID,
    workingDir: "/workspace",
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

describe("disk-pressure-warning injector", () => {
  beforeEach(() => {
    clearWorkspaceContext();
    clearConversations();
  });

  test("emits the exact cleanup prompt during disk pressure cleanup mode", async () => {
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
Disk usage is critically low: this assistant is in storage cleanup mode because the workspace volume is critically full.

In your first paragraph, warn the user that storage is critically low and that normal work is suspended until space is freed.

Then help the user clean up storage. Prefer safe inspection steps first, such as checking available space and finding large directories. Ask before deleting files or caches unless the user has already clearly approved the specific cleanup action.

Do not work on unrelated tasks until enough space is freed to clear the lock or the user explicitly overrides it. Background processes and messages from trusted contacts are blocked while this cleanup mode is active.
</disk_pressure_warning>`);
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
    const turnContext = "<turn_context>\ninterface: macos\n</turn_context>";

    seedWorkspaceContext(workspace);
    seedDiskPressure(true);
    const result = await applyRuntimeInjections(runMessages, {
      turnContext: makeContext(),
      unifiedTurnContext: turnContext,
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
    seedDiskPressure(true);
    const result = await applyRuntimeInjections(
      [{ role: "user", content: [{ type: "text", text: "status" }] }],
      {
        turnContext: makeContext(),
        mode: "minimal",
        unifiedTurnContext: "<turn_context>...</turn_context>",
      },
    );

    expect(tailTexts(result.messages)).toEqual([
      DISK_PRESSURE_WARNING_PROMPT,
      "<turn_context>...</turn_context>",
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
    const slackTranscript: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "[12:00 user]: earlier" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "[12:01 @assistant]: cleanup?" }],
      },
    ];

    seedDiskPressure(true);
    const result = await applyRuntimeInjections(originalRun, {
      turnContext: makeContext(),
      channelCapabilities: {
        channel: "slack",
        dashboardCapable: false,
        supportsDynamicUi: false,
        supportsVoiceInput: false,
        chatType: "channel",
      },
      slackChronologicalMessages: slackTranscript,
    });

    expect(result.messages).toHaveLength(2);
    const texts = tailTexts(result.messages);
    expect(texts[0]).toBe(DISK_PRESSURE_WARNING_PROMPT);
    expect(
      texts.some((text) => text.startsWith("<channel_capabilities>")),
    ).toBe(true);
    expect(texts[texts.length - 1]).toBe("[12:01 @assistant]: cleanup?");
  });

  test("compaction strip plus re-apply does not duplicate the warning", async () => {
    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "find large files" }] },
    ];

    seedDiskPressure(true);
    const first = await applyRuntimeInjections(runMessages, {
      turnContext: makeContext(),
    });
    const stripped = stripInjectionsForCompaction(first.messages);
    expect(tailTexts(stripped)).toEqual(["find large files"]);

    const second = await applyRuntimeInjections(stripped, {
      turnContext: makeContext(),
    });
    expect(
      tailTexts(second.messages).filter(
        (text) => text === DISK_PRESSURE_WARNING_PROMPT,
      ),
    ).toHaveLength(1);
  });
});
