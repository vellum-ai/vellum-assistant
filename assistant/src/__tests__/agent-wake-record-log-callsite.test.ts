/**
 * Regression test for the Codex P1 from PR 2 review (#32026):
 *
 * `persistLog` in `wakeAgentForOpportunity` previously hardcoded
 * `"mainAgent"` when calling `recordRequestLog`, which silently
 * misattributed every non-main wake (e.g. `memoryRetrospective`,
 * `memoryV2Consolidation`) on the `llm_request_logs.call_site` column.
 *
 * This test pins the contract: the caller-provided `opts.callSite` is
 * threaded into `recordRequestLog` so per-call-site filtering and
 * analytics stay honest.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  DiskPressureTurnMetadata,
  DiskPressureTurnPolicyDecision,
} from "../daemon/disk-pressure-policy.js";
import type { AgentEvent } from "../agent/loop.js";
import type { Message } from "../providers/types.js";

mock.module("../memory/conversation-crud.js", () => ({
  getConversationOverrideProfile: () => undefined,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llm: {} }),
}));

mock.module("../config/llm-context-resolution.js", () => ({
  resolveEffectiveContextWindow: () => ({ maxInputTokens: 200_000 }),
}));

mock.module("../daemon/disk-pressure-policy.js", () => ({
  classifyDiskPressureTurnPolicy: (
    _status: unknown,
    _metadata: DiskPressureTurnMetadata,
  ): DiskPressureTurnPolicyDecision => ({ action: "allow-normal" }),
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

const recordRequestLogCalls: Array<{
  conversationId: string;
  requestPayload: string;
  responsePayload: string;
  messageId: string | undefined;
  provider: string | undefined;
  callSite: string | undefined;
}> = [];

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: (
    conversationId: string,
    requestPayload: string,
    responsePayload: string,
    messageId?: string,
    provider?: string,
    callSite?: string,
  ): string => {
    recordRequestLogCalls.push({
      conversationId,
      requestPayload,
      responsePayload,
      messageId,
      provider,
      callSite,
    });
    return "stub-log-id";
  },
  setAgentLoopExitReasonOnLatestLog: () => {},
}));

import {
  __resetWakeChainForTests,
  wakeAgentForOpportunity,
  type WakeTarget,
} from "../runtime/agent-wake.js";

/**
 * Build a `WakeTarget` whose `agentLoop.run` fires a `usage` event with
 * rawRequest/rawResponse so `persistLog` actually runs and the test can
 * read the captured `callSite`.
 */
function makeTarget(): WakeTarget {
  const history: Message[] = [];
  let processing = false;
  return {
    conversationId: "conv-wake-record-log-callsite",
    agentLoop: {
      run: (async (
        messages: Message[],
        onEvent: (event: AgentEvent) => void,
      ) => {
        // Fire a usage event so `persistLog` runs (buffered, then
        // flushed when `goLive` fires below).
        const usageEvent = {
          type: "usage",
          inputTokens: 10,
          outputTokens: 5,
          rawRequest: { hello: "world" },
          rawResponse: { ok: true },
          actualProvider: "stub-provider",
          model: "stub-model",
        } as unknown as AgentEvent;
        onEvent(usageEvent);
        // Append an assistant message with visible text so
        // `inspectWakeOutput` reports `hasVisibleText: true` and the
        // wake transitions to live (otherwise the wake is a silent
        // no-op and the buffered usage row is dropped).
        const assistantMessage: Message = {
          role: "assistant",
          content: [{ type: "text", text: "wake produced output" }],
        } as unknown as Message;
        return [...messages, assistantMessage];
      }) as WakeTarget["agentLoop"]["run"],
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
  recordRequestLogCalls.length = 0;
});

describe("wakeAgentForOpportunity — recordRequestLog callSite forwarding", () => {
  test("threads caller-supplied callSite into recordRequestLog", async () => {
    const target = makeTarget();

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "memory retro pass",
        source: "memory_retrospective",
        callSite: "memoryRetrospective",
      },
      { resolveTarget: async () => target },
    );

    expect(recordRequestLogCalls.length).toBeGreaterThanOrEqual(1);
    // Every persisted log row must reflect the caller's intent — not
    // the legacy hardcoded "mainAgent".
    for (const call of recordRequestLogCalls) {
      expect(call.callSite).toBe("memoryRetrospective");
    }
  });

  test("defaults to mainAgent when caller omits callSite", async () => {
    const target = makeTarget();

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "default wake",
        source: "scheduler",
      },
      { resolveTarget: async () => target },
    );

    expect(recordRequestLogCalls.length).toBeGreaterThanOrEqual(1);
    expect(recordRequestLogCalls[0]!.callSite).toBe("mainAgent");
  });
});
