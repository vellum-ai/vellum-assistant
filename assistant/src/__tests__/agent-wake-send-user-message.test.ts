/**
 * A direct wake never offers `send_user_message`.
 *
 * `wakeAgentForOpportunity` drives `agentLoop.run` itself rather than going
 * through `runAgentLoopImpl`, so it neither suppresses streamed assistant text
 * nor stamps a visibility marker on the rows it persists. Offering the tool
 * there would hand the model a delivery channel whose message nothing emits,
 * leaving a scheduled or heartbeat wake holding a tool chip and no words.
 *
 * The wake pins the turn snapshot false for its whole dispatch and restores
 * the previous value afterwards, so the tool surface reads "off" while it runs
 * and a following user turn is unaffected.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversationOverrideProfile: () => undefined,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

import type { AgentLoopRunOptions } from "../agent/loop.js";
import * as featureFlags from "../config/assistant-feature-flags.js";
import { SEND_USER_MESSAGE_TOOL_NAME } from "../config/send-user-message-constants.js";
import type { Conversation } from "../daemon/conversation.js";
import { isToolActiveForContext } from "../daemon/conversation-tool-setup.js";
import type { Message } from "../providers/types.js";
import {
  __resetWakeChainForTests,
  wakeAgentForOpportunity,
} from "../runtime/agent-wake.js";

let flagSpy: ReturnType<typeof spyOn> | undefined;

function makeTarget(onRun: (conv: Conversation) => void): {
  target: Conversation;
} {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  let processing = false;

  const target = {
    conversationId: "conv-wake-sum",
    // The tool surface reads these two, plus the pinned snapshot.
    currentCallSite: "mainAgent",
    toolsDisabledDepth: 0,
    hasNoClient: false,
    agentLoop: {
      run: async (options: AgentLoopRunOptions) => {
        // Observe the conversation exactly as the tool surface would, mid-run.
        onRun(target as unknown as Conversation);
        return { history: options.messages, exitReason: null };
      },
    },
    messages,
    trimAgedSightFrames: (msgs: Message[]) => msgs,
    getMessages: () => messages,
    isProcessing: () => processing,
    waitForIdle: async () => !processing,
    setProcessing: (on: boolean) => {
      processing = on;
    },
    setTrustContext: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    drainQueue: async () => {},
    kickDrainQueue: async () => {},
    maybeCompact: async () => null,
    buildCurrentSystemPrompt: () => "mock-system-prompt",
    modelOverride: undefined,
  };
  return { target: target as unknown as Conversation };
}

beforeEach(() => {
  __resetWakeChainForTests();
  flagSpy = spyOn(
    featureFlags,
    "isAssistantFeatureFlagEnabled",
  ).mockImplementation((key: string) => key === "send-user-message");
});

afterEach(() => {
  flagSpy?.mockRestore();
  flagSpy = undefined;
});

describe("send_user_message on a direct wake", () => {
  test("is unavailable during the wake and restored after it", async () => {
    let activeDuringRun: boolean | undefined;
    let snapshotDuringRun: boolean | undefined;
    const { target } = makeTarget((conv) => {
      snapshotDuringRun = conv.currentTurnSendUserMessageActive;
      activeDuringRun = isToolActiveForContext(
        SEND_USER_MESSAGE_TOOL_NAME,
        conv,
      );
    });

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "scheduler",
      },
      { resolveTarget: async () => target },
    );

    // The flag is on and the call site is mainAgent, so only the wake's own
    // snapshot can be keeping the tool off the surface.
    expect(snapshotDuringRun).toBe(false);
    expect(activeDuringRun).toBe(false);
    // Restored, so a following user turn resolves the tool on its own terms.
    expect(target.currentTurnSendUserMessageActive).toBeUndefined();
    expect(isToolActiveForContext(SEND_USER_MESSAGE_TOOL_NAME, target)).toBe(
      true,
    );
  });
});
