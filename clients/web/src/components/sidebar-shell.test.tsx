import { afterEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import type { UseEdgeSwipeBackArgs } from "@/hooks/use-edge-swipe-back";

let isMobile = true;
let lastSwipeArgs: UseEdgeSwipeBackArgs | null = null;

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobile,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));

mock.module("@/hooks/use-edge-swipe-back", () => ({
  useEdgeSwipeBack: (args: UseEdgeSwipeBackArgs) => {
    lastSwipeArgs = args;
  },
}));

const { SidebarShell } = await import("./sidebar-shell");

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="pathname">{pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <SidebarShell
                backHref="/assistant"
                menuRoute="/assistant/settings"
                sidebar={<nav>menu</nav>}
                title="Settings"
              >
                content
              </SidebarShell>
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  isMobile = true;
  lastSwipeArgs = null;
});

describe("SidebarShell edge-swipe back", () => {
  test("arms the swipe on the menu root and exits to backHref", () => {
    // GIVEN a mobile viewport sitting on the settings menu root
    // WHEN the shell mounts
    renderAt("/assistant/settings");

    // THEN the back-swipe gesture is enabled (not gated out on the root)
    expect(lastSwipeArgs?.enabled).toBe(true);

    // AND committing it navigates out to backHref (the surface that opened it)
    act(() => lastSwipeArgs?.onBack());
    expect(screen.getByTestId("pathname").textContent).toBe("/assistant");
  });

  test("arms the swipe on a sub-page and returns to the menu root", () => {
    // GIVEN a mobile viewport on a settings sub-page
    // WHEN the shell mounts
    renderAt("/assistant/settings/billing");

    // THEN the gesture is enabled
    expect(lastSwipeArgs?.enabled).toBe(true);

    // AND committing it returns to the menu root, not all the way out
    act(() => lastSwipeArgs?.onBack());
    expect(screen.getByTestId("pathname").textContent).toBe(
      "/assistant/settings",
    );
  });

  test("disables the swipe off mobile", () => {
    // GIVEN a non-mobile (desktop) viewport
    isMobile = false;

    // WHEN the shell mounts on the menu root
    renderAt("/assistant/settings");

    // THEN the touch gesture is disabled
    expect(lastSwipeArgs?.enabled).toBe(false);
  });
});
