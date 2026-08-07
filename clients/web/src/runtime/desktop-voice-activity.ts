/**
 * Runtime wrapper for the desktop's live-voice session surface: the companion
 * surface the Electron main process keeps on screen
 * (`clients/macos/src/main/companion-window.ts`), which holds its expanded call
 * state for as long as a session runs.
 *
 * The desktop counterpart to `native-live-activity.ts`. That module speaks to
 * a Capacitor plugin and an ActivityKit activity; this one speaks to an
 * Electron BrowserWindow. They are two transports for one payload, which is
 * why {@link useLiveActivityMirror} can drive both from a single computed
 * snapshot and why the payload types live in `@vellumai/ipc-contract` rather
 * than being restated here.
 *
 * **Skew contract, same as its mobile sibling.** Every call no-ops off
 * Electron and on a shell that predates the channel, and nothing here throws.
 * The surface is optional and must never block or end a voice session.
 *
 * Two consumers use different halves. The window holding the session drives
 * {@link startVoiceActivity} / {@link updateVoiceActivity} /
 * {@link endVoiceActivity} and listens through
 * {@link subscribeVoiceActivityControl}; the surface's own route reads the
 * session off `runtime/companion-surface` and presses through
 * {@link sendVoiceActivityControl}.
 */

import {
  isElectron,
  type VoiceActivityContent,
  type VoiceActivityControl,
  type VoiceActivityStart,
} from "@/runtime/is-electron";

type VoiceActivityBridge = NonNullable<
  NonNullable<Window["vellum"]>["voiceActivity"]
>;

const bridge = (): VoiceActivityBridge | undefined => {
  if (!isElectron()) {
    return undefined;
  }
  return window.vellum?.voiceActivity;
};

/**
 * Put a session that just became active on the surface, or update the one
 * already showing.
 *
 * Safe to call when one is running: main updates it rather than replacing it,
 * and deliberately does not restart the elapsed clock. Pair every call with
 * {@link endVoiceActivity}. A call state that outlives its session leaves the
 * surface expanded over the desktop showing a phase nothing is driving.
 */
export function startVoiceActivity(state: VoiceActivityStart): void {
  bridge()?.start(state);
}

/**
 * Push new content to the running call. A no-op when none is running.
 *
 * Unlike ActivityKit there is no update budget here (this is local IPC), but
 * callers still push only on an actual content change, because the two sinks
 * are driven from one comparison in the mirror.
 */
export function updateVoiceActivity(content: VoiceActivityContent): void {
  bridge()?.update(content);
}

/** Return the surface to its resting state. A no-op when none is running. */
export function endVoiceActivity(): void {
  bridge()?.end();
}

/**
 * Subscribe to presses on the surface, returning an unsubscribe.
 *
 * The inbound path, the one that *acts on* the session rather than describing
 * it. Main broadcasts each press to every renderer but the surface, so this
 * fires in whichever window has the session mounted; a press that lands with
 * no listener attached does nothing rather than queueing for the next session.
 */
export function subscribeVoiceActivityControl(
  handler: (control: VoiceActivityControl) => void,
): () => void {
  return bridge()?.onControl(handler) ?? (() => undefined);
}

/**
 * Send a press on the surface toward the session. Called only by the companion
 * surface's own route, which reads the session it is drawing off
 * `runtime/companion-surface`.
 */
export function sendVoiceActivityControl(control: VoiceActivityControl): void {
  bridge()?.control(control);
}
