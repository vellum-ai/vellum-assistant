/**
 * useDeepLinkApp — consumes the `?app=<id>` URL search parameter on initial
 * load, opens the app in the viewer, and strips the param from the URL.
 *
 * Fires once per mount (guarded by a consumed ref) so navigating back to
 * the same URL doesn't re-trigger the viewer.
 */

import { useEffect, useRef } from "react";
import { useViewerStore } from "@/stores/viewer-store";

export function useDeepLinkApp(
  assistantId: string | null,
  searchParams: URLSearchParams,
): void {
  const consumedRef = useRef(false);

  useEffect(() => {
    if (consumedRef.current) return;
    const appId = searchParams.get("app");
    if (!appId || !assistantId) return;
    consumedRef.current = true;
    void useViewerStore.getState().loadApp(assistantId, appId);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("app");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      query ? `${window.location.pathname}?${query}` : window.location.pathname,
    );
  }, [searchParams, assistantId]);
}
