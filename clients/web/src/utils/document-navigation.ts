import type { Location } from "react-router";

import { routes } from "@/utils/routes";

export const DOCUMENT_RETURN_PARAM = "documentReturn";

/** Only the two document entry surfaces are valid return destinations. */
export function documentReturnPath(value?: string | null): string {
  if (
    value === routes.library.root ||
    value === `${routes.library.root}/` ||
    /^\/assistant\/conversations\/[^/?#\\]+\/?$/.test(value ?? "")
  ) {
    return value!;
  }
  return routes.library.root;
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
  const params = new URLSearchParams(location.search);
  if (
    documentReturnPath(location.pathname) !== location.pathname ||
    ["prompt", "relay", "document"].some((key) => params.has(key))
  ) {
    return undefined;
  }
  return {
    documentEntry: { surfaceId, returnTo: location.pathname },
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
