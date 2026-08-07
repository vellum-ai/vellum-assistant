/**
 * Tests for `PinnedAppNavItem`.
 *
 * The design-library `SideMenu.Item` and `ContextMenu` primitives are mocked
 * with lightweight elements so these tests exercise the component's
 * composition and store wiring (open, unpin, collapsed omission) rather than
 * Radix ContextMenu internals. `onSelect` is surfaced as an `onClick` so
 * happy-dom can drive it.
 *
 * `PanelItem` is deliberately *not* mocked. The expanded row is a real pill
 * now, and its role, accessible name and active marker are what the assertions
 * below turn on, so a stand-in would be asserting the stand-in's own markers.
 * The collapsed rail still renders `SideMenu.Item`, which is why the mock is
 * still here.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

mock.module("@vellumai/design-library", () => {
  const SideMenu = {
    Item: ({
      label,
      onSelect,
      active,
    }: {
      label: string;
      onSelect?: () => void;
      active?: boolean;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "app-row",
          "data-active": active ? "true" : "false",
          onClick: onSelect,
        },
        label,
      ),
  };
  const ContextMenu = {
    Root: ({ children }: { children?: ReactNode }) =>
      createElement("div", { "data-testid": "ctx-root" }, children),
    Trigger: ({ children }: { children?: ReactNode }) =>
      createElement("div", { "data-testid": "ctx-trigger" }, children),
    Content: ({ children }: { children?: ReactNode }) =>
      createElement("div", { "data-testid": "ctx-content" }, children),
    Item: ({
      children,
      onSelect,
    }: {
      children?: ReactNode;
      onSelect?: () => void;
    }) =>
      createElement("button", { type: "button", onClick: onSelect }, children),
  };
  return { SideMenu, ContextMenu };
});

import { PinnedAppNavItem } from "@/domains/chat/components/pinned-app-nav-item";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { PinnableApp, PinnedAppEntry } from "@/utils/app-pin-storage";

const APP: PinnedAppEntry = {
  appId: "app-1",
  pinnedOrder: 1,
  name: "My App",
  icon: "🚀",
};

function seedPin(entry: PinnedAppEntry): void {
  const app: PinnableApp = {
    id: entry.appId,
    name: entry.name,
    icon: entry.icon,
  };
  usePinnedAppsStore.getState().togglePin(app);
}

beforeEach(() => {
  localStorage.clear();
  usePinnedAppsStore.setState({ pinnedApps: [], pinnedAppIds: new Set() });
});

afterEach(() => {
  cleanup();
});

describe("PinnedAppNavItem", () => {
  test("renders the app label and opens the app on select", () => {
    const onOpen = mock((_appId: string) => {});
    render(
      <PinnedAppNavItem
        app={APP}
        active={false}
        collapsed={false}
        onOpen={onOpen}
      />,
    );

    /* Queried by accessible name, not by test id: the pill carries the app's
       icon as an emoji next to the label, and the emoji is `aria-hidden`
       precisely so the row announces "My App" rather than "🚀 My App". An
       exact-name match is what holds that - it fails if the emoji ever leaks
       into the name. */
    const row = screen.getByRole("button", { name: "My App" });
    expect(row.textContent).toContain("My App");

    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]).toBe("app-1");
  });

  test("expanded: Unpin action clears the pin (the sidebar escape hatch)", () => {
    seedPin(APP);
    expect(usePinnedAppsStore.getState().isPinned("app-1")).toBe(true);

    render(<PinnedAppNavItem app={APP} active={false} collapsed={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Unpin" }));

    expect(usePinnedAppsStore.getState().isPinned("app-1")).toBe(false);
  });

  test("expanded: the hover-revealed unpin button also clears the pin", () => {
    seedPin(APP);
    expect(usePinnedAppsStore.getState().isPinned("app-1")).toBe(true);

    render(<PinnedAppNavItem app={APP} active={false} collapsed={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Unpin My App" }));

    expect(usePinnedAppsStore.getState().isPinned("app-1")).toBe(false);
  });

  // Regression: the hover-revealed button has no hover to reveal it on
  // touch, so it must not sit clickable-but-invisible over the row's
  // right edge, or a tap there unpins instead of opening the app.
  test("expanded: the hover-revealed unpin button disables its hit target on coarse pointers", () => {
    render(<PinnedAppNavItem app={APP} active={false} collapsed={false} />);

    const button = screen.getByRole("button", { name: "Unpin My App" });
    expect(button.className).toContain("pointer-coarse:pointer-events-none");
  });

  test("collapsed rail: renders the row without the context-menu wrapper", () => {
    render(<PinnedAppNavItem app={APP} active={false} collapsed />);

    expect(screen.getByTestId("app-row").textContent).toBe("My App");
    expect(screen.queryByTestId("ctx-root")).toBeNull();
    expect(screen.queryByRole("button", { name: "Unpin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unpin My App" })).toBeNull();
  });

  /* `aria-current="page"` rather than a `data-active` attribute: the pill's
     active state is the one assistive tech reads, and it is what the pill's
     own active styling is keyed off (`aria-[current=page]:` classes), so
     asserting it covers both. Both states, because an attribute that is always
     set marks every row as the current one.

     `onOpen` is supplied because the pill only takes button semantics when it
     has a handler, and the sidebar always gives it one. Without it this would
     assert the marker on a shape the sidebar never renders. */
  test("marks the row as the current page only while active", () => {
    const props = { app: APP, collapsed: false, onOpen: () => {} };

    render(<PinnedAppNavItem {...props} active />);
    expect(
      screen
        .getByRole("button", { name: "My App" })
        .getAttribute("aria-current"),
    ).toBe("page");

    cleanup();
    render(<PinnedAppNavItem {...props} active={false} />);
    expect(
      screen
        .getByRole("button", { name: "My App" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });
});
