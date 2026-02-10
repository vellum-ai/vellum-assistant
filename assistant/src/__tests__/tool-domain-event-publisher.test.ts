import { describe, test, expect } from 'bun:test';
import { EventBus, type AnyEventEnvelope } from '../events/bus.js';
import type { AssistantDomainEvents } from '../events/domain-events.js';
import { createToolDomainEventPublisher } from '../events/tool-domain-event-publisher.js';

function makeEventsCollector() {
  const bus = new EventBus<AssistantDomainEvents>();
  const events: AnyEventEnvelope<AssistantDomainEvents>[] = [];
  bus.onAny((event) => events.push(event));
  return { bus, events };
}

describe('createToolDomainEventPublisher', () => {
  test('maps start and permission lifecycle events into domain events', async () => {
    const { bus, events } = makeEventsCollector();
    const publish = createToolDomainEventPublisher(bus);

    await publish({
      type: 'start',
      toolName: 'shell',
      input: { command: 'ls' },
      workingDir: '/tmp/project',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      startedAtMs: 100,
    });

    await publish({
      type: 'permission_prompt',
      toolName: 'shell',
      input: { command: 'ls' },
      workingDir: '/tmp/project',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      riskLevel: 'medium',
      reason: 'needs approval',
      allowlistOptions: [],
      scopeOptions: [],
      sandboxed: true,
    });

    await publish({
      type: 'permission_denied',
      toolName: 'shell',
      input: { command: 'rm -rf /tmp' },
      workingDir: '/tmp/project',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      riskLevel: 'high',
      decision: 'deny',
      reason: 'Permission denied by user',
      durationMs: 20,
    });

    expect(events.map((event) => event.type)).toEqual([
      'tool.execution.started',
      'tool.permission.requested',
      'tool.permission.decided',
    ]);
    expect(events[0].payload).toMatchObject({
      toolName: 'shell',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      startedAtMs: 100,
    });
    expect(events[1].payload).toMatchObject({
      toolName: 'shell',
      riskLevel: 'medium',
    });
    expect(events[2].payload).toMatchObject({
      toolName: 'shell',
      decision: 'deny',
      riskLevel: 'high',
    });
  });

  test('maps executed lifecycle event to permission.decided + execution.finished', async () => {
    const { bus, events } = makeEventsCollector();
    const publish = createToolDomainEventPublisher(bus);

    await publish({
      type: 'executed',
      toolName: 'file_read',
      input: { path: 'README.md' },
      workingDir: '/tmp/project',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      riskLevel: 'low',
      decision: 'allow',
      durationMs: 15,
      result: { content: 'ok', isError: false },
    });

    expect(events.map((event) => event.type)).toEqual([
      'tool.permission.decided',
      'tool.execution.finished',
    ]);
    expect(events[0].payload).toMatchObject({
      decision: 'allow',
      riskLevel: 'low',
    });
    expect(events[1].payload).toMatchObject({
      toolName: 'file_read',
      isError: false,
      durationMs: 15,
      decision: 'allow',
    });
  });

  test('maps secret_detected lifecycle event to tool.secret.detected domain event', async () => {
    const { bus, events } = makeEventsCollector();
    const publish = createToolDomainEventPublisher(bus);

    await publish({
      type: 'secret_detected',
      toolName: 'file_read',
      input: { path: 'secrets.txt' },
      workingDir: '/tmp/project',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      action: 'redact',
      matches: [{ type: 'AWS Access Key', redactedValue: '[REDACTED:AWS Access Key]' }],
      detectedAtMs: 55,
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool.secret.detected');
    expect(events[0].payload).toEqual({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      toolName: 'file_read',
      action: 'redact',
      matches: [{ type: 'AWS Access Key', redactedValue: '[REDACTED:AWS Access Key]' }],
      detectedAtMs: 55,
    });
  });

  test('maps error lifecycle event to execution.failed with diagnostics', async () => {
    const { bus, events } = makeEventsCollector();
    const publish = createToolDomainEventPublisher(bus);

    await publish({
      type: 'error',
      toolName: 'shell',
      input: { command: 'cat /missing' },
      workingDir: '/tmp/project',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      riskLevel: 'medium',
      decision: 'error',
      durationMs: 9,
      errorMessage: 'ENOENT',
      isExpected: false,
      errorName: 'Error',
      errorStack: 'Error: ENOENT\n    at test',
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool.execution.failed');
    expect(events[0].payload).toMatchObject({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      toolName: 'shell',
      riskLevel: 'medium',
      decision: 'error',
      durationMs: 9,
      error: 'ENOENT',
      isExpected: false,
      errorName: 'Error',
      errorStack: 'Error: ENOENT\n    at test',
    });
  });
});
