/**
 * Content-script port of the Google Meet join flow.
 *
 * Ports `skills/meet-join/bot/src/browser/join-flow.ts` (which drives Meet
 * via Playwright from outside the browser) to run inside a Manifest V3
 * content script attached to `https://meet.google.com/*`. The selector
 * catalog, timeouts, and branch structure are intentionally kept in sync
 * with the bot-side implementation so the two are trivially cross-referenced
 * when Meet's DOM drifts.
 *
 * Call graph:
 *
 *   1. Dismiss the media-permission modal if Meet rendered one. The modal
 *      blocks the underlying prejoin UI for anonymous joiners; a missing
 *      modal is the signed-in happy path and is not an error.
 *   2. Wait for either the prejoin name input OR a join button — signed-in
 *      flows skip the name input entirely, so treating it as mandatory would
 *      hang the extension for 30s on a page that's otherwise interactable.
 *   3. Populate the display name if the input is present.
 *   4. Click Join now (preferred — signed-in / same-domain flow) or fall back
 *      to Ask to join (locked meeting, host admits).
 *   5. Wait for the in-meeting UI. The red "Leave call" button is the
 *      canonical marker — it only mounts once the bot is in the meeting.
 *   6. Post `consentMessage` in chat via {@link postConsentMessage}. Best
 *      effort — if the chat composer can't be located we surface a
 *      diagnostic error but do NOT fail the join, since the bot is already
 *      in the meeting at this point and tearing it down would be strictly
 *      worse than a missing consent notice.
 *
 * Error strategy: every step throws a descriptive `Error` on timeout. Before
 * re-throwing, we emit an `ExtensionDiagnosticMessage` via `opts.onEvent` so
 * the bot-side stderr captures the failure reason. We intentionally do NOT
 * capture screenshots — `page.screenshot` has no content-script analogue,
 * and diagnostics already surface through the native port's stderr.
 */
import type { ExtensionToBotMessage } from "../../../contracts/native-messaging.js";
import { selectors } from "../dom/selectors.js";
import { waitForAny, waitForSelector } from "../dom/wait.js";
import { postConsentMessage } from "./chat.js";

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

/** Options accepted by {@link runJoinFlow}. */
export interface RunJoinFlowOptions {
  /** Full Meet join URL. Currently used only for diagnostic context. */
  meetingUrl: string;
  /** Display name Meet will render next to the bot's tile. */
  displayName: string;
  /**
   * Consent notice to post once the bot is in the meeting. Dropped into the
   * chat panel via {@link postConsentMessage} as step 6 of the flow.
   */
  consentMessage: string;
  /** Opaque identifier for the meeting the extension is in. */
  meetingId: string;
  /**
   * Sink for extension→bot events emitted during the join flow. Currently we
   * only emit `diagnostic` messages on failure; lifecycle transitions are
   * emitted by the content-script entry point (`content.ts`).
   */
  onEvent: (msg: ExtensionToBotMessage) => void;
  /**
   * Document to operate against. Defaults to the live `document` so the
   * production content script can call `runJoinFlow(opts)` without passing
   * it through; tests override with a JSDOM-backed document.
   */
  doc?: Document;
  /**
   * Window used to compute screen-space coordinates for `trusted_click`.
   * Production uses the live `window`; tests override with a JSDOM window
   * (which has `screenX=0`, `screenY=0`, and `outerHeight === innerHeight`
   * so the click coords resolve to plain client coords).
   */
  window?: {
    screenX: number;
    screenY: number;
    outerHeight: number;
    innerHeight: number;
  };
}

/**
 * Emit a diagnostic `error` message to the bot, then throw `new Error(message)`.
 *
 * Surfaces descriptive failures in the bot's stderr-equivalent log stream
 * without silently swallowing them; the thrown error propagates to the
 * content-script entry point which emits a `lifecycle { state: "error" }`
 * event for the daemon.
 */
function fail(
  onEvent: (msg: ExtensionToBotMessage) => void,
  message: string,
): never {
  onEvent({
    type: "diagnostic",
    level: "error",
    message,
  });
  throw new Error(message);
}

/**
 * Drive the Meet prejoin surface to completion and post the consent notice.
 *
 * Resolves once the in-meeting UI has mounted and the consent-message post
 * attempt has completed (success or caught failure).
 */
