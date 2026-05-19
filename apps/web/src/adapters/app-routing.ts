import {
  useNavigate,
  useSearchParams,
  useLocation,
} from "react-router";
import { useCallback } from "react";

/**
 * Framework-agnostic routing adapter.
 *
 * Wraps React Router v7 primitives so the rest of the codebase
 * can import a stable API regardless of the underlying router.
 */
export function useAppRouting() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();

  const push = useCallback(
    (url: string) => navigate(url),
    [navigate],
  );

  const replace = useCallback(
    (url: string) => navigate(url, { replace: true }),
    [navigate],
  );

  return { push, replace, pathname: location.pathname, searchParams };
}

export type AppRoutingAdapter = ReturnType<typeof useAppRouting>;

/**
 * Granular pathname-only adapter. Use when a component only needs the
 * current pathname and should NOT re-render on search-param or router
 * changes.
 */
export function useAppPathname(): string {
  return useLocation().pathname;
}

/**
 * Granular navigation adapter. Returns `push` and `replace` without
 * subscribing to pathname or search-param changes.
 */
export function useAppNavigate() {
  const navigate = useNavigate();

  const push = useCallback(
    (url: string) => navigate(url),
    [navigate],
  );

  const replace = useCallback(
    (url: string) => navigate(url, { replace: true }),
    [navigate],
  );

  return { push, replace };
}

/**
 * Granular search-params adapter. Use when a component only needs
 * search params.
 */
export function useAppSearchParams(): URLSearchParams {
  const [searchParams] = useSearchParams();
  return searchParams;
}
