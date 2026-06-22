/**
 * On-demand revalidation for LLM-generated home page content.
 *
 * The personalized greeting and assistant-generated suggestion prompts
 * are served from caches (see `home-greeting-cache.ts` and
 * `suggested-prompts.ts`). The GET handler stays read-only; when a
 * client fetches the home feed it calls `revalidateHomeContentInBackground()`
 * fire-and-forget, which regenerates whichever caches are stale and
 * publishes a `home_feed_updated` event when fresh content lands so
 * connected clients refetch and the personalized content swaps in.
 *
 * This keeps LLM cost proportional to actual Home usage: nothing
 * generates at daemon startup or on a timer, and the per-cache TTLs
 * (4 hours each) bound how often a regeneration can happen.
 */

import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import { refreshPersonalizedGreeting } from "./home-greeting.js";
import { refreshAssistantSuggestedPrompts } from "./suggested-prompts.js";

const log = getLogger("home-content-refresh");

let inFlight: Promise<void> | null = null;

async function revalidateAll(): Promise<void> {
  const [greetingRefreshed, promptsRefreshed] = await Promise.all([
    refreshPersonalizedGreeting(),
    refreshAssistantSuggestedPrompts(),
  ]);

  if (!greetingRefreshed && !promptsRefreshed) {
    return;
  }

  await assistantEventHub.publish(
    buildAssistantEvent({
      type: "home_feed_updated",
      updatedAt: new Date().toISOString(),
      newItemCount: 0,
    }),
  );
}

/**
 * Regenerate stale home content in the background. Returns immediately;
 * callers (the home feed GET handler) must not await generation. Both
 * refreshers no-op when their cache is fresh, so calling this on every
 * feed fetch is cheap — at most one generation per cache TTL window.
 * Concurrent calls share a single in-flight revalidation.
 */
export function revalidateHomeContentInBackground(): void {
  if (inFlight) {
    return;
  }
  inFlight = revalidateAll()
    .catch((err) => {
      log.warn({ err }, "Home content revalidation failed");
    })
    .finally(() => {
      inFlight = null;
    });
}
