import { publish } from "@/lib/event-bus";
import { publishLifecycleEdge } from "@/runtime/event-sources/lifecycle-edge";
import {
  isAttendedPayload,
  subscribeToWindowAttention,
} from "@/runtime/window-attention";

/**
 * Electron window state to `app.resume` / `app.hidden`
 * (`signal: "window_attention"`) for on-screen changes, and `app.attention`
 * for the narrower question of whether the user is watching.
 *
 * This is the desktop renderer's replacement for
 * `runtime/event-sources/dom-visibility.ts`, which cannot fire there: Vellum
 * windows disable background throttling, and that disables the Page
 * Visibility API with it. Off Electron the runtime wrapper is a no-op and the
 * returned unsubscribe-noop drops through cleanly.
 *
 * Main reports the window this renderer belongs to, so a conversation pop-out
 * follows its own window. One left on screen keeps its stream, and keeps
 * reporting itself watched, while the main window sits minimized behind it.
 *
 * The lifecycle edge tracks whether the window is on screen, not whether it
 * holds keyboard focus. Minimizing or hiding is what backgrounds this
 * renderer, and the consumers that read it act on hardware and consent: the
 * composer's camera gives the stream back, the voice room revokes Live
 * capture consent, and the shutter abandons an armed press. A window sitting
 * visible behind another app is still showing the transcript, and a browser
 * in the same position never reports itself hidden either, so focus rides
 * `app.attention` and `isWindowAttended()` in `runtime/window-attention.ts`
 * instead.
 *
 * `assistant/sse-service.ts` is the one consumer that reads the label:
 * it keeps the stream through a `"window_attention"` hide, because the
 * desktop has no push fallback and `VellumAdapter.send` is a fire-and-forget
 * broadcast with no queue or redelivery, so a torn-down stream is a
 * notification lost outright rather than one delivered late.
 */

/** Last attention state published, `null` before the first payload. */
let lastAttended: boolean | null = null;

/** Last on-screen state published as an edge, `null` before the first one. */
let lastOnScreen: boolean | null = null;

export function publishElectronWindowAttentionSource(): () => void {
  const unsubscribe = subscribeToWindowAttention((payload) => {
    const nextAttended = isAttendedPayload(payload);
    if (lastAttended === null || nextAttended !== lastAttended) {
      lastAttended = nextAttended;
      // The first payload publishes as well. Consumers mount before this
      // source starts, so a focused window whose consumers read attention
      // before any payload arrives has already reported itself unwatched, and
      // nothing else corrects that until the next real edge.
      publish("app.attention", { attended: nextAttended });
    }
    if (!payload) {
      return;
    }
    const onScreen = payload.visible && !payload.minimized;
    // The first payload is the current state rather than a transition into
    // it, so it seeds the baseline instead of publishing a boot-time edge.
    if (lastOnScreen !== null && onScreen !== lastOnScreen) {
      publishLifecycleEdge(onScreen ? "resume" : "hidden", "window_attention");
    }
    lastOnScreen = onScreen;
  });
  return () => {
    lastAttended = null;
    lastOnScreen = null;
    unsubscribe();
  };
}
