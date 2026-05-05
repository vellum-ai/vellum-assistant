import { beforeEach, describe, expect, test } from "bun:test";

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import {
  applyRuntimeInjections,
  stripInjectionsForCompaction,
} from "../daemon/conversation-runtime-assembly.js";
import {
  DEFAULT_INJECTOR_ORDER,
  defaultInjectorsPlugin,
  DISK_PRESSURE_WARNING_PROMPT,
} from "../plugins/defaults/injectors.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Injector, TurnContext } from "../plugins/types.js";
import type { Message } from "../providers/types.js";

function findInjector(name: string): Injector {
  const injector = defaultInjectorsPlugin.injectors?.find(
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
    conversationId: "conv-test",
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
const cleanupContext = { cleanupModeActive: true };

describe("disk-pressure-warning injector", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(defaultInjectorsPlugin);
    _setOverridesForTesting({ "safe-storage-limits": true });
  });

  test("emits the exact cleanup prompt while safe storage limits are enabled", async () => {
    const block = await diskPressureInjector.produce(
      makeContext({
        injectionInputs: { diskPressureContext: cleanupContext },
      }),
    );

    expect(block).toEqual({
      id: "disk-pressure-warning",
      text: DISK_PRESSURE_WARNING_PROMPT,
      placement: "prepend-user-tail",
    });
    expect(diskPressureInjector.order).toBe(
      DEFAULT_INJECTOR_ORDER.diskPressureWarning,
    );
    expect(DISK_PRESSURE_WARNING_PROMPT).toBe(`<disk_pressure_warning>
Disk usage is critically low: this assistant is in storage cleanup mode because the workspace volume is at least 95% full.

In your first paragraph, warn the user that storage is critically low and that normal work is suspended until space is freed.

Then help the user clean up storage. Prefer safe inspection steps first, such as checking available space and finding large directories. Ask before deleting files or caches unless the user has already clearly approved the specific cleanup action.

Do not work on unrelated tasks until disk usage drops below the critical threshold or the user explicitly overrides the lock. Background processes and messages from trusted contacts are blocked while this cleanup mode is active.
</disk_pressure_warning>`);
  });

  test("omits the prompt when cleanup context is null or inactive", async () => {
    await expect(
      diskPressureInjector.produce(
        makeContext({ injectionInputs: { diskPressureContext: null } }),
      ),
    ).resolves.toBeNull();

    await expect(
      diskPressureInjector.produce(
        makeContext({
          injectionInputs: {
            diskPressureContext: { cleanupModeActive: false },
          },
        }),
      ),
    ).resolves.toBeNull();
  });

  test("omits the prompt when safe storage limits are disabled", async () => {
    _setOverridesForTesting({ "safe-storage-limits": false });

    await expect(
      diskPressureInjector.produce(
        makeContext({
          injectionInputs: { diskPressureContext: cleanupContext },
        }),
      ),
    ).resolves.toBeNull();
  });

  test("prepends ahead of workspace and unified turn context in full mode", async () => {
    const runMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "clean up space" }] },
    ];
    const workspace = "<workspace>\nRoot: /workspace\n</workspace>";
    const turnContext = "<turn_context>\ninterface: macos\n</turn_context>";

    const result = await applyRuntimeInjections(runMessages, {
      turnContext: makeContext(),
      diskPressureContext: cleanupContext,
      workspaceTopLevelContext: workspace,
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
    const result = await applyRuntimeInjections(
      [{ role: "user", content: [{ type: "text", text: "status" }] }],
      {
        turnContext: makeContext(),
        mode: "minimal",
        diskPressureContext: cleanupContext,
        workspaceTopLevelContext: "<workspace>...</workspace>",
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

    const result = await applyRuntimeInjections(originalRun, {
      turnContext: makeContext(),
      diskPressureContext: cleanupContext,
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

    const first = await applyRuntimeInjections(runMessages, {
      turnContext: makeContext(),
      diskPressureContext: cleanupContext,
    });
    const stripped = stripInjectionsForCompaction(first.messages);
    expect(tailTexts(stripped)).toEqual(["find large files"]);

    const second = await applyRuntimeInjections(stripped, {
      turnContext: makeContext(),
      diskPressureContext: cleanupContext,
    });
    expect(
      tailTexts(second.messages).filter(
        (text) => text === DISK_PRESSURE_WARNING_PROMPT,
      ),
    ).toHaveLength(1);
  });
});
