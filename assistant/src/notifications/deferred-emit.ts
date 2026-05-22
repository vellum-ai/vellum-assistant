/**
 * Per-conversation notification buffer used to keep a background job's
 * "success" notification from racing the runner's `activity.failed` when
 * the job times out after the model already invoked `notifications send`.
 *
 * `registerDeferredConversation` arms the buffer before the LLM turn.
 * `bufferIfDeferred` is called from the IPC route handler — it buffers when
 * armed, swallows when tombstoned (post-discard grace window), and returns
 * null otherwise so the route emits normally.
 * `commitDeferredConversation` flushes on success; `discardDeferredConversation`
 * drops on failure and tombstones briefly to catch late tool calls that
 * arrive after `processMessage` keeps running past the runner's timeout.
 */

import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";
import {
  emitNotificationSignal,
  type EmitSignalParams,
  type EmitSignalResult,
} from "./emit-signal.js";

const log = getLogger("notifications-deferred-emit");

// How long after the last observed late notification we keep the tombstone
// alive. `work` in `runBackgroundJob` is not cancelled on timeout — it can
// continue running and emit skill calls indefinitely. We refresh the timer
// on every late arrival, so the tombstone persists as long as the turn is
// still draining and only expires once the conversation has been quiet for
// this long.
const TOMBSTONE_TTL_MS = 5 * 60 * 1000;

type BufferEntry =
  | { state: "buffered"; items: EmitSignalParams<string>[] }
  | { state: "tombstoned"; timer: ReturnType<typeof setTimeout> };

const buffers = new Map<string, BufferEntry>();

function scheduleTombstoneEviction(
  conversationId: string,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    const cur = buffers.get(conversationId);
    if (cur?.state === "tombstoned") buffers.delete(conversationId);
  }, TOMBSTONE_TTL_MS);
  timer.unref?.();
  return timer;
}

export function registerDeferredConversation(conversationId: string): void {
  buffers.set(conversationId, { state: "buffered", items: [] });
}

/**
 * Buffer the signal when the originating conversation is armed, swallow it
 * when tombstoned, otherwise return null so the caller emits normally.
 */
export function bufferIfDeferred(
  originatingConversationId: string | undefined,
  params: EmitSignalParams<string>,
): EmitSignalResult | null {
  if (!originatingConversationId) return null;
  const entry = buffers.get(originatingConversationId);
  if (!entry) return null;
  if (entry.state === "tombstoned") {
    // Refresh the eviction timer so the tombstone outlives any continuing
    // turn activity. Otherwise a long-running orphan `processMessage` could
    // emit a `notifications send` after the fixed TTL elapsed and bypass
    // buffering, recreating the "success + activity.failed" contradiction.
    clearTimeout(entry.timer);
    entry.timer = scheduleTombstoneEviction(originatingConversationId);
    return {
      signalId: uuid(),
      deduplicated: false,
      dispatched: false,
      reason: "Notification dropped: background job did not complete",
      deliveryResults: [],
    };
  }
  entry.items.push(params);
  return {
    signalId: uuid(),
    deduplicated: false,
    dispatched: false,
    reason: "Notification deferred until background job completes",
    deliveryResults: [],
  };
}

export async function commitDeferredConversation(
  conversationId: string,
): Promise<void> {
  const entry = buffers.get(conversationId);
  if (!entry || entry.state !== "buffered") return;
  buffers.delete(conversationId);
  for (const params of entry.items) {
    try {
      await emitNotificationSignal(params);
    } catch (err) {
      log.warn(
        { err, conversationId },
        "Buffered notification failed to emit on commit",
      );
    }
  }
}

/**
 * Drop any buffered signals and tombstone the conversation. The tombstone
 * persists until the turn has been quiet for `TOMBSTONE_TTL_MS`; each late
 * notification observed via `bufferIfDeferred` refreshes the timer.
 */
export function discardDeferredConversation(conversationId: string): number {
  const entry = buffers.get(conversationId);
  if (!entry) return 0;
  const droppedCount = entry.state === "buffered" ? entry.items.length : 0;
  if (entry.state === "tombstoned") clearTimeout(entry.timer);
  buffers.set(conversationId, {
    state: "tombstoned",
    timer: scheduleTombstoneEviction(conversationId),
  });
  if (droppedCount > 0) {
    log.info(
      { conversationId, droppedCount },
      "Discarded buffered notifications for failed background job",
    );
  }
  return droppedCount;
}

/** @internal Test-only reset hook. */
export function resetDeferredForTest(): void {
  buffers.clear();
}
