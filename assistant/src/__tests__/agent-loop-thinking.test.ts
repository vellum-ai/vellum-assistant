import { describe, test, expect } from 'bun:test';
import { AgentLoop } from '../agent/loop.js';
import type { Provider, Message, ProviderResponse, SendMessageOptions, ToolDefinition } from '../providers/types.js';

/** Minimal mock provider that captures the config passed to sendMessage. */
function createMockProvider(): { provider: Provider; lastConfig: () => Record<string, unknown> | undefined } {
  let capturedConfig: Record<string, unknown> | undefined;

  const provider: Provider = {
    name: 'mock',
    async sendMessage(
      _messages: Message[],
      _tools?: ToolDefinition[],
      _systemPrompt?: string,
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      capturedConfig = options?.config as Record<string, unknown> | undefined;
      return {
        content: [{ type: 'text', text: 'Hello' }],
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'end_turn',
      };
    },
  };

  return { provider, lastConfig: () => capturedConfig };
}

describe('AgentLoop thinking budget clamping', () => {
  test('clamps budget_tokens when it exceeds max_tokens', async () => {
    const { provider, lastConfig } = createMockProvider();
    const loop = new AgentLoop(provider, 'test', {
      maxTokens: 4096,
      thinking: { enabled: true, budgetTokens: 10000 },
    });

    await loop.run(
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      () => {},
    );

    const config = lastConfig()!;
    const thinking = config.thinking as { type: string; budget_tokens: number };
    expect(thinking.type).toBe('enabled');
    expect(thinking.budget_tokens).toBe(4095); // clamped to maxTokens - 1
  });

  test('does not clamp when budget_tokens is within max_tokens', async () => {
    const { provider, lastConfig } = createMockProvider();
    const loop = new AgentLoop(provider, 'test', {
      maxTokens: 64000,
      thinking: { enabled: true, budgetTokens: 10000 },
    });

    await loop.run(
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      () => {},
    );

    const config = lastConfig()!;
    const thinking = config.thinking as { type: string; budget_tokens: number };
    expect(thinking.budget_tokens).toBe(10000); // unchanged
  });

  test('does not include thinking config when thinking is disabled', async () => {
    const { provider, lastConfig } = createMockProvider();
    const loop = new AgentLoop(provider, 'test', {
      maxTokens: 64000,
      thinking: { enabled: false, budgetTokens: 10000 },
    });

    await loop.run(
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      () => {},
    );

    const config = lastConfig()!;
    expect(config.thinking).toBeUndefined();
  });
});
