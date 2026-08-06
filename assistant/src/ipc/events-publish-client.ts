/**
 * Client transport for forwarding an event publish to the daemon.
 *
 * The daemon owns the event hub and the client connections it fans out to. A
 * side process (a sidecar worker, the route host) that publishes to its *own*
 * in-process hub reaches no SSE subscriber, so it must hand the event to the
 * daemon instead. This module is that hand-off: it calls the daemon's
 * `/events/publish` IPC route ({@link EVENTS_PUBLISH_IPC_METHOD}), which
 * republishes the event on the daemon's real hub.
 *
 * The method-name constant lives here (not in the route module) so callers can
 * import it without pulling in the route handler's dependency graph.
 */

import type { AssistantEventEnvelope } from "../api/index.js";
import type { AssistantEventPublishOptions } from "../runtime/assistant-event-publish-options.js";
import { getLogger } from "../util/logger.js";
import { cliIpcCall } from "./cli-client.js";

const log = getLogger("events-publish-client");

/** IPC method name — the raw publish transport other processes call. */
export const EVENTS_PUBLISH_IPC_METHOD = "/events/publish";

/**
 * Forward an event publish to the daemon over IPC. Best-effort: a transport
 * failure is logged, not thrown — a dropped UI-invalidation must never surface
 * as a handler error (mirroring the local hub, whose subscriber failures are
 * isolated from the publisher).
 */
export async function forwardEventPublishToDaemon(
  event: AssistantEventEnvelope,
  options: AssistantEventPublishOptions | undefined,
): Promise<void> {
  const result = await cliIpcCall(EVENTS_PUBLISH_IPC_METHOD, {
    body: { event, options },
  });
  if (!result.ok) {
    log.warn(
      { err: result.error, eventType: event.message?.type },
      "Failed to forward event publish to the daemon",
    );
  }
}
