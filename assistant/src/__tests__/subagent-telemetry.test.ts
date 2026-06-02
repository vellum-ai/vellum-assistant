/**
 * Per-phase build telemetry for subagents.
 *
 * Two layers under test:
 *  1. The pure event builders (`buildSubagentSpawnEvent` /
 *     `buildSubagentTerminalEvent`) — assert the structured event shape,
 *     that the tier (overrideProfile) is recorded per subagent, that role →
 *     build-phase mapping is correct, and the silent-context-starvation signal.
 *  2. The manager integration — drive a controllable fake subagent through
 *     spawn → completion and assert the established telemetry sink
 *     (`recordLifecycleEvent`) is hit with the per-subagent tier, with no
 *     regression to spawn/concurrency accounting.
 *
 * Note: this file mocks `../memory/lifecycle-events-store.js`. Per the repo's
 * bun-mock isolation gotcha, run it on its own (single-file `bun test`).
 */

import { describe, expect, mock, test } from "bun:test";

// Capture every lifecycle event name the manager records, before importing the
// modules under test so the mock is in place at import time.
const recordedLifecycleEvents: string[] = [];
mock.module("../memory/lifecycle-events-store.js", () => ({
  recordLifecycleEvent: (eventName: string) => {
    recordedLifecycleEvents.push(eventName);
    return { id: "evt", eventName, createdAt: Date.now() };
  },
}));

import type { ServerMessage } from "../daemon/message-protocol.js";
import { SubagentManager } from "../subagent/manager.js";
import {
  buildSubagentSpawnEvent,
  buildSubagentTerminalEvent,
} from "../subagent/telemetry.js";
import type { SubagentState } from "../subagent/types.js";

// ── Pure builders ───────────────────────────────────────────────────────

describe("subagent telemetry — event builders", () => {
  test("spawn event records role, phase, and tier (overrideProfile)", () => {
    const evt = buildSubagentSpawnEvent({
      subagentId: "sub-1",
      label: "Build the worker",
      role: "coder",
      overrideProfile: "worker-cheap",
      isFork: false,
    });

    expect(evt).toMatchObject({
      event: "subagent_build_spawned",
      subagentId: "sub-1",
      label: "Build the worker",
      role: "coder",
      phase: "worker", // coder → worker phase
      overrideProfile: "worker-cheap",
      isFork: false,
    });
    // Lifecycle name encodes phase + tier so platform aggregation can group.
    expect(evt.lifecycleEventName).toBe(
      "subagent_build:worker:worker-cheap:spawned",
    );
  });

  test("planner maps to the plan phase; missing tier becomes 'default'", () => {
    const evt = buildSubagentSpawnEvent({
      subagentId: "sub-2",
      label: "Plan",
      role: "planner",
      isFork: false,
    });
    expect(evt.phase).toBe("plan");
    expect(evt.overrideProfile).toBeNull();
    expect(evt.lifecycleEventName).toBe("subagent_build:plan:default:spawned");
  });

  test("terminal event carries tier, duration, tokens, and outcome", () => {
    const evt = buildSubagentTerminalEvent({
      subagentId: "sub-3",
      label: "Worker",
      role: "coder",
      overrideProfile: "tier-a",
      isFork: false,
      outcome: "completed",
      durationMs: 4200,
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 0.012,
    });

    expect(evt).toMatchObject({
      event: "subagent_build_terminal",
      outcome: "completed",
      overrideProfile: "tier-a",
      durationMs: 4200,
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 0.012,
      suspiciousZeroOutput: false,
    });
    expect(evt.lifecycleEventName).toBe(
      "subagent_build:worker:tier-a:completed",
    );
    expect(evt.zeroOutputLifecycleEventName).toBeUndefined();
  });

  test("overrideProfile (tier) is recorded distinctly per subagent", () => {
    const cheap = buildSubagentTerminalEvent({
      subagentId: "a",
      label: "a",
      role: "coder",
      overrideProfile: "cheap",
      isFork: false,
      outcome: "completed",
      inputTokens: 1,
      outputTokens: 1,
      estimatedCost: 0,
    });
    const premium = buildSubagentTerminalEvent({
      subagentId: "b",
      label: "b",
      role: "coder",
      overrideProfile: "premium",
      isFork: false,
      outcome: "completed",
      inputTokens: 1,
      outputTokens: 1,
      estimatedCost: 0,
    });
    expect(cheap.overrideProfile).toBe("cheap");
    expect(premium.overrideProfile).toBe("premium");
    expect(cheap.lifecycleEventName).not.toBe(premium.lifecycleEventName);
  });

  test("silent-context-starvation: completed coder with zero output is flagged", () => {
    const starved = buildSubagentTerminalEvent({
      subagentId: "sub-x",
      label: "Worker",
      role: "coder",
      overrideProfile: "tier-a",
      isFork: false,
      outcome: "completed",
      inputTokens: 5000,
      outputTokens: 0,
      estimatedCost: 0,
    });
    expect(starved.suspiciousZeroOutput).toBe(true);
    expect(starved.zeroOutputLifecycleEventName).toBe(
      "subagent_build:worker:tier-a:zero_output",
    );

    // Non-coder roles, failures, and non-zero output do NOT trip the signal.
    const planner = buildSubagentTerminalEvent({
      subagentId: "sub-y",
      label: "Plan",
      role: "planner",
      isFork: false,
      outcome: "completed",
      inputTokens: 1,
      outputTokens: 0,
      estimatedCost: 0,
    });
    expect(planner.suspiciousZeroOutput).toBe(false);

    const failed = buildSubagentTerminalEvent({
      subagentId: "sub-z",
      label: "Worker",
      role: "coder",
      isFork: false,
      outcome: "failed",
      inputTokens: 1,
      outputTokens: 0,
      estimatedCost: 0,
    });
    expect(failed.suspiciousZeroOutput).toBe(false);
  });
});

// ── Manager integration ─────────────────────────────────────────────────

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

function makeState(id: string, overrideProfile?: string): SubagentState {
  return {
    config: {
      id,
      parentConversationId: "parent-1",
      label: id,
      objective: `objective-${id}`,
      role: "coder",
      ...(overrideProfile ? { overrideProfile } : {}),
    },
    status: "pending",
    conversationId: `conv-${id}`,
    resolvedRole: "coder",
    isFork: false,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  };
}

function injectControllable(
  manager: SubagentManager,
  id: string,
  overrideProfile?: string,
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
      usageStats: { inputTokens: 10, outputTokens: 20, estimatedCost: 0.01 },
    },
    state: makeState(id, overrideProfile),
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

describe("subagent telemetry — manager integration", () => {
  test("completion records a per-tier terminal lifecycle event", async () => {
    recordedLifecycleEvents.length = 0;

    const manager = new SubagentManager();
    const internals = asInternals(manager);

    const gate = injectControllable(manager, "sub-int-1", "tier-fast");
    internals.startRun(
      "sub-int-1",
      internals.subagents.get("sub-int-1")!.state.config.objective,
    );
    await flush();

    gate.release();
    await flush();
    await flush();

    // The completed coder ran on tier-fast → its terminal event is recorded
    // with the worker phase + tier encoded.
    expect(recordedLifecycleEvents).toContain(
      "subagent_build:worker:tier-fast:completed",
    );
    // Concurrency accounting did not leak.
    expect(internals.runningCount).toBe(0);
    expect(internals.runQueue.length).toBe(0);

    internals.stopSweep();
  });
});