export async function runJoinFlow(opts: RunJoinFlowOptions): Promise<void> {
  const { consentMessage, displayName, onEvent } = opts;
  const doc = opts.doc ?? document;

  // Step 1 — dismiss the media-permission modal if Meet rendered one. Best
  // effort; a missing modal is the signed-in happy path.
  try {
    const modal = await waitForSelector(
      selectors.PREJOIN_MEDIA_PROMPT_ACCEPT_BUTTON,
      MEDIA_PROMPT_TIMEOUT_MS,
      doc,
    );
    (modal as HTMLElement).click();
  } catch {
    // No modal — proceed directly to the prejoin surface.
  }

  // Step 2 — race the prejoin surface selectors. Signed-in flows skip the
  // name input entirely, so waiting for the input alone would hang the
  // extension for the full prejoin budget on an otherwise interactable page.
  let firstVisible: { selector: string; element: Element };
  try {
    firstVisible = await waitForAny(
      [
        selectors.PREJOIN_NAME_INPUT,
        selectors.PREJOIN_JOIN_NOW_BUTTON,
        selectors.PREJOIN_ASK_TO_JOIN_BUTTON,
      ],
      PREJOIN_TIMEOUT_MS,
      doc,
    );
  } catch {
    fail(
      onEvent,
      `meet-ext: prejoin surface did not appear within ${PREJOIN_TIMEOUT_MS}ms (url: ${opts.meetingUrl})`,
    );
  }
  // Silence an unused-variable warning in strict mode — we only look up
  // `firstVisible` to observe that the race resolved, then branch on live DOM.
  void firstVisible;

  // Step 3 — populate the name input if present. Meet doesn't render it for
  // signed-in users, in which case the account's name is used instead.
  //
  // Meet's UI is React-based; React tracks input values via the native
  // HTMLInputElement setter and ignores assignments that bypass it. Using
  // the native setter followed by a bubbling `input` event is the canonical
  // pattern for programmatically setting a controlled input in React —
  // without it, Meet's internal state never registers the name change and
  // the join button remains gated as if the field were still empty.
  const nameInput = doc.querySelector(selectors.PREJOIN_NAME_INPUT);
  if (nameInput) {
    const input = nameInput as HTMLInputElement;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter) {
      setter.call(input, displayName);
    } else {
      input.value = displayName;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Step 4 — wait for the admission button, then click it. Prefer "Join now"
  // because it is the happy-path branch for signed-in / same-domain sessions;
  // fall back to "Ask to join" for locked meetings. Meet re-renders the
  // join button after we populate the name input, so a synchronous query
  // here races against that render. Poll with a short budget — the button
  // is visible in the DOM within a few hundred ms of the input event.
  let admissionBtn: Element | null = null;
  const joinDeadline = Date.now() + 10_000;
  while (Date.now() < joinDeadline) {
    admissionBtn =
      doc.querySelector(selectors.PREJOIN_JOIN_NOW_BUTTON) ??
      doc.querySelector(selectors.PREJOIN_ASK_TO_JOIN_BUTTON);
    if (admissionBtn) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!admissionBtn) {
    // Dump every button's aria-label / text so fixture refreshes can catch
    // selector drift quickly — Meet's DOM changes without notice.
    const buttons = Array.from(doc.querySelectorAll("button")).slice(0, 30);
    const inventory = buttons.map((b) => {
      const label = b.getAttribute("aria-label") ?? "";
      const text = (b.textContent ?? "").trim().slice(0, 40);
      const disabled = (b as HTMLButtonElement).disabled;
      return `[aria="${label}" text="${text}" disabled=${disabled}]`;
    });
    fail(
      onEvent,
      `meet-ext: no join button matched selectors after 10s. buttons: ${inventory.join(" ")}`,
    );
  }
  const btnLabel = admissionBtn.getAttribute("aria-label") ?? "";
  // Meet gates the prejoin admission button on `event.isTrusted`, so a
  // programmatic `.click()` from a content script is silently ignored by
  // the real Meet UI. Admission requires a REAL X-server mouse click,
  // which the bot dispatches via xdotool when it receives this
  // `trusted_click` message. We compute screen coordinates locally here
  // because the bot has no DOM access; the math is:
  //
  //   screenX = window.screenX + clientX
  //   screenY = window.screenY + (outerHeight - innerHeight) + clientY
  //
  // `outerHeight - innerHeight` is the browser-chrome vertical offset
  // (address bar + tab strip + any info-bar) that sits above the viewport.
  // We still dispatch the JS `.click()` afterwards because (a) it's free,
  // (b) the jsdom test harness exercises that path, and (c) any Meet build
  // that ever relaxes the `isTrusted` check would start working again
  // automatically.
  const rect = (admissionBtn as HTMLElement).getBoundingClientRect();
  const win = opts.window ?? (doc.defaultView ?? globalThis);
  const chromeOffsetY = Math.max(
    0,
    (win as typeof globalThis).outerHeight - (win as typeof globalThis).innerHeight,
  );
  const screenX = Math.round(
    ((win as typeof globalThis).screenX ?? 0) + rect.left + rect.width / 2,
  );
  const screenY = Math.round(
    ((win as typeof globalThis).screenY ?? 0) +
      chromeOffsetY +
      rect.top +
      rect.height / 2,
  );
  onEvent({ type: "trusted_click", x: screenX, y: screenY });
  (admissionBtn as HTMLElement).click();
  onEvent({
    type: "diagnostic",
    level: "info",
    message: `meet-ext: clicked admission button aria-label="${btnLabel}" screen=(${screenX},${screenY})`,
  });

  // Step 5 — wait for the in-meeting UI. The "Leave call" button only mounts
  // once the bot is in the meeting, so it is our canonical admission signal.
  try {
    await waitForSelector(
      selectors.INGAME_LEAVE_BUTTON,
      MEETING_ROOM_TIMEOUT_MS,
      doc,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      onEvent,
      `meet-ext: in-meeting UI did not appear within ${MEETING_ROOM_TIMEOUT_MS}ms (host may not have admitted the bot): ${msg}`,
    );
  }

  // Step 6 — post the consent notice in chat. Best effort: the bot is
  // already admitted at this point, so a chat-post failure should surface as
  // a diagnostic but must not fail the join itself (tearing the bot back out
  // of the meeting is strictly worse than a missing consent message). The
  // most likely failure mode is Meet's chat DOM drifting out from under our
  // selectors.
  try {
    await postConsentMessage(consentMessage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onEvent({
      type: "diagnostic",
      level: "error",
      message: `consent post failed: ${msg}`,
    });
  }
}
