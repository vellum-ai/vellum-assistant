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
 * `subscribe` registers the plugin as an in-process consumer only (never a
 * device "client"), so it cannot impersonate a real client by id or receive
 * host-capability-targeted events; its callback is handed an isolated, frozen
 * snapshot so it cannot mutate an in-flight event a real client receives later
 * in the same fanout.
 *
 * `publish` canonicalizes the caller's event (and options) to their JSON wire
 * form — the exact representation the client receives — then deep-freezes that
 * snapshot before checking the type and forwards it. JSON canonicalization
 * collapses getters / Proxies to inert values and coerces boxed values (e.g.
 * `new String("host_bash_request")`) to primitives, so the guard cannot be
 * shown a benign type while the client acts on a host one (time-of-check vs.
 * time-of-use). Freezing stops a subscriber from mutating the in-flight event
 * mid-fanout (the hub delivers one object to every subscriber in turn).
 */

import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  type AssistantEventFilter,
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
 * JSON primitives pinned at module-load time — before any user plugin loads and
 * could swap the globals. A JSON round-trip canonicalizes a published event to
 * exactly the wire form the client receives, so the guard checks the same
 * representation the client will act on.
 */
const jsonStringify: typeof JSON.stringify = JSON.stringify;
const jsonParse: typeof JSON.parse = JSON.parse;

/** Canonicalize a value to its JSON wire form. Throws if it is not serializable. */
function wireSnapshot<T>(value: T): T {
  return jsonParse(jsonStringify(value)) as T;
}

/**
 * Recursively freeze a value (cycle-safe). The hub fans the same event object
 * out to every subscriber in turn; freezing the snapshot stops a malicious
 * subscriber — e.g. a plugin that subscribed and then calls `publish` — from
 * mutating the in-flight event into a host request before a later host-capable
 * client receives it.
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/**
 * `String.prototype.startsWith` bound at module-load time — before any user
 * plugin loads and could monkey-patch the prototype — so the host-prefix check
 * cannot be neutralized by a patched method.
 */
const startsWith = Function.prototype.call.bind(
  String.prototype.startsWith,
) as (str: string, search: string) => boolean;

/** The blocked event type if `event` is a host-proxy control event, else `undefined`. */
function hostControlEventType(event: AssistantEvent): string | undefined {
  const type: unknown = event.message?.type;
  return typeof type === "string" &&
    startsWith(type, HOST_CONTROL_EVENT_TYPE_PREFIX)
    ? type
    : undefined;
}

/** The plugin-facing event hub. See module docs. */
export const pluginAssistantEventHub: PluginEventHub = Object.freeze({
  subscribe: (subscriber) => {
    // Plugins subscribe as in-process consumers only — never as device
    // "clients" — so a plugin cannot impersonate/evict a real client by id or
    // receive host-capability-targeted events meant for the desktop app. The
    // filter is canonicalized to inert data so the hub never invokes a
    // plugin-defined getter while reading `entry.filter` during fanout, and the
    // callback is handed an isolated, frozen snapshot so it cannot mutate an
    // in-flight event a real client receives later in the same fanout (the hub
    // delivers one shared object to every subscriber in turn).
    let filter: AssistantEventFilter | undefined;
    try {
      filter = subscriber.filter ? wireSnapshot(subscriber.filter) : undefined;
    } catch {
      filter = undefined;
    }
    return assistantEventHub.subscribe({
      type: "process",
      filter,
      callback: (event) => {
        let isolated: AssistantEvent;
        try {
          isolated = deepFreeze(wireSnapshot(event));
        } catch {
          return;
        }
        return subscriber.callback(isolated);
      },
    });
  },

  publish: async (event, options) => {
    let snapshot: AssistantEvent;
    let snapshotOptions: Parameters<AssistantEventHub["publish"]>[1];
    try {
      snapshot = deepFreeze(wireSnapshot(event));
      snapshotOptions = options ? wireSnapshot(options) : undefined;
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
    // Read the caller's `conversationId` once and pass an inert object, so the
    // hub never reads a plugin-defined getter.
    assistantEventHub.hasSubscribersForEvent({
      conversationId: event?.conversationId,
    }),
});
