/**
 * Which call control the companion's introduction is asking this window to
 * listen for a chord for, or `null` when it is asking for none.
 *
 * The run belongs to main and is drawn on the surface's own renderer; the
 * chord can only be heard by the window that arms it, which is this one. So
 * main, the side that holds the beat, says when a card is asking and for what,
 * and this window arms exactly that (`use-call-chords`).
 *
 * `null` everywhere there is no companion: the browser, iOS, and the Windows
 * shell, which has no surface to introduce.
 */

import { useEffect, useState } from "react";

import type { CompanionIntroCallControl } from "@vellumai/ipc-contract";

import { isElectron } from "@/runtime/is-electron";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";

/**
 * Whether this window is one that should be listening at all.
 *
 * Asked before either call below, so a window with no companion neither
 * subscribes nor puts an ask out that could only ever answer "none": off
 * Electron this hook is inert rather than quietly resolving to null a tick
 * after it mounts.
 *
 * **The app's own window and no other.** `RootLayout` mounts in pop-out thread
 * windows too, and main pushes this only to the app's window, but the ask is
 * answered for whoever asks. A pop-out that armed the chord would become the
 * host's owner of the binding and take the press from the window that can do
 * something with it, and its own count is published to nobody: the companion
 * mirror publishes from the main window alone. The same rule, for the same
 * reason, that `use-companion-mirror` holds.
 */
function hostPublishesIntroChord(): boolean {
  if (isPopoutWindowLifetime()) {
    return false;
  }
  const companion = isElectron() ? window.vellum?.companion : undefined;
  return (
    companion?.onIntroChord !== undefined ||
    companion?.getIntroChord !== undefined
  );
}

/** Main's push, which lands on every change while a shell is there to send it. */
function subscribeToBridge(
  callback: (control: CompanionIntroCallControl | null) => void,
): () => void {
  const companion = isElectron() ? window.vellum?.companion : undefined;
  // A shell that predates the channel never publishes one, and a shell without
  // a surface has no `companion` at all.
  if (companion?.onIntroChord === undefined) {
    return () => undefined;
  }
  return companion.onIntroChord(callback);
}

/**
 * The same fact, asked for rather than waited for.
 *
 * A run can be mid-beat while this window is still loading, and the window can
 * reload without the run moving, and in both cases the push that would have
 * armed the binding has already been and gone. Main holds the beat, so it is
 * asked. The same reason `companion-intro-stage` asks.
 */
async function askBridge(): Promise<CompanionIntroCallControl | null> {
  const companion = isElectron() ? window.vellum?.companion : undefined;
  if (companion?.getIntroChord === undefined) {
    return null;
  }
  return await companion.getIntroChord();
}

/**
 * The control the run is asking for, followed for as long as the caller is
 * mounted.
 *
 * State rather than a module-level singleton, unlike the staging next door:
 * that fact is read inside a keypress that cannot wait for a subscription, and
 * this one has exactly one reader, a hook that arms a binding from it.
 */
export function useCompanionIntroChord(): CompanionIntroCallControl | null {
  const [control, setControl] = useState<CompanionIntroCallControl | null>(
    null,
  );
  useEffect(() => {
    if (!hostPublishesIntroChord()) {
      return;
    }
    // Whether a push has landed, which is what makes the ask below stale: a
    // push carries the moment it describes, while the ask carries only the
    // moment it went out. A beat walked past while the ask was in flight has
    // already sent the newer answer, and taking the ask's over it would arm a
    // chord for a card that is gone.
    let pushed = false;
    // Subscribed before the ask, so a change that lands while the ask is out
    // is not lost and the ask can tell it has been overtaken.
    const unsubscribe = subscribeToBridge((next) => {
      pushed = true;
      setControl(next);
    });
    void askBridge().then((initial) => {
      if (pushed) {
        return;
      }
      setControl(initial);
    });
    return unsubscribe;
  }, []);
  return control;
}
