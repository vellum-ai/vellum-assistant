/**
 * Regression tests for AcpSessionManager state population — specifically
 * that `parentConversationId` is set on every session state at spawn time
 * and is therefore visible through `getStatus()` from t=0.
 */

import { describe, expect, mock, test } from "bun:test";

import type { AcpSessionState } from "../types.js";

// Records every `cancel(protocolSessionId)` the manager dispatches to a fake
// process, so tests can assert which sessions were cancelled.
const cancelCalls: string[] = [];

// Stub the agent-process module so spawn() does not actually launch a child
// process. Each fake instance records the cwd it was spawned in and resolves
// every protocol method synchronously. The mock is process-global (Bun's
// `mock.module` semantics) — that's fine because this file only exercises
// AcpSessionManager.
mock.module("../agent-process.js", () => ({
  AcpAgentProcess: class FakeAcpAgentProcess {
    constructor(
      public readonly agentId: string,
      _config: unknown,
      _factory: unknown,
    ) {}
    spawn(_cwd: string): void {}
    async initialize(): Promise<void> {}
    async createSession(_cwd: string): Promise<string> {
      return `proto-${this.agentId}`;
    }
    async prompt(): Promise<{ stopReason: string }> {
      // Never resolves — keeps the session alive in `running` state for
      // the duration of the test so cleanup logic doesn't tear it down.
      return new Promise(() => {});
    }
    async cancel(sessionId: string): Promise<void> {
      cancelCalls.push(sessionId);
    }
    markStderr(): number {
      return 0;
    }
    stderrSince(): string {
      return "";
    }
    kill(): void {}
  },
}));

const { AcpSessionManager } = await import("../session-manager.js");

describe("AcpSessionManager — parentConversationId population", () => {
  const noopSend = () => {};

  test("getStatus(id) returns parentConversationId matching the spawn argument", async () => {
    const manager = new AcpSessionManager(5);

    const { acpSessionId } = await manager.spawn(
      "agent-1",
      { command: "echo", args: ["hi"] },
      "do something",
      "/tmp",
      "conv-parent-abc",
      noopSend,
    );

    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.parentConversationId).toBe("conv-parent-abc");
  });

  test("getStatus() returns an array where every entry has parentConversationId populated", async () => {
    const manager = new AcpSessionManager(5);

    await manager.spawn(
      "agent-1",
      { command: "echo", args: ["hi"] },
      "task 1",
      "/tmp",
      "conv-parent-1",
      noopSend,
    );
    await manager.spawn(
      "agent-2",
      { command: "echo", args: ["hi"] },
      "task 2",
      "/tmp",
      "conv-parent-2",
      noopSend,
    );

    const states = manager.getStatus() as AcpSessionState[];
    const parents = states.map((s) => s.parentConversationId).sort();
    expect(parents).toEqual(["conv-parent-1", "conv-parent-2"]);
  });
});

describe("AcpSessionManager — cancelForParent", () => {
  const noopSend = () => {};

  test("cancels only the sessions spawned by the given parent", async () => {
    cancelCalls.length = 0;
    const manager = new AcpSessionManager(5);

    const a1 = await manager.spawn(
      "agent-a1",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "parent-A",
      noopSend,
    );
    const a2 = await manager.spawn(
      "agent-a2",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "parent-A",
      noopSend,
    );
    const b1 = await manager.spawn(
      "agent-b1",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "parent-B",
      noopSend,
    );

    // WHEN parent-A is cancelled
    const count = manager.cancelForParent("parent-A");

    // THEN it reports the two parent-A sessions and leaves parent-B alone
    expect(count).toBe(2);

    // Let the detached per-session cancels settle (each awaits a protocol
    // notification before flipping status).
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((manager.getStatus(a1.acpSessionId) as AcpSessionState).status).toBe(
      "cancelled",
    );
    expect((manager.getStatus(a2.acpSessionId) as AcpSessionState).status).toBe(
      "cancelled",
    );
    expect((manager.getStatus(b1.acpSessionId) as AcpSessionState).status).toBe(
      "running",
    );

    // AND the cancel reached each parent-A agent process exactly once.
    expect(cancelCalls.sort()).toEqual(["proto-agent-a1", "proto-agent-a2"]);
  });

  test("returns 0 and dispatches nothing when the parent has no sessions", () => {
    cancelCalls.length = 0;
    const manager = new AcpSessionManager(5);

    expect(manager.cancelForParent("parent-with-nothing")).toBe(0);
    expect(cancelCalls).toEqual([]);
  });
});
