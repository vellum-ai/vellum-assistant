import { publish } from "@/lib/event-bus";
import {
  isAttendedPayload,
  subscribeToWindowAttention,
} from "@/runtime/window-attention";

/**
 * Electron window state → `app.attention`, the edge that says whether the
 * user is watching this window.
 *
 * Main reports the window this renderer belongs to, so a conversation pop-out
 * follows its own window. One left on screen keeps reporting itself watched
 * while the main window sits minimized behind it.
 *
 * No lifecycle edge is published here. `app.hidden` means backgrounded to
 * every consumer that reads it: the composer's camera gives the hardware
 * back, the voice room revokes capture consent, react-query drops focus, and
 * `assistant/sse-service.ts` tears the stream down behind a five second
 * grace. The desktop has no push fallback and `VellumAdapter.send` is a
 * fire-and-forget broadcast with no queue or redelivery, so a torn-down
 * stream is a notification lost outright rather than one delivered late.
 * A minimized desktop app must still surface the reply it was waiting for,
 * which is the whole point of this signal, so minimizing must not disconnect
 * it. Under Electron `app.hidden` is therefore unreachable: the DOM source
 * cannot fire there either.
 *
 * `app.attention` and `isWindowAttended()` in `runtime/window-attention.ts`
 * are where the "is the user watching this" question is asked instead. The
 * consumers that act on them suppress a redundant notification, which is
 * recoverable in a way a dropped stream is not.
 */

/** Last attention state published, `null` before the first payload. */
let lastAttended: boolean | null = null;

export function publishElectronWindowAttentionSource(): () => void {
  const unsubscribe = subscribeToWindowAttention((payload) => {
    const nextAttended = isAttendedPayload(payload);
    if (lastAttended !== null && nextAttended === lastAttended) {
      return;
    }
    lastAttended = nextAttended;
    // The first payload publishes as well. Consumers mount before this
    // source starts, so a focused window whose consumers read attention
    // before any payload arrives has already reported itself unwatched, and
    // nothing else corrects that until the next real edge.
    publish("app.attention", { attended: nextAttended });
  });
  return () => {
    lastAttended = null;
    unsubscribe();
  };
}
