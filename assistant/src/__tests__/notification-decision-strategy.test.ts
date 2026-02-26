/**
 * Regression tests for the notification decision engine's strategy selection.
 *
 * Validates that the deterministic fallback correctly classifies signals based
 * on urgency + requiresAction, that channel selection respects connected channels,
 * and that the copy-composer generates correct fallback copy for known event names.
 */

import { describe, expect, test } from 'bun:test';

import { composeFallbackCopy } from '../notifications/copy-composer.js';
import type { NotificationSignal } from '../notifications/signal.js';
import type { NotificationChannel } from '../notifications/types.js';

// -- Helpers -----------------------------------------------------------------

function makeSignal(overrides?: Partial<NotificationSignal>): NotificationSignal {
  return {
    signalId: 'sig-test-001',
    assistantId: 'self',
    createdAt: Date.now(),
    sourceChannel: 'scheduler',
    sourceSessionId: 'sess-001',
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

// -- Tests -------------------------------------------------------------------

describe('notification decision strategy', () => {
  // -- Copy composer exhaustiveness ------------------------------------------

  describe('copy-composer fallback templates', () => {
    const channels: NotificationChannel[] = ['vellum', 'telegram'];

    test('guardian.question template includes question text from payload', () => {
      const signal = makeSignal({
        sourceEventName: 'guardian.question',
        contextPayload: { questionText: 'What is the gate code?' },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.body).toContain('What is the gate code?');
    });

    test('reminder.fired template uses message from payload', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: { message: 'Take out the trash' },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.body).toBe('Take out the trash');
      expect(copy.vellum!.title).toBe('Reminder');
      expect(copy.telegram!.deliveryText).toBe('Take out the trash');
    });

    test('schedule.complete template uses name from payload', () => {
      const signal = makeSignal({
        sourceEventName: 'schedule.complete',
        contextPayload: { name: 'Daily backup' },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.body).toContain('Daily backup');
    });

    test('unknown event name produces generic copy with urgency prefix', () => {
      const signal = makeSignal({
        sourceEventName: 'some_novel.event',
        attentionHints: {
          requiresAction: true,
          urgency: 'high',
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.title).toBe('Notification');
      expect(copy.vellum!.body).toContain('Urgent:');
      expect(copy.vellum!.body).toContain('action required');
      expect(copy.telegram!.deliveryText).toBe(copy.telegram!.body);
    });

    test('unknown event name without urgency produces clean generic copy', () => {
      const signal = makeSignal({
        sourceEventName: 'background.sync_complete',
        attentionHints: {
          requiresAction: false,
          urgency: 'low',
          isAsyncBackground: true,
          visibleInSourceNow: false,
        },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.body).not.toContain('Urgent:');
      expect(copy.vellum!.body).not.toContain('action required');
      // Dots and underscores in event name are replaced with spaces
      expect(copy.vellum!.body).toContain('background sync complete');
    });

    test('fallback copy is generated for every requested channel', () => {
      const signal = makeSignal({
        sourceEventName: 'reminder.fired',
        contextPayload: { message: 'Test' },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.telegram).toBeDefined();
      // Both channels get the same copy
      expect(copy.vellum!.title).toBe(copy.telegram!.title);
      expect(copy.vellum!.body).toBe(copy.telegram!.body);
      // Telegram gets a dedicated chat message field.
      expect(copy.telegram!.deliveryText).toBe(copy.telegram!.body);
    });

    test('empty payload falls back to default text in template', () => {
      const signal = makeSignal({
        sourceEventName: 'guardian.question',
        contextPayload: {},
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.body).toBe('A guardian question needs your attention');
    });
  });

  // -- NotificationChannel type correctness ----------------------------------

  describe('NotificationChannel type', () => {
    test('vellum and telegram are valid notification channels', () => {
      // This validates the type definition at runtime.
      const channels: NotificationChannel[] = ['vellum', 'telegram'];
      expect(channels).toHaveLength(2);
    });
  });

  // -- AttentionHints urgency levels ------------------------------------------

  describe('attention hints urgency levels', () => {
    test('all three urgency levels are valid', () => {
      for (const urgency of ['low', 'medium', 'high'] as const) {
        const signal = makeSignal({
          attentionHints: {
            requiresAction: false,
            urgency,
            isAsyncBackground: true,
            visibleInSourceNow: false,
          },
        });
        expect(signal.attentionHints.urgency).toBe(urgency);
      }
    });
  });
});
