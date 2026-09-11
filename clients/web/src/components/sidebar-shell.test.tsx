import { afterEach, describe, expect, mock, test } from "bun:test";

import { useEffect } from "react";
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

/**
 * Stands in for a routed page: counts its own mounts, so a test can tell a
 * page that never rendered from one that rendered somewhere off-screen.
 */
let contentMounts = 0;
function ContentProbe() {
  useEffect(() => {
    contentMounts += 1;
  }, []);
  return <div data-testid="content">content</div>;
}

function renderAt(path: string, menuReplacesContentOnMobile = true) {
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
                menuReplacesContentOnMobile={menuReplacesContentOnMobile}
              >
                <ContentProbe />
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
  contentMounts = 0;
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
    renderAt("/assistant/settings/usage");

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

describe("SidebarShell menu route content", () => {
  test("the menu route on a narrow viewport never mounts the routed page", () => {
    // GIVEN a mobile viewport sitting on the menu root, where the nav list is
    // the whole screen
    // WHEN the shell mounts
    renderAt("/assistant/settings");

    // THEN the nav list is what rendered, exactly once: the desktop rail is
    // not mounted alongside it as a second, permanently invisible copy.
    expect(screen.getAllByRole("navigation")).toHaveLength(1);

    // AND the page behind it never mounted, so none of its render work, its
    // effects or its requests were paid for. Asserted on mounts rather than on
    // visibility: a CSS-hidden page is still in the document and still runs.
    expect(contentMounts).toBe(0);
    expect(screen.queryByTestId("content")).toBeNull();
  });

  test("a sub-page on a narrow viewport mounts no sidebar copy at all", () => {
    // GIVEN a mobile viewport on a settings sub-page, where the nav list is
    // off-screen behind the page
    // WHEN the shell mounts
    renderAt("/assistant/settings/usage");

    // THEN no sidebar is mounted: the rail that would carry it is desktop-only
    expect(screen.queryAllByRole("navigation")).toHaveLength(0);
  });

  test("a sub-page on a narrow viewport mounts the routed page", () => {
    // GIVEN a mobile viewport on a settings sub-page
    // WHEN the shell mounts
    renderAt("/assistant/settings/usage");

    // THEN the page is the screen, and it mounted exactly once
    expect(contentMounts).toBe(1);
    expect(screen.getByTestId("content")).not.toBeNull();
  });

  test("a caller that has not opted in keeps its menu-route child mounted", () => {
    // GIVEN a shell whose menu-route child does real work, the Logs root being
    // the case in the tree: its index child is a redirect that has to mount to
    // carry a bookmarked URL on to its destination
    // WHEN a narrow viewport lands on that menu route
    renderAt("/assistant/settings", false);

    // THEN the child still mounts, so the redirect still runs. Substitution is
    // opt-in precisely because a child can have work that outlives being seen.
    expect(contentMounts).toBe(1);

    // AND the nav list is still what the viewer gets, exactly as before: not
    // opting in withholds the unmounting, not the two-page flow.
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
  });

  test("a roomy viewport mounts the routed page on the menu route too", () => {
    // GIVEN a desktop viewport, where the sidebar and the page sit side by side
    isMobile = false;

    // WHEN the shell mounts on the menu root
    renderAt("/assistant/settings");

    // THEN both surfaces are present: the page is not substituted away, and
    // the rail carries the one sidebar copy
    expect(contentMounts).toBe(1);
    expect(screen.getByTestId("content")).not.toBeNull();
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
  });
});
