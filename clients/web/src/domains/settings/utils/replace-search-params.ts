import type { Location, NavigateFunction } from "react-router";

/**
 * Replace-navigate with the current query string mutated in place, keeping the
 * URL hash.
 *
 * The hash is the point: `setSearchParams` drops it, and so does a navigate to
 * a canonical route, while anchor deep links (`#daily-credit-limit`, from the
 * daily-limit email) have to survive every rewrite of this page's params
 * however late the anchored card mounts.
 */
export function replaceSearchParams(
  navigate: NavigateFunction,
  location: Pick<Location, "pathname" | "search" | "hash">,
  mutate: (params: URLSearchParams) => void,
): void {
  const next = new URLSearchParams(location.search);
  mutate(next);
  void navigate(
    { pathname: location.pathname, search: `?${next}`, hash: location.hash },
    { replace: true },
  );
}
