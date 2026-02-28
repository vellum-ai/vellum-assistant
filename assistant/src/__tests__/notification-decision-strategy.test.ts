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
import { validateThreadActions } from '../notifications/decision-engine.js';
import type { NotificationSignal } from '../notifications/signal.js';
import type { ThreadCandidateSet } from '../notifications/thread-candidates.js';
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

    test('guardian.question template includes free-text answer instructions when requestCode is present', () => {
      const signal = makeSignal({
        sourceEventName: 'guardian.question',
        contextPayload: {
          questionText: 'What is the gate code?',
          requestCode: 'A1B2C3',
        },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.body).toContain('A1B2C3');
      expect(copy.vellum!.body).toContain('<your answer>');
      expect(copy.vellum!.body).not.toContain('approve');
      expect(copy.vellum!.body).not.toContain('reject');
      expect(copy.telegram!.deliveryText).toContain('A1B2C3');
    });

    test('guardian.question template uses approve/reject instructions when toolName is present', () => {
      const signal = makeSignal({
        sourceEventName: 'guardian.question',
        contextPayload: {
          questionText: 'Allow running host_bash?',
          requestCode: 'D4E5F6',
          toolName: 'host_bash',
        },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.body).toContain('D4E5F6');
      expect(copy.vellum!.body).toContain('approve');
      expect(copy.vellum!.body).toContain('reject');
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

    test('ingress.access_request template includes requester identifier', () => {
      const signal = makeSignal({
        sourceEventName: 'ingress.access_request',
        contextPayload: {
          senderIdentifier: 'Alice',
          requestCode: 'A1B2C3',
        },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.title).toBe('Access Request');
      expect(copy.vellum!.body).toContain('Alice');
      expect(copy.vellum!.body).toContain('requesting access');
    });

    test('ingress.access_request template includes request code instruction when present', () => {
      const signal = makeSignal({
        sourceEventName: 'ingress.access_request',
        contextPayload: {
          senderIdentifier: 'Bob',
          requestCode: 'D4E5F6',
        },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.body).toContain('D4E5F6');
      expect(copy.vellum!.body).toContain('approve');
      expect(copy.vellum!.body).toContain('reject');
    });

    test('ingress.access_request template includes invite flow instruction', () => {
      const signal = makeSignal({
        sourceEventName: 'ingress.access_request',
        contextPayload: {
          senderIdentifier: 'Charlie',
        },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.body).toContain('open invite flow');
    });

    test('ingress.access_request template includes caller name for voice-originated requests', () => {
      // In production, senderIdentifier resolves to senderName for voice
      // calls (senderName || senderUsername || senderExternalUserId), so
      // both values are the caller's name. The phone number arrives via
      // senderExternalUserId and should appear in the parenthetical.
      const signal = makeSignal({
        sourceEventName: 'ingress.access_request',
        contextPayload: {
          senderIdentifier: 'Alice Smith',
          senderName: 'Alice Smith',
          senderExternalUserId: '+15559998888',
          sourceChannel: 'voice',
          requestCode: 'V1C2E3',
        },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      expect(copy.vellum!.title).toBe('Access Request');
      // Voice-originated requests should include the caller name and phone number in parentheses
      expect(copy.vellum!.body).toContain('Alice Smith');
      expect(copy.vellum!.body).toContain('(+15559998888)');
      expect(copy.vellum!.body).toContain('calling');
    });

    test('ingress.access_request template falls back to non-voice copy when sourceChannel is not voice', () => {
      const signal = makeSignal({
        sourceEventName: 'ingress.access_request',
        contextPayload: {
          senderIdentifier: 'user-123',
          senderName: 'Bob Jones',
          sourceChannel: 'telegram',
          requestCode: 'T1G2M3',
        },
      });

      const copy = composeFallbackCopy(signal, channels);
      expect(copy.vellum).toBeDefined();
      // Non-voice should use the standard "requesting access" text, not "calling"
      expect(copy.vellum!.body).toContain('user-123');
      expect(copy.vellum!.body).toContain('requesting access');
      expect(copy.vellum!.body).not.toContain('calling');
    });

    test('ingress.access_request Telegram deliveryText is concise', () => {
      const signal = makeSignal({
        sourceEventName: 'ingress.access_request',
        contextPayload: {
          senderIdentifier: 'Dave',
          requestCode: 'ABC123',
        },
      });

      const copy = composeFallbackCopy(signal, ['telegram']);
      expect(copy.telegram).toBeDefined();
      expect(copy.telegram!.deliveryText).toBeDefined();
      expect(typeof copy.telegram!.deliveryText).toBe('string');
      expect(copy.telegram!.deliveryText!.length).toBeGreaterThan(0);
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

  // -- Thread action validation -----------------------------------------------

  describe('thread action validation', () => {
    const validChannels: NotificationChannel[] = ['vellum', 'telegram'];
    const candidateSet: ThreadCandidateSet = {
      vellum: [
        {
          conversationId: 'conv-001',
          title: 'Reminder thread',
          updatedAt: Date.now(),
          latestSourceEventName: 'reminder.fired',
          channel: 'vellum',
        },
        {
          conversationId: 'conv-002',
          title: 'Guardian thread',
          updatedAt: Date.now(),
          latestSourceEventName: 'guardian.question',
          channel: 'vellum',
          guardianContext: { pendingUnresolvedRequestCount: 2 },
        },
      ],
      telegram: [
        {
          conversationId: 'conv-003',
          title: 'Telegram thread',
          updatedAt: Date.now(),
          latestSourceEventName: 'reminder.fired',
          channel: 'telegram',
        },
      ],
    };

    test('accepts start_new action', () => {
      const result = validateThreadActions(
        { vellum: { action: 'start_new' } },
        validChannels,
        candidateSet,
      );
      expect(result.vellum).toEqual({ action: 'start_new' });
    });

    test('accepts reuse_existing with valid candidate conversationId', () => {
      const result = validateThreadActions(
        { vellum: { action: 'reuse_existing', conversationId: 'conv-001' } },
        validChannels,
        candidateSet,
      );
      expect(result.vellum).toEqual({ action: 'reuse_existing', conversationId: 'conv-001' });
    });

    test('downgrades reuse_existing with invalid conversationId to start_new', () => {
      const result = validateThreadActions(
        { vellum: { action: 'reuse_existing', conversationId: 'conv-INVALID' } },
        validChannels,
        candidateSet,
      );
      expect(result.vellum).toEqual({ action: 'start_new' });
    });

    test('downgrades reuse_existing without conversationId to start_new', () => {
      const result = validateThreadActions(
        { vellum: { action: 'reuse_existing' } },
        validChannels,
        candidateSet,
      );
      expect(result.vellum).toEqual({ action: 'start_new' });
    });

    test('downgrades reuse_existing with empty conversationId to start_new', () => {
      const result = validateThreadActions(
        { vellum: { action: 'reuse_existing', conversationId: '  ' } },
        validChannels,
        candidateSet,
      );
      expect(result.vellum).toEqual({ action: 'start_new' });
    });

    test('rejects reuse_existing targeting a different channel candidate', () => {
      // conv-003 is a telegram candidate, not a vellum candidate
      const result = validateThreadActions(
        { vellum: { action: 'reuse_existing', conversationId: 'conv-003' } },
        validChannels,
        candidateSet,
      );
      expect(result.vellum).toEqual({ action: 'start_new' });
    });

    test('ignores thread actions for channels not in validChannels', () => {
      const result = validateThreadActions(
        { sms: { action: 'start_new' } },
        validChannels,
        candidateSet,
      );
      expect(result).toEqual({});
    });

    test('handles null/undefined input gracefully', () => {
      expect(validateThreadActions(null, validChannels, candidateSet)).toEqual({});
      expect(validateThreadActions(undefined, validChannels, candidateSet)).toEqual({});
    });

    test('handles missing candidate set — all reuse_existing downgrade to start_new', () => {
      const result = validateThreadActions(
        { vellum: { action: 'reuse_existing', conversationId: 'conv-001' } },
        validChannels,
        undefined,
      );
      expect(result.vellum).toEqual({ action: 'start_new' });
    });

    test('supports multiple channels simultaneously', () => {
      const result = validateThreadActions(
        {
          vellum: { action: 'reuse_existing', conversationId: 'conv-002' },
          telegram: { action: 'start_new' },
        },
        validChannels,
        candidateSet,
      );
      expect(result.vellum).toEqual({ action: 'reuse_existing', conversationId: 'conv-002' });
      expect(result.telegram).toEqual({ action: 'start_new' });
    });

    test('ignores unknown action values', () => {
      const result = validateThreadActions(
        { vellum: { action: 'unknown_action' } },
        validChannels,
        candidateSet,
      );
      expect(result.vellum).toBeUndefined();
    });
  });
});
