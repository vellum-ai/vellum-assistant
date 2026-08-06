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
 */

import { getLogger } from "../util/logger.js";
import { assistantEventHub } from "./assistant-event-hub.js";

const log = getLogger("desktop-presence");

/**
 * Bounds how long suppression can outlive the Mac going to sleep or dropping
 * off, while still tolerating two dropped reports at the 30s report interval.
 */
export const PRESENCE_STALE_AFTER_MS = 90_000;

export interface DesktopAttendanceOptions {
  /**
   * Only count macOS clients whose verified actor principal matches this id.
   * A client that connected without a principal (legacy or service token)
   * never matches a supplied id.
   */
  actorPrincipalId?: string;
  /** Clock used for the staleness comparison. */
  now?: Date;
}

/**
 * Whether some macOS client has reported `active` recently enough to trust.
 * Stale, absent, non-macOS, and error reads all answer `false`.
 *
 * Callers whose notification targets one recipient (guardian-scoped or
 * otherwise per-recipient pushes) must pass that recipient's
 * `actorPrincipalId`, or another user's attended Mac suppresses the push.
 * Omitting it treats any attended macOS client as attendance, which only
 * suits notifications with no single recipient.
 */
export function isDesktopAttended(
  options: DesktopAttendanceOptions = {},
): boolean {
  const { actorPrincipalId, now = new Date() } = options;
  try {
    return assistantEventHub.listClientsByInterface("macos").some((client) => {
      if (
        actorPrincipalId !== undefined &&
        client.actorPrincipalId !== actorPrincipalId
      ) {
        return false;
      }
      return (
        client.presence?.state === "active" &&
        now.getTime() - client.presence.reportedAt.getTime() <=
          PRESENCE_STALE_AFTER_MS
      );
    });
  } catch (err) {
    // Returning false sends the push, which is the safe direction.
    log.warn({ err }, "desktop presence read failed; treating as unattended");
    return false;
  }
}
