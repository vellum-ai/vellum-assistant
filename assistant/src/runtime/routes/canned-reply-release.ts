/**
 * Deferred release for the canned-reply routes (canned first greeting, unknown
 * slash command).
 *
 * These routes answer without an agent loop, so they hold the processing lock
 * themselves and are the only thing that will ever clear it. They publish their
 * client events on the next tick so the HTTP 202 reaches the client first and
 * its `serverToLocalConversationMap` is populated before any SSE arrives, and
 * they release only after that burst so the next queued message cannot start
 * processing ahead of the reply the client is still being told about.
 *
 * The release therefore has to be unconditional: a throw from any broadcast in
 * the burst would otherwise latch the conversation "processing" with no agent
 * loop, no `finally`, and no later path left to clear it, so every subsequent
 * send is queued behind an idle conversation for the life of the daemon.
 */

import type { Conversation } from "../../daemon/conversation.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("canned-reply-release");

/** The conversation surface {@link scheduleCannedReplyRelease} touches. */
export type CannedReplyReleaseTarget = Pick<
  Conversation,
  "setProcessing" | "kickDrainQueue"
>;

export function scheduleCannedReplyRelease(params: {
  conversation: CannedReplyReleaseTarget;
  /** Names the release site in drain logs (e.g. `"canned_greeting"`). */
  origin: string;
  /** The deferred client event burst. Runs before the release. */
  emit: () => void;
  /** Optional work that only makes sense once the lock is free. */
  afterRelease?: () => void;
}): void {
  const { conversation, origin, emit, afterRelease } = params;
  setTimeout(() => {
    try {
      emit();
    } catch (err) {
      // Swallowed rather than rethrown: this runs from a timer with no caller
      // left to handle it, so an escaping error is an uncaught exception in
      // the daemon process. The reply is already persisted, and clients
      // reconcile a missed event burst on their next fetch.
      log.error({ err, origin }, "Canned reply event burst failed");
    } finally {
      conversation.setProcessing(false);
      void conversation.kickDrainQueue("loop_complete", origin);
    }
    afterRelease?.();
  }, 0);
}
