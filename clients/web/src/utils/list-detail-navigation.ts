/**
 * Leaving a list-detail screen for its list.
 *
 * Mirrors the recording in `utils/app-navigation.ts`: the marker lives on the
 * pushed history entry, so it survives Forward and a reload, and an entry that
 * was never pushed from its list simply carries none.
 */

import type { NavigateFunction } from "react-router";

/**
 * Carried on a detail entry that was pushed from its list, so leaving the
 * detail pops back to that list instead of stacking a second copy of it.
 */
export const PUSHED_FROM_LIST_STATE = { pushedFromList: true } as const;

/** Whether `state` carries {@link PUSHED_FROM_LIST_STATE}. */
function wasPushedFromList(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    "pushedFromList" in state &&
    state.pushedFromList === true
  );
}

/**
 * Sends a detail screen back to `listPath`. A deep-linked detail has no list
 * behind it, so it replaces rather than popping out of the app.
 */
export function returnToList(
  navigate: NavigateFunction,
  state: unknown,
  listPath: string,
): void {
  if (wasPushedFromList(state)) {
    void navigate(-1);
    return;
  }
  void navigate(listPath, { replace: true });
}
