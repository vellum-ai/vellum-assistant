import { useEffect, useState } from "react";

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
 * `false` everywhere there is no companion: the browser, iOS, and the Windows
 * shell, which has no surface to introduce.
 */
export function subscribeToCompanionIntroStage(
  callback: (staged: boolean) => void,
): () => void {
  const companion = isElectron() ? window.vellum?.companion : undefined;
  // A shell that predates the channel never publishes one, and a shell without
  // a surface has no `companion` at all.
  if (companion?.onIntroStage === undefined) {
    return () => undefined;
  }
  return companion.onIntroStage(callback);
}

/**
 * Whether a run is staged right now, asked rather than waited for.
 *
 * A run can start while this window is still loading, and the window can
 * reload mid-run, and in both cases the push that would have dimmed it has
 * already been and gone. Main holds the answer, so it is asked for. The same
 * reason `companion.getState` exists for the surface's own route.
 */
export async function getCompanionIntroStaged(): Promise<boolean> {
  const companion = isElectron() ? window.vellum?.companion : undefined;
  if (companion?.getIntroStage === undefined) {
    return false;
  }
  return await companion.getIntroStage();
}

/** The staged state as React state: asked for once on mount, then watched. */
export function useCompanionIntroStaged(): boolean {
  const [staged, setStaged] = useState(false);
  useEffect(() => {
    let live = true;
    // Subscribed before the ask, so a change that lands while the ask is out
    // is not lost. The ask can then only be overtaken by a fresher answer,
    // which is the one to keep.
    const unsubscribe = subscribeToCompanionIntroStage((next) => {
      if (live) {
        setStaged(next);
      }
    });
    void getCompanionIntroStaged().then((next) => {
      if (live && next) {
        setStaged(true);
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return staged;
}
