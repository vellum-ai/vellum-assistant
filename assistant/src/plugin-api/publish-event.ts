/**
 * Plugin-facing helper for publishing a runtime event to the assistant's event
 * hub.
 *
 * This is the narrow, purpose-built wrapper that replaces handing plugins the
 * general `assistantEventHub` handle: a plugin that only needs to *emit* an
 * event imports `publishEvent` instead of the whole publish/subscribe surface.
 * It delegates to the capability-restricted {@link pluginAssistantEventHub}
 * facade, so the same guards apply — the event is canonicalized to its JSON
 * wire form and daemon-to-client host-proxy control events (`host_*`) are
 * rejected.
 *
 * Typical use is a route or hook surfacing a UI-invalidation event (e.g.
 * `sync_changed`) so subscribed clients re-fetch the data that changed.
 */

import type { AssistantEventEnvelope } from "../runtime/assistant-event.js";
import {
  pluginAssistantEventHub,
  type PluginEventHub,
} from "./event-hub-facade.js";

/** Publish options, mirroring the hub's `publish` options (targeting, self-echo suppression). */
export type PublishEventOptions = NonNullable<
  Parameters<PluginEventHub["publish"]>[1]
>;

/**
 * Publish a runtime event to the assistant's event hub. Resolves once fanout to
 * all subscribers has been attempted (a throwing subscriber never aborts
 * delivery to the rest). Rejects if the event is non-serializable or is a
 * host-proxy control event, which plugins may not publish.
 */
export function publishEvent(
  event: AssistantEventEnvelope,
  options?: PublishEventOptions,
): Promise<void> {
  return pluginAssistantEventHub.publish(event, options);
}
