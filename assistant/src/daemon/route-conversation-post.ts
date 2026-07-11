/**
 * Post a message into a conversation from a workspace custom route.
 *
 * Lets integration routes (webhook receivers, cron-triggered handlers,
 * device/service callbacks) surface an inbound event as a real assistant turn
 * — "your deploy finished", "payment received" — instead of only publishing a
 * client-side event via the event hub.
 *
 * Security posture (asserted by route-conversation-post.test.ts):
 *   - Attribution is unspoofable: every posted turn is stamped with the
 *     dedicated `route` interface. The caller cannot supply an interface, so a
 *     route can never impersonate a human surface (web / macos / cli / …).
 *   - No privilege escalation: the turn runs under the target conversation's
 *     existing trust context. This helper never passes a trust or auth context,
 *     so a route cannot grant itself guardian trust by posting a turn.
 *   - Loop backstop: a per-conversation rate limit bounds runaway
 *     route → assistant → route cycles.
 */

import { v7 as uuidv7 } from "uuid";

import type { InterfaceId } from "../channels/types.js";
import { getConversation } from "../persistence/conversation-crud.js";
import { getLogger } from "../util/logger.js";
import { getOrCreateConversation } from "./conversation-store.js";
import { processMessageInBackground } from "./process-message.js";

const log = getLogger("route-conversation-post");

/** Attribution interface for turns injected by workspace custom routes. */
const ROUTE_SOURCE_INTERFACE: InterfaceId = "route";

/** Loop backstop: max route-originated posts per conversation per window. */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const recentPostTimestamps = new Map<string, number[]>();

export type RouteMessageErrorCode = "not_found" | "rate_limited" | "invalid";

/**
 * Typed failure surfaced by {@link postRouteConversationMessage}. A route
 * handler can catch it and map `code` to an HTTP status, or let it propagate
 * (the dispatcher renders it as a 500).
 */
export class RouteMessageError extends Error {
  readonly code: RouteMessageErrorCode;
  constructor(message: string, code: RouteMessageErrorCode) {
    super(message);
    this.name = "RouteMessageError";
    this.code = code;
  }
}

function enforceRateLimit(conversationId: string): void {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (recentPostTimestamps.get(conversationId) ?? []).filter(
    (t) => t > cutoff,
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    throw new RouteMessageError(
      `Route message rate limit exceeded for this conversation ` +
        `(max ${RATE_LIMIT_MAX} per ${RATE_LIMIT_WINDOW_MS / 1000}s). ` +
        `This backstops runaway route→assistant→route loops.`,
      "rate_limited",
    );
  }
  recent.push(now);
  recentPostTimestamps.set(conversationId, recent);
}

/**
 * Post `text` into an existing conversation as a real user turn attributed to
 * the `route` interface, returning the persisted message id. The agent turn
 * runs fire-and-forget (matching the conversation launcher), so this resolves
 * as soon as the message is persisted and the loop is kicked off.
 *
 * @throws {@link RouteMessageError} with code `invalid` (missing id / empty
 *   text), `not_found` (unknown conversation — never silently creates one), or
 *   `rate_limited`.
 */
export async function postRouteConversationMessage(
  conversationId: string,
  text: string,
): Promise<{ messageId: string }> {
  if (typeof conversationId !== "string" || conversationId.trim() === "") {
    throw new RouteMessageError("conversationId is required", "invalid");
  }
  if (typeof text !== "string" || text.trim() === "") {
    throw new RouteMessageError(
      "message text must be a non-empty string",
      "invalid",
    );
  }

  // Reject unknown conversations explicitly. processMessageInBackground would
  // otherwise create one via getOrCreateActiveConversation, letting a route
  // spawn empty conversations from arbitrary ids.
  if (!getConversation(conversationId)) {
    throw new RouteMessageError(
      `conversation not found: ${conversationId}`,
      "not_found",
    );
  }

  enforceRateLimit(conversationId);

  // Attribution is fixed here — never taken from the caller — so a route cannot
  // post as a human interface. Trust and auth contexts are intentionally
  // omitted: the turn inherits the conversation's existing trust context and a
  // route cannot elevate privilege by posting.

  // Honor the standard send contract: queue when the conversation is mid-turn
  // rather than dropping the event. A bursty integration (webhook, cron) that
  // fires during an active turn would otherwise hit CONVERSATION_BUSY_MESSAGE
  // and be lost. The queued turn carries the same `route` attribution via
  // metadata so its drain is stamped correctly.
  const conversation = await getOrCreateConversation(conversationId);
  if (conversation.isProcessing()) {
    const requestId = uuidv7();
    const result = conversation.enqueueMessage({
      content: text,
      requestId,
      metadata: {
        userMessageChannel: "vellum",
        assistantMessageChannel: "vellum",
        userMessageInterface: ROUTE_SOURCE_INTERFACE,
        assistantMessageInterface: ROUTE_SOURCE_INTERFACE,
      },
    });
    if (result.rejected) {
      throw new RouteMessageError(
        "conversation queue is full; retry shortly",
        "rate_limited",
      );
    }
    if (result.queued) {
      log.info(
        { conversationId, requestId },
        "Route message queued behind an active turn",
      );
      return { messageId: requestId };
    }
    // The turn finished between the check and the enqueue — fall through and
    // process immediately.
  }

  const { messageId } = await processMessageInBackground(conversationId, text, {
    sourceChannel: "vellum",
    sourceInterface: ROUTE_SOURCE_INTERFACE,
  });

  log.info(
    { conversationId, messageId },
    "Route posted a message into a conversation",
  );
  return { messageId };
}
