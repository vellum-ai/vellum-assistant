/**
 * In-meeting camera-toggle feature for the content script.
 *
 * Drives the Google Meet camera on/off toggle in the bottom toolbar. The
 * avatar subsystem calls into this module (via native-messaging
 * `camera.enable` / `camera.disable` commands dispatched from the bot's
 * HTTP `/avatar/enable` / `/avatar/disable` routes) so that enabling the
 * avatar renderer also turns the camera ON (so Meet starts emitting the
 * v4l2loopback-fed video stream to other participants), and disabling the
 * renderer turns the camera OFF.
 *
 * ## State model
 *
 * Meet reports the camera's on/off state exclusively through the
 * `aria-label` swap on the toolbar button: `"Turn off camera"` ⇒ camera
 * is currently ON, `"Turn on camera"` ⇒ camera is currently OFF. There is
 * no `aria-pressed` attribute. See {@link isCameraOn} in `../dom/selectors.ts`
 * for the label parser.
 *
 * ## Click strategy
 *
 * Meet gates the prejoin admission button on `event.isTrusted` — a
 * programmatic `.click()` from a content script is silently ignored. The
 * in-meeting camera toggle was not empirically verified to be gated at the
 * time of this feature landing, BUT two independent signals argue for
 * using the trusted-click path anyway:
 *
 *   1. Every other post-admission surface we've instrumented (chat send,
 *      chat panel toggle) turned out to be gated, so assuming the mic and
 *      camera buttons also are is the safer default.
 *   2. `features/chat.ts` already emits `trusted_click` for the chat send
 *      button (see the `sendChat` implementation). Mirroring the pattern
 *      keeps the feature modules symmetric.
 *
 * We therefore emit a `trusted_click` over native messaging with the
 * button's computed screen coordinates when an `onEvent` sink is wired,
 * and fall back to a JS `.click()` ONLY when `onEvent` is absent (jsdom
 * unit tests that don't stand up the native-messaging bridge). We cannot
 * do both per attempt because the camera toggle is a stateful flip —
 * unlike chat-send or panel-open, each accepted click inverts the state,
 * so if Meet ever relaxes the `isTrusted` gate and both clicks land the
 * toggle inverts twice per attempt and settles in the wrong state.
 *
 * ## Polling confirmation
 *
 * After the click, the feature polls {@link isCameraOn} for up to 5s until
 * the aria-label flips to the expected post-click state. If the state never
 * transitions, the feature throws a descriptive error so the bot can
 * surface it in logs — the `/avatar/enable` HTTP route treats a failed
 * camera toggle as best-effort (the renderer is already running, so a
 * stuck camera toggle is a regression signal but not a reason to tear the
 * renderer back down).
 *
 * ## No-op short-circuit
 *
 * If the toggle is already in the requested state (enable called when the
 * camera is already on, or vice versa), `enableCamera` / `disableCamera`
 * return `{ changed: false }` without clicking. This keeps the daemon's
 * retry path idempotent — repeated enable calls against an already-on
 * camera don't rack up a spurious click per retry that would bounce the
 * state off then back on.
 */

import type { ExtensionToBotMessage } from "../../../contracts/native-messaging.js";
import { controlSelectors, isCameraOn } from "../dom/selectors.js";

/**
 * How long {@link enableCamera} / {@link disableCamera} wait for the
 * aria-label to flip after clicking before giving up. Sized for production
 * latency (the xdotool trusted_click is a fire-and-forget native-messaging
 * emit that queues through the bot → xdotool → X-server → Chromium
 * pipeline, which typically lands in 50–400ms under load) with generous
 * slack for the tail.
 */
const TOGGLE_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * How often to re-check the aria-label while polling for the post-click
 * state transition. Short enough that a fast click lands well under the
 * timeout, long enough to avoid busy-looping a React reconciliation cycle.
 */
const TOGGLE_CONFIRM_POLL_INTERVAL_MS = 50;

/**
 * Result of a {@link enableCamera} / {@link disableCamera} call.
 *
 * `changed: false` means the toggle was already in the requested state;
 * `changed: true` means a click was dispatched and the aria-label
 * transition was confirmed. Both count as success — the distinction is
 * observability. Throwing is the signal that the toggle could not reach
 * the requested state (element missing, polling timed out).
 */
export interface ToggleCameraResult {
  changed: boolean;
}

