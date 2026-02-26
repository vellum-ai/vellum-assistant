/**
 * Tests for the thread seed composer.
 *
 * Validates surface-aware verbosity resolution, copy-based seed
 * composition, and the threadSeedMessage sanity check.
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

  test('rejects very short string (1-2 chars)', () => {
    expect(isThreadSeedSane('Hi')).toBe(false);
  });

  test('accepts short CJK text (>= 3 chars)', () => {
    // CJK characters pack more meaning per character
    expect(isThreadSeedSane('リマインダー')).toBe(true);
    expect(isThreadSeedSane('提醒您')).toBe(true);
  });

  test('accepts string at min boundary (3 chars)', () => {
    expect(isThreadSeedSane('abc')).toBe(true);
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
});

// ── composeThreadSeed — copy-based composition ─────────────────────────

describe('composeThreadSeed', () => {
  describe('rich verbosity (vellum/macos)', () => {
    test('combines title and body into flowing prose', () => {
      const signal = makeSignal();
      const copy = makeCopy({ title: 'Reminder', body: 'Take out the trash' });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      expect(seed).toContain('Reminder');
      expect(seed).toContain('Take out the trash');
      // Should be flowing prose (joined with ". "), not newline-separated
      expect(seed).not.toContain('\n');
    });

    test('appends "Action required." when requiresAction is true', () => {
      const signal = makeSignal({
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const copy = makeCopy({ title: 'Reminder', body: 'Call the doctor' });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      expect(seed).toContain('Action required');
    });

    test('omits "Notification" generic title', () => {
      const signal = makeSignal();
      const copy = makeCopy({ title: 'Notification', body: 'Something new.' });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      expect(seed).not.toMatch(/^Notification/);
      expect(seed).toContain('Something new');
    });
  });

  describe('compact verbosity (telegram)', () => {
    test('preserves title/body format with newline separator', () => {
      const signal = makeSignal();
      const copy = makeCopy({ title: 'Alert', body: 'Details here.' });
      const seed = composeThreadSeed(signal, 'telegram' as NotificationChannel, copy);
      expect(seed).toBe('Alert\n\nDetails here.');
    });

    test('does not append action markers', () => {
      const signal = makeSignal({
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const copy = makeCopy({ title: 'Reminder', body: 'Respond to email' });
      const seed = composeThreadSeed(signal, 'telegram' as NotificationChannel, copy);
      expect(seed).toBe('Reminder\n\nRespond to email');
    });
  });

  describe('localization preservation', () => {
    test('preserves localized LLM copy on vellum (rich)', () => {
      const signal = makeSignal();
      const copy = makeCopy({
        title: 'リマインダー',
        body: 'ゴミを出してください',
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      expect(seed).toContain('リマインダー');
      expect(seed).toContain('ゴミを出してください');
    });

    test('preserves localized LLM copy on telegram (compact)', () => {
      const signal = makeSignal();
      const copy = makeCopy({
        title: 'リマインダー',
        body: 'ゴミを出してください',
      });
      const seed = composeThreadSeed(signal, 'telegram' as NotificationChannel, copy);
      expect(seed).toBe('リマインダー\n\nゴミを出してください');
    });

    test('does not inject English template strings into localized copy', () => {
      const signal = makeSignal({
        sourceEventName: 'guardian.question',
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const copy = makeCopy({
        title: 'ガーディアンの質問',
        body: 'ゲートコードは何ですか？',
      });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      expect(seed).toContain('ガーディアンの質問');
      expect(seed).toContain('ゲートコードは何ですか？');
      // The only English that may appear is "Action required." which is
      // an intentional structural marker, not a content replacement
    });
  });

  describe('surface-aware verbosity', () => {
    test('vellum seeds are formatted differently than telegram seeds', () => {
      const signal = makeSignal({
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const copy = makeCopy({ title: 'Reminder', body: 'Important meeting at 3pm' });
      const richSeed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      const compactSeed = composeThreadSeed(signal, 'telegram' as NotificationChannel, copy);
      // Rich has action note, compact does not
      expect(richSeed).toContain('Action required');
      expect(compactSeed).not.toContain('Action required');
    });

    test('interfaceHint in contextPayload overrides channel default', () => {
      const signal = makeSignal({
        contextPayload: { interfaceHint: 'telegram' },
      });
      const copy = makeCopy({ title: 'Alert', body: 'Details.' });
      // Channel is vellum but interfaceHint says telegram → compact format
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      expect(seed).toBe('Alert\n\nDetails.');
    });
  });

  describe('edge cases', () => {
    test('handles empty copy body gracefully', () => {
      const signal = makeSignal();
      const copy = makeCopy({ title: 'Alert', body: '' });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      expect(seed.length).toBeGreaterThan(0);
    });

    test('never produces raw JSON in output', () => {
      const signal = makeSignal();
      const copy = makeCopy({ title: 'Alert', body: 'Check the results.' });
      const seed = composeThreadSeed(signal, 'vellum' as NotificationChannel, copy);
      expect(seed).not.toMatch(/^\{/);
      expect(seed).not.toMatch(/^\[/);
    });
  });
});
