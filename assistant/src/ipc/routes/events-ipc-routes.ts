/**
 * IPC-only route for publishing an assistant event onto the daemon's hub from
 * another process.
 *
 * The daemon owns the event hub and the client connections it fans out to, so
 * any other process that needs to surface an event (sidecar workers today;
 * skill/plugin-facing helpers as they land) must hand the event to the daemon
 * rather than construct a disconnected hub of its own. This route is that
 * transport: it takes the full event envelope and republishes it on the
 * daemon's `assistantEventHub`, where real subscribers observe it.
 *
 * Host-proxy control events (`host_*`) are refused. Those drive privileged
 * shell / file / input / browser execution on the desktop client and are
 * gated by the host proxies (risk classification, user approval) before the
 * daemon itself publishes them — so accepting one from an outside caller,
 * which can reach this socket, would bypass that approval gate. The block
 * mirrors the plugin event-hub facade's guard.
 *
 * IPC-only: registered directly on the assistant IPC server (see
 * `assistant-server.ts`), never in the shared `ROUTES` array.
 */

import { z } from "zod";

import type { AssistantEvent } from "../../runtime/assistant-event.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { ForbiddenError } from "../../runtime/routes/errors.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

/** IPC method name — the raw publish transport other processes call. */
export const EVENTS_PUBLISH_IPC_METHOD = "/events/publish";

/** Type prefix shared by every daemon-to-client host-proxy control event. */
const HOST_CONTROL_EVENT_TYPE_PREFIX = "host_";

const EventsPublishParamsSchema = z.object({
  /** The full event envelope to publish. */
  event: z.record(z.string(), z.unknown()),
  /** Optional publish targeting/suppression options (see hub `publish`). */
  options: z.record(z.string(), z.unknown()).optional(),
});

/** The blocked event type if `event` is a host-proxy control event, else undefined. */
function hostControlEventType(
  event: Record<string, unknown>,
): string | undefined {
  const message = event.message as { type?: unknown } | undefined;
  const type = message?.type;
  return typeof type === "string" &&
    type.startsWith(HOST_CONTROL_EVENT_TYPE_PREFIX)
    ? type
    : undefined;
}

export async function handleEventsPublish({
  body = {},
}: RouteHandlerArgs): Promise<{ ok: true }> {
  const { event, options } = EventsPublishParamsSchema.parse(body);

  const blockedType = hostControlEventType(event);
  if (blockedType !== undefined) {
    throw new ForbiddenError(
      `Refusing to publish a daemon-to-client host-proxy control event (type "${blockedType}") over ${EVENTS_PUBLISH_IPC_METHOD}.`,
    );
  }

  await assistantEventHub.publish(
    event as unknown as AssistantEvent,
    options as Parameters<typeof assistantEventHub.publish>[1],
  );
  return { ok: true };
}

/**
 * IPC-only events methods, keyed by operationId. Registered directly on the
 * assistant IPC server (see `assistant-server.ts`).
 */
export const EVENTS_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  [EVENTS_PUBLISH_IPC_METHOD]: handleEventsPublish,
};
