import { recordLifecycleEvent } from "../memory/lifecycle-events-store.js";
import { getLogger } from "../util/logger.js";
import type { EventBus, Subscription } from "./bus.js";
import type { AssistantDomainEvents } from "./domain-events.js";

const log = getLogger("tool-permission-telemetry");

export function registerToolPermissionTelemetryListener(
  eventBus: EventBus<AssistantDomainEvents>,
): Subscription {
  // Track which tool calls were actually prompted so we only record
  // decided telemetry for real user interactions, not auto-allowed tools.
  // Uses a composite key (requestId:toolName) because requestId is per-message,
  // not per-tool-call — parallel tool_use blocks share the same requestId.
  const promptedToolCalls = new Set<string>();

  return eventBus.onAny((event) => {
    try {
      switch (event.type) {
        case "tool.permission.requested": {
          const { requestId, toolName } = event.payload;
          if (requestId) {
            promptedToolCalls.add(`${requestId}:${toolName}`);
          }
          recordLifecycleEvent(`permission_prompt:${toolName}`);
          return;
        }
        case "tool.permission.decided": {
          const { requestId, toolName, decision } = event.payload;
          const key = requestId ? `${requestId}:${toolName}` : undefined;
          if (key && promptedToolCalls.has(key)) {
            promptedToolCalls.delete(key);
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
