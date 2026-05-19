
import { useCallback } from "react";

import {
  useAppNavigate,
  useAppSearchParams,
  type AppRoutingAdapter,
} from "@/adapters/app-routing.js";

/**
 * Chat-domain routing adapter.
 *
 * Delegates to the shared `useAppRouting` adapter and adds `replaceUrl`
 * for silent URL-bar updates specific to the chat domain.
 *
 * Every `next/navigation` import in the `(chat)/` directory should flow
 * through this hook so the rest of the domain code stays framework-agnostic.
 * When the codebase migrates to React Router v7, only the shared adapter
 * and this file change.
 */
export function useRouting() {
  const { push, replace } = useAppNavigate();
  const searchParams = useAppSearchParams();

  /**
   * Silently update the URL bar without triggering a framework navigation.
   * In Next.js App Router this avoids a full re-render / remount of the
   * page component. The RR v7 migration strategy for this is TBD —
   * `navigate(url, { replace: true })` triggers a full route re-evaluation,
   * so callers relying on no-re-render semantics may need to keep using
   * `window.history.replaceState` or adopt a custom silent-update wrapper.
   */
  const replaceUrl = useCallback(
    (url: string) => window.history.replaceState(null, "", url),
    [],
  );

  return { push, replace, replaceUrl, searchParams };
}

export type RoutingAdapter = ReturnType<typeof useRouting>;

// Re-export the shared adapter type for consumers that don't need replaceUrl.
export type { AppRoutingAdapter };
