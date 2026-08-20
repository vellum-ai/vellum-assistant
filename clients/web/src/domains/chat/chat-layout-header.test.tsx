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

import { usePageSurfaceStore } from "@/stores/page-surface-store";

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
    use: {
      setInlineTitleBarActive: () => setInlineTitleBarActiveSpy,
      windowsMenuBarSuppressed: () => false,
    },
  },
}));

let mockIsNativeMobile = false;
let mockElectronHostOS: "macos" | "windows" | null = null;
mock.module("@/runtime/platform-detection", () => ({
  detectElectronHostOS: () =>
    mockIsElectron ? (mockElectronHostOS ?? "macos") : null,
  isNativeMobile: () => mockIsNativeMobile,
}));

// Imported after the mocks so the header picks up the mocked modules.
const { ChatLayoutHeader } = await import("@/domains/chat/chat-layout-header");

beforeEach(() => {
  mockIsElectron = false;
  mockIsNativeMobile = false;
  mockElectronHostOS = null;
  usePageSurfaceStore.getState().setSurface(null);
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

describe("ChatLayoutHeader page surface", () => {
  function headerElement() {
    return document.querySelector<HTMLElement>(
      '[data-slot="chat-layout-header"]',
    );
  }

  test("takes the route's published surface on the native shells", () => {
    mockIsNativeMobile = true;
    usePageSurfaceStore.getState().setSurface("var(--surface-overlay)");

    renderHeader();

    // Continuous with the safe-area strips, which resolve the same way.
    expect(headerElement()?.style.background).toBe("var(--surface-overlay)");
  });

  test("keeps the neutral chrome off the native shells", () => {
    mockIsNativeMobile = false;
    usePageSurfaceStore.getState().setSurface("var(--surface-overlay)");

    renderHeader();

    expect(headerElement()?.style.background).toBe("var(--surface-base)");
  });

  test("keeps the neutral chrome on a route that publishes nothing", () => {
    mockIsNativeMobile = true;

    renderHeader();

    expect(headerElement()?.style.background).toBe("var(--surface-base)");
  });
});

describe("ChatLayoutHeader desktop chrome", () => {
  test("reserves the Windows title-bar control area", () => {
    mockIsElectron = true;
    mockElectronHostOS = "windows";
    renderHeader();

    const header = document.querySelector<HTMLElement>(
      '[data-slot="chat-layout-header"]',
    );
    expect(header?.style.paddingRight).toBe("150px");
  });
});
