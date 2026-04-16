/**
 * High-level Google Meet join flow.
 *
 * Builds on `createBrowserSession` (PR 6) and the centralized DOM selectors
 * (PR 7) to drive Meet's prejoin surface, click through to the in-meeting UI,
 * and drop a consent notice into chat.
 *
 * Call graph:
 *
 *   1. Dismiss the media-permission modal if Meet rendered one (blocks the
 *      prejoin UI underneath for anonymous joiners).
 *   2. Wait for either the prejoin name input OR a join button — signed-in
 *      flows skip the name input entirely, so treating it as mandatory would
 *      hang the bot for 30s on a page that's otherwise interactable.
 *   3. Fill the name input with `displayName` if it is present.
 *   4. Branch on the admission policy:
 *        - If "Join now" is present, click it (signed-in / same-domain flow).
 *        - Else click "Ask to join" (locked meeting — host admits the bot).
 *   5. Wait for the in-meeting UI (the red "Leave call" button is the
 *      canonical marker — it only mounts once the bot is actually in the
 *      meeting room).
 *   6. Post `consentMessage` in chat so human participants are informed that
 *      an AI assistant is listening.
 *
 * Error strategy: every step throws a descriptive `Error` when a selector
 * times out; `main.ts` converts thrown errors into `process.exit(1)` so the
 * container orchestrator notices the failure.
 */

import { writeFile } from "node:fs/promises";

import type { Page } from "playwright";

import { postConsentMessage } from "./chat-bridge.js";
import { selectors } from "./dom-selectors.js";

/** How long to wait for the prejoin surface to mount. */
const PREJOIN_TIMEOUT_MS = 30_000;

/**
 * How long to wait for Meet's media-permission modal. Short by design — if
 * Meet didn't render the modal (signed-in flows, older UI variants) we want
 * to fall through to the prejoin wait quickly rather than spending the full
 * prejoin budget on a dialog that will never appear.
 */
const MEDIA_PROMPT_TIMEOUT_MS = 5_000;

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
 * Directory the bot can write diagnostic artifacts to. Matches the
 * session-manager's `/out` mount, which is bound back to the host at
 * `<workspace>/meets/<meetingId>/out/` — so anything we drop here is
 * visible to the operator even after the container is torn down.
 */
const DIAGNOSTICS_DIR = "/out";

/**
 * Best-effort: snapshot the current page to `/out/<name>.png` so an
 * operator can see exactly what Google Meet was showing when a selector
 * timed out. Never re-throws — diagnostics must not mask the real join
 * failure that triggered the capture. Logs capture failures to stderr so
 * the operator can tell "capture was attempted and failed" apart from
 * "capture was never attempted".
 */
async function captureFailureSnapshot(
  page: Page,
  name: string,
): Promise<string | null> {
  const snapPath = `${DIAGNOSTICS_DIR}/${name}.png`;
  try {
    await page.screenshot({ path: snapPath, fullPage: true });
    return snapPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `meet-bot: screenshot capture failed for ${name}: ${msg}\n`,
    );
    return null;
  }
}

/**
 * Best-effort: dump the current page's HTML to `/out/<name>.html`. Useful
 * when the screenshot path fails (page crashed, missing display) or when
 * Meet served an entirely different surface (sign-in wall, unsupported-
 * browser interstitial) and we want to inspect what selectors WOULD have
 * matched.
 */
async function captureFailureHtml(
  page: Page,
  name: string,
): Promise<string | null> {
  const htmlPath = `${DIAGNOSTICS_DIR}/${name}.html`;
  try {
    const html = await page.content();
    await writeFile(htmlPath, html, "utf8");
    return htmlPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`meet-bot: html capture failed for ${name}: ${msg}\n`);
    return null;
  }
}

/**
 * Best-effort: capture the current page URL so a 301/redirect to a
 * sign-in wall (or a completely different Meet surface) is obvious from
 * the error message. Returns `null` silently if the page has already
 * been closed.
 */
async function safePageUrl(page: Page): Promise<string | null> {
  try {
    return page.url();
  } catch {
    return null;
  }
}

