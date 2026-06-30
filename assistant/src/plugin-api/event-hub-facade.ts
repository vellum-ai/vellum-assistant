/**
 * Capability-restricted view of the assistant event hub handed to workspace
 * plugins through `@vellumai/plugin-api`.
 *
 * Plugins receive this facade instead of the raw {@link AssistantEventHub}
 * singleton. It delegates every operation to the one daemon hub instance — so
 * subscriptions and reads observe the same shared state — except
 * {@link AssistantEventHub.publish}, which refuses daemon-to-client host-proxy
 * control events (`host_bash_*`, `host_file_*`, `host_transfer_*`,
 * `host_browser_*`, `host_cu_*`, `host_app_control_*`).
 *
 * Those events drive privileged shell / file / input / browser execution on
 * the desktop client. The host proxies gate that execution (risk
 * classification, user approval, same-actor binding, pending-interaction
 * registration) before publishing. Letting an in-process plugin publish the
 * event directly would bypass the gate and reach the host machine outside any
 * sandbox, so the plugin-facing hub rejects it.
 */

import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  type AssistantEventHub,
  assistantEventHub,
} from "../runtime/assistant-event-hub.js";

/**
 * Type prefix shared by every daemon-to-client host-proxy control event. Each
 * host-proxy message type (`host_bash_request`, `host_file_cancel`, …) begins
 * with it, so a prefix test covers all current and future host-proxy kinds.
 */
const HOST_CONTROL_EVENT_TYPE_PREFIX = "host_";

/** The blocked event type if `event` is a host-proxy control event, else `undefined`. */
function hostControlEventType(event: AssistantEvent): string | undefined {
  const type: unknown = event.message?.type;
  return typeof type === "string" &&
    type.startsWith(HOST_CONTROL_EVENT_TYPE_PREFIX)
    ? type
    : undefined;
}

/**
 * The plugin-facing event hub. A {@link Proxy} over the daemon singleton:
 * `publish` is wrapped with the host-control guard; every other member is
 * delegated to — and bound to — the real instance so subscriber state is
 * shared.
 */
export const pluginAssistantEventHub: AssistantEventHub = new Proxy(
  assistantEventHub,
  {
    get(target, prop) {
      if (prop === "publish") {
        return (
          event: AssistantEvent,
          options?: Parameters<AssistantEventHub["publish"]>[1],
        ): Promise<void> => {
          const blockedType = hostControlEventType(event);
          if (blockedType !== undefined) {
            return Promise.reject(
              new Error(
                `Plugins may not publish daemon-to-client host-proxy control events (type "${blockedType}").`,
              ),
            );
          }
          return target.publish(event, options);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);
