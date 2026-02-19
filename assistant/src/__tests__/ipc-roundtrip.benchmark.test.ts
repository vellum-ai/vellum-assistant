/**
 * IPC Serialization/Parsing Benchmark
 *
 * Measures serialize + parse round-trip performance in isolation
 * (no daemon required). Target ranges:
 * - Small message p95: < 1ms (averaged over 1000 runs)
 * - Large message (1MB): < 50ms
 * - Rapid-fire: no message loss across 100 messages
 * - Round-trip: content preserved exactly
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { serialize, createMessageParser } from '../daemon/ipc-protocol.js';
import type { ClientMessage, ServerMessage } from '../daemon/ipc-contract.js';

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

describe('IPC round-trip benchmark', () => {
  test('small message serialize + parse p95 < 1ms over 1000 runs', () => {
    const msg: ClientMessage = { type: 'ping' };
    const parser = createMessageParser();
    const timings: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const start = performance.now();
      const serialized = serialize(msg);
      const parsed = parser.feed(serialized);
      const elapsed = performance.now() - start;
      timings.push(elapsed);

      // Sanity: each iteration should yield exactly one message
      expect(parsed).toHaveLength(1);
    }

    const p95 = percentile(timings, 95);
    expect(p95).toBeLessThan(1);
  });

  test('large message (1MB) serialize + parse < 50ms', () => {
    // Build a ~1MB payload using assistant_text_delta with a large text field
    const largeText = 'x'.repeat(1024 * 1024);
    const msg: ServerMessage = { type: 'assistant_text_delta', text: largeText };
    const parser = createMessageParser();
    const timings: number[] = [];

    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const serialized = serialize(msg);
      const parsed = parser.feed(serialized);
      const elapsed = performance.now() - start;
      timings.push(elapsed);

      expect(parsed).toHaveLength(1);
    }

    const p95 = percentile(timings, 95);
    expect(p95).toBeLessThan(50);
  });

  test('no message loss under rapid-fire (100 messages)', () => {
    const parser = createMessageParser();
    const messages: ClientMessage[] = [];

    for (let i = 0; i < 100; i++) {
      messages.push({ type: 'session_list' } as ClientMessage);
    }

    // Serialize all messages and concatenate into a single buffer
    const combined = messages.map((m) => serialize(m)).join('');

    // Feed the entire buffer at once
    const parsed = parser.feed(combined);

    expect(parsed).toHaveLength(100);
    for (const p of parsed) {
      expect(p).toHaveProperty('type', 'session_list');
    }
  });

  test('serialize + parse round-trip preserves message content', () => {
    const parser = createMessageParser();

    const clientMsg: ClientMessage = {
      type: 'user_message',
      sessionId: 'sess-abc-123',
      content: 'Hello, world! Special chars: \u00e9\u00e0\u00fc \ud83d\ude00 "quotes" & <angle>',
      attachments: [
        {
          filename: 'test.txt',
          mimeType: 'text/plain',
          data: 'SGVsbG8gV29ybGQ=',
        },
      ],
    };

    const serialized = serialize(clientMsg);
    const parsed = parser.feed(serialized);

    expect(parsed).toHaveLength(1);
    const roundTripped = parsed[0] as ClientMessage;
    expect(roundTripped).toEqual(clientMsg);

    // Verify specific fields survived the round-trip
    expect(roundTripped.type).toBe('user_message');
    if (roundTripped.type === 'user_message') {
      expect(roundTripped.sessionId).toBe('sess-abc-123');
      expect(roundTripped.content).toContain('\ud83d\ude00');
      expect(roundTripped.attachments).toHaveLength(1);
      expect(roundTripped.attachments![0].filename).toBe('test.txt');
    }
  });
});
