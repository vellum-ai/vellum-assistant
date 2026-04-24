/**
 * Regression test: SubagentManager.spawn() must inherit the parent
 * conversation's trust context onto the child. Without this, the child
 * defaults to trustClass === "unknown" and guardian-gated tools (e.g.
 * web_fetch) fail closed even when the parent was guardian-authenticated.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";

type CapturedTrustContext = { trustClass: string; sourceChannel: string };

const setTrustContextCalls: (CapturedTrustContext | null)[] = [];

class FakeConversation {
  hasSystemPromptOverride = false;
  messages: unknown[] = [];
  usageStats = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

  constructor(
    _id: string,
    _provider: unknown,
    _systemPrompt: string,
    _maxTokens: number,
    _sendToClient: (msg: ServerMessage) => void,
  ) {}

  updateClient(): void {}
  setIsSubagent(): void {}
  setTrustContext(ctx: CapturedTrustContext | null): void {
    setTrustContextCalls.push(ctx);
  }
  setSubagentAllowedTools(): void {}
  setPreactivatedSkillIds(): void {}
  enqueueMessage() {
    return { rejected: false, queued: true };
  }
  abort(): void {}
  dispose(): void {}
  sendToClient(): void {}
  loadFromDb(): Promise<void> {
    return Promise.resolve();
  }
  persistUserMessage(): string {
    return "msg-id";
  }
  runAgentLoop(): Promise<void> {
    return Promise.resolve();
  }
  getCurrentSystemPrompt(): string {
    return "system";
  }
  injectInheritedContext(): void {}
}

mock.module("../daemon/conversation.js", () => ({
  Conversation: FakeConversation,
}));

mock.module("../memory/conversation-bootstrap.js", () => ({
  bootstrapConversation: () => ({ id: "conv-id" }),
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "anthropic" }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: { default: { provider: "anthropic", maxTokens: 4096 } },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { SubagentManager } from "../subagent/manager.js";

describe("SubagentManager — trust context inheritance", () => {
  afterEach(() => {
    setTrustContextCalls.length = 0;
  });

  test("copies the parent conversation's trust context onto the child", async () => {
    const manager = new SubagentManager();
    const parentTrustContext = {
      trustClass: "guardian" as const,
      sourceChannel: "slack" as const,
    };
    manager.resolveParentConversation = ((id: string) => {
      if (id === "parent-1") {
        return { trustContext: parentTrustContext } as never;
      }
      return undefined;
    }) as typeof manager.resolveParentConversation;

    await manager.spawn(
      {
        parentConversationId: "parent-1",
        label: "test",
        objective: "test objective",
      },
      () => {},
    );

    expect(setTrustContextCalls).toEqual([parentTrustContext]);
  });

  test("does not set trust context when parent cannot be resolved", async () => {
    const manager = new SubagentManager();
    manager.resolveParentConversation = (() =>
      undefined) as typeof manager.resolveParentConversation;

    await manager.spawn(
      {
        parentConversationId: "parent-missing",
        label: "test",
        objective: "test objective",
      },
      () => {},
    );

    expect(setTrustContextCalls).toEqual([]);
  });

  test("does not set trust context when parent has none", async () => {
    const manager = new SubagentManager();
    manager.resolveParentConversation = (() =>
      ({
        trustContext: undefined,
      }) as never) as typeof manager.resolveParentConversation;

    await manager.spawn(
      {
        parentConversationId: "parent-untrusted",
        label: "test",
        objective: "test objective",
      },
      () => {},
    );

    expect(setTrustContextCalls).toEqual([]);
  });
});
