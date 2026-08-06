/**
 * Runtime wrapper for the desktop live-voice session surface: the floating
 * window the Electron main process shows for the length of a session
 * (`clients/macos/src/main/voice-activity-window.ts`).
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
 * Two consumers use different halves. The main window drives
 * {@link startVoiceActivity} / {@link updateVoiceActivity} /
 * {@link endVoiceActivity} and listens through
 * {@link subscribeVoiceActivityControl}; the panel's own route reads
 * {@link getVoiceActivityState} / {@link subscribeVoiceActivityState} and
 * sends through {@link sendVoiceActivityControl}.
 */

import {
  isElectron,
  type VoiceActivityContent,
  type VoiceActivityControl,
  type VoiceActivityStart,
  type VoiceActivityState,
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
 * Show the panel for a session that just became active, or update the one
 * already showing.
 *
 * Safe to call when one is running: main updates it rather than opening a
 * second, and deliberately does not restart the elapsed clock. Pair every call
 * with {@link endVoiceActivity}. A panel that outlives its session floats
 * over the desktop showing a phase nothing is driving.
 */
export function startVoiceActivity(state: VoiceActivityStart): void {
  bridge()?.start(state);
}

/**
 * Push new content to the running panel. A no-op when none is running.
 *
 * Unlike ActivityKit there is no update budget here (this is local IPC), but
 * callers still push only on an actual content change, because the two sinks
 * are driven from one comparison in the mirror.
 */
export function updateVoiceActivity(content: VoiceActivityContent): void {
  bridge()?.update(content);
}

/** Dismiss the panel at the end of a session. A no-op when none is running. */
export function endVoiceActivity(): void {
  bridge()?.end();
}

/**
 * Subscribe to panel button presses, returning an unsubscribe.
 *
 * The inbound path, the one that *acts on* the session rather than describing
 * it. Main broadcasts each press to every renderer but the panel, so this
 * fires in whichever window has the session mounted; a press that lands with
 * no listener attached does nothing rather than queueing for the next session.
 */
export function subscribeVoiceActivityControl(
  handler: (control: VoiceActivityControl) => void,
): () => void {
  return bridge()?.onControl(handler) ?? (() => undefined);
}

/**
 * Subscribe to the state the panel should render, returning an unsubscribe.
 * `null` means no session is running. Only the panel's own route consumes
 * this.
 */
export function subscribeVoiceActivityState(
  handler: (state: VoiceActivityState | null) => void,
): () => void {
  return bridge()?.onState(handler) ?? (() => undefined);
}

/**
 * Read the current session snapshot.
 *
 * The panel route loads lazily, so states pushed before its subscription
 * registers are dropped. Pull this once subscribed to catch up.
 */
export async function getVoiceActivityState(): Promise<VoiceActivityState | null> {
  return (await bridge()?.getState()) ?? null;
}

/** Send a panel button press toward the session. Called only by the panel route. */
export function sendVoiceActivityControl(control: VoiceActivityControl): void {
  bridge()?.control(control);
}

/** Bring the app forward, the panel's way back to the conversation. */
export function activateVoiceActivityApp(): void {
  bridge()?.activate?.();
}

/**
 * Hide the window. The session keeps running, and the tray can bring it back.
 */
export function dismissVoiceActivityPanel(): void {
  bridge()?.dismiss?.();
}

/** Shrink the window to its chip, or restore it. */
export function setVoiceActivityCollapsed(collapsed: boolean): void {
  bridge()?.setCollapsed?.(collapsed);
}
