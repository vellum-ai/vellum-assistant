import type { ServerMessage } from "../daemon/message-protocol.js";
import type { EventBus, Subscription } from "./bus.js";
import type { AssistantDomainEvents } from "./domain-events.js";

export function registerToolNotificationListener(
  eventBus: EventBus<AssistantDomainEvents>,
  sendToClient: (message: ServerMessage) => void,
): Subscription {
  return eventBus.on("tool.secret.detected", (event) => {
    sendToClient({
      type: "secret_detected",
      toolName: event.toolName,
      matches: event.matches,
      action: event.action,
    });
  });
}
