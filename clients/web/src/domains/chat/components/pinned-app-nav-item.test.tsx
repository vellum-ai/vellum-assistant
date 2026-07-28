/**
 * Tests for `PinnedAppNavItem`.
 *
 * The design-library `SideMenu.Item` and `ContextMenu` primitives are mocked
 * with lightweight elements so these tests exercise the component's
 * composition and store wiring (open, unpin, collapsed omission) rather than
 * Radix ContextMenu internals. `onSelect` is surfaced as an `onClick` so
 * happy-dom can drive it.
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
    Item: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) =>
      createElement("button", { type: "button", onClick: onSelect }, children),
  };
  return { SideMenu, ContextMenu };
});

import { PinnedAppNavItem } from "@/domains/chat/components/pinned-app-nav-item";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { PinnableApp, PinnedAppEntry } from "@/utils/app-pin-storage";

const APP: PinnedAppEntry = { appId: "app-1", pinnedOrder: 1, name: "My App", icon: "🚀" };

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
      <PinnedAppNavItem app={APP} active={false} collapsed={false} onOpen={onOpen} />,
    );

    const row = screen.getByTestId("app-row");
    expect(row.textContent).toBe("My App");

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

  test("collapsed rail: renders the row without the context-menu wrapper", () => {
    render(<PinnedAppNavItem app={APP} active={false} collapsed />);

    expect(screen.getByTestId("app-row").textContent).toBe("My App");
    expect(screen.queryByTestId("ctx-root")).toBeNull();
    expect(screen.queryByRole("button", { name: "Unpin" })).toBeNull();
  });

  test("marks the row active when active is true", () => {
    render(<PinnedAppNavItem app={APP} active collapsed={false} />);
    expect(screen.getByTestId("app-row").getAttribute("data-active")).toBe("true");
  });
});
