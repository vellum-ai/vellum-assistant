/**
 * Builds the `broadcast` capability the pipeline stamps onto every hook
 * context. A hook calls `ctx.broadcast(detail)`; the returned closure emits a
 * single `hook_event`, bound to the conversation (when the hook runs inside
 * one), the hook name, and the emitting hook's owner. The hook supplies only
 * `detail` — it cannot choose the event type, the conversation, or the owner.
 *
 * `hook_event` is excluded from the SSE replay ring in `broadcastMessage`, so
 * these transient signals are delivered live but never replayed on reconnect.
 */

import type { HookEventOwner } from "../api/events/hook-event.js";
import type { HookName } from "../plugin-api/constants.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";

export function makeHookBroadcast(meta: {
  conversationId?: string;
  hookName: HookName;
  owner: HookEventOwner;
}): (detail: Record<string, unknown>) => void {
  return (detail) => {
    broadcastMessage(
      {
        type: "hook_event",
        conversationId: meta.conversationId,
        hookName: meta.hookName,
        owner: meta.owner,
        detail,
      },
      meta.conversationId,
    );
  };
}
