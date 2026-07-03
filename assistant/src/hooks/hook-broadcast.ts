/**
 * Builds the `broadcast` capability the pipeline stamps onto every hook
 * context. A hook calls `ctx.broadcast(detail)`; the returned closure emits a
 * single `hook_event`, bound to the conversation (when the hook runs inside
 * one), the hook name, and the emitting hook's owner. The hook supplies only
 * `detail` — it cannot choose the event type, the conversation, or the owner.
 *
 * `hook_event` travels the standard SSE stream (including reconnect replay)
 * like every other event; clients render it as transient progress.
 */

import type { HookEventOwner } from "../api/events/hook-event.js";
import type { HookName } from "../plugin-api/constants.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import type { HookBroadcast } from "./types.js";

export function makeHookBroadcast(meta: {
  conversationId?: string;
  hookName: HookName;
  owner: HookEventOwner;
}): HookBroadcast {
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
