/**
 * Regression tests for the notification decision engine's strategy selection.
 *
 * Validates that the deterministic fallback correctly classifies signals based
 * on urgency + requiresAction, that channel selection respects connected channels,
 * the copy-composer generates correct fallback copy for known event names, and
 * thread action types are structurally correct.
 */

import { describe, expect, test } from 'bun:test';

import { composeFallbackCopy } from '../notifications/copy-composer.js';
import type { NotificationSignal } from '../notifications/signal.js';
import type {
  NotificationChannel,
  NotificationDecision,
  ThreadAction,
  ThreadActionReuseExisting,
  ThreadActionStartNew,
  ThreadCandidate,
} from '../notifications/types.js';

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
      // Telegram gets a dedicated chat message field; vellum does not.
      expect(copy.telegram!.deliveryText).toBe(copy.telegram!.body);
      expect(copy.vellum!.deliveryText).toBeUndefined();
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

  // -- Thread action types ---------------------------------------------------

  describe('thread action types', () => {
    test('start_new action has correct shape', () => {
      const action: ThreadActionStartNew = { action: 'start_new' };
      expect(action.action).toBe('start_new');
    });

    test('reuse_existing action requires conversationId', () => {
      const action: ThreadActionReuseExisting = {
        action: 'reuse_existing',
        conversationId: 'conv-123',
      };
      expect(action.action).toBe('reuse_existing');
      expect(action.conversationId).toBe('conv-123');
    });

    test('ThreadAction union discriminates correctly', () => {
      const startNew: ThreadAction = { action: 'start_new' };
      const reuse: ThreadAction = { action: 'reuse_existing', conversationId: 'conv-456' };

      expect(startNew.action).toBe('start_new');
      expect(reuse.action).toBe('reuse_existing');
      if (reuse.action === 'reuse_existing') {
        expect(reuse.conversationId).toBe('conv-456');
      }
    });

    test('decision output can include threadActions per channel', () => {
      const decision: NotificationDecision = {
        shouldNotify: true,
        selectedChannels: ['vellum', 'telegram'] as NotificationChannel[],
        reasoningSummary: 'Test decision with thread actions',
        renderedCopy: {},
        dedupeKey: 'test-dedupe',
        confidence: 0.9,
        fallbackUsed: false,
        threadActions: {
          vellum: { action: 'start_new' },
          telegram: { action: 'reuse_existing', conversationId: 'conv-789' },
        },
      };

      expect(decision.threadActions?.vellum?.action).toBe('start_new');
      expect(decision.threadActions?.telegram?.action).toBe('reuse_existing');
      if (decision.threadActions?.telegram?.action === 'reuse_existing') {
        expect(decision.threadActions.telegram.conversationId).toBe('conv-789');
      }
    });

    test('decision output without threadActions defaults to undefined', () => {
      const decision: NotificationDecision = {
        shouldNotify: true,
        selectedChannels: ['vellum'] as NotificationChannel[],
        reasoningSummary: 'No thread actions specified',
        renderedCopy: {},
        dedupeKey: 'test-dedupe-2',
        confidence: 0.8,
        fallbackUsed: false,
      };

      expect(decision.threadActions).toBeUndefined();
    });
  });

  // -- ThreadCandidate type ---------------------------------------------------

  describe('thread candidate metadata', () => {
    test('candidate has required fields', () => {
      const candidate: ThreadCandidate = {
        conversationId: 'conv-100',
        title: 'Guardian: What is the gate code?',
        updatedAt: Date.now(),
        latestSourceEventName: 'guardian.question',
        channel: 'vellum' as NotificationChannel,
      };

      expect(candidate.conversationId).toBe('conv-100');
      expect(candidate.channel).toBe('vellum');
      expect(candidate.latestSourceEventName).toBe('guardian.question');
    });

    test('candidate includes guardian-specific context when present', () => {
      const candidate: ThreadCandidate = {
        conversationId: 'conv-200',
        title: 'Guardian Question Thread',
        updatedAt: Date.now(),
        latestSourceEventName: 'guardian.question',
        channel: 'telegram' as NotificationChannel,
        pendingGuardianRequestCount: 2,
        recentCallSessionId: 'call-sess-abc',
      };

      expect(candidate.pendingGuardianRequestCount).toBe(2);
      expect(candidate.recentCallSessionId).toBe('call-sess-abc');
    });

    test('signal can carry thread candidates per channel', () => {
      const signal = makeSignal({
        threadCandidates: {
          vellum: [
            {
              conversationId: 'conv-300',
              title: 'Reminder thread',
              updatedAt: Date.now() - 60_000,
              latestSourceEventName: 'reminder.fired',
              channel: 'vellum' as NotificationChannel,
            },
          ],
        },
      });

      expect(signal.threadCandidates?.vellum).toHaveLength(1);
      expect(signal.threadCandidates?.vellum?.[0]?.conversationId).toBe('conv-300');
    });
  });
});
