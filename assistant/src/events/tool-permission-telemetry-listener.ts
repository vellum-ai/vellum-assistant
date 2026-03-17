import { recordLifecycleEvent } from "../memory/lifecycle-events-store.js";
import { getLogger } from "../util/logger.js";
import type { EventBus, Subscription } from "./bus.js";
import type { AssistantDomainEvents } from "./domain-events.js";

const log = getLogger("tool-permission-telemetry");

export function registerToolPermissionTelemetryListener(
  eventBus: EventBus<AssistantDomainEvents>,
): Subscription {
  return eventBus.onAny((event) => {
    try {
      switch (event.type) {
        case "tool.permission.requested":
          recordLifecycleEvent(
            `permission_prompt:${event.payload.toolName}`,
          );
          return;
        case "tool.permission.decided":
          recordLifecycleEvent(
            `permission_decided:${event.payload.toolName}:${event.payload.decision}`,
          );
          return;
        default:
          return;
      }
    } catch (err) {
      log.warn({ err }, "Failed to record permission telemetry event");
    }
  });
}
