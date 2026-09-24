/**
 * A wake whose conversation is mid-turn in another process must skip with
 * `busy`, not run a second agent loop and not leave the wake's per-turn
 * fields on the conversation.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversationOverrideProfile: () => undefined,
}));

mock.module("../config/llm-context-resolution.js", () => ({
  resolveEffectiveContextWindow: () => ({ maxInputTokens: 200_000 }),
}));

mock.module("../daemon/disk-pressure-policy.js", () => ({
  classifyDiskPressureTurnPolicy: () => ({ action: "allow-normal" }),
}));

mock.module("../daemon/disk-pressure-guard.js", () => ({
  getDiskPressureStatus: () => ({
    enabled: false,
    state: "disabled",
    locked: false,
    acknowledged: false,
    overrideActive: false,
    effectivelyLocked: false,
    lockId: null,
    usagePercent: null,
    thresholdPercent: 95,
    path: null,
    lastCheckedAt: null,
    blockedCapabilities: [],
    error: null,
  }),
}));

import type { Conversation } from "../daemon/conversation.js";
import { ProcessingHeldElsewhereError } from "../persistence/processing-claim.js";
import {
  __resetWakeChainForTests,
  wakeAgentForOpportunity,
} from "../runtime/agent-wake.js";

function makeTarget(): { target: Conversation; state: { runs: number } } {
  const state = { runs: 0 };
  const messages: Message[] = [];
  const target = {
    conversationId: "conv-held-elsewhere",
    agentLoop: {
      run: async ({ messages }: { messages: Message[] }) => {
        state.runs++;
        return { history: messages, exitReason: null, newMessages: [] };
      },
    },
    messages,
    trimAgedSightFrames: (msgs: Message[]) => msgs,
    getMessages: () => messages,
    isProcessing: () => false,
    waitForIdle: async () => true,
    // The daemon holds the persisted claim: the in-memory flag is free, but
    // the marker write refuses.
    setProcessing: (on: boolean) => {
      if (on) {
        throw new ProcessingHeldElsewhereError("conv-held-elsewhere", 1, 1);
      }
    },
    setTrustContext: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    drainQueue: async () => {},
    kickDrainQueue: async () => {},
    maybeCompact: async () => null,
    syncLoopSystemPrompt: () => {},
    currentTurnWorkOrigins: undefined,
    currentTurnCronRunId: undefined,
    abortController: null,
  };
  return { target: target as unknown as Conversation, state };
}

beforeEach(() => {
  __resetWakeChainForTests();
});

describe("wakeAgentForOpportunity when another process holds the claim", () => {
  test("skips with busy and runs no agent loop", async () => {
    // GIVEN a wake targeting a conversation the daemon is mid-turn on
    const { target, state } = makeTarget();
    // WHEN the wake runs (as the schedule worker would)
    const result = await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "check back",
        source: "scheduler",
      },
      { resolveTarget: async () => target },
    );
    // THEN it reports busy, ran nothing, and left no wake state behind
    expect(result).toEqual({
      invoked: false,
      producedToolCalls: false,
      reason: "busy",
    });
    expect(state.runs).toBe(0);
    expect(target.currentTurnWorkOrigins).toBeUndefined();
  });
});
