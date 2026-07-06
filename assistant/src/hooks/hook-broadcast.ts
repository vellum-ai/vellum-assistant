/**
 * Builds the `broadcast` capability the pipeline stamps onto every hook
 * context. A hook calls `ctx.broadcast(detail)`; the returned closure emits a
 * single `hook_event`, bound to the conversation (when the hook runs inside
 * one), the hook name, and the emitting hook's owner. The hook supplies only
 * `detail` — it cannot choose the event type, the conversation, or the owner.
 *
 * `hook_event` travels the standard SSE stream (including reconnect replay)
 * like every other event; clients render it as transient progress.
 *
 * The closure never throws: `detail` is hook-supplied and untrusted, so a
 * payload JSON cannot represent (circular reference, BigInt, throwing toJSON)
 * is replaced with a marker instead of propagating a serialization error into
 * the hook chain, and any emit failure is logged and swallowed — `broadcast`
 * is best-effort by contract.
 */

import type { HookEventOwner } from "../api/events/hook-event.js";
import type { HookName } from "../plugin-api/constants.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import type { HookBroadcast } from "./types.js";

const log = getLogger("hook-broadcast");

export function makeHookBroadcast(meta: {
  conversationId?: string;
  hookName: HookName;
  owner: HookEventOwner;
}): HookBroadcast {
  return (detail) => {
    let safeDetail = detail;
    try {
      JSON.stringify(detail);
    } catch (err) {
      log.warn(
        { err, hookName: meta.hookName, owner: meta.owner },
        "hook_event detail is not JSON-serializable — emitting a marker payload instead",
      );
      safeDetail = { unserializableDetail: true };
    }
    try {
      broadcastMessage(
        {
          type: "hook_event",
          conversationId: meta.conversationId,
          hookName: meta.hookName,
          owner: meta.owner,
          detail: safeDetail,
        },
        meta.conversationId,
      );
    } catch (err) {
      log.warn(
        { err, hookName: meta.hookName, owner: meta.owner },
        "hook_event broadcast failed (non-fatal)",
      );
    }
  };
}
