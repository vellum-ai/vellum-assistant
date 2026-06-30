/**
 * Capability-restricted view of the assistant event hub handed to workspace
 * plugins through `@vellumai/plugin-api`.
 *
 * Plugins receive this facade instead of the raw {@link AssistantEventHub}
 * singleton. Every hub method is delegated to the one daemon instance — so
 * subscriptions and reads observe the same shared state — except `publish`,
 * which refuses daemon-to-client host-proxy control events (`host_bash_*`,
 * `host_file_*`, `host_transfer_*`, `host_browser_*`, `host_cu_*`,
 * `host_app_control_*`).
 *
 * Those events drive privileged shell / file / input / browser execution on
 * the desktop client. The host proxies gate that execution (risk
 * classification, user approval, same-actor binding, pending-interaction
 * registration) before publishing; letting an in-process plugin publish the
 * event directly would bypass the gate and reach the host machine outside any
 * sandbox.
 *
 * The facade is a frozen, null-prototype object of bound methods. It does NOT
 * inherit from `AssistantEventHub.prototype`, so a plugin cannot reach the
 * unguarded `publish` through the prototype chain (`Object.getPrototypeOf`,
 * `.constructor`, …). The real hub is captured only inside the bound closures,
 * which never hand it back out.
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
 * Build the plugin-facing facade over `hub`: every method bound to the real
 * instance (shared state), `publish` replaced with the host-control guard, on
 * a null prototype so the raw `publish` is unreachable by reflection.
 */
function buildPluginEventHub(hub: AssistantEventHub): AssistantEventHub {
  const guardedPublish: AssistantEventHub["publish"] = (event, options) => {
    const blockedType = hostControlEventType(event);
    if (blockedType !== undefined) {
      return Promise.reject(
        new Error(
          `Plugins may not publish daemon-to-client host-proxy control events (type "${blockedType}").`,
        ),
      );
    }
    return hub.publish(event, options);
  };

  const facade: Record<string, unknown> = Object.create(null);
  const prototype = Object.getPrototypeOf(hub) as object;
  const members = hub as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === "constructor") continue;
    const member = members[name];
    if (typeof member !== "function") continue;
    facade[name] =
      name === "publish"
        ? guardedPublish
        : (member as (...args: unknown[]) => unknown).bind(hub);
  }
  return Object.freeze(facade) as unknown as AssistantEventHub;
}

/** The plugin-facing event hub. See module docs. */
export const pluginAssistantEventHub: AssistantEventHub =
  buildPluginEventHub(assistantEventHub);
