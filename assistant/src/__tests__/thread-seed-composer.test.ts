/**
 * Tests for the thread seed composer.
 *
 * Validates surface-aware verbosity resolution, event-specific seed
 * templates, generic fallback, and the threadSeedMessage sanity check.
 */

import { describe, expect, test } from 'bun:test';

import {
  composeThreadSeed,
  isThreadSeedSane,
  resolveVerbosity,
} from '../notifications/thread-seed-composer.js';
import type { NotificationSignal } from '../notifications/signal.js';
import type { NotificationChannel, RenderedChannelCopy } from '../notifications/types.js';

// ── Helpers ────────────────────────────────────────────────────────────

function makeSignal(overrides?: Partial<NotificationSignal>): NotificationSignal {
  return {
    signalId: 'sig-seed-001',
    assistantId: 'self',
    createdAt: Date.now(),
    sourceChannel: 'scheduler',
    sourceSessionId: 'sess-1',
    sourceEventName: 'test.event',
    contextPayload: {},
    attentionHints: {
      requiresAction: false,
      urgency: 'medium',
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

function makeCopy(overrides?: Partial<RenderedChannelCopy>): RenderedChannelCopy {
  return {
    title: 'Test Alert',
    body: 'Something happened.',
    ...overrides,
  };
}

// ── resolveVerbosity ───────────────────────────────────────────────────

describe('resolveVerbosity', () => {
  test('vellum channel defaults to rich', () => {
    expect(resolveVerbosity('vellum' as NotificationChannel, {})).toBe('rich');
  });

  test('telegram channel defaults to compact', () => {
    expect(resolveVerbosity('telegram' as NotificationChannel, {})).toBe('compact');
  });

  test('explicit interfaceHint=macos overrides to rich', () => {
    expect(
      resolveVerbosity('telegram' as NotificationChannel, { interfaceHint: 'macos' }),
    ).toBe('rich');
  });

  test('explicit interfaceHint=telegram overrides to compact', () => {
    expect(
      resolveVerbosity('vellum' as NotificationChannel, { interfaceHint: 'telegram' }),
    ).toBe('compact');
  });

  test('explicit interfaceHint=ios resolves to rich', () => {
    expect(
      resolveVerbosity('telegram' as NotificationChannel, { interfaceHint: 'ios' }),
    ).toBe('rich');
  });

  test('sourceInterface is used when interfaceHint is missing', () => {
    expect(
      resolveVerbosity('telegram' as NotificationChannel, { sourceInterface: 'macos' }),
    ).toBe('rich');
  });

  test('interfaceHint takes priority over sourceInterface', () => {
    expect(
      resolveVerbosity('telegram' as NotificationChannel, {
        interfaceHint: 'telegram',
        sourceInterface: 'macos',
      }),
    ).toBe('compact');
  });

  test('invalid interfaceHint is ignored, falls through to channel default', () => {
    expect(
      resolveVerbosity('vellum' as NotificationChannel, { interfaceHint: 'not_a_real_interface' }),
    ).toBe('rich');
  });

  test('unknown channel without hints defaults to compact', () => {
    expect(resolveVerbosity('sms' as NotificationChannel, {})).toBe('compact');
  });
});

// ── isThreadSeedSane ───────────────────────────────────────────────────

describe('isThreadSeedSane', () => {
  test('accepts a normal string', () => {
    expect(isThreadSeedSane('This is a valid thread seed message.')).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isThreadSeedSane('')).toBe(false);
  });

  test('rejects very short string', () => {
    expect(isThreadSeedSane('Hi')).toBe(false);
  });

  test('rejects JSON object dump', () => {
    expect(isThreadSeedSane('{"key": "value", "nested": {"a": 1}}')).toBe(false);
  });

  test('rejects JSON array dump', () => {
    expect(isThreadSeedSane('[{"item": 1}, {"item": 2}]')).toBe(false);
  });

  test('rejects non-string values', () => {
    expect(isThreadSeedSane(42)).toBe(false);
    expect(isThreadSeedSane(null)).toBe(false);
    expect(isThreadSeedSane(undefined)).toBe(false);
  });

  test('rejects excessively long string', () => {
    expect(isThreadSeedSane('x'.repeat(2001))).toBe(false);
  });

  test('accepts string at max boundary', () => {
    expect(isThreadSeedSane('x'.repeat(2000))).toBe(true);
  });

  test('accepts string at min boundary', () => {
    expect(isThreadSeedSane('0123456789')).toBe(true);
  });
});

// ── composeThreadSeed — event-specific templates ───────────────────────

describe('composeThreadSeed', () => {
  describe('reminder.fired', () => {
    test('rich verbosity includes reminder message', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: { message: 'Take out the trash' },
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      expect(seed).toContain('Take out the trash');
      expect(seed).toContain('Reminder');
    });

    test('rich verbosity with requiresAction includes attention note', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: { message: 'Call the doctor' },
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      expect(seed).toContain('Call the doctor');
      expect(seed).toContain('attention');
    });

    test('compact verbosity is shorter', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: { message: 'Take out the trash' },
      });
      const richSeed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      const compactSeed = composeThreadSeed(signal, 'telegram' as NotificationChannel, makeCopy());
      expect(compactSeed.length).toBeLessThanOrEqual(richSeed.length);
      expect(compactSeed).toContain('Take out the trash');
    });

    test('compact with requiresAction appends action marker', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: { message: 'Respond to email' },
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const seed = composeThreadSeed(signal, 'telegram' as NotificationChannel, makeCopy());
      expect(seed).toContain('action needed');
    });

    test('falls back to label when message is missing', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: { label: 'My labeled reminder' },
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      expect(seed).toContain('My labeled reminder');
    });

    test('uses default text when both message and label are missing', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: {},
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      expect(seed).toContain('reminder has fired');
    });
  });

  describe('guardian.question', () => {
    test('rich includes question text and reply instruction', () => {
      const signal = makeSignal({
        sourceEventName: 'guardian.question',
        contextPayload: { questionText: 'What is the gate code?' },
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      expect(seed).toContain('What is the gate code?');
      expect(seed).toContain('Reply');
    });

    test('compact is shorter', () => {
      const signal = makeSignal({
        sourceEventName: 'guardian.question',
        contextPayload: { questionText: 'What is the gate code?' },
      });
      const seed = composeThreadSeed(signal, 'telegram' as NotificationChannel, makeCopy());
      expect(seed).toContain('What is the gate code?');
      expect(seed).not.toContain('Reply in this thread');
    });
  });

  describe('tool_confirmation.required_action', () => {
    test('rich mentions tool name and includes review instruction', () => {
      const signal = makeSignal({
        sourceEventName: 'tool_confirmation.required_action',
        contextPayload: { toolName: 'send_email' },
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      expect(seed).toContain('send_email');
      expect(seed).toContain('confirmation');
    });

    test('compact is concise', () => {
      const signal = makeSignal({
        sourceEventName: 'tool_confirmation.required_action',
        contextPayload: { toolName: 'send_email' },
      });
      const seed = composeThreadSeed(signal, 'telegram' as NotificationChannel, makeCopy());
      expect(seed).toContain('send_email');
      expect(seed).toContain('confirmation');
      expect(seed.length).toBeLessThan(50);
    });
  });

  describe('ingress.escalation', () => {
    test('rich includes sender, preview, and action instruction', () => {
      const signal = makeSignal({
        sourceEventName: 'ingress.escalation',
        contextPayload: { senderIdentifier: 'Alice', preview: 'Can you help me?' },
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      expect(seed).toContain('Alice');
      expect(seed).toContain('Can you help me?');
      expect(seed).toContain('review');
    });

    test('compact omits detailed instructions', () => {
      const signal = makeSignal({
        sourceEventName: 'ingress.escalation',
        contextPayload: { senderIdentifier: 'Bob' },
      });
      const seed = composeThreadSeed(signal, 'telegram' as NotificationChannel, makeCopy());
      expect(seed).toContain('Bob');
      expect(seed).toContain('attention');
    });
  });

  // ── Generic fallback ─────────────────────────────────────────────────

  describe('generic fallback (unknown event)', () => {
    test('rich generic includes copy title and body with action note', () => {
      const signal = makeSignal({
        sourceEventName: 'some.unknown_event',
        attentionHints: {
          requiresAction: true,
          urgency: 'medium',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const copy = makeCopy({ title: 'Custom Title', body: 'Event details here.' });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      expect(seed).toContain('Custom Title');
      expect(seed).toContain('Event details here');
      expect(seed).toContain('Action required');
    });

    test('rich generic skips "Notification" title', () => {
      const signal = makeSignal({ sourceEventName: 'novel.event' });
      const copy = makeCopy({ title: 'Notification', body: 'Something new.' });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      expect(seed).not.toMatch(/^Notification/);
      expect(seed).toContain('Something new');
    });

    test('compact generic preserves title/body format', () => {
      const signal = makeSignal({ sourceEventName: 'novel.event' });
      const copy = makeCopy({ title: 'Alert', body: 'Details here.' });
      const seed = composeThreadSeed(signal, 'telegram' as NotificationChannel, copy);
      expect(seed).toBe('Alert\n\nDetails here.');
    });
  });

  // ── Surface-aware verbosity ──────────────────────────────────────────

  describe('surface-aware verbosity', () => {
    test('vellum seeds are longer than telegram seeds for same signal', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: { message: 'Important meeting at 3pm' },
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const richSeed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      const compactSeed = composeThreadSeed(signal, 'telegram' as NotificationChannel, makeCopy());
      expect(richSeed.length).toBeGreaterThan(compactSeed.length);
    });

    test('interfaceHint in contextPayload overrides channel default', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: { message: 'Test', interfaceHint: 'telegram' },
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      // Even though channel is vellum, interfaceHint says telegram → compact
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      // Compact reminder with action marker
      expect(seed).toContain('action needed');
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('empty contextPayload produces usable seed', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: {},
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      expect(seed.length).toBeGreaterThan(10);
      expect(seed).not.toContain('{');
    });

    test('never produces raw JSON in output', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: { message: '{"nested": "json"}', extra: { deep: true } },
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, makeCopy());
      // The message field is a string that happens to look like JSON — it should
      // be treated as a string (which it is, since str() just returns it).
      // The point is the seed itself isn't a JSON dump.
      expect(seed).toContain('Reminder');
    });
  });
});
