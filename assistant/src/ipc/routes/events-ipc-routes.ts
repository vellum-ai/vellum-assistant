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
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { AssistantEventPublishOptionsSchema } from "../../runtime/assistant-event-publish-options.js";
import { stampAndBuffer } from "../../runtime/assistant-stream-state.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import { EVENTS_PUBLISH_IPC_METHOD } from "../events-publish-client.js";

const EventsPublishParamsSchema = z.object({
  event: AssistantEventEnvelopeSchema,
  options: AssistantEventPublishOptionsSchema.optional(),
});

export async function handleEventsPublish({
  body = {},
}: RouteHandlerArgs): Promise<{ ok: true }> {
  const { event, options } = EventsPublishParamsSchema.parse(body);
  // A forwarded event comes from a process where seq stamping is disabled
  // (a worker), so it arrives with no `seq` and was never buffered for SSE
  // replay. The daemon is the seq authority, so stamp + buffer here — at the
  // transport boundary, before fanout — exactly as `broadcastMessage` does on
  // the in-daemon path, so reconnecting clients replay it in order.
  stampAndBuffer(event, { targeting: options });
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
