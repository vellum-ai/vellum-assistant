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
import { createElement, type CSSProperties, type ReactNode } from "react";

mock.module("@vellumai/design-library", () => {
  const SideMenu = {
    Item: ({
      label,
      onSelect,
      active,
      style,
    }: {
      label: string;
      onSelect?: () => void;
      active?: boolean;
      style?: CSSProperties;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "app-row",
          "data-active": active ? "true" : "false",
          onClick: onSelect,
          // Forwarded, not dropped: the tile's tint is declared through
          // `style`, so a stand-in that swallowed it would report every
          // collapsed pin as uncoloured.
          style,
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
    Separator: () => createElement("hr"),
    Item: ({
      children,
      onSelect,
      ...rest
    }: {
      children?: ReactNode;
      onSelect?: () => void;
    }) =>
      createElement(
        "button",
        { type: "button", onClick: onSelect, ...rest },
        children,
      ),
  };
  return { SideMenu, ContextMenu };
});

import { PinnedAppNavItem } from "@/domains/chat/components/pinned-app-nav-item";
import { getPinColorHex } from "@/domains/chat/utils/pin-color-registry";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { PinnableApp, PinnedAppEntry } from "@/utils/app-pin-storage";

const APP: PinnedAppEntry = {
  appId: "app-1",
  pinnedOrder: 1,
  name: "My App",
  icon: "🚀",
};

const TEAL_APP: PinnedAppEntry = { ...APP, color: "teal" };

/* Read from the registry rather than restated, so the palette stays the one
   place a colour's hex is written down and a repalette does not fail tests
   that are not about the palette. */
const TEAL_HEX = getPinColorHex("teal")!;

/**
 * The three tint custom properties as the row actually declares them. Read
 * through `getPropertyValue` because a custom property is not a typed style
 * field, and an undeclared one reads as the empty string.
 */
function tintOf(element: HTMLElement): {
  bg: string;
  hover: string;
  active: string;
} {
  return {
    bg: element.style.getPropertyValue("--panel-item-bg"),
    hover: element.style.getPropertyValue("--panel-item-hover"),
    active: element.style.getPropertyValue("--panel-item-active"),
  };
}

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

  /* `onOpen` is supplied throughout the tint cases below because the pill only
     takes button semantics when it has a handler, and the sidebar always gives
     it one. Without it these would read the tint off a shape the sidebar never
     renders. */
  test("an uncoloured pin declares no tint, so the pill keeps its plain surface", () => {
    render(
      <PinnedAppNavItem
        app={APP}
        active={false}
        collapsed={false}
        onOpen={() => {}}
      />,
    );

    expect(tintOf(screen.getByRole("button", { name: "My App" }))).toEqual({
      bg: "",
      hover: "",
      active: "",
    });
  });

  test("a coloured pin declares all three tint properties on the pill", () => {
    render(
      <PinnedAppNavItem
        app={TEAL_APP}
        active={false}
        collapsed={false}
        onOpen={() => {}}
      />,
    );

    const tint = tintOf(screen.getByRole("button", { name: "My App" }));
    expect(tint.bg).toContain(TEAL_HEX);
    expect(tint.hover).toContain(TEAL_HEX);
    /* All three, not just the resting one. Each of the other two states has
       its own declaration in the pill, so a tint that set only `--panel-item-bg`
       would drop back to an untinted surface token the moment the row was
       hovered or became the current page. */
    expect(tint.active).toContain(TEAL_HEX);
  });

  /* The invariant from the collapsed-rail decision: the rail changes a pin's
     shape and nothing else, so the tile declares exactly what the pill does.
     Compared property by property rather than merely asserted non-empty, so a
     tile that tinted only its resting surface would fail. */
  test("the colour rides onto the collapsed rail tile unchanged", () => {
    render(
      <PinnedAppNavItem
        app={TEAL_APP}
        active={false}
        collapsed={false}
        onOpen={() => {}}
      />,
    );
    const expanded = tintOf(screen.getByRole("button", { name: "My App" }));

    cleanup();
    render(<PinnedAppNavItem app={TEAL_APP} active={false} collapsed />);

    expect(tintOf(screen.getByTestId("app-row"))).toEqual(expanded);
  });

  /* Stored ids outlive the palette. An id the registry no longer carries has
     to paint nothing rather than resolve to a broken colour value. */
  test("a colour id the registry does not know paints no tint", () => {
    render(
      <PinnedAppNavItem
        app={{ ...APP, color: "not-a-real-color" }}
        active={false}
        collapsed={false}
        onOpen={() => {}}
      />,
    );

    expect(tintOf(screen.getByRole("button", { name: "My App" })).bg).toBe("");
  });

  test("picking a swatch stores the colour on the pin", () => {
    seedPin(APP);

    render(<PinnedAppNavItem app={APP} active={false} collapsed={false} />);
    fireEvent.click(screen.getByRole("button", { name: "teal" }));

    expect(usePinnedAppsStore.getState().pinnedApps[0]!.color).toBe("teal");
  });

  test("picking No color clears a colour the pin already had", () => {
    seedPin(APP);
    usePinnedAppsStore.getState().setColor(APP.appId, "teal");

    render(
      <PinnedAppNavItem app={TEAL_APP} active={false} collapsed={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "No color, selected" }));

    expect(usePinnedAppsStore.getState().pinnedApps[0]!.color).toBeUndefined();
  });

  /* The ring marking the current colour is invisible to a screen reader, so
     the selected swatch has to say so in its name. */
  test("names the pin's current colour as the selected swatch", () => {
    render(
      <PinnedAppNavItem app={TEAL_APP} active={false} collapsed={false} />,
    );

    expect(screen.getByRole("button", { name: "teal, selected" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "No color, selected" }),
    ).toBeNull();
  });

  test("collapsed rail: the colour row is omitted with the rest of the menu", () => {
    render(<PinnedAppNavItem app={TEAL_APP} active={false} collapsed />);

    expect(screen.queryByRole("button", { name: "teal, selected" })).toBeNull();
  });

  /* `aria-current="page"` rather than a `data-active` attribute: the pill's
     active state is the one assistive tech reads, and it is what the pill's
     own active styling is keyed off (`aria-[current=page]:` classes), so
     asserting it covers both. Both states, because an attribute that is always
     set marks every row as the current one. */
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
