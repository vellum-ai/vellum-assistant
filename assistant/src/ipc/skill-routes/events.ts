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
import type { SkillIpcStreamingRoute } from "../skill-ipc-types.js";

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
// Event-type blocklist
// ---------------------------------------------------------------------------

/**
 * Message types that skills are NOT allowed to publish. These are
 * daemon→client control events that trigger host-side execution (bash,
 * file I/O, browser automation, credential prompts) or register pending
 * interactions. Allowing a skill to publish them would bypass the
 * trust/approval gates and escape the skill isolation boundary.
 *
 * Prefix-based: any event whose `type` starts with `"host_"` is blocked,
 * covering current types (`host_bash_request`, `host_file_request`,
 * `host_browser_request`, `host_cu_request`, `host_transfer_request`,
 * and their `_cancel` counterparts) plus any future `host_*` additions.
 */
function isBlockedEventType(type: unknown): boolean {
  if (typeof type !== "string") return true;
  if (type.startsWith("host_")) return true;
  if (type === "confirmation_request") return true;
  if (type === "secret_request") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePublish(
  params?: Record<string, unknown>,
): Promise<{ published: true }> {
  const { event } = PublishParams.parse(params);
  const msgType = (event.message as Record<string, unknown>)?.type;
  if (isBlockedEventType(msgType)) {
    throw new Error(
      `Skills cannot publish events of type "${String(msgType)}"`,
    );
  }
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
      const subscription = assistantEventHub.subscribe({
        type: "process",
        filter,
        callback: (event) => {
          stream.send(event);
        },
        onEvict: () => stream.close("subscription evicted by hub cap"),
      });
      return () => {
        subscription.dispose();
      };
    },
  },
];
