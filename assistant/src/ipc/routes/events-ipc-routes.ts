/**
 * IPC-only route for publishing an assistant event onto the daemon's hub from
 * another process.
 *
 * The daemon owns the event hub and the client connections it fans out to, so
 * any other process that needs to surface an event (sidecar workers today;
 * a conversation's own out-of-process turn as that lands) must hand the event
 * to the daemon rather than construct a disconnected hub of its own. This
 * route is that transport: it takes a full `AssistantEvent` envelope and
 * republishes it on the daemon's `assistantEventHub`, where real subscribers
 * observe it.
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

import type { HostProxyCapability, InterfaceId } from "../../channels/types.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import type { AssistantEvent } from "../../runtime/assistant-event.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

/** IPC method name — the raw publish transport other processes call. */
export const EVENTS_PUBLISH_IPC_METHOD = "/events/publish";

/**
 * A complete event envelope. `id`/`emittedAt`/`message` are required — SSE
 * framing dereferences `event.id`, so a partial envelope would throw in a
 * subscriber callback and silently drop that client. `message` is the opaque
 * outbound payload; its `ServerMessage` union is not re-validated here.
 */
const EventEnvelopeSchema: z.ZodType<AssistantEvent> = z.object({
  id: z.string().min(1),
  conversationId: z.string().optional(),
  seq: z.number().optional(),
  emittedAt: z.string().min(1),
  message: z.custom<ServerMessage>(
    (value) => value != null && typeof value === "object",
  ),
});

const PublishOptionsSchema = z.object({
  targetCapability: z.custom<HostProxyCapability>().optional(),
  targetClientId: z.string().optional(),
  targetInterfaceId: z.custom<InterfaceId>().optional(),
  excludeClientId: z.string().optional(),
});

const EventsPublishParamsSchema = z.object({
  event: EventEnvelopeSchema,
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
