import { describe, test, expect } from 'bun:test';
import { EventBus } from '../events/bus.js';
import type { AssistantDomainEvents } from '../events/domain-events.js';
import { registerToolNotificationListener } from '../events/tool-notification-listener.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';

describe('registerToolNotificationListener', () => {
  test('forwards tool.secret.detected events to IPC secret_detected messages', async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    const messages: ServerMessage[] = [];
    registerToolNotificationListener(bus, (msg) => messages.push(msg));

    await bus.emit('tool.secret.detected', {
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      toolName: 'file_read',
      action: 'warn',
      matches: [{ type: 'AWS Access Key', redactedValue: '[REDACTED:AWS Access Key]' }],
      detectedAtMs: 123,
    });

    expect(messages).toEqual([
      {
        type: 'secret_detected',
        toolName: 'file_read',
        action: 'warn',
        matches: [{ type: 'AWS Access Key', redactedValue: '[REDACTED:AWS Access Key]' }],
      },
    ]);
  });

  test('stops forwarding after subscription is disposed', async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    const messages: ServerMessage[] = [];
    const subscription = registerToolNotificationListener(bus, (msg) => messages.push(msg));

    subscription.dispose();
    await bus.emit('tool.secret.detected', {
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      toolName: 'file_read',
      action: 'warn',
      matches: [{ type: 'AWS Access Key', redactedValue: '[REDACTED:AWS Access Key]' }],
      detectedAtMs: 123,
    });

    expect(messages).toHaveLength(0);
  });
});