/** Options for {@link enableCamera} / {@link disableCamera}. */
export interface ToggleCameraOptions {
  /**
   * Sink for extension→bot events. When provided, emits a `trusted_click`
   * with screen-space coordinates for the toggle button so the bot can
   * dispatch a real X-server click via xdotool. Same pattern as
   * `features/chat.ts` and `features/join.ts`.
   */
  onEvent?: (msg: ExtensionToBotMessage) => void;
  /**
   * Window used to compute screen-space coordinates. Defaults to the live
   * `window` / `globalThis` when omitted; tests override with a JSDOM-backed
   * shape so the coord math is deterministic.
   */
  window?: {
    screenX: number;
    screenY: number;
    outerHeight: number;
    innerHeight: number;
  };
  /**
   * Document to operate against. Defaults to the live `document` so the
   * production content script can call `enableCamera()` without passing
   * it through; tests override with a JSDOM-backed document.
   */
  doc?: Document;
  /**
   * Override for the aria-state polling timeout. Defaults to
   * {@link TOGGLE_CONFIRM_TIMEOUT_MS}; tests pass shorter values so the
   * timeout path is exercised without waiting 5s.
   */
  timeoutMs?: number;
  /**
   * Override for the aria-state polling interval. Defaults to
   * {@link TOGGLE_CONFIRM_POLL_INTERVAL_MS}; tests can shorten it to
   * minimize test wall-clock.
   */
  pollIntervalMs?: number;
}

/**
 * Turn the Meet camera ON. Returns `{ changed: false }` if the camera was
 * already on; `{ changed: true }` after a successful click + aria-state
 * confirmation. Throws a descriptive error if the toggle is missing or if
 * the aria-state never transitions within the timeout.
 */
export async function enableCamera(
  opts: ToggleCameraOptions = {},
): Promise<ToggleCameraResult> {
  return toggleCameraTo(true, opts);
}

/**
 * Turn the Meet camera OFF. Symmetric to {@link enableCamera}.
 */
export async function disableCamera(
  opts: ToggleCameraOptions = {},
): Promise<ToggleCameraResult> {
  return toggleCameraTo(false, opts);
}

/**
 * Shared implementation for enable/disable. Keeps the click + confirm
 * logic in one place so the two public entry points can't drift.
 */
async function toggleCameraTo(
  desired: boolean,
  opts: ToggleCameraOptions,
): Promise<ToggleCameraResult> {
  const doc = opts.doc ?? document;
  const timeoutMs = opts.timeoutMs ?? TOGGLE_CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? TOGGLE_CONFIRM_POLL_INTERVAL_MS;

  const current = isCameraOn(doc);
  if (current === null) {
    throw new Error(
      `camera: toggle button not found (selector: ${controlSelectors.CAMERA_TOGGLE})`,
    );
  }
  if (current === desired) {
    return { changed: false };
  }

  const toggle = doc.querySelector<HTMLButtonElement>(
    controlSelectors.CAMERA_TOGGLE,
  );
  if (!toggle) {
    // `isCameraOn` already confirmed a matching element exists, but a
    // concurrent DOM mutation could have removed it between the two
    // queries. Surface that as the same "not found" error for simplicity.
    throw new Error(
      `camera: toggle button not found (selector: ${controlSelectors.CAMERA_TOGGLE})`,
    );
  }

  // Emit trusted_click with computed screen coords when the caller wired
  // up an onEvent sink. Math mirrors `features/chat.ts` and
  // `features/join.ts` — see the long comment in `features/join.ts` for
  // the assumptions about screenX/Y, chrome offsets, and DPI. Production
  // Xvfb pins the window to (0,0) with no bottom chrome, so the
  // `outerHeight - innerHeight` delta is the top chrome offset.
  let trustedClickEmitted = false;
  if (opts.onEvent) {
    try {
      const rect = toggle.getBoundingClientRect();
      const win = opts.window ?? doc.defaultView ?? globalThis;
      const chromeOffsetY = Math.max(
        0,
        (win as typeof globalThis).outerHeight -
          (win as typeof globalThis).innerHeight,
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
      opts.onEvent({ type: "trusted_click", x: screenX, y: screenY });
      trustedClickEmitted = true;
    } catch {
      // If the rect or window shape is bogus, or the sink throws, fall
      // through to the JS click fallback rather than swallowing the whole
      // toggle attempt.
    }
  }

  // Only click as a fallback when trusted_click did not fire. The camera
  // toggle inverts state on every accepted click, so firing both paths
  // would flip twice if Meet's isTrusted gate is ever relaxed. If the
  // trusted_click is dropped (e.g. xdotool crashes mid-emit), we'll time
  // out below with a descriptive error rather than second-guessing the
  // bridge here.
  if (!trustedClickEmitted) {
    try {
      toggle.click();
    } catch {
      // `.click()` can fail if the button is detached mid-flight; fall
      // through to the poll — we'll time out below with a descriptive error.
    }
  }

  // Poll the aria-state for the post-click transition. Shared between
  // the jsdom test harness (which flips the label synchronously from the
  // JS `.click()` fallback) and production (which waits for xdotool's
  // X-server click to land tens of ms later via the `trusted_click` path).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = isCameraOn(doc);
    if (now === desired) {
      return { changed: true };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Final check at the deadline boundary so a transition that lands
  // exactly on the last tick isn't lost to the loop exit condition.
  const final = isCameraOn(doc);
  if (final === desired) {
    return { changed: true };
  }

  throw new Error(
    `camera: aria-state did not transition to ${
      desired ? "on" : "off"
    } within ${timeoutMs}ms (last observed: ${
      final === null ? "unknown" : final ? "on" : "off"
    })`,
  );
}
