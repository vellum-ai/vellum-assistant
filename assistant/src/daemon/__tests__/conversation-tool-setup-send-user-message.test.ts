/**
 * Availability of `send_user_message` on the per-turn tool surface: the flag
 * must be on AND the turn must be a main-agent turn. Subagents, calls,
 * live-voice legs, and background workers keep streamed assistant text, so the
 * tool never appears for them.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as featureFlags from "../../config/assistant-feature-flags.js";
import { SEND_USER_MESSAGE_TOOL_NAME } from "../../config/send-user-message-gate.js";
import type { Conversation } from "../conversation.js";
import { isToolActiveForContext } from "../conversation-tool-setup.js";

let flagSpy: ReturnType<typeof spyOn> | undefined;

function setFlag(enabled: boolean): void {
  flagSpy = spyOn(featureFlags, "isAssistantFeatureFlagEnabled").mockImplementation(
    (key: string) => (key === "send-user-message" ? enabled : false),
  );
}

function ctx(overrides: Partial<Conversation> = {}): Conversation {
  return {
    toolsDisabledDepth: 0,
    hasNoClient: false,
    ...overrides,
  } as unknown as Conversation;
}

afterEach(() => {
  flagSpy?.mockRestore();
  flagSpy = undefined;
});

describe("send_user_message tool availability", () => {
  test("is unavailable when the flag is off", () => {
    setFlag(false);
    expect(
      isToolActiveForContext(SEND_USER_MESSAGE_TOOL_NAME, ctx()),
    ).toBe(false);
  });

  test("is available on a main-agent turn when the flag is on", () => {
    setFlag(true);
    expect(
      isToolActiveForContext(
        SEND_USER_MESSAGE_TOOL_NAME,
        ctx({ currentCallSite: "mainAgent" }),
      ),
    ).toBe(true);
  });

  test("is available on a turn with no resolved call site", () => {
    setFlag(true);
    expect(isToolActiveForContext(SEND_USER_MESSAGE_TOOL_NAME, ctx())).toBe(
      true,
    );
  });

  test("is unavailable to a subagent", () => {
    setFlag(true);
    expect(
      isToolActiveForContext(
        SEND_USER_MESSAGE_TOOL_NAME,
        ctx({ isSubagent: true, currentCallSite: "mainAgent" }),
      ),
    ).toBe(false);
  });

  test("is unavailable to calls, live-voice, and worker call sites", () => {
    setFlag(true);
    for (const callSite of [
      "callAgent",
      "voiceFrontDoor",
      "subagentSpawn",
      "heartbeatAgent",
      "memoryConsolidation",
    ] as const) {
      expect(
        isToolActiveForContext(
          SEND_USER_MESSAGE_TOOL_NAME,
          ctx({ currentCallSite: callSite }),
        ),
      ).toBe(false);
    }
  });
});
