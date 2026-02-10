import type { EventBus, Subscription } from './bus.js';
import type { AssistantDomainEvents } from './domain-events.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';

export function registerToolNotificationListener(
  eventBus: EventBus<AssistantDomainEvents>,
  sendToClient: (message: ServerMessage) => void,
): Subscription {
  return eventBus.on('tool.secret.detected', (event) => {
    sendToClient({
      type: 'secret_detected',
      toolName: event.toolName,
      matches: event.matches,
      action: event.action,
    });
  });
}
