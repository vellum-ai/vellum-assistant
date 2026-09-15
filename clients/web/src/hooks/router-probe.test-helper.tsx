/**
 * A router for hook tests, with the location it lands on readable from the DOM.
 *
 * A hook that navigates is asserted on by where the router ends up, so the
 * wrapper mounts a probe that renders the current location beside the hook.
 * Reading it through `screen` keeps the assertions off router internals.
 *
 * ```tsx
 * renderHook(() => useThing(), { wrapper: wrapperAt("/assistant") });
 * expect(currentLocation().pathname).toBe("/assistant/library");
 * ```
 *
 * A suite that brings its own wrapper (a query client, a rendered component)
 * mounts {@link LocationProbe} inside its own router instead, and reads the
 * same {@link currentLocation}.
 */

import { screen } from "@testing-library/react";
import { useEffect, type ReactElement, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";

const PATHNAME_TEST_ID = "router-probe-pathname";
const SEARCH_TEST_ID = "router-probe-search";
const STATE_TEST_ID = "router-probe-state";

/** Renders the router's location for {@link currentLocation} to read. */
export function LocationProbe(): ReactElement {
  const { pathname, search, state } = useLocation();
  return (
    <>
      <span data-testid={PATHNAME_TEST_ID}>{pathname}</span>
      <span data-testid={SEARCH_TEST_ID}>{search}</span>
      <span data-testid={STATE_TEST_ID}>{JSON.stringify(state ?? null)}</span>
    </>
  );
}

/**
 * Mirrors the router's location onto `window.location`, which a memory router
 * does not drive. The imperative route helpers (`currentPathname`,
 * `appIdForPath` readers, `closeAppRoute`, `dropAppFromRoute`) read the window,
 * so without this they see whatever path the suite last set by hand. The
 * entry's state goes with it, under the `usr` key React Router keeps it on,
 * for the helpers that decide by what the entry records.
 */
export function LocationMirror(): null {
  const { pathname, search, state } = useLocation();
  useEffect(() => {
    window.history.replaceState({ usr: state ?? null }, "", pathname + search);
  }, [pathname, search, state]);
  return null;
}

/**
 * Where the mounted probe's router currently is. `search` includes its `?`, and
 * `state` is the entry's history state, `null` when it carries none.
 */
export function currentLocation(): {
  pathname: string;
  search: string;
  state: unknown;
} {
  return {
    pathname: screen.getByTestId(PATHNAME_TEST_ID).textContent ?? "",
    search: screen.getByTestId(SEARCH_TEST_ID).textContent ?? "",
    state: JSON.parse(
      screen.getByTestId(STATE_TEST_ID).textContent || "null",
    ) as unknown,
  };
}

/** A `renderHook` wrapper whose router opens at `initialPath`. */
export function wrapperAt(initialPath: string) {
  return function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    );
  };
}
