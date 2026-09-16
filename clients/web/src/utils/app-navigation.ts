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

/** The recording an entry carries, or `null` when it carries none. */
function readAppEntry(state: unknown): AppEntryState["appEntry"] | null {
  if (!state || typeof state !== "object" || !("appEntry" in state)) {
    return null;
  }
  const entry = state.appEntry;
  if (
    !entry ||
    typeof entry !== "object" ||
    !("appId" in entry) ||
    typeof entry.appId !== "string" ||
    !("returnTo" in entry) ||
    typeof entry.returnTo !== "string"
  ) {
    return null;
  }
  return { appId: entry.appId, returnTo: entry.returnTo };
}

/** Whether the entry behind this one is where `appId` was opened from. */
export function hasAppReturnEntry(
  state: unknown,
  appId: string,
  returnTo: string,
): boolean {
  const entry = readAppEntry(state);
  return entry !== null && entry.appId === appId && entry.returnTo === returnTo;
}

/**
 * The recording to hand a replace that keeps the app on the entry it is on.
 * The entry survives the replace, so the recording stands, re-keyed to the
 * conversation the entry now names.
 *
 * The entry behind keeps the id it was pushed under, so a re-key leaves the
 * return path naming a conversation that entry's URL does not. The pop still
 * lands there, and `useConversationLoader` redirects a retired draft URL onto
 * its server row (`draftReplacements`), so the entry resolves to the same
 * conversation the return path names.
 *
 * `undefined` when the entry carries no recording, which leaves the close on
 * its replace fallback.
 */
export function carriedAppEntryState(
  state: unknown,
  conversationId: string,
): AppEntryState | undefined {
  const entry = readAppEntry(state);
  if (entry === null) {
    return undefined;
  }
  return {
    appEntry: {
      appId: entry.appId,
      returnTo: routes.conversation(conversationId),
    },
  };
}
