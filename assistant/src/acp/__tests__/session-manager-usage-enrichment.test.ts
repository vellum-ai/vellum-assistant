/**
 * Verifies that the cumulative `PromptResponse.usage` payload enriches the
 * emitted `acp_session_usage` event with the reported model and cache-read/
 * write token totals.
 */

import { describe, expect, mock, test } from "bun:test";

import type { SessionNotification } from "@agentclientprotocol/sdk";

import type { ServerMessage } from "../../daemon/message-protocol.js";

type HandlerFactory = (agent: unknown) => {
  sessionUpdate(params: SessionNotification): Promise<void>;
};
const handlerFactories: HandlerFactory[] = [];

// Captured resolver for the in-flight prompt so a test can report a model
// (via a session update) before the prompt completes with a usage payload.
let resolvePrompt: (value: unknown) => void = () => {};

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
    prompt(): Promise<unknown> {
      return new Promise((res) => {
        resolvePrompt = res as (value: unknown) => void;
      });
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

// persistTerminal writes a history row on completion; stand up the DB.
const { initializeDb } = await import("../../persistence/db-init.js");
await initializeDb();
const { AcpSessionManager } = await import("../session-manager.js");

describe("AcpSessionManager — usage enrichment from PromptResponse", () => {
  test("emits model + cache tokens on the final usage event", async () => {
    handlerFactories.length = 0;
    const sent: ServerMessage[] = [];
    const manager = new AcpSessionManager(5);

    const { acpSessionId } = await manager.spawn(
      "agent-enrich",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-parent",
      (msg) => sent.push(msg),
    );

    const handler = handlerFactories[handlerFactories.length - 1]?.(undefined);
    // Report the model before the prompt resolves.
    await handler?.sessionUpdate({
      sessionId: acpSessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            type: "select",
            category: "model",
            id: "model",
            name: "Model",
            currentValue: "opus",
            options: [
              { value: "opus", name: "Claude Opus" },
              { value: "sonnet", name: "Claude Sonnet" },
            ],
          },
        ],
      },
    });

    // Complete the turn with a cumulative usage payload carrying cache tokens.
    resolvePrompt({
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedReadTokens: 40,
        cachedWriteTokens: 10,
        totalTokens: 170,
      },
    });
    // Flush the background prompt's .then() chain.
    await new Promise((r) => setTimeout(r, 0));

    const usageEvent = sent.find(
      (m): m is Extract<ServerMessage, { type: "acp_session_usage" }> =>
        m.type === "acp_session_usage",
    );
    expect(usageEvent).toBeDefined();
    expect(usageEvent?.model).toBe("Claude Opus");
    expect(usageEvent?.cacheReadTokens).toBe(40);
    expect(usageEvent?.cacheWriteTokens).toBe(10);
    expect(usageEvent?.inputTokens).toBe(100);
    expect(usageEvent?.outputTokens).toBe(20);
  });
});
