/**
 * Chat-panel bridge helpers.
 *
 * Wraps Playwright operations for the Google Meet chat side panel so the rest
 * of the bot can send messages without having to know anything about the DOM
 * or which panels need toggling.
 *
 * Two entry points are exposed:
 *
 *   - `postConsentMessage(page, consentMessage)` — opens the chat panel (if it
 *     is collapsed) and then sends `consentMessage`. Invoked once by the join
 *     flow in `join-flow.ts` immediately after the bot lands in the meeting.
 *   - `sendChat(page, text)` — the core "type and send" routine. Assumes the
 *     chat panel is already open (or will open implicitly when the input is
 *     found). Phase 2's `/send_chat` HTTP endpoint will reuse this directly.
 *
 * `postConsentMessage` is implemented as a thin wrapper around `sendChat` plus
 * an "ensure the panel is open" preamble; the typing routine itself is shared
 * via `sendChat` so future callers don't end up duplicating the send logic.
 */

import type { Page } from "playwright";

import { selectors } from "./dom-selectors.js";

/**
 * How long to wait for chat-panel UI elements (button, input) to appear. The
 * panel opens synchronously but Meet can be slow to mount React trees on
 * lower-end hardware; 10s is a conservative cap that still surfaces genuine
 * DOM drift quickly.
 */
const CHAT_PANEL_TIMEOUT_MS = 10_000;

/**
 * Opens the chat side panel if it is not already open, then sends
 * `consentMessage` via `sendChat`. Safe to call exactly once per session from
 * the join flow; callers that want to send additional messages should call
 * `sendChat` directly afterwards so we do not click the panel button (which
 * would collapse the panel) on every send.
 */
export async function postConsentMessage(
  page: Page,
  consentMessage: string,
): Promise<void> {
  // Try to surface the panel first. If the composer is already visible (the
  // panel was opened earlier in the session), the click is unnecessary — and
  // clicking a second time would toggle the panel closed. To avoid that, we
  // check for the input first and only click the toggle if it is missing.
  const inputVisible = await page.locator(selectors.INGAME_CHAT_INPUT).count();
  if (inputVisible === 0) {
    await page.waitForSelector(selectors.INGAME_CHAT_PANEL_BUTTON, {
      timeout: CHAT_PANEL_TIMEOUT_MS,
    });
    await page.click(selectors.INGAME_CHAT_PANEL_BUTTON);
  }

  await sendChat(page, consentMessage);
}

/**
 * Types `text` into the chat composer and submits it.
 *
 * Assumes the chat panel is already open — the function waits for the input
 * itself (not the panel toggle), so it is safe to call from the HTTP
 * `/send_chat` endpoint where the panel may have been opened by an earlier
 * request. If the input never appears, `waitForSelector` throws.
 */
export async function sendChat(page: Page, text: string): Promise<void> {
  await page.waitForSelector(selectors.INGAME_CHAT_INPUT, {
    timeout: CHAT_PANEL_TIMEOUT_MS,
  });
  await page.fill(selectors.INGAME_CHAT_INPUT, text);
  // Press Enter on the input to submit. Meet's composer sends on Enter and
  // inserts a newline on Shift+Enter, so a plain Enter is the send shortcut.
  // We fall back to clicking the send button if pressing Enter fails (e.g. in
  // locales where Meet has rebound the keyboard shortcut) — this keeps the
  // happy path ergonomic without silently dropping messages.
  try {
    await page.press(selectors.INGAME_CHAT_INPUT, "Enter");
  } catch {
    await page.click(selectors.INGAME_CHAT_SEND_BUTTON);
  }
}
