/**
 * Tests for `ChatLayoutHeader`'s right-cluster composition.
 *
 * The header is presentational, so tests drive it through props. The cluster
 * renders its occupants inline in one order (leading slot, search, the route's
 * own slot) and nothing folds them away: an off-conversation voice session
 * takes the row above the header on a phone rather than a seat in it.
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

describe("ChatLayoutHeader — right cluster", () => {
  test("renders the leading slot, search and the route slot inline", () => {
    renderHeader({
      topBarRightLeading: <div data-testid="voice-pill" />,
      topBarRightSlot: <button type="button">Notifications</button>,
    });
    expect(screen.getByTestId("voice-pill")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Search (Ctrl+K)" }),
    ).toBeTruthy();
    expect(screen.getByText("Notifications")).toBeTruthy();
    // Nothing folds the cluster away: no overflow menu to open.
    expect(screen.queryByRole("button", { name: "More controls" })).toBeNull();
  });

  test("search reaches the command palette", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Search (Ctrl+K)" }));
    expect(toggleCommandPaletteSpy).toHaveBeenCalledTimes(1);
  });
});

describe("ChatLayoutHeader mobile affordances", () => {
  test("renders the hamburger and search affordances with their aria wiring", () => {
    renderHeader({ drawerOpen: false });

    const hamburger = screen.getByRole("button", { name: "Open navigation" });
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
    expect(hamburger.getAttribute("aria-controls")).toBe("chat-side-menu");
    expect(
      screen.getByRole("button", { name: "Search (Ctrl+K)" }),
    ).toBeTruthy();
  });
});
