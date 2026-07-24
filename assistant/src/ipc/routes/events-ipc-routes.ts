/**
 * IPC-only route for publishing an assistant event onto the daemon's hub from
 * another process.
 *
 * The daemon owns the event hub and the client connections it fans out to, so
 * any other process that needs to surface an event (sidecar workers today;
 * a conversation's own out-of-process turn as that lands) must hand the event
 * to the daemon rather than construct a disconnected hub of its own. This
 * route is that transport: it validates a full event envelope against the
 * shared `AssistantEventEnvelopeSchema` and republishes it on the daemon's
 * `assistantEventHub`, where real subscribers observe it.
 *
 * The route does not filter host-proxy (`host_*`) events: the security
 * boundary for privileged host execution sits with the host proxies, which
 * gate every `host_*` message (risk classification, user approval) on the
 * desktop client before it runs. This is a raw transport for the processes
 * that own a conversation's turn.
 *
 * IPC-only: registered directly on the assistant IPC server (see
 * `assistant-server.ts`), never in the shared `ROUTES` array.
 */

import { z } from "zod";

import { AssistantEventEnvelopeSchema } from "../../api/index.js";
import {
  HOST_PROXY_CAPABILITIES,
  INTERFACE_IDS,
} from "../../channels/types.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

/** IPC method name — the raw publish transport other processes call. */
export const EVENTS_PUBLISH_IPC_METHOD = "/events/publish";

/** Publish targeting/suppression options — see the hub's `publish`. */
const PublishOptionsSchema = z.object({
  targetCapability: z.enum(HOST_PROXY_CAPABILITIES).optional(),
  targetClientId: z.string().optional(),
  targetInterfaceId: z.enum(INTERFACE_IDS).optional(),
  excludeClientId: z.string().optional(),
});

const EventsPublishParamsSchema = z.object({
  event: AssistantEventEnvelopeSchema,
  options: PublishOptionsSchema.optional(),
});

export async function handleEventsPublish({
  body = {},
}: RouteHandlerArgs): Promise<{ ok: true }> {
  const { event, options } = EventsPublishParamsSchema.parse(body);
  await assistantEventHub.publish(event, options);
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
