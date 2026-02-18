import { describe, test, expect } from 'bun:test';
import { AssistantEventHub } from '../runtime/assistant-event-hub.js';
import type { AssistantEvent } from '../runtime/assistant-event.js';

function makeEvent(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  return {
    id: 'evt_test',
    assistantId: 'ast_1',
    sessionId: 'sess_1',
    emittedAt: '2026-02-18T00:00:00.000Z',
    message: { type: 'assistant_text_delta', sessionId: 'sess_1', text: 'hi' },
    ...overrides,
  };
}

// ── Fanout ────────────────────────────────────────────────────────────────────

describe('AssistantEventHub — fanout', () => {
  test('delivers event to a single matching subscriber', () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: 'ast_1' }, (e) => received.push(e));
    hub.publish(makeEvent());

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('evt_test');
  });

  test('delivers event to multiple subscribers in registration order', () => {
    const hub = new AssistantEventHub();
    const order: string[] = [];

    hub.subscribe({ assistantId: 'ast_1' }, () => order.push('first'));
    hub.subscribe({ assistantId: 'ast_1' }, () => order.push('second'));
    hub.subscribe({ assistantId: 'ast_1' }, () => order.push('third'));

    hub.publish(makeEvent());

    expect(order).toEqual(['first', 'second', 'third']);
  });

  test('does not deliver event to subscriber for a different assistantId', () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: 'ast_OTHER' }, (e) => received.push(e));
    hub.publish(makeEvent({ assistantId: 'ast_1' }));

    expect(received).toHaveLength(0);
  });

  test('sessionId filter further restricts delivery', () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    hub.subscribe({ assistantId: 'ast_1', sessionId: 'sess_A' }, (e) => receivedA.push(e));
    hub.subscribe({ assistantId: 'ast_1', sessionId: 'sess_B' }, (e) => receivedB.push(e));

    hub.publish(makeEvent({ sessionId: 'sess_A' }));

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });

  test('subscriber without sessionId filter receives all sessions for that assistant', () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: 'ast_1' }, (e) => received.push(e));

    hub.publish(makeEvent({ sessionId: 'sess_A' }));
    hub.publish(makeEvent({ sessionId: 'sess_B' }));
    hub.publish(makeEvent({ sessionId: undefined }));

    expect(received).toHaveLength(3);
  });

  test('publish with no subscribers is a no-op', () => {
    const hub = new AssistantEventHub();
    expect(() => hub.publish(makeEvent())).not.toThrow();
  });
});

// ── Unsubscribe / cleanup ────────────────────────────────────────────────────

describe('AssistantEventHub — unsubscribe cleanup', () => {
  test('dispose stops event delivery', () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    const sub = hub.subscribe({ assistantId: 'ast_1' }, (e) => received.push(e));
    hub.publish(makeEvent());
    expect(received).toHaveLength(1);

    sub.dispose();
    hub.publish(makeEvent());
    expect(received).toHaveLength(1); // no new events
  });

  test('dispose is idempotent', () => {
    const hub = new AssistantEventHub();
    const sub = hub.subscribe({ assistantId: 'ast_1' }, () => {});

    sub.dispose();
    sub.dispose(); // must not throw
    expect(sub.active).toBe(false);
  });

  test('active reflects subscription state', () => {
    const hub = new AssistantEventHub();
    const sub = hub.subscribe({ assistantId: 'ast_1' }, () => {});
    expect(sub.active).toBe(true);

    sub.dispose();
    expect(sub.active).toBe(false);
  });

  test('subscriberCount reflects live subscriptions only', () => {
    const hub = new AssistantEventHub();

    const sub1 = hub.subscribe({ assistantId: 'ast_1' }, () => {});
    const sub2 = hub.subscribe({ assistantId: 'ast_1' }, () => {});
    expect(hub.subscriberCount()).toBe(2);

    sub1.dispose();
    expect(hub.subscriberCount()).toBe(1);

    sub2.dispose();
    expect(hub.subscriberCount()).toBe(0);
  });

  test('disposing one subscription does not affect others', () => {
    const hub = new AssistantEventHub();
    const received1: AssistantEvent[] = [];
    const received2: AssistantEvent[] = [];

    const sub1 = hub.subscribe({ assistantId: 'ast_1' }, (e) => received1.push(e));
    hub.subscribe({ assistantId: 'ast_1' }, (e) => received2.push(e));

    sub1.dispose();
    hub.publish(makeEvent());

    expect(received1).toHaveLength(0);
    expect(received2).toHaveLength(1);
  });
});
