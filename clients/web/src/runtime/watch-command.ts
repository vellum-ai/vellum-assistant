/**
 * The `toggleWatch` command's whole body: the flag in front of the start edge,
 * then the toggle.
 *
 * A module of its own rather than a closure in `root-layout.tsx`, because this
 * is the door into a session that reads the user's screen and a door is worth
 * being able to test. Everything else the layout registers is a navigation or a
 * dialog; this one is the last thing standing between an IPC message and a
 * capture starting.
 */

import { WATCH_FLAG } from "@vellumai/ipc-contract";

import {
  isWatchSessionActive,
  toggleWatch,
} from "@/domains/chat/watch/watch-controller";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * Whether Watch is offered to the signed-in user.
 *
 * Read from the store rather than subscribed to, which is what this file's one
 * caller wants: the answer matters at the instant a press lands and at no other
 * time, and subscribing would re-render the app's whole layout every time a
 * targeting change arrived.
 *
 * Indexed by {@link WATCH_FLAG}, the same key Electron main reads to decide
 * whether the companion surface draws the control at all. The store key is the
 * flag key here because the key is a single word, so `kebabToStoreKey` returns
 * it unchanged (`feature-flag-catalog.ts`).
 *
 * Anything that is not a positive evaluation is a no: registry defaults before
 * the fetch lands, a store that never got a server answer, an environment where
 * the flag was never provisioned. A session that reads the screen is not
 * started on a value nobody has confirmed.
 */
export function isWatchEnabled(): boolean {
  return useClientFeatureFlagStore.getState()[WATCH_FLAG] === true;
}

/**
 * Start or stop a watch session, if the user is meant to have one.
 *
 * **The gate is here and not only on the control that draws it.** The companion
 * surface hides its Watch button while the flag is off, but hiding a button is
 * not closing a door: the surface is a separate window with its own lifetime,
 * and a press already in flight, or a window still holding the state it had
 * before the flag moved, reaches this channel all the same. This window is the
 * side that owns the session, so this is where the answer has to be true.
 *
 * **The gate is on the start edge only.** Both edges arrive through this one
 * call, because the surface draws one control and only the side holding the
 * session knows which edge a press is. A flag that closed both would close the
 * way out of a session that is already running, which is the one thing the
 * surface deliberately keeps drawing when the flag goes off mid-session: it
 * swaps Watch for the stop control rather than hiding the row, because a
 * capture the user can see and cannot end is worse than the feature staying
 * visible. That control presses this command, so a running session has to be
 * allowed through no matter what the flag says.
 *
 * Nothing is navigated and the app is deliberately not raised, unlike
 * `startVoice`. The session reads the user's screen, so the work in front of
 * them is its subject: bringing Vellum forward would cover the very thing the
 * session exists to watch.
 */
export function handleToggleWatchCommand(): void {
  if (!isWatchSessionActive() && !isWatchEnabled()) {
    return;
  }
  void toggleWatch();
}
