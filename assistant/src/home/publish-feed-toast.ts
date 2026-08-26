/**
 * Publishes the `feed_toast` event for feed rows that want attention while the
 * user is in the app.
 *
 * The toast exists for one job: async work finished and you should look at it
 * now, and you happen to be in the app. Three rules follow from that and are
 * enforced here:
 *
 *   - **Terminal transitions only.** A run finishing with something to show,
 *     failing in a way you can fix, or becoming blocked on you. Never on start,
 *     never on progress: starting work shows as a live count on the bell.
 *   - **Never the only delivery.** Every toast names the durable feed row
 *     behind it, so missing one costs nothing.
 *   - **Activity never toasts.** Routine work is silent by definition.
 *
 * Whether a toast is actually drawn is the client's call: it is in-app only, so
 * an unfocused window drops the event and the system notification takes over.
 * Stacking and collapsing ("3 runs finished") is likewise a client concern,
 * since only the client knows what is already on screen.
 */

import type { FeedItem } from "../api/responses/home.js";
import { isTerminalRunState } from "../api/responses/home.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import { resolveFeedItemHeadline } from "./feed-headline.js";

const log = getLogger("feed-toast");

/**
 * Emit a toast for a feed row, when the row qualifies. Never throws.
 *
 * Returns whether an event was published, which is what the tests assert on:
 * "did a progress update toast" is the regression worth guarding.
 */
export function publishFeedToast(item: FeedItem): boolean {
  try {
    if (!qualifiesForToast(item)) {
      return false;
    }

    const action = resolveToastAction(item);
    broadcastMessage({
      type: "feed_toast",
      feedItemId: item.id,
      bucket: item.bucket ?? "worth_knowing",
      title: resolveFeedItemHeadline(item),
      body: item.summary,
      emittedAt: new Date().toISOString(),
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      ...(action ?? {}),
    });
    return true;
  } catch (err) {
    log.warn({ err, feedItemId: item.id }, "Failed to publish a feed toast");
    return false;
  }
}

function qualifiesForToast(item: FeedItem): boolean {
  const bucket = item.bucket;
  if (bucket !== "needs_you" && bucket !== "worth_knowing") {
    return false;
  }
  if (item.status === "dismissed") {
    return false;
  }
  if (item.type === "run") {
    // The one place a non-terminal state still toasts: a run that is blocked
    // on the user is not "in progress" in any sense they can ignore.
    const state = item.run?.state;
    if (!state) {
      return false;
    }
    return state === "needs_input" || isTerminalRunState(state);
  }
  // A system-health row is a counter that never pushes, and a digest is the
  // definition of routine. Both are Activity anyway; the guard is belt to the
  // bucket check's braces.
  return item.type === "notification";
}

/**
 * The inline action a needs-you toast carries, so the user can decide without
 * opening anything.
 *
 * Only offered when the row names a real destination. A button that opens a
 * surface with nothing on it is worse than no button.
 */
function resolveToastAction(
  item: FeedItem,
): { actionLabel: string; actionPath: string } | undefined {
  const firstAction = item.actions?.[0];
  if (firstAction) {
    return {
      actionLabel: firstAction.label,
      actionPath: `/activity?feedItemId=${encodeURIComponent(item.id)}`,
    };
  }
  if (item.bucket === "needs_you" && item.conversationId) {
    return {
      actionLabel: "Open",
      actionPath: `/chat/${encodeURIComponent(item.conversationId)}`,
    };
  }
  return undefined;
}
