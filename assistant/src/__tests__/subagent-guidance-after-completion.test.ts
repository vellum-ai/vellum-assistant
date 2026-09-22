import { afterEach, describe, expect, test } from "bun:test";

import { __resetConversationAdmissionForTests } from "../daemon/conversation-admission.js";
import {
  removeSubagentConversation,
  setSubagentConversation,
} from "../daemon/conversation-registry.js";
import { beginTurnFinalization } from "../daemon/turn-finalization.js";
import { SubagentManager } from "../subagent/manager.js";

/**
 * A child conversation whose lock and finalization barrier follow the real
 * agent loop's order: take the lock, work, release the lock (waking idle
 * waiters), wait out the turn-boundary commit, close the barrier, return.
 * The first run holds until `finish()` so guidance can arrive mid-run.
 */
function makeChild(conversationId: string, commitMs: number) {
  let processing = false;
  const waiters = new Set<() => void>();
  const runs: string[] = [];
  let release: (() => void) | null = null;
  const setProcessing = (value: boolean) => {
    processing = value;
    if (!value) {
      const pending = [...waiters];
      waiters.clear();
      for (const wake of pending) {
        wake();
      }
    }
  };
  async function runTurn(content: string) {
    runs.push(content);
    setProcessing(true);
    const close = beginTurnFinalization(conversationId);
    try {
      if (runs.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    } finally {
      setProcessing(false);
      await new Promise((resolve) => setTimeout(resolve, commitMs));
      close();
    }
  }
  const conversation = {
    conversationId,
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    subagentDeniedToolNames: new Set<string>(),
    subagentToolStats: { calls: 0, succeeded: 0, filesWritten: new Set() },
    isProcessing: () => processing,
    waitForIdle: ({ timeoutMs }: { timeoutMs: number }) =>
      processing
        ? new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), timeoutMs);
            waiters.add(() => {
              clearTimeout(timer);
              resolve(true);
            });
          })
        : Promise.resolve(true),
    hasPendingDeferredSends: () => false,
    persistUserMessage: async () => ({ id: "msg-1", deduplicated: false }),
    async runAgentLoop(content: string) {
      return runTurn(content);
    },
  };
  return { conversation, runs, finish: () => release?.() };
}

describe("subagent guidance sent while the child is mid-run", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    __resetConversationAdmissionForTests();
  });

  for (const commitMs of [0, 5]) {
    test(`runs as a follow-up turn once the child completes (commit ${commitMs}ms)`, async () => {
      __resetConversationAdmissionForTests();
      const manager = new SubagentManager();

      const internals = manager as any;
      const subagentId = "sub-guidance";
      const conversationId = `conv-sub-guidance-${commitMs}`;
      const child = makeChild(conversationId, commitMs);
      const state = {
        config: {
          id: subagentId,
          parentConversationId: "conv-parent",
          label: "child",
          objective: "work",
        },
        status: "running",
        conversationId,
        isFork: false,
        createdAt: Date.now(),
        usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      };
      internals.subagents.set(subagentId, {
        conversation: child.conversation,
        state,
        parentSendToClient: () => {},
        synchronous: true,
      });

      setSubagentConversation(conversationId, child.conversation as any);
      cleanup = () => {
        removeSubagentConversation(conversationId, child.conversation as any);
        internals.stopSweep?.();
      };

      const run = internals.runSubagent(subagentId, "work");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(child.runs).toEqual(["work"]);

      expect(await manager.sendMessage(subagentId, "guidance")).toBe("sent");

      child.finish();
      await run;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(state.status).toBe("completed");
      expect(child.runs).toEqual(["work", "guidance"]);
    });
  }
});
