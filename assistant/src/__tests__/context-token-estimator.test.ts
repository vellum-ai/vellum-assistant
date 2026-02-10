import { describe, expect, test } from 'bun:test';
import type { Message } from '../providers/types.js';
import {
  estimateContentBlockTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimatePromptTokens,
  estimateTextTokens,
} from '../context/token-estimator.js';

describe('token estimator', () => {
  test('estimates text tokens from character length', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
  });

  test('estimates block types with non-zero overhead', () => {
    expect(estimateContentBlockTokens({ type: 'text', text: 'hello world' })).toBeGreaterThan(0);
    expect(
      estimateContentBlockTokens({
        type: 'tool_use',
        id: 't1',
        name: 'shell',
        input: { command: 'echo hi' },
      }),
    ).toBeGreaterThan(estimateContentBlockTokens({ type: 'text', text: 'echo hi' }));
    expect(
      estimateContentBlockTokens({
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'done',
      }),
    ).toBeGreaterThan(estimateContentBlockTokens({ type: 'text', text: 'done' }));
    expect(
      estimateContentBlockTokens({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(100) },
      }),
    ).toBeGreaterThan(500);
  });

  test('estimates message and prompt totals', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Please summarize this' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure.' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/tmp/a.txt' } },
        ],
      },
    ];
    const messagesOnly = estimateMessagesTokens(messages);
    const withSystem = estimatePromptTokens(messages, 'System prompt');
    expect(estimateMessageTokens(messages[0])).toBeGreaterThan(0);
    expect(messagesOnly).toBeGreaterThan(estimateMessageTokens(messages[0]));
    expect(withSystem).toBeGreaterThan(messagesOnly);
  });

  test('counts file base64 payload when estimating file block tokens', () => {
    const sharedSource = {
      type: 'base64' as const,
      filename: 'report.pdf',
      media_type: 'application/pdf',
    };
    const smallFileTokens = estimateContentBlockTokens({
      type: 'file',
      source: { ...sharedSource, data: 'a'.repeat(64) },
      extracted_text: 'short summary',
    });
    const largeFileTokens = estimateContentBlockTokens({
      type: 'file',
      source: { ...sharedSource, data: 'a'.repeat(6400) },
      extracted_text: 'short summary',
    });

    expect(largeFileTokens).toBeGreaterThan(smallFileTokens);
    expect(largeFileTokens - smallFileTokens).toBeGreaterThan(1000);
  });
});
