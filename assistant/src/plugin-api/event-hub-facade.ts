/**
 * Capability-restricted view of the assistant event hub handed to workspace
 * plugins through `@vellumai/plugin-api`.
 *
 * Plugins receive this facade instead of the raw {@link AssistantEventHub}
 * singleton. It exposes only the operations a plugin legitimately needs —
 * subscribing to runtime events, publishing non-host events, and checking for
 * subscribers — each delegated to the one daemon hub instance so subscriptions
 * and reads observe the same shared state.
 *
 * Two classes of hub method are withheld:
 *
 * - **`publish` of host-proxy control events** (`host_bash_*`, `host_file_*`,
 *   `host_transfer_*`, `host_browser_*`, `host_cu_*`, `host_app_control_*`).
 *   These drive privileged shell / file / input / browser execution on the
 *   desktop client; the host proxies gate that execution (risk classification,
 *   user approval, same-actor binding, pending-interaction registration) before
 *   publishing. The facade's `publish` rejects them so an in-process plugin
 *   cannot reach the host machine outside the sandbox.
 *
 * - **Methods returning live subscriber entries or mutating hub state**
 *   (`listClients*`, `getClientById`, `disposeClient`, …). A `ClientEntry`
 *   carries the subscriber's `callback` — a direct event-delivery primitive — so
 *   handing one to a plugin would let it deliver a forged host event without
 *   going through the guarded `publish` at all.
 *
 * `publish` deep-clones the caller's event (and options) into an inert snapshot
 * before checking the type and forwards that same snapshot, so a host event
 * cannot slip past the guard via a mutating getter / Proxy (time-of-check vs.
 * time-of-use) or be re-read with a different type by the client.
 */

import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  type AssistantEventHub,
  assistantEventHub,
} from "../runtime/assistant-event-hub.js";

/**
 * The subset of {@link AssistantEventHub} workspace plugins may use. Picking
 * method signatures off the class keeps the facade in sync with the hub while
 * statically withholding everything else.
 */
export type PluginEventHub = Pick<
  AssistantEventHub,
  "subscribe" | "publish" | "hasSubscribersForEvent"
>;

/**
 * Type prefix shared by every daemon-to-client host-proxy control event. Each
 * host-proxy message type (`host_bash_request`, `host_file_cancel`, …) begins
 * with it, so a prefix test covers all current and future host-proxy kinds.
 */
const HOST_CONTROL_EVENT_TYPE_PREFIX = "host_";

/**
 * The structured-clone primitive, pinned at module-load time — before any user
 * plugin loads and could swap the global — so the publish snapshot always
 * produces inert data.
 */
const cloneValue: typeof structuredClone = structuredClone;

/** The blocked event type if `event` is a host-proxy control event, else `undefined`. */
function hostControlEventType(event: AssistantEvent): string | undefined {
  const type: unknown = event.message?.type;
  return typeof type === "string" &&
    type.startsWith(HOST_CONTROL_EVENT_TYPE_PREFIX)
    ? type
    : undefined;
}

/** The plugin-facing event hub. See module docs. */
export const pluginAssistantEventHub: PluginEventHub = Object.freeze({
  subscribe: (subscriber) => assistantEventHub.subscribe(subscriber),

  publish: async (event, options) => {
    let snapshot: AssistantEvent;
    let snapshotOptions: Parameters<AssistantEventHub["publish"]>[1];
    try {
      snapshot = cloneValue(event);
      snapshotOptions = options ? cloneValue(options) : undefined;
    } catch {
      throw new Error("Plugins may not publish a non-serializable event.");
    }
    const blockedType = hostControlEventType(snapshot);
    if (blockedType !== undefined) {
      throw new Error(
        `Plugins may not publish daemon-to-client host-proxy control events (type "${blockedType}").`,
      );
    }
    return assistantEventHub.publish(snapshot, snapshotOptions);
  },

  hasSubscribersForEvent: (event) =>
    assistantEventHub.hasSubscribersForEvent(event),
});
