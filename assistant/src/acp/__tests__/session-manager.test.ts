/**
 * Regression tests for AcpSessionManager state population — specifically
 * that `parentConversationId` is set on every session state at spawn time
 * and is therefore visible through `getStatus()` from t=0.
 */

import { describe, expect, mock, test } from "bun:test";

import type { AcpSessionState } from "../types.js";

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
    async cancel(): Promise<void> {}
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
