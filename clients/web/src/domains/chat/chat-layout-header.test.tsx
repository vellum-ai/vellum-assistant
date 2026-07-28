/**
 * Tests for `ChatLayoutHeader`'s right-cluster composition.
 *
 * The header is presentational, so tests drive it through props. Focus is the
 * `collapseRightCluster` arm: while the voice-session pill occupies the row
 * the remaining controls fold behind a ⋯ popover, the leading slot stays
 * outside it, and the popover opens to reach what it swallowed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let mockIsElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => mockIsElectron,
}));

const toggleCommandPaletteSpy = mock(() => {});
mock.module("@/stores/command-palette-store", () => ({
  useCommandPaletteStore: {
    use: { toggle: () => toggleCommandPaletteSpy },
  },
}));

const setInlineTitleBarActiveSpy = mock((_active: boolean) => {});
mock.module("@/stores/title-bar-store", () => ({
  useTitleBarStore: {
    use: { setInlineTitleBarActive: () => setInlineTitleBarActiveSpy },
  },
}));

// Imported after the mocks so the header picks up the mocked modules.
const { ChatLayoutHeader } = await import("@/domains/chat/chat-layout-header");

beforeEach(() => {
  mockIsElectron = false;
  toggleCommandPaletteSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

function renderHeader(
  props: Partial<React.ComponentProps<typeof ChatLayoutHeader>> = {},
) {
  return render(
    <ChatLayoutHeader
      isMobile
      drawerOpen={false}
      collapsed={false}
      toggleSidebar={() => {}}
      {...props}
    />,
  );
}

const overflowTrigger = () =>
  screen.queryByRole("button", { name: "More controls" });

describe("ChatLayoutHeader — right cluster", () => {
  test("renders the controls inline when not collapsed", () => {
    renderHeader({
      topBarRightLeading: <div data-testid="voice-pill" />,
      topBarRightSlot: <button type="button">Notifications</button>,
    });
    expect(screen.getByTestId("voice-pill")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Search (Ctrl+K)" }),
    ).toBeTruthy();
    expect(screen.getByText("Notifications")).toBeTruthy();
    expect(overflowTrigger()).toBeNull();
  });

  test("collapsed: folds search and the slot behind ⋯, keeping the leading slot out", () => {
    renderHeader({
      collapseRightCluster: true,
      topBarRightLeading: <div data-testid="voice-pill" />,
      topBarRightSlot: <button type="button">Notifications</button>,
    });
    // The live-session indicator stays in the chrome — it must not be
    // something the user opens a menu to discover.
    expect(screen.getByTestId("voice-pill")).toBeTruthy();
    expect(overflowTrigger()).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Search (Ctrl+K)" }),
    ).toBeNull();
    expect(screen.queryByText("Notifications")).toBeNull();
  });

  test("the ⋯ trigger opens, revealing the collapsed controls", () => {
    // The collapse hides real affordances, so the trigger reaching them is
    // the load-bearing part.
    renderHeader({
      collapseRightCluster: true,
      topBarRightLeading: <div data-testid="voice-pill" />,
      topBarRightSlot: <button type="button">Notifications</button>,
    });

    fireEvent.click(overflowTrigger()!);

    expect(
      screen.getByRole("button", { name: "Search (Ctrl+K)" }),
    ).toBeTruthy();
    expect(screen.getByText("Notifications")).toBeTruthy();
  });

  test("search inside the popover still reaches the command palette", () => {
    renderHeader({ collapseRightCluster: true });
    fireEvent.click(overflowTrigger()!);
    fireEvent.click(screen.getByRole("button", { name: "Search (Ctrl+K)" }));
    expect(toggleCommandPaletteSpy).toHaveBeenCalledTimes(1);
  });
});
