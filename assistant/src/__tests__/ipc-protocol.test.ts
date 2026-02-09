import { describe, test, expect } from 'bun:test';
import { createMessageParser, serialize, MAX_LINE_SIZE } from '../daemon/ipc-protocol.js';

describe('IPC Protocol', () => {
  describe('serialize', () => {
    test('serializes a message to JSON with trailing newline', () => {
      const result = serialize({ type: 'ping' });
      expect(result).toBe('{"type":"ping"}\n');
    });
  });

  describe('createMessageParser', () => {
    test('parses a complete JSON message', () => {
      const parser = createMessageParser();
      const messages = parser.feed('{"type":"ping"}\n');
      expect(messages).toEqual([{ type: 'ping' }]);
    });

    test('handles partial messages across multiple feeds', () => {
      const parser = createMessageParser();
      const m1 = parser.feed('{"type":');
      expect(m1).toEqual([]);
      const m2 = parser.feed('"ping"}\n');
      expect(m2).toEqual([{ type: 'ping' }]);
    });

    test('parses multiple messages in one feed', () => {
      const parser = createMessageParser();
      const messages = parser.feed('{"type":"ping"}\n{"type":"pong"}\n');
      expect(messages).toEqual([{ type: 'ping' }, { type: 'pong' }]);
    });

    test('skips malformed JSON lines', () => {
      const parser = createMessageParser();
      const messages = parser.feed('not-json\n{"type":"ping"}\n');
      expect(messages).toEqual([{ type: 'ping' }]);
    });

    describe('without maxLineSize (client-side)', () => {
      test('does NOT throw on large messages', () => {
        const parser = createMessageParser();
        const largePayload = 'x'.repeat(MAX_LINE_SIZE + 1000);
        // Feed a large partial line (no newline) — should not throw
        expect(() => parser.feed(largePayload)).not.toThrow();
      });

      test('successfully parses a large complete message', () => {
        const parser = createMessageParser();
        const bigText = 'a'.repeat(MAX_LINE_SIZE + 100);
        const msg = { type: 'assistant_text_delta' as const, text: bigText };
        const messages = parser.feed(serialize(msg));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual(msg);
      });
    });

    describe('with maxLineSize (server-side)', () => {
      test('throws when buffer exceeds maxLineSize', () => {
        const parser = createMessageParser({ maxLineSize: 100 });
        const largePayload = 'x'.repeat(150);
        expect(() => parser.feed(largePayload)).toThrow(
          /exceeds maximum line size of 100 bytes/,
        );
      });

      test('clears buffer after throwing', () => {
        const parser = createMessageParser({ maxLineSize: 100 });
        const largePayload = 'x'.repeat(150);
        expect(() => parser.feed(largePayload)).toThrow();
        // After the throw, the buffer should be cleared and parsing should work again
        const messages = parser.feed('{"type":"ping"}\n');
        expect(messages).toEqual([{ type: 'ping' }]);
      });

      test('does not throw when buffer is within limit', () => {
        const parser = createMessageParser({ maxLineSize: 100 });
        expect(() => parser.feed('short partial')).not.toThrow();
      });

      test('does not throw for complete messages regardless of size', () => {
        const parser = createMessageParser({ maxLineSize: 100 });
        // A long complete line (terminated by \n) is consumed immediately,
        // so the buffer is empty after processing.
        const longLine = JSON.stringify({ type: 'ping', data: 'x'.repeat(200) }) + '\n';
        expect(() => parser.feed(longLine)).not.toThrow();
      });

      test('throws with MAX_LINE_SIZE constant', () => {
        const parser = createMessageParser({ maxLineSize: MAX_LINE_SIZE });
        const oversized = 'x'.repeat(MAX_LINE_SIZE + 1);
        expect(() => parser.feed(oversized)).toThrow(
          /exceeds maximum line size/,
        );
      });
    });
  });
});
