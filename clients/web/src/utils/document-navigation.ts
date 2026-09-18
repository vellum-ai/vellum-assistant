import type { Location } from "react-router";

import {
  appIdForPath,
  conversationIdForPath,
  hasOneShotEntryParam,
  routes,
} from "@/utils/routes";

export const DOCUMENT_RETURN_PARAM = "documentReturn";

/**
 * The entry surface `value` names, or `null` when it names none: the Library,
 * or a conversation. An app sub-route names its conversation, since opening a
 * document drops the app, so the previous history entry is `returnTo` or a
 * presentation of it. Popping back lands on the app route it was actually
 * pushed from; the replace fallback lands on the bare conversation.
 *
 * `value` can come from the query, so it is checked for the characters a
 * pathname parse would read past: a query, a hash, a backslash escape, and
 * the doubled slash of a protocol-relative URL.
 */
function safeReturnPath(value?: string | null): string | null {
  const path = value ?? "";
  if (path === routes.library.root || path === `${routes.library.root}/`) {
    return path;
  }
  if (/[?#\\]/.test(path) || path.includes("//")) {
    return null;
  }
  const conversationId = conversationIdForPath(path);
  if (conversationId === null) {
    return null;
  }
  return appIdForPath(path) === null
    ? path
    : routes.conversation(conversationId);
}

/** Only the two document entry surfaces are valid return destinations. */
export function documentReturnPath(value?: string | null): string {
  return safeReturnPath(value) ?? routes.library.root;
}

export function documentEntryUrl(surfaceId: string, returnTo: string): string {
  const params = new URLSearchParams({
    [DOCUMENT_RETURN_PARAM]: documentReturnPath(returnTo),
  });
  return `${routes.document(surfaceId)}?${params}`;
}

/** Marks a pushed document entry whose previous route is safe to revisit. */
export function documentEntryState(
  location: Pick<Location, "pathname" | "search">,
  surfaceId: string,
) {
  const returnTo = safeReturnPath(location.pathname);
  if (returnTo === null || hasOneShotEntryParam(location.search)) {
    return undefined;
  }
  return {
    documentEntry: { surfaceId, returnTo },
  };
}

/**
 * Whether the previous history entry is the one this document was opened
 * from: the same surface, returning to `returnTo`. The entry itself may be a
 * presentation of that route (its app sub-route), which is why the match is
 * on the recorded `returnTo` rather than on the entry's own path.
 */
export function hasDocumentReturnEntry(
  state: unknown,
  surfaceId: string,
  returnTo: string,
): boolean {
  if (!state || typeof state !== "object" || !("documentEntry" in state)) {
    return false;
  }
  const entry = state.documentEntry;
  return (
    !!entry &&
    typeof entry === "object" &&
    "surfaceId" in entry &&
    entry.surfaceId === surfaceId &&
    "returnTo" in entry &&
    entry.returnTo === returnTo
  );
}
