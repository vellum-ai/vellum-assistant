/**
 * Regression test: `classifyDiskPressureTurnPolicy` must receive the
 * caller-supplied `callSite` from `wakeAgentForOpportunity`, not a
 * hardcoded `"mainAgent"`.
 *
 * Today the disk-pressure classifier's `isBackgroundTurn` branches on
 * `isDirectWake` before it consults `callSite`, so the hardcoded value
 * did not produce a runtime regression. But the metadata recorded the
 * wrong call site for any wake initiated by a background job (e.g.
 * memory-v2 consolidation), and the inconsistency would bite the moment
 * policy ever branches on `callSite` for wake turns. This test pins the
 * forwarded value so the contract stays honest.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  DiskPressureTurnMetadata,
  DiskPressureTurnPolicyDecision,
} from "../daemon/disk-pressure-policy.js";
import type { Message } from "../providers/types.js";

mock.module("../memory/conversation-crud.js", () => ({
  getConversationOverrideProfile: () => undefined,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llm: {} }),
}));

mock.module("../config/llm-context-resolution.js", () => ({
  resolveEffectiveContextWindow: () => ({ maxInputTokens: 200_000 }),
}));

const classifyCalls: DiskPressureTurnMetadata[] = [];
mock.module("../daemon/disk-pressure-policy.js", () => ({
  classifyDiskPressureTurnPolicy: (
    _status: unknown,
    metadata: DiskPressureTurnMetadata,
  ): DiskPressureTurnPolicyDecision => {
    classifyCalls.push(metadata);
    return { action: "allow-normal" };
  },
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

import {
  __resetWakeChainForTests,
  wakeAgentForOpportunity,
  type WakeTarget,
} from "../runtime/agent-wake.js";

function makeTarget(): WakeTarget {
  const history: Message[] = [];
  let processing = false;
  return {
    conversationId: "conv-wake-callsite",
    agentLoop: {
      run: (async (messages: Message[]) => ({
        history: messages,
        exitReason: null,
      })) as WakeTarget["agentLoop"]["run"],
    },
    getMessages: () => history,
    pushMessage: (msg) => {
      history.push(msg);
    },
    emitAgentEvent: () => {},
    isProcessing: () => processing,
    markProcessing: (on) => {
      processing = on;
    },
    persistTailMessage: async () => {},
  };
}

beforeEach(() => {
  __resetWakeChainForTests();
  classifyCalls.length = 0;
});

describe("wakeAgentForOpportunity — disk-pressure callSite forwarding", () => {
  test("forwards opts.callSite to classifyDiskPressureTurnPolicy", async () => {
    const target = makeTarget();

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "consolidate buffer",
        source: "memory_v2_consolidation",
        callSite: "memoryV2Consolidation",
      },
      { resolveTarget: async () => target },
    );

    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]!.callSite).toBe("memoryV2Consolidation");
    expect(classifyCalls[0]!.isDirectWake).toBe(true);
  });

  test("defaults to mainAgent when opts.callSite is omitted", async () => {
    const target = makeTarget();

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "resume",
        source: "scheduler",
      },
      { resolveTarget: async () => target },
    );

    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]!.callSite).toBe("mainAgent");
  });
});