/**
 * Best-effort: capture the current page title. A title like "Meet — <code>"
 * means the prejoin DOM loaded but our selectors are wrong; a title like
 * "Sign in — Google Accounts" or "Unsupported browser" tells us Meet served
 * something else entirely.
 */
async function safePageTitle(page: Page): Promise<string | null> {
  try {
    return await page.title();
  } catch {
    return null;
  }
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

  // Step 1 — dismiss the media-permission modal if Meet rendered one. The
  // modal blocks the underlying prejoin UI from being interacted with (even
  // from visible selectors), so the bot must click through it before doing
  // anything else. Best-effort — a missing modal is the signed-in happy path
  // and must not fail the join.
  try {
    await page.waitForSelector(selectors.PREJOIN_MEDIA_PROMPT_ACCEPT_BUTTON, {
      timeout: MEDIA_PROMPT_TIMEOUT_MS,
    });
    await page.click(selectors.PREJOIN_MEDIA_PROMPT_ACCEPT_BUTTON);
  } catch {
    // No modal — proceed directly to the prejoin surface.
  }

  // Step 2 — wait for the prejoin surface to be ready. Meet shows the
  // "Your name" input only for anonymous joiners; signed-in flows skip
  // straight to the join buttons. `Promise.any` resolves as soon as any one
  // of the three selectors becomes visible, and only rejects if all three
  // time out — which is the signal that Meet served something other than a
  // prejoin (login redirect, error screen, etc.).
  try {
    await Promise.any([
      page.waitForSelector(selectors.PREJOIN_NAME_INPUT, {
        timeout: PREJOIN_TIMEOUT_MS,
      }),
      page.waitForSelector(selectors.PREJOIN_JOIN_NOW_BUTTON, {
        timeout: PREJOIN_TIMEOUT_MS,
      }),
      page.waitForSelector(selectors.PREJOIN_ASK_TO_JOIN_BUTTON, {
        timeout: PREJOIN_TIMEOUT_MS,
      }),
    ]);
  } catch {
    const url = await safePageUrl(page);
    const title = await safePageTitle(page);
    const snap = await captureFailureSnapshot(page, "prejoin-failure");
    const html = await captureFailureHtml(page, "prejoin-failure");
    throw new Error(
      `meet-bot: prejoin surface did not appear within ${PREJOIN_TIMEOUT_MS}ms` +
        (url ? ` (final URL: ${url})` : "") +
        (title ? ` (page title: ${JSON.stringify(title)})` : "") +
        (snap ? ` (screenshot: ${snap})` : "") +
        (html ? ` (html: ${html})` : ""),
    );
  }

  // Step 3 — populate the display name if the input is present. Signed-in
  // flows (and some Meet UI variants) don't render it, in which case the
  // account's name is used instead.
  const nameInputCount = await page
    .locator(selectors.PREJOIN_NAME_INPUT)
    .count();
  if (nameInputCount > 0) {
    await page.fill(selectors.PREJOIN_NAME_INPUT, displayName);
  }

  // Step 4 — choose the admission button. Prefer "Join now" because it is the
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

  // Step 5 — wait for the in-meeting UI. The "Leave call" button only mounts
  // once the bot is inside the meeting room, so it is our canonical signal
  // that the admission flow succeeded.
  try {
    await page.waitForSelector(selectors.INGAME_LEAVE_BUTTON, {
      timeout: MEETING_ROOM_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const url = await safePageUrl(page);
    const snap = await captureFailureSnapshot(page, "admission-failure");
    throw new Error(
      `meet-bot: in-meeting UI did not appear within ${MEETING_ROOM_TIMEOUT_MS}ms (host may not have admitted the bot): ${msg}` +
        (url ? ` (final URL: ${url})` : "") +
        (snap ? ` (screenshot: ${snap})` : ""),
    );
  }

  // Step 6 — drop the consent notice. `postConsentMessage` handles opening
  // the chat panel if it is still collapsed.
  await postConsentMessage(page, consentMessage);
}
