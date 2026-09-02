/**
 * Presence opt-in for the background skill-update notification: a refinement
 * announced into a conversation the user is already watching stays quiet,
 * and everything short of a confident "focused" still announces.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { MEMORY_RETROSPECTIVE_ORIGIN } from "../plugins/defaults/memory/memory-retrospective-constants.js";
import type { ToolContext } from "../tools/types.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

const FLAG = "activity-presence-suppression";
const SOURCE_CONVERSATION_ID = "source-conv";
const RUN_CONVERSATION_ID = "retro-run-conv";
const HINTS = ["user asks to run the procedure under test"];

let webFocused = false;
let webPresenceShouldThrow = false;
const webPresenceArgs: unknown[][] = [];
const realWebPresence = await import("../runtime/web-presence.js");
mock.module("../runtime/web-presence.js", () => ({
  ...realWebPresence,
  isWebConversationFocused: (...args: unknown[]) => {
    webPresenceArgs.push(args);
    if (webPresenceShouldThrow) {
      throw new Error("simulated presence read failure");
    }
    return webFocused;
  },
}));

let emittedSignals: Array<{
  sourceEventName: string;
  attentionHints?: Record<string, unknown>;
}> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: {
    sourceEventName: string;
    attentionHints?: Record<string, unknown>;
  }) => {
    emittedSignals.push(params);
    return { signalId: "test-signal" };
  },
}));

mock.module("../daemon/skill-memory-refresh.js", () => ({
  refreshSkillCapabilityMemories: () => {},
}));

mock.module("../telemetry/watchdog-events-store.js", () => ({
  recordWatchdogEvent: () => {},
}));

const { writeInstallMeta } = await import("../skills/install-meta.js");
const { getManagedSkillDir } = await import("../skills/managed-store.js");
const { executeScaffoldManagedSkill } =
  await import("../tools/skills/scaffold-managed.js");

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
    ...overrides,
  };
}

/** Seed an assistant-authored skill the background pass may overwrite. */
async function seedAssistantSkill(id: string): Promise<void> {
  await executeScaffoldManagedSkill(
    {
      skill_id: id,
      name: "Weekly Report Export",
      description: "export the weekly usage report",
      body_markdown: "Old body.",
      activation_hints: HINTS,
    },
    context(),
  );
  writeInstallMeta(getManagedSkillDir(id), {
    origin: "custom",
    installedAt: new Date().toISOString(),
    author: "assistant",
  });
}

/**
 * Run the background refinement that notifies. Lineage resolves, so the
 * notification is keyed to the source conversation rather than the fork.
 */
async function refineInBackground(id: string): Promise<void> {
  await executeScaffoldManagedSkill(
    {
      skill_id: id,
      name: "Weekly Report Export",
      description: "export the weekly usage report",
      body_markdown: "1. Refined steps.",
      activation_hints: HINTS,
      overwrite: true,
    },
    context({
      conversationId: RUN_CONVERSATION_ID,
      requestOrigin: MEMORY_RETROSPECTIVE_ORIGIN,
    }),
    {
      getConversation: (lookupId: string) =>
        lookupId === RUN_CONVERSATION_ID
          ? { forkParentConversationId: SOURCE_CONVERSATION_ID }
          : null,
    },
  );
}

function onlyHints(): Record<string, unknown> {
  expect(emittedSignals).toHaveLength(1);
  const signal = emittedSignals[0]!;
  expect(signal.sourceEventName).toBe("activity.complete");
  return signal.attentionHints!;
}

describe("background skill update presence opt-in", () => {
  beforeEach(() => {
    webFocused = false;
    webPresenceShouldThrow = false;
    webPresenceArgs.length = 0;
    emittedSignals = [];
    setOverridesForTesting({ [FLAG]: true });
  });

  test("suppresses when the source conversation is focused", async () => {
    webFocused = true;
    await seedAssistantSkill("presence-focused");

    await refineInBackground("presence-focused");

    const hints = onlyHints();
    expect(hints.visibleInSourceNow).toBe(true);
    // The quiet shape of this signal is unchanged by the opt-in.
    expect(hints.urgency).toBe("low");
    expect(hints.isAsyncBackground).toBe(true);
    expect(hints.requiresAction).toBe(false);
    // The presence read is asked about the conversation the feed item links
    // to, not the hidden retrospective fork the tool call ran in.
    expect(webPresenceArgs).toEqual([[SOURCE_CONVERSATION_ID]]);
  });

  test("still announces when the conversation is not focused", async () => {
    webFocused = false;
    await seedAssistantSkill("presence-unfocused");

    await refineInBackground("presence-unfocused");

    expect(onlyHints().visibleInSourceNow).toBe(false);
    expect(webPresenceArgs).toEqual([[SOURCE_CONVERSATION_ID]]);
  });

  test("never reads presence when the flag is off", async () => {
    webFocused = true;
    await seedAssistantSkill("presence-flag-off");
    setOverridesForTesting({ [FLAG]: false });

    await refineInBackground("presence-flag-off");

    expect(onlyHints().visibleInSourceNow).toBe(false);
    expect(webPresenceArgs).toEqual([]);
  });

  test("still announces when the presence read throws", async () => {
    webPresenceShouldThrow = true;
    await seedAssistantSkill("presence-throws");

    await refineInBackground("presence-throws");

    expect(onlyHints().visibleInSourceNow).toBe(false);
  });
});
