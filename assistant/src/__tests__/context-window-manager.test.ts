import { describe, expect, test } from 'bun:test';
import {
  CONTEXT_SUMMARY_MARKER,
  ContextWindowManager,
  createContextSummaryMessage,
  getSummaryFromContextMessage,
} from '../context/window-manager.js';
import type { ContextWindowConfig } from '../config/types.js';
import type { Message, Provider, ProviderResponse } from '../providers/types.js';

function makeConfig(overrides: Partial<ContextWindowConfig> = {}): ContextWindowConfig {
  return {
    enabled: true,
    maxInputTokens: 450,
    targetInputTokens: 300,
    compactThreshold: 0.6,
    preserveRecentUserTurns: 2,
    summaryMaxTokens: 128,
    chunkTokens: 80,
    ...overrides,
  };
}

function createProvider(fn: (messages: Message[]) => ProviderResponse | Promise<ProviderResponse>): Provider {
  return {
    name: 'mock',
    async sendMessage(messages: Message[]): Promise<ProviderResponse> {
      return fn(messages);
    },
  };
}

function message(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

describe('ContextWindowManager', () => {
  test('skips compaction when estimated tokens are below threshold', async () => {
    const provider = createProvider(() => {
      throw new Error('should not be called');
    });
    const manager = new ContextWindowManager(provider, 'system prompt', makeConfig());
    const history = [
      message('user', 'hello'),
      message('assistant', 'hi'),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(history);
    expect(result.reason).toBe('below compaction threshold');
  });

  test('compacts old turns and keeps recent user turns', async () => {
    let summaryCalls = 0;
    const provider = createProvider(() => {
      summaryCalls += 1;
      return {
        content: [{ type: 'text', text: `## Goals\n- summary call ${summaryCalls}` }],
        model: 'mock-model',
        usage: { inputTokens: 100, outputTokens: 25 },
        stopReason: 'end_turn',
      };
    });
    const manager = new ContextWindowManager(provider, 'system prompt', makeConfig());
    const long = 'x'.repeat(240);
    const history: Message[] = [
      message('user', `u1 ${long}`),
      message('assistant', `a1 ${long}`),
      message('user', `u2 ${long}`),
      message('assistant', `a2 ${long}`),
      message('user', `u3 ${long}`),
      message('assistant', `a3 ${long}`),
    ];

    const result = await manager.maybeCompact(history);

    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBeGreaterThan(0);
    expect(result.summaryCalls).toBe(summaryCalls);
    expect(result.summaryInputTokens).toBeGreaterThan(0);
    expect(result.summaryOutputTokens).toBeGreaterThan(0);
    expect(result.messages[0].role).toBe('assistant');
    expect(getSummaryFromContextMessage(result.messages[0])?.length).toBeGreaterThan(0);

    const userTexts = result.messages
      .filter((m) => m.role === 'user')
      .map((m) => (m.content[0].type === 'text' ? m.content[0].text : ''));
    expect(userTexts.some((text) => text.startsWith('u1 '))).toBe(false);
    expect(userTexts.some((text) => text.startsWith('u2 '))).toBe(true);
    expect(userTexts.some((text) => text.startsWith('u3 '))).toBe(true);
  });

  test('updates an existing summary message instead of nesting summaries', async () => {
    const provider = createProvider(() => ({
      content: [{ type: 'text', text: '## Goals\n- updated summary' }],
      model: 'mock-model',
      usage: { inputTokens: 50, outputTokens: 10 },
      stopReason: 'end_turn',
    }));
    const manager = new ContextWindowManager(
      provider,
      'system prompt',
      makeConfig({ maxInputTokens: 300, targetInputTokens: 160, preserveRecentUserTurns: 1 }),
    );
    const long = 'y'.repeat(220);
    const history: Message[] = [
      createContextSummaryMessage('## Goals\n- old summary'),
      message('user', `older ${long}`),
      message('assistant', `reply ${long}`),
      message('user', `latest ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeLessThan(history.length + 1);
    expect(getSummaryFromContextMessage(result.messages[0])).toContain('updated summary');
    expect(
      result.messages.filter(
        (m) =>
          m.role === 'assistant'
          && m.content.some(
            (block) =>
              block.type === 'text'
              && block.text.startsWith(CONTEXT_SUMMARY_MARKER),
          ),
      ),
    ).toHaveLength(1);
  });

  test('falls back to local summary when provider summarization fails', async () => {
    const provider = createProvider(async () => {
      throw new Error('provider unavailable');
    });
    const manager = new ContextWindowManager(
      provider,
      'system prompt',
      makeConfig({ maxInputTokens: 260, targetInputTokens: 140, preserveRecentUserTurns: 1 }),
    );
    const long = 'z'.repeat(220);
    const history = [
      message('user', `task ${long}`),
      message('assistant', `result ${long}`),
      message('user', `followup ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    expect(result.summaryCalls).toBeGreaterThan(0);
    expect(result.summaryInputTokens).toBe(0);
    expect(result.summaryOutputTokens).toBe(0);
    expect(result.summaryModel).toBe('');
    expect(result.summaryText).toContain('## Recent Progress');
  });
});
