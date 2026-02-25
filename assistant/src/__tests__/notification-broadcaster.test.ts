/**
 * Regression tests for the notification broadcaster.
 *
 * Validates that the broadcaster correctly:
 * - Dispatches to registered adapters
 * - Handles missing adapters gracefully
 * - Falls back to copy-composer when decision copy is missing
 * - Reports delivery results per channel
 */

import { describe, expect, mock, test } from 'bun:test';

// -- Mocks (must be declared before importing modules that depend on them) ----

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock destination-resolver to return a destination for every requested channel
mock.module('../notifications/destination-resolver.js', () => ({
  resolveDestinations: (_assistantId: string, channels: string[]) => {
    const m = new Map();
    for (const ch of channels) {
      m.set(ch, { channel: ch, endpoint: `mock-${ch}` });
    }
    return m;
  },
}));

// Mock deliveries-store to avoid DB access
mock.module('../notifications/deliveries-store.js', () => ({
  createDelivery: () => {},
  updateDeliveryStatus: () => {},
}));

import { NotificationBroadcaster } from '../notifications/broadcaster.js';
import type { NotificationSignal } from '../notifications/signal.js';
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationChannel,
  NotificationDecision,
} from '../notifications/types.js';

// -- Helpers -----------------------------------------------------------------

function makeSignal(overrides?: Partial<NotificationSignal>): NotificationSignal {
  return {
    signalId: 'sig-broadcast-001',
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

function makeDecision(overrides?: Partial<NotificationDecision>): NotificationDecision {
  return {
    shouldNotify: true,
    selectedChannels: ['vellum'],
    reasoningSummary: 'Test decision',
    renderedCopy: {
      vellum: { title: 'Test Alert', body: 'Something happened' },
    },
    dedupeKey: 'broadcast-test-001',
    confidence: 0.9,
    fallbackUsed: false,
    ...overrides,
  };
}

class MockAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel;
  sent: ChannelDeliveryPayload[] = [];
  shouldFail = false;

  constructor(channel: NotificationChannel) {
    this.channel = channel;
  }

  async send(payload: ChannelDeliveryPayload, _dest: ChannelDestination): Promise<DeliveryResult> {
    this.sent.push(payload);
    if (this.shouldFail) return { success: false, error: 'Mock failure' };
    return { success: true };
  }
}

// -- Tests -------------------------------------------------------------------

describe('notification broadcaster', () => {
  test('dispatches to the vellum adapter when selected', async () => {
    const vellumAdapter = new MockAdapter('vellum');
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision();

    const results = await broadcaster.broadcastDecision(signal, decision);

    expect(vellumAdapter.sent).toHaveLength(1);
    expect(vellumAdapter.sent[0].copy.title).toBe('Test Alert');
    expect(results.some(r => r.channel === 'vellum' && r.status === 'sent')).toBe(true);
  });

  test('skips channels without registered adapters', async () => {
    // Register only vellum, but decision selects both
    const vellumAdapter = new MockAdapter('vellum');
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      selectedChannels: ['vellum', 'telegram'],
      renderedCopy: {
        vellum: { title: 'Test', body: 'Body' },
        telegram: { title: 'Test', body: 'Body' },
      },
    });

    const results = await broadcaster.broadcastDecision(signal, decision);

    // Vellum should succeed, telegram should be skipped (no adapter registered)
    expect(results).toHaveLength(2);
    const vellumResult = results.find(r => r.channel === 'vellum');
    const telegramResult = results.find(r => r.channel === 'telegram');
    expect(vellumResult?.status).toBe('sent');
    expect(telegramResult?.status).toBe('skipped');
  });

  test('reports failed delivery when adapter returns error', async () => {
    const vellumAdapter = new MockAdapter('vellum');
    vellumAdapter.shouldFail = true;
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision();

    const results = await broadcaster.broadcastDecision(signal, decision);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('failed');
    expect(results[0].errorMessage).toContain('Mock failure');
  });

  test('passes deepLinkTarget through to adapter payload', async () => {
    const vellumAdapter = new MockAdapter('vellum');
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      deepLinkTarget: { conversationId: 'conv-123', screen: 'thread' },
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(vellumAdapter.sent).toHaveLength(1);
    expect(vellumAdapter.sent[0].deepLinkTarget).toEqual({
      conversationId: 'conv-123',
      screen: 'thread',
    });
  });

  test('multiple channels receive independent copy from the decision', async () => {
    const vellumAdapter = new MockAdapter('vellum');
    const telegramAdapter = new MockAdapter('telegram');
    const broadcaster = new NotificationBroadcaster([vellumAdapter, telegramAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      selectedChannels: ['vellum', 'telegram'],
      renderedCopy: {
        vellum: { title: 'Desktop Alert', body: 'For desktop' },
        telegram: { title: 'Mobile Alert', body: 'For mobile' },
      },
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(vellumAdapter.sent).toHaveLength(1);
    expect(vellumAdapter.sent[0].copy.title).toBe('Desktop Alert');

    expect(telegramAdapter.sent).toHaveLength(1);
    expect(telegramAdapter.sent[0].copy.title).toBe('Mobile Alert');
  });

  test('uses fallback copy when decision is missing copy for a channel', async () => {
    const vellumAdapter = new MockAdapter('vellum');
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal({ sourceEventName: 'reminder.fired' });
    const decision = makeDecision({
      renderedCopy: {}, // No rendered copy
      fallbackUsed: true,
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(vellumAdapter.sent).toHaveLength(1);
    // The fallback should produce some copy (either from template or generic)
    expect(vellumAdapter.sent[0].copy.title).toBeDefined();
    expect(vellumAdapter.sent[0].copy.body).toBeDefined();
  });

  test('empty selectedChannels produces no deliveries', async () => {
    const vellumAdapter = new MockAdapter('vellum');
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      selectedChannels: [],
    });

    const results = await broadcaster.broadcastDecision(signal, decision);

    expect(results).toHaveLength(0);
    expect(vellumAdapter.sent).toHaveLength(0);
  });
});
