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
 *   6. Post `consentMessage` in chat. PR 12 wires this up; for PR 9 we leave
 *      a TODO and return early.
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
   * Consent notice to post once the bot is in the meeting. Plumbed through
   * for PR 12 (chat posting). Not used in PR 9.
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
 * Drive the Meet prejoin surface to completion.
 *
 * Resolves once the in-meeting UI has mounted. Does NOT post the consent
 * message — that is deferred to PR 12 (see the TODO at step 6).
 */
export async function runJoinFlow(opts: RunJoinFlowOptions): Promise<void> {
  const { displayName, onEvent } = opts;
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
  const nameInput = doc.querySelector(selectors.PREJOIN_NAME_INPUT);
  if (nameInput) {
    (nameInput as HTMLInputElement).focus();
    (nameInput as HTMLInputElement).value = displayName;
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Step 4 — click the admission button. Prefer "Join now" because it is the
  // happy-path branch for signed-in / same-domain sessions; fall back to
  // "Ask to join" for locked meetings. We re-query the live DOM rather than
  // relying on `firstVisible` because Meet may have mounted additional
  // buttons between step 2 and here.
  const joinNow = doc.querySelector(selectors.PREJOIN_JOIN_NOW_BUTTON);
  if (joinNow) {
    (joinNow as HTMLElement).click();
  } else {
    const askToJoin = doc.querySelector(selectors.PREJOIN_ASK_TO_JOIN_BUTTON);
    if (!askToJoin) {
      fail(
        onEvent,
        "meet-ext: no join button present after prejoin surface mounted",
      );
    }
    (askToJoin as HTMLElement).click();
  }

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

  // Step 6 — TODO(meet-ext): post consent via sendChat (added in PR 12).
  // For PR 9 we stop here and let the content-script entry emit the
  // `lifecycle { state: "joined" }` event.
  return;
}
