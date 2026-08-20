/**
 * Web presence policy.
 *
 * Answers exactly one question for notification producers: is the user
 * demonstrably looking at this specific conversation in a web browser tab
 * right now? Producers use the answer to skip an APNs push the user would
 * see on screen anyway.
 *
 * Fails open by design, the same posture as desktop presence
 * (`runtime/desktop-presence.ts`): presence is in-memory, best-effort, and
 * reported by a client that can drop off (crash, network loss, backgrounded
 * tab killed by the OS) without telling the daemon, so anything short of a
 * fresh, visible, matching-conversation report answers `false` and the push
 * goes out. A missed notification is strictly worse than a redundant one.
 *
 * Deliberately separate from desktop presence: a web report is scoped to one
 * conversation (the tab's focused thread), not the whole app. The Electron
 * desktop renderer detects its own host OS and tags its turns
 * `macos`/`windows` (`detectClientOs()` in the web client), so an Electron
 * turn is already covered by `isDesktopAttended()` and never reaches this
 * gate. Do not fold this into `setClientPresence` / the `macos`-scoped
 * desktop-attendance path.
 */

import { getLogger } from "../util/logger.js";
import { assistantEventHub } from "./assistant-event-hub.js";

const log = getLogger("web-presence");

/**
 * Shared semantic + transport freshness bound. The semantic report says what
 * the tab was showing; `lastActiveAt` says the owning SSE connection is still
 * alive. Both must be fresh so a live-but-hidden stream cannot preserve an old
 * visible report, and a fresh report cannot suppress after its transport dies.
 */
export const WEB_PRESENCE_STALE_AFTER_MS = 180_000;

export interface WebPresenceOptions {
  /**
   * Only count web clients whose verified actor principal matches this id.
   * A client that connected without a principal (legacy or service token)
   * never matches a supplied id.
   */
  actorPrincipalId?: string;
  /** Clock used for the staleness comparison. */
  now?: Date;
}

/**
 * Whether some web client has reported, recently enough to trust, that the
 * given conversation is visible and focused. Stale, absent, hidden,
 * unfocused, non-web, and error reads all answer `false`.
 *
 * Callers whose notification targets one recipient must pass that
 * recipient's `actorPrincipalId`, or another user's focused tab suppresses
 * the push. Omitting it treats any matching web client as focus, which only
 * suits notifications with no single recipient.
 */
export function isWebConversationFocused(
  conversationId: string,
  options: WebPresenceOptions = {},
): boolean {
  const { actorPrincipalId, now = new Date() } = options;
  try {
    return assistantEventHub.listClientsByInterface("web").some((client) => {
      if (
        actorPrincipalId !== undefined &&
        client.actorPrincipalId !== actorPrincipalId
      ) {
        return false;
      }
      const report = client.webPresence;
      if (!report) {
        return false;
      }
      const nowMs = now.getTime();
      if (
        nowMs - report.reportedAt.getTime() > WEB_PRESENCE_STALE_AFTER_MS ||
        nowMs - client.lastActiveAt.getTime() > WEB_PRESENCE_STALE_AFTER_MS
      ) {
        return false;
      }
      return report.visible && report.focusedConversationId === conversationId;
    });
  } catch (err) {
    // Returning false sends the push, which is the safe direction.
    log.warn({ err }, "web presence read failed; treating as unfocused");
    return false;
  }
}
