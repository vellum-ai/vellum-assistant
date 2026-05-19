import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";

/**
 * Chat-domain routing hook.
 *
 * Wraps React Router primitives and adds `replaceUrl` for silent URL-bar
 * updates that don't trigger a full route re-evaluation.
 */
export function useRouting() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const push = useCallback((path: string) => navigate(path), [navigate]);
  const replace = useCallback(
    (path: string) => navigate(path, { replace: true }),
    [navigate],
  );

  const replaceUrl = useCallback(
    (url: string) => window.history.replaceState(null, "", url),
    [],
  );

  return { push, replace, replaceUrl, searchParams };
}

export type RoutingAdapter = ReturnType<typeof useRouting>;
