import { recordLifecycleEvent } from "../memory/lifecycle-events-store.js";
import { getLogger } from "../util/logger.js";
import type { EventBus, Subscription } from "./bus.js";
import type { AssistantDomainEvents } from "./domain-events.js";

const log = getLogger("tool-permission-telemetry");

export function registerToolPermissionTelemetryListener(
  eventBus: EventBus<AssistantDomainEvents>,
): Subscription {
  // Track which request IDs were actually prompted so we only record
  // decided telemetry for real user interactions, not auto-allowed tools.
  const promptedRequestIds = new Set<string>();

  return eventBus.onAny((event) => {
    try {
      switch (event.type) {
        case "tool.permission.requested":
          if (event.payload.requestId) {
            promptedRequestIds.add(event.payload.requestId);
          }
          recordLifecycleEvent(
            `permission_prompt:${event.payload.toolName}`,
          );
          return;
        case "tool.permission.decided": {
          const { requestId, toolName, decision } = event.payload;
          if (requestId && promptedRequestIds.has(requestId)) {
            promptedRequestIds.delete(requestId);
            recordLifecycleEvent(
              `permission_decided:${toolName}:${decision}`,
            );
          }
          return;
        }
        default:
          return;
      }
    } catch (err) {
      log.warn({ err }, "Failed to record permission telemetry event");
    }
  });
}
