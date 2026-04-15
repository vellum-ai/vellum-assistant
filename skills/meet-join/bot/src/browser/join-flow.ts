/**
 * High-level Google Meet join flow.
 *
 * Builds on `createBrowserSession` (PR 6) and the centralized DOM selectors
 * (PR 7) to drive Meet's prejoin surface, click through to the in-meeting UI,
 * and drop a consent notice into chat.
 *
 * Call graph:
 *
 *   1. Wait for the prejoin name input.
 *   2. Fill the name input with `displayName`.
 *   3. Branch on the admission policy:
 *        - If "Join now" is present, click it (signed-in / same-domain flow).
 *        - Else click "Ask to join" (locked meeting — host admits the bot).
 *   4. Wait for the in-meeting UI (the red "Leave call" button is the
 *      canonical marker — it only mounts once the bot is actually in the
 *      meeting room).
 *   5. Post `consentMessage` in chat so human participants are informed that
 *      an AI assistant is listening.
 *
 * Error strategy: every step throws a descriptive `Error` when a selector
 * times out; `main.ts` converts thrown errors into `process.exit(1)` so the
 * container orchestrator notices the failure.
 */

import type { Page } from "playwright";

import { postConsentMessage } from "./chat-bridge.js";
import { selectors } from "./dom-selectors.js";

/** How long to wait for the prejoin name input to mount. */
const PREJOIN_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the meeting-room UI after clicking the join button.
 * The "Ask to join" flow can block on the host manually admitting the bot,
 * so the cap is intentionally generous.
 */
const MEETING_ROOM_TIMEOUT_MS = 90_000;

export interface JoinMeetOptions {
  /** Display name Meet will render next to the bot's tile. */
  displayName: string;
  /**
   * Consent notice to post once the bot is in the meeting. Typically surfaced
   * by the assistant to remind human participants that an AI is listening.
   */
  consentMessage: string;
}

/**
 * Drive the Google Meet prejoin surface to completion and deliver the consent
 * notice.
 *
 * Resolves once the consent message has been posted. Rejects with a
 * descriptive `Error` if any step (prejoin input, join button, meeting-room
 * transition, chat delivery) fails.
 */
export async function joinMeet(
  page: Page,
  opts: JoinMeetOptions,
): Promise<void> {
  const { displayName, consentMessage } = opts;

  // Step 1 — wait for the prejoin name input so we know the page has reached
  // the "Ready to join?" stage (rather than, say, a Google login redirect).
  try {
    await page.waitForSelector(selectors.PREJOIN_NAME_INPUT, {
      timeout: PREJOIN_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `meet-bot: prejoin name input did not appear within ${PREJOIN_TIMEOUT_MS}ms: ${msg}`,
    );
  }

  // Step 2 — populate the display name.
  await page.fill(selectors.PREJOIN_NAME_INPUT, displayName);

  // Step 3 — choose the admission button. Prefer "Join now" because it is the
  // happy-path branch for signed-in / same-domain sessions; fall back to
  // "Ask to join" for locked meetings.
  const joinNowCount = await page
    .locator(selectors.PREJOIN_JOIN_NOW_BUTTON)
    .count();
  if (joinNowCount > 0) {
    await page.click(selectors.PREJOIN_JOIN_NOW_BUTTON);
  } else {
    await page.click(selectors.PREJOIN_ASK_TO_JOIN_BUTTON);
  }

  // Step 4 — wait for the in-meeting UI. The "Leave call" button only mounts
  // once the bot is inside the meeting room, so it is our canonical signal
  // that the admission flow succeeded.
  try {
    await page.waitForSelector(selectors.INGAME_LEAVE_BUTTON, {
      timeout: MEETING_ROOM_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `meet-bot: in-meeting UI did not appear within ${MEETING_ROOM_TIMEOUT_MS}ms (host may not have admitted the bot): ${msg}`,
    );
  }

  // Step 5 — drop the consent notice. `postConsentMessage` handles opening
  // the chat panel if it is still collapsed.
  await postConsentMessage(page, consentMessage);
}
