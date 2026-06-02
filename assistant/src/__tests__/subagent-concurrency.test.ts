/**
 * Concurrency-cap behavior for SubagentManager.
 *
 * Verifies that spawns beyond SUBAGENT_LIMITS.maxConcurrentRunning are accepted
 * immediately but held in `pending`, and that queued subagents are started as
 * running ones reach a terminal state — until all have run.
 *
 * Drives the manager via its private internals (matching the layout of
 * subagent-disposal.test.ts) so the test never needs a real Conversation,
 * provider, or daemon.
 */

import { describe, expect, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";
import { SubagentManager } from "../subagent/manager.js";
import { SUBAGENT_LIMITS, type SubagentState } from "../subagent/types.js";

/** Minimal stand-in for the private ManagedSubagent the manager stores. */
interface FakeManaged {
  conversation: {
    abort: () => void;
    dispose: () => void;
    persistUserMessage: () => { id: string; deduplicated: boolean };
    runAgentLoop: () => Promise<void>;
    usageStats: {
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
    };
  } | null;
  state: SubagentState;
  parentSendToClient: (msg: ServerMessage) => void;
  retainedUntil?: number;
  hadEnqueuedMessages?: boolean;
}

interface ManagerInternals {
  subagents: Map<string, FakeManaged>;
  parentToChildren: Map<string, Set<string>>;
  runQueue: string[];
  runningCount: number;
  startRun: (subagentId: string, objective: string) => void;
  stopSweep: () => void;
}

function asInternals(manager: SubagentManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function makeState(id: string): SubagentState {
  return {
    config: {
      id,
      parentConversationId: "parent-1",
      label: id,
      objective: `objective-${id}`,
    },
    status: "pending",
    conversationId: `conv-${id}`,
    resolvedRole: "general",
    isFork: false,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  };
}

/**
 * Inject a fake subagent whose runAgentLoop blocks on a manually-resolved
 * promise, letting the test control exactly when each "running" subagent
 * completes. Returns a `release` fn that resolves the loop.
 */
function injectControllable(
  manager: SubagentManager,
  id: string,
): { release: () => void } {
  const internals = asInternals(manager);
  let resolveLoop!: () => void;
  const loopGate = new Promise<void>((r) => {
    resolveLoop = r;
  });

  const managed: FakeManaged = {
    conversation: {
      abort: () => {},
      dispose: () => {},
      persistUserMessage: () => ({ id: "msg", deduplicated: false }),
      runAgentLoop: () => loopGate,
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    },
    state: makeState(id),
    parentSendToClient: () => {},
  };
  internals.subagents.set(id, managed);

  if (!internals.parentToChildren.has("parent-1")) {
    internals.parentToChildren.set("parent-1", new Set());
  }
  internals.parentToChildren.get("parent-1")!.add(id);

  return { release: resolveLoop };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("SubagentManager concurrency cap", () => {
  test("spawns beyond the cap queue and drain as running ones complete", async () => {
    const manager = new SubagentManager();
    const internals = asInternals(manager);
    const cap = SUBAGENT_LIMITS.maxConcurrentRunning;
    const total = cap + 3;

    const ids = Array.from({ length: total }, (_, i) => `sub-${i}`);
    const gates = ids.map((id) => injectControllable(manager, id));

    // Mimic spawn()'s cap-gating: start up to `cap`, queue the rest.
    for (const id of ids) {
      const objective = internals.subagents.get(id)!.state.config.objective;
      if (internals.runningCount < cap) {
        internals.startRun(id, objective);
      } else {
        internals.runQueue.push(id);
      }
    }
    await flush();

    // Exactly `cap` are running; the excess sit pending in the queue.
    expect(internals.runningCount).toBe(cap);
    expect(internals.runQueue.length).toBe(total - cap);
    const running = ids.filter(
      (id) => manager.getState(id)!.status === "running",
    );
    expect(running.length).toBe(cap);
    for (const id of ids.slice(cap)) {
      expect(manager.getState(id)!.status).toBe("pending");
    }

    // Complete running subagents one at a time; each completion should pull
    // exactly one queued subagent into the running set.
    for (let i = 0; i < total; i++) {
      const runningNow = ids.filter(
        (id) => manager.getState(id)!.status === "running",
      );
      expect(runningNow.length).toBeGreaterThan(0);
      // Release the first currently-running subagent.
      const idx = ids.indexOf(runningNow[0]!);
      gates[idx]!.release();
      await flush();
      await flush();
    }

    // All eventually ran to completion; queue drained; no slots leaked.
    for (const id of ids) {
      expect(manager.getState(id)!.status).toBe("completed");
    }
    expect(internals.runQueue.length).toBe(0);
    expect(internals.runningCount).toBe(0);

    internals.stopSweep();
  });

  test("low-count spawns (under cap) all start immediately, none queued", async () => {
    const manager = new SubagentManager();
    const internals = asInternals(manager);

    const ids = ["a", "b"]; // typical 1–2 subagent flow
    for (const id of ids) injectControllable(manager, id);
    for (const id of ids) {
      internals.startRun(
        id,
        internals.subagents.get(id)!.state.config.objective,
      );
    }
    await flush();

    expect(internals.runQueue.length).toBe(0);
    expect(internals.runningCount).toBe(ids.length);
    for (const id of ids) {
      expect(manager.getState(id)!.status).toBe("running");
    }

    internals.stopSweep();
  });
});
