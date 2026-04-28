/**
 * Skill IPC routes for `host.events.*`.
 *
 * Exposes the daemon's `assistantEventHub` to out-of-process skills so they
 * can publish, subscribe to, and construct `AssistantEvent` envelopes
 * without linking against `assistant/` directly. Mirrors the in-process
 * `EventsFacet` surface defined in `@vellumai/skill-host-contracts` and
 * implemented for in-process callers by `DaemonSkillHost`.
 *
 * ### Routes
 *
 * - `host.events.publish` — one-shot RPC. Params `{ event: AssistantEvent }`.
 *   Forwards to `assistantEventHub.publish(event)` and resolves once all
 *   matching subscribers have been dispatched.
 *
 * - `host.events.subscribe` — long-lived stream. Params
 *   `{ filter: AssistantEventFilter }`. The server opens a subscription on
 *   `assistantEventHub` and streams each matching event back as a delivery
 *   frame (`{ id, event: "delivery", payload }`) until the client
 *   disconnects or sends the `host.events.subscribe.close` control method.
 *   Teardown is wired through the IPC server's per-socket subscription map
 *   so daemon shutdown also evicts every active subscriber.
 *
 * - `host.events.buildEvent` — deterministic helper. Params
 *   `{ message, conversationId? }`. Returns the `AssistantEvent` envelope a
 *   skill would otherwise construct locally — keeping event-id allocation
 *   and timestamp generation on the daemon side
 *   so skill processes do not drift on UUID / clock sources.
 */

import { z } from "zod";

import { buildAssistantEvent } from "../../runtime/assistant-event.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import type { SkillIpcRoute } from "../skill-ipc-types.js";
import type { SkillIpcStreamingRoute } from "../skill-server.js";

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

/**
 * `AssistantEvent` wire shape accepted by `host.events.publish`. The
 * envelope fields (`id`, `emittedAt`, `message`) are required;
 * `conversationId` is optional. The `message` payload is an opaque JSON
 * object — the daemon does not narrow it before handing it to
 * `assistantEventHub.publish`, matching the in-process hub contract.
 */
const AssistantEventSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().optional(),
  emittedAt: z.string().min(1),
  message: z.record(z.string(), z.unknown()),
});

const PublishParams = z.object({
  event: AssistantEventSchema,
});

const FilterSchema = z.object({
  conversationId: z.string().optional(),
});

const SubscribeParams = z.object({
  filter: FilterSchema,
});

const BuildEventParams = z.object({
  message: z.record(z.string(), z.unknown()),
  conversationId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePublish(
  params?: Record<string, unknown>,
): Promise<{ published: true }> {
  const { event } = PublishParams.parse(params);
  // Contract types the hub as `AssistantEvent<ServerMessage>`; the wire-level
  // message is an opaque record that satisfies the `ServerMessage` structural
  // shape (`{ type: string; [key: string]: unknown }`). Cast at the boundary.
  await assistantEventHub.publish(event as never);
  return { published: true };
}

function handleBuildEvent(params?: Record<string, unknown>): unknown {
  const { message, conversationId } = BuildEventParams.parse(params);
  return buildAssistantEvent(message as never, conversationId);
}

// ---------------------------------------------------------------------------
// Route exports
// ---------------------------------------------------------------------------

export const eventsRoutes: SkillIpcRoute[] = [
  { method: "host.events.publish", handler: handlePublish },
  { method: "host.events.buildEvent", handler: handleBuildEvent },
];

export const eventsStreamingRoutes: SkillIpcStreamingRoute[] = [
  {
    method: "host.events.subscribe",
    handler: (stream, params) => {
      const { filter } = SubscribeParams.parse(params);
      const subscription = assistantEventHub.subscribe(
        filter,
        (event) => {
          stream.send(event);
        },
        // The hub evicts the oldest subscriber when its cap fills. Without
        // this callback the IPC stream would silently stop receiving events
        // while the client still believed it was subscribed. Mirror the SSE
        // route's behavior by tearing the stream down with a terminal error
        // frame so the client can resubscribe.
        { onEvict: () => stream.close("subscription evicted by hub cap") },
      );
      return () => {
        subscription.dispose();
      };
    },
  },
];
