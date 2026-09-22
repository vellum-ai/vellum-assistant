import { createBooleanBridgeStore } from "@/runtime/boolean-bridge-store";
import { isElectron } from "@/runtime/is-electron";

/**
 * Whether the companion's one-time introduction is being staged on this
 * window.
 *
 * The surface ordinarily steps off the screen while Vellum is frontmost, which
 * is the moment a new user is looking at the app, so a due run holds it in
 * front and stands it in the middle of this window instead
 * (`companion-window.ts`). Main is the side that decides that, and this is how
 * it reaches the window being staged over: the app dims itself for the length
 * of a run so the only lit thing on screen is the surface.
 *
 * **The fact is held here, not in the component that draws it.** Its two
 * readers want it differently: the scrim watches it and re-renders, and the
 * voice entry guards ask for it in the middle of a press that cannot afford to
 * wait (see `voice-entry-guards.ts`). So the module follows main's pushes from
 * the moment it is imported and keeps the answer, and both readers take it
 * from the same place.
 *
 * `false` everywhere there is no companion: the browser, iOS, and the Windows
 * shell, which has no surface to introduce.
 */

/** Main's push, which lands on every change while a shell is there to send it. */
function subscribeToBridge(callback: (staged: boolean) => void): () => void {
  const companion = isElectron() ? window.vellum?.companion : undefined;
  // A shell that predates the channel never publishes one, and a shell without
  // a surface has no `companion` at all.
  if (companion?.onIntroStage === undefined) {
    return () => undefined;
  }
  return companion.onIntroStage(callback);
}

/**
 * The same fact, asked for rather than waited for.
 *
 * A run can start while this window is still loading, and the window can
 * reload mid-run, and in both cases the push that would have dimmed it has
 * already been and gone. Main holds the answer, so it is asked for. The same
 * reason `companion.getState` exists for the surface's own route.
 */
async function askBridge(): Promise<boolean> {
  const companion = isElectron() ? window.vellum?.companion : undefined;
  if (companion?.getIntroStage === undefined) {
    return false;
  }
  return await companion.getIntroStage();
}

// Followed from import rather than from a mount, because the reader that
// cannot wait is a function call inside a keypress, not a component: by the
// time it asks, the answer has to already be here. Never unsubscribed, since
// the thing it belongs to is the document.
//
// Subscribed before the ask, so a change that lands while the ask is out is
// not lost, and so the ask can tell that it has been overtaken.
const stage = createBooleanBridgeStore({
  subscribe: subscribeToBridge,
  getInitial: askBridge,
});

/**
 * Whether a run is staged right now, answered from what main last said.
 *
 * Synchronous on purpose. Its caller is deciding, inside a user gesture,
 * whether a press opens a session, and an await there costs the gesture the
 * permissions that hang off it.
 */
export function companionIntroStaged(): boolean {
  return stage.getSnapshot();
}

/** The staged state as React state. Never staged where there is no shell. */
export function useCompanionIntroStaged(): boolean {
  return stage.useValue();
}
