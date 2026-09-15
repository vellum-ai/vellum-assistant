/**
 * The entry an open app was pushed from, recorded so closing it returns
 * through that entry instead of stacking another one. Mirrors the document
 * flow in {@link documentEntryState}: the recording lives on the pushed
 * history entry, so it survives Forward and a reload, and an entry that was
 * never pushed from its conversation simply carries none. A replace that lands
 * on an app entry must carry `location.state` forward or the close degrades to
 * the replace fallback.
 */

import {
  appIdForPath,
  conversationIdForPath,
  hasOneShotEntryParam,
  routes,
} from "@/utils/routes";

export interface AppEntryState {
  appEntry: { appId: string; returnTo: string };
}

/**
 * The route to pop back to, or `null` when `pathname` is not the conversation
 * the app is opening on without an app of its own.
 */
function appReturnPath(
  pathname: string,
  conversationId: string,
): string | null {
  if (appIdForPath(pathname) !== null) {
    return null;
  }
  return conversationIdForPath(pathname) === conversationId
    ? routes.conversation(conversationId)
    : null;
}

/**
 * Marks a pushed app entry whose previous route is the conversation it was
 * opened from. `undefined` when there is no such entry (a direct link, an open
 * from the Library, an open onto a fresh draft, an open over another app) and
 * when the entry being left carries a one-shot param that would re-fire on a
 * pop.
 */
export function appEntryState(
  location: { pathname: string; search: string },
  appId: string,
  conversationId: string,
): AppEntryState | undefined {
  const returnTo = appReturnPath(location.pathname, conversationId);
  if (returnTo === null || hasOneShotEntryParam(location.search)) {
    return undefined;
  }
  return { appEntry: { appId, returnTo } };
}

/** Whether the entry behind this one is where `appId` was opened from. */
export function hasAppReturnEntry(
  state: unknown,
  appId: string,
  returnTo: string,
): boolean {
  if (!state || typeof state !== "object" || !("appEntry" in state)) {
    return false;
  }
  const entry = state.appEntry;
  return (
    !!entry &&
    typeof entry === "object" &&
    "appId" in entry &&
    entry.appId === appId &&
    "returnTo" in entry &&
    entry.returnTo === returnTo
  );
}
