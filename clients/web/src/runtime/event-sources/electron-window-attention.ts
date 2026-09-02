import { publishLifecycleEdge } from "@/runtime/event-sources/lifecycle-edge";
import { isElectron } from "@/runtime/is-electron";
import { subscribeToWindowAttention } from "@/runtime/window-attention";

/**
 * Electron main-window state → `app.resume` / `app.hidden`
 * (`signal: "window_attention"`), plus {@link isWindowAttended} for consumers
 * that need the answer synchronously rather than on an edge.
 *
 * This is the desktop renderer's replacement for
 * `runtime/event-sources/dom-visibility.ts`, which cannot fire there: Vellum
 * windows disable background throttling, and that disables the Page
 * Visibility API with it. Off Electron the runtime wrapper is a no-op and the
 * returned unsubscribe-noop drops through cleanly.
 *
 * The bus edge tracks whether the window is on screen, not whether it holds
 * keyboard focus. `app.hidden` means backgrounded to every consumer that
 * already reads it: the composer's camera gives the hardware back on it, the
 * voice room revokes capture consent, and the SSE service schedules a
 * teardown. A window sitting visible behind another app is still showing the
 * transcript, and a browser in the same position never reports itself hidden
 * either. Focus lives on {@link isWindowAttended} instead, which is where the
 * "is the user watching this" question is asked.
 */

/** Whether the window is on screen and holds focus, `null` until reported. */
let attended: boolean | null = null;

/** Last on-screen state published as an edge, `null` before the first one. */
let lastOnScreen: boolean | null = null;

/**
 * Whether the desktop window is on screen, unminimized, and focused.
 *
 * Off Electron this is `true`: the signal never fires there, the DOM is the
 * authority, and a `false` would veto every consumer that gates on attention.
 * Under Electron a missing answer resolves to `false` instead, because the
 * only ways to get one are a host that predates the channel and a payload the
 * contract cannot read. Both mean the renderer does not know where the window
 * is, and a consumer suppressing a notification on the strength of that would
 * drop it for good.
 */
export function isWindowAttended(): boolean {
  if (attended !== null) {
    return attended;
  }
  return !isElectron();
}

export function publishElectronWindowAttentionSource(): () => void {
  const unsubscribe = subscribeToWindowAttention((payload) => {
    if (!payload) {
      attended = false;
      return;
    }
    attended = payload.visible && payload.focused && !payload.minimized;
    const onScreen = payload.visible && !payload.minimized;
    // The first payload is the current state rather than a transition into
    // it, so it seeds the baseline instead of publishing a boot-time resume.
    if (lastOnScreen !== null && onScreen !== lastOnScreen) {
      publishLifecycleEdge(onScreen ? "resume" : "hidden", "window_attention");
    }
    lastOnScreen = onScreen;
  });
  return () => {
    attended = null;
    lastOnScreen = null;
    unsubscribe();
  };
}
