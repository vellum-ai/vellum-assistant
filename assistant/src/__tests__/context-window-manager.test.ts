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
    expect(result.messages[0].role).toBe('user');
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
          m.role === 'user'
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

  test('serializes file blocks for summary chunks', async () => {
    const prompts: string[] = [];
    const provider = createProvider((messages) => {
      const textBlock = messages[0]?.content[0];
      if (textBlock?.type === 'text') {
        prompts.push(textBlock.text);
      }
      return {
        content: [{ type: 'text', text: '## Goals\n- file summarized' }],
        model: 'mock-model',
        usage: { inputTokens: 60, outputTokens: 12 },
        stopReason: 'end_turn',
      };
    });
    const manager = new ContextWindowManager(
      provider,
      'system prompt',
      makeConfig({ maxInputTokens: 280, targetInputTokens: 150, preserveRecentUserTurns: 1 }),
    );
    const long = 'f'.repeat(220);
    const history: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              filename: 'spec.pdf',
              data: 'a'.repeat(4096),
            },
            extracted_text: 'Critical requirement from attached spec.',
          },
        ],
      },
      message('assistant', `ack ${long}`),
      message('user', `followup ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);

    const combinedPrompts = prompts.join('\n');
    expect(combinedPrompts).toContain('file: spec.pdf');
    expect(combinedPrompts).toContain('application/pdf');
    expect(combinedPrompts).toContain('Critical requirement from attached spec.');
    expect(combinedPrompts).not.toContain('unknown_block');
  });

  test('counts compacted persisted messages without tool-result user turns', async () => {
    const provider = createProvider(() => ({
      content: [{ type: 'text', text: '## Goals\n- compacted summary' }],
      model: 'mock-model',
      usage: { inputTokens: 75, outputTokens: 20 },
      stopReason: 'end_turn',
    }));
    const manager = new ContextWindowManager(
      provider,
      'system prompt',
      makeConfig({ maxInputTokens: 320, targetInputTokens: 170, preserveRecentUserTurns: 1 }),
    );
    const long = 'k'.repeat(220);
    const history: Message[] = [
      message('user', `u1 ${long}`),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/tmp/a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }] },
      message('assistant', `a1 ${long}`),
      message('user', `u2 ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(4);
    expect(result.compactedPersistedMessages).toBe(3);
  });

  test('counts mixed tool_result+text user messages as persisted', async () => {
    const provider = createProvider(() => ({
      content: [{ type: 'text', text: '## Goals\n- mixed summary' }],
      model: 'mock-model',
      usage: { inputTokens: 75, outputTokens: 20 },
      stopReason: 'end_turn',
    }));
    const manager = new ContextWindowManager(
      provider,
      'system prompt',
      makeConfig({ maxInputTokens: 320, targetInputTokens: 170, preserveRecentUserTurns: 1 }),
    );
    const long = 'k'.repeat(220);
    // Simulates a merged user message (repairHistory merges consecutive same-role
    // messages), resulting in a user turn with both tool_result and text blocks.
    const history: Message[] = [
      message('user', `u1 ${long}`),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/tmp/a' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'contents' },
          { type: 'text', text: `follow-up question ${long}` },
        ],
      },
      message('assistant', `a1 ${long}`),
      message('user', `u2 ${long}`),
    ];

    const result = await manager.maybeCompact(history);
    expect(result.compacted).toBe(true);
    // The mixed user message should be counted as persisted (4 = u1 + mixed + a_tooluse + a1)
    expect(result.compactedPersistedMessages).toBe(4);
  });

  test('parses legacy assistant-role context summary messages', () => {
    const legacySummary: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: `${CONTEXT_SUMMARY_MARKER}\n## Goals\n- legacy` }],
    };
    expect(getSummaryFromContextMessage(legacySummary)).toContain('legacy');
  });

  test('does not parse user-authored summary marker text as internal summary', () => {
    const userMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: `${CONTEXT_SUMMARY_MARKER}\nI typed this prefix myself` }],
    };
    expect(getSummaryFromContextMessage(userMessage)).toBeNull();
  });

  test('skips compaction during cooldown when projected gain is too low', async () => {
    const provider = createProvider(() => {
      throw new Error('summarizer should not be called while cooldown skip is active');
    });
    const manager = new ContextWindowManager(
      provider,
      'system prompt',
      makeConfig({ maxInputTokens: 260, targetInputTokens: 180, preserveRecentUserTurns: 1 }),
    );
    const long = 'c'.repeat(220);
    const history: Message[] = [
      message('user', `u1 ${long}`),
      message('assistant', `a1 ${long}`),
      message('user', `u2 ${long}`),
    ];

    const result = await manager.maybeCompact(history, undefined, {
      lastCompactedAt: Date.now() - 30_000,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('compaction cooldown active with low projected gain');
  });

  test('ignores cooldown and compacts under severe token pressure', async () => {
    const provider = createProvider(() => ({
      content: [{ type: 'text', text: '## Goals\n- compacted under pressure' }],
      model: 'mock-model',
      usage: { inputTokens: 60, outputTokens: 12 },
      stopReason: 'end_turn',
    }));
    const manager = new ContextWindowManager(
      provider,
      'system prompt',
      makeConfig({ maxInputTokens: 320, targetInputTokens: 180, preserveRecentUserTurns: 1 }),
    );
    const long = 'p'.repeat(340);
    const history: Message[] = [
      message('user', `u1 ${long}`),
      message('assistant', `a1 ${long}`),
      message('user', `u2 ${long}`),
      message('assistant', `a2 ${long}`),
      message('user', `u3 ${long}`),
    ];

    const result = await manager.maybeCompact(history, undefined, {
      lastCompactedAt: Date.now() - 30_000,
    });
    expect(result.compacted).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
