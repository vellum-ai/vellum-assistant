/**
 * Verifies that an ACP `usage_update` flowing through a live session is
 * recorded on the session's `latestUsage`, reachable via `getStatus()`.
 */

import { describe, expect, mock, test } from "bun:test";

import type { SessionNotification } from "@agentclientprotocol/sdk";

import type { AcpSessionState } from "../types.js";

// Captures the client-handler factory each fake process is constructed with
// so tests can drive session updates through the real wiring (the wrapped
// sender that records `latestUsage`).
type HandlerFactory = (agent: unknown) => {
  sessionUpdate(params: SessionNotification): Promise<void>;
};
const handlerFactories: HandlerFactory[] = [];

mock.module("../agent-process.js", () => ({
  AcpAgentProcess: class FakeAcpAgentProcess {
    constructor(
      public readonly agentId: string,
      _config: unknown,
      factory: HandlerFactory,
    ) {
      handlerFactories.push(factory);
    }
    spawn(_cwd: string): void {}
    async initialize(): Promise<void> {}
    async createSession(_cwd: string): Promise<string> {
      return `proto-${this.agentId}`;
    }
    async prompt(): Promise<{ stopReason: string }> {
      return new Promise(() => {});
    }
    async cancel(): Promise<void> {}
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

describe("AcpSessionManager — latestUsage tracking", () => {
  const noopSend = () => {};

  test("records latestUsage from a usage_update on the session state", async () => {
    handlerFactories.length = 0;
    const manager = new AcpSessionManager(5);

    const { acpSessionId } = await manager.spawn(
      "agent-usage",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-parent",
      noopSend,
    );

    const handler = handlerFactories[handlerFactories.length - 1]?.(undefined);
    expect(handler).toBeDefined();

    await handler?.sessionUpdate({
      sessionId: acpSessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 1200,
        size: 200000,
        cost: { amount: 0.42, currency: "USD" },
      },
    });

    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.latestUsage).toEqual({
      usedTokens: 1200,
      contextSize: 200000,
      costAmount: 0.42,
      costCurrency: "USD",
    });
  });

  test("latestUsage omits cost fields when usage_update carries no cost", async () => {
    handlerFactories.length = 0;
    const manager = new AcpSessionManager(5);

    const { acpSessionId } = await manager.spawn(
      "agent-usage-nocost",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-parent",
      noopSend,
    );

    const handler = handlerFactories[handlerFactories.length - 1]?.(undefined);
    await handler?.sessionUpdate({
      sessionId: acpSessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 50,
        size: 100,
      },
    });

    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.latestUsage).toEqual({
      usedTokens: 50,
      contextSize: 100,
      costAmount: undefined,
      costCurrency: undefined,
    });
  });
});
