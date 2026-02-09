import { describe, test, expect } from 'bun:test';
import { EventBus, EventBusDisposedError } from '../events/bus.js';
import type { AssistantDomainEvents } from '../events/domain-events.js';

describe('EventBus', () => {
  test('emits typed events to direct listeners in registration order', async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    const seen: string[] = [];

    bus.on('tool.execution.started', (event) => {
      seen.push(`first:${event.toolName}`);
    });
    bus.on('tool.execution.started', async (event) => {
      await Promise.resolve();
      seen.push(`second:${event.sessionId}`);
    });

    await bus.emit('tool.execution.started', {
      conversationId: 'conv-1',
      sessionId: 'sess-1',
      toolName: 'shell',
      input: { command: 'ls' },
      startedAtMs: Date.now(),
    });

    expect(seen).toEqual(['first:shell', 'second:sess-1']);
  });

  test('supports onAny listeners with event envelopes', async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    let seenType = '';
    let seenConversationId = '';

    bus.onAny((event) => {
      seenType = event.type;
      seenConversationId = event.payload.conversationId;
      expect(typeof event.emittedAtMs).toBe('number');
    });

    await bus.emit('daemon.session.created', {
      conversationId: 'conv-2',
      createdAtMs: Date.now(),
    });

    expect(seenType).toBe('daemon.session.created');
    expect(seenConversationId).toBe('conv-2');
  });

  test('subscription disposal is idempotent and prevents future callbacks', async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    let calls = 0;

    const sub = bus.on('daemon.lifecycle.stopped', () => {
      calls += 1;
    });

    sub.dispose();
    sub.dispose();

    await bus.emit('daemon.lifecycle.stopped', {
      stoppedAtMs: Date.now(),
    });

    expect(calls).toBe(0);
    expect(sub.active).toBe(false);
  });

  test('dispose clears listeners and rejects new registrations/emits', async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    const sub = bus.on('daemon.lifecycle.started', () => {});
    const anySub = bus.onAny(() => {});

    expect(bus.listenerCount('daemon.lifecycle.started')).toBe(1);
    expect(bus.anyListenerCount()).toBe(1);

    bus.dispose();

    expect(bus.listenerCount()).toBe(0);
    expect(bus.anyListenerCount()).toBe(0);
    expect(sub.active).toBe(true);
    expect(anySub.active).toBe(true);

    expect(() => bus.on('daemon.lifecycle.started', () => {})).toThrow(EventBusDisposedError);
    expect(() => bus.onAny(() => {})).toThrow(EventBusDisposedError);
    await expect(
      bus.emit('daemon.lifecycle.started', {
        pid: 1,
        socketPath: '/tmp/sock',
        startedAtMs: Date.now(),
      }),
    ).rejects.toBeInstanceOf(EventBusDisposedError);
  });

  test('emit continues after listener failures and throws AggregateError', async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    let ranAfterFailure = false;

    bus.on('tool.execution.finished', () => {
      throw new Error('listener failed');
    });
    bus.on('tool.execution.finished', () => {
      ranAfterFailure = true;
    });

    await expect(
      bus.emit('tool.execution.finished', {
        conversationId: 'conv-3',
        sessionId: 'sess-3',
        toolName: 'file_read',
        decision: 'allow',
        riskLevel: 'low',
        isError: false,
        durationMs: 12,
        finishedAtMs: Date.now(),
      }),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(ranAfterFailure).toBe(true);
  });
});
