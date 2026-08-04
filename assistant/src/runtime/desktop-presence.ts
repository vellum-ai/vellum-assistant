/**
 * Desktop presence policy.
 *
 * Answers exactly one question for notification producers: is the user
 * demonstrably at their Mac right now? Producers use the answer to skip a
 * push that the user would see on screen anyway.
 *
 * Fails open by design. Presence is in-memory, best-effort, and reported by
 * a client that can drop off at any time, so anything short of a fresh
 * `active` report from a `macos` client answers `false` and the push goes
 * out. A missed notification is strictly worse than a redundant one.
 *
 * A future two-tier-delay design (hold the push briefly, then send it if the
 * user never acknowledges) extends this module with delay tiers rather than
 * replacing it: the attended/unattended read stays the same input.
 */

import { getLogger } from "../util/logger.js";
import { assistantEventHub } from "./assistant-event-hub.js";

const log = getLogger("desktop-presence");

/** Must exceed the client's report interval with margin, so a single dropped report does not read as absent. */
export const PRESENCE_STALE_AFTER_MS = 3 * 60_000;

/**
 * Whether some macOS client has reported `active` recently enough to trust.
 * Stale, absent, non-macOS, and error reads all answer `false`.
 */
export function isDesktopAttended(now: Date = new Date()): boolean {
  try {
    return assistantEventHub
      .listClientsByInterface("macos")
      .some(
        (client) =>
          client.presence?.state === "active" &&
          now.getTime() - client.presence.reportedAt.getTime() <=
            PRESENCE_STALE_AFTER_MS,
      );
  } catch (err) {
    // Returning false sends the push, which is the safe direction.
    log.warn({ err }, "desktop presence read failed; treating as unattended");
    return false;
  }
}
