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

/** Renders the router's location for {@link currentLocation} to read. */
export function LocationProbe(): ReactElement {
  const { pathname, search } = useLocation();
  return (
    <>
      <span data-testid={PATHNAME_TEST_ID}>{pathname}</span>
      <span data-testid={SEARCH_TEST_ID}>{search}</span>
    </>
  );
}

/**
 * Mirrors the router's location onto `window.location`, which a memory router
 * does not drive. The imperative route helpers (`currentPathname`,
 * `appIdForPath` readers, `closeAppRoute`, `dropAppFromRoute`) read the window,
 * so without this they see whatever path the suite last set by hand.
 */
export function LocationMirror(): null {
  const { pathname, search } = useLocation();
  useEffect(() => {
    window.history.replaceState(null, "", pathname + search);
  }, [pathname, search]);
  return null;
}

/** Where the mounted probe's router currently is. `search` includes its `?`. */
export function currentLocation(): { pathname: string; search: string } {
  return {
    pathname: screen.getByTestId(PATHNAME_TEST_ID).textContent ?? "",
    search: screen.getByTestId(SEARCH_TEST_ID).textContent ?? "",
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
