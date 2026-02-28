/**
 * Regression tests for notification decision fallback copy.
 *
 * Ensures fallback decisions still produce human-friendly copy when the
 * decision-model call is unavailable.
 */

import { describe, expect, mock, test } from 'bun:test';

mock.module('../channels/config.js', () => ({
  getDeliverableChannels: () => ['vellum', 'telegram', 'sms'],
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    notifications: {
      decisionModelIntent: 'latency-optimized',
    },
  }),
}));

mock.module('../notifications/decisions-store.js', () => ({
  createDecision: () => {},
}));

mock.module('../notifications/preference-summary.js', () => ({
  getPreferenceSummary: () => undefined,
}));

mock.module('../notifications/thread-candidates.js', () => ({
  buildThreadCandidates: () => undefined,
  serializeCandidatesForPrompt: () => undefined,
}));

mock.module('../providers/provider-send-message.js', () => ({
  getConfiguredProvider: () => null,
  createTimeout: () => ({
    signal: new AbortController().signal,
    cleanup: () => {},
  }),
  extractToolUse: () => null,
  userMessage: (text: string) => ({ role: 'user', content: text }),
}));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { evaluateSignal } from '../notifications/decision-engine.js';
import type { NotificationSignal } from '../notifications/signal.js';
import type { NotificationChannel } from '../notifications/types.js';

function makeSignal(overrides?: Partial<NotificationSignal>): NotificationSignal {
  return {
    signalId: 'sig-fallback-guardian-1',
    assistantId: 'self',
    createdAt: Date.now(),
    sourceChannel: 'voice',
    sourceSessionId: 'call-session-1',
    sourceEventName: 'guardian.question',
    contextPayload: {
      questionText: 'What is the gate code?',
    },
    attentionHints: {
      requiresAction: true,
      urgency: 'high',
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

describe('notification decision fallback copy', () => {
  test('uses human-friendly template copy for guardian.question', async () => {
    const signal = makeSignal();
    const decision = await evaluateSignal(signal, ['vellum'] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    expect(decision.renderedCopy.vellum?.title).toBe('Guardian Question');
    expect(decision.renderedCopy.vellum?.body).toBe('What is the gate code?');
    expect(decision.renderedCopy.vellum?.title).not.toBe('guardian.question');
    expect(decision.renderedCopy.vellum?.body).not.toContain('Action required: guardian.question');
  });

  test('enforces request-code instructions for guardian.question when requestCode exists', async () => {
    const signal = makeSignal({
      contextPayload: {
        questionText: 'What is the gate code?',
        requestCode: 'A1B2C3',
      },
    });
    const decision = await evaluateSignal(signal, ['vellum'] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    expect(decision.renderedCopy.vellum?.body).toContain('A1B2C3');
    expect(decision.renderedCopy.vellum?.body).toContain('approve');
    expect(decision.renderedCopy.vellum?.body).toContain('reject');
  });
});
