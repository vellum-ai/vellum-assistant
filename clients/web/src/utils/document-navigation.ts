import type { Location } from "react-router";

import { appIdForPath, conversationIdForPath, routes } from "@/utils/routes";

export const DOCUMENT_RETURN_PARAM = "documentReturn";

/**
 * A conversation, optionally naming the app the viewer holds on screen.
 * Stricter than {@link conversationIdForPath}, which parses a pathname and so
 * tolerates the query, hash, and escape syntax an untrusted value can carry.
 */
const CONVERSATION_RETURN =
  /^\/assistant\/conversations\/[^/?#\\]+(?:\/app\/[^/?#\\]+)?\/?$/;

/**
 * The entry surface `value` names, or `null` when it names none. An app
 * sub-route names its conversation: opening a document drops the app.
 */
function safeReturnPath(value?: string | null): string | null {
  const path = value ?? "";
  if (path === routes.library.root || path === `${routes.library.root}/`) {
    return path;
  }
  if (!CONVERSATION_RETURN.test(path)) {
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
  const params = new URLSearchParams(location.search);
  if (
    returnTo === null ||
    ["prompt", "relay", "document"].some((key) => params.has(key))
  ) {
    return undefined;
  }
  return {
    documentEntry: { surfaceId, returnTo },
  };
}

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
