import { describe, expect, test } from "bun:test";

import { AgentLoop } from "../agent/loop.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

/** Minimal mock provider that captures the config passed to sendMessage. */
function createMockProvider(): {
  provider: Provider;
  lastConfig: () => Record<string, unknown> | undefined;
} {
  let capturedConfig: Record<string, unknown> | undefined;

  const provider: Provider = {
    name: "mock",
    async sendMessage(
      _messages: Message[],
      _tools?: ToolDefinition[],
      _systemPrompt?: string,
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      capturedConfig = options?.config as Record<string, unknown> | undefined;
      return {
        content: [{ type: "text", text: "Hello" }],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      };
    },
  };

  return { provider, lastConfig: () => capturedConfig };
}

describe("AgentLoop thinking and effort", () => {
  test("sends adaptive thinking when thinking is enabled", async () => {
    const { provider, lastConfig } = createMockProvider();
    const loop = new AgentLoop(provider, "test", {
      maxTokens: 64000,
      thinking: { enabled: true },
    });

    await loop.run(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      () => {},
    );

    const config = lastConfig()!;
    const thinking = config.thinking as { type: string };
    expect(thinking.type).toBe("adaptive");
  });

  test("sends disabled thinking when thinking is disabled", async () => {
    const { provider, lastConfig } = createMockProvider();
    const loop = new AgentLoop(provider, "test", {
      maxTokens: 64000,
      thinking: { enabled: false },
    });

    await loop.run(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      () => {},
    );

    const config = lastConfig()!;
    expect(config.thinking).toEqual({ type: "disabled" });
  });

  test("sends effort in provider config", async () => {
    const { provider, lastConfig } = createMockProvider();
    const loop = new AgentLoop(provider, "test", {
      maxTokens: 64000,
      effort: "high",
    });

    await loop.run(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      () => {},
    );

    const config = lastConfig()!;
    expect(config.effort).toBe("high");
  });

  test("sends effort with disabled thinking when thinking is disabled", async () => {
    const { provider, lastConfig } = createMockProvider();
    const loop = new AgentLoop(provider, "test", {
      maxTokens: 64000,
      effort: "medium",
      thinking: { enabled: false },
    });

    await loop.run(
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      () => {},
    );

    const config = lastConfig()!;
    expect(config.effort).toBe("medium");
    expect(config.thinking).toEqual({ type: "disabled" });
  });
});
