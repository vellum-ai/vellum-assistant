/**
 * Regression tests for notification decision fallback copy.
 *
 * Ensures fallback decisions still produce human-friendly copy when the
 * decision-model call is unavailable.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('../channels/config.js', () => ({
  getDeliverableChannels: () => ['vellum', 'telegram', 'sms'],
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    ui: {},
    
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

let configuredProvider: { sendMessage: () => Promise<unknown> } | null = null;
let extractedToolUse: unknown = null;

mock.module('../providers/provider-send-message.js', () => ({
  getConfiguredProvider: () => configuredProvider,
  createTimeout: () => ({
    signal: new AbortController().signal,
    cleanup: () => {},
  }),
  extractToolUse: () => extractedToolUse,
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
  beforeEach(() => {
    configuredProvider = null;
    extractedToolUse = null;
  });

  test('uses human-friendly template copy for guardian.question', async () => {
    const signal = makeSignal();
    const decision = await evaluateSignal(signal, ['vellum'] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    expect(decision.renderedCopy.vellum?.title).toBe('Guardian Question');
    expect(decision.renderedCopy.vellum?.body).toBe('What is the gate code?');
    expect(decision.renderedCopy.vellum?.title).not.toBe('guardian.question');
    expect(decision.renderedCopy.vellum?.body).not.toContain('Action required: guardian.question');
  });

  test('enforces free-text answer instructions for guardian.question when requestCode exists', async () => {
    const signal = makeSignal({
      contextPayload: {
        questionText: 'What is the gate code?',
        requestCode: 'A1B2C3',
        requestKind: 'pending_question',
      },
    });
    const decision = await evaluateSignal(signal, ['vellum'] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    expect(decision.renderedCopy.vellum?.body).toContain('A1B2C3');
    expect(decision.renderedCopy.vellum?.body).toContain('<your answer>');
    expect(decision.renderedCopy.vellum?.body).not.toContain('approve');
    expect(decision.renderedCopy.vellum?.body).not.toContain('reject');
  });

  test('enforcement appends free-text answer instructions when LLM copy only mentions request code', async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: 'record_notification_decision',
      input: {
        shouldNotify: true,
        selectedChannels: ['vellum'],
        reasoningSummary: 'LLM decision',
        renderedCopy: {
          vellum: {
            title: 'Guardian Question',
            body: 'Use reference code A1B2C3 for this request.',
          },
        },
        dedupeKey: 'guardian-question-test',
        confidence: 0.9,
      },
    };

    const signal = makeSignal({
      contextPayload: {
        questionText: 'What is the gate code?',
        requestCode: 'A1B2C3',
        requestKind: 'pending_question',
      },
    });

    const decision = await evaluateSignal(signal, ['vellum'] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 <your answer>"');
  });

  test('enforcement appends explicit approve/reject instructions for tool-approval guardian questions', async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: 'record_notification_decision',
      input: {
        shouldNotify: true,
        selectedChannels: ['vellum'],
        reasoningSummary: 'LLM decision',
        renderedCopy: {
          vellum: {
            title: 'Guardian Question',
            body: 'Use reference code A1B2C3 for this request.',
          },
        },
        dedupeKey: 'guardian-question-tool-approval-test',
        confidence: 0.9,
      },
    };

    const signal = makeSignal({
      contextPayload: {
        questionText: 'Allow running host_bash?',
        requestCode: 'A1B2C3',
        requestKind: 'tool_grant_request',
      },
    });

    const decision = await evaluateSignal(signal, ['vellum'] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 approve"');
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 reject"');
  });
});
