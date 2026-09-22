/**
 * Tests for `RoutePendingIndicator`.
 *
 * The property that matters is that it tracks the router's own pending state
 * rather than a timer of its own, so it cannot outlive a navigation or miss
 * one. The delay before it is visible is CSS, so it is asserted as a class
 * rather than by waiting.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { RoutePendingIndicator } from "@/components/route-pending-indicator";

afterEach(cleanup);

/**
 * A router whose second route resolves only when the returned `release` is
 * called, so a navigation can be held open and inspected mid-flight.
 */
function routerWithHeldChunk(): {
  router: ReturnType<typeof createMemoryRouter>;
  release: () => void;
} {
  let release = (): void => {};
  const router = createMemoryRouter(
    [
      {
        path: "/",
        Component: () => (
          <>
            <RoutePendingIndicator />
            <div>home</div>
          </>
        ),
      },
      {
        path: "/slow",
        lazy: {
          Component: () =>
            new Promise<() => React.JSX.Element>((resolve) => {
              release = () => resolve(() => <div>arrived</div>);
            }),
        },
      },
    ],
    { initialEntries: ["/"] },
  );
  return { router, release: () => release() };
}

describe("RoutePendingIndicator", () => {
  test("renders nothing while the router is idle", () => {
    const { router } = routerWithHeldChunk();
    render(<RouterProvider router={router} />);

    expect(screen.queryByRole("status")).toBeNull();
  });

  test("appears while a lazy route is still resolving and goes when it lands", async () => {
    const { router, release } = routerWithHeldChunk();
    render(<RouterProvider router={router} />);

    // GIVEN a navigation whose chunk has not arrived
    await act(async () => {
      void router.navigate("/slow");
      await Promise.resolve();
    });

    // THEN the bar is mounted, and carries the class that keeps it invisible
    // until the wait outlasts the CSS delay
    const bar = screen.getByRole("status");
    expect(bar).not.toBeNull();
    expect(bar.className).toContain("route-pending-indicator");

    // AND the moving fill carries its animation in a class, not an inline
    // style: an inline `animation` outranks a stylesheet rule, so the
    // reduced-motion override could not turn it off.
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain("route-pending-indicator-fill");
    expect(fill.style.animation).toBe("");

    // WHEN the chunk resolves
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // THEN the bar goes with the navigation that caused it
    expect(screen.getByText("arrived")).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
