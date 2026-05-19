/**
 * Tests for `PreferencesMenu`.
 *
 * Coverage focuses on the surface-selection contract added by PR 6 of the
 * `mobile-ui-figma-parity` plan:
 *   - On desktop (`useIsMobile() === false`) the trigger opens a Radix
 *     Popover. We detect this via the `data-radix-popper-content-wrapper`
 *     positioning element that Radix Popover emits but Radix Dialog does not,
 *     and via the absence of the BottomSheet's bottom-anchored overlay.
 *   - On mobile (`useIsMobile() === true`) the trigger opens the BottomSheet
 *     (Radix Dialog). We detect this by the `bottom-0` positioning class on
 *     the rendered Content. The BottomSheet intentionally omits the auto X
 *     close button (dismissal flows through Escape / backdrop tap / item
 *     action), and menu items still fire their handlers (we sample Settings,
 *     which calls `router.push(routes.settings.root)`).
 *
 * Both Popover and Dialog set `role="dialog"`, so that role alone cannot
 * distinguish the two surfaces — the structural classes / wrapper element are
 * the reliable signal.
 *
 * Heavy upstream dependencies (`useAuth`, `useAppFeatureFlags`, `useRouter`,
 * `useQuery` for billing) are mocked at the module level via
 * `mock.module(...)` — bun's preferred convention as established by
 * `AssistantShell.test.tsx`, `PrivacyScreen.test.tsx`, etc. The downstream
 * Modals are stubbed to inert nodes so we don't assert on their internals.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject is imported.
// ---------------------------------------------------------------------------

const isMobileRef = { value: false };

mock.module("@/lib/hooks/useIsMobile.js", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const routerCalls = { pushed: [] as string[] };

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      routerCalls.pushed.push(href);
    },
    back: () => {},
    replace: () => {},
    refresh: () => {},
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const logoutMock = mock(async () => {});

mock.module("@/lib/auth.js", () => ({
  useAuth: () => ({
    userId: "test-user",
    isLoggedIn: true,
    isAdmin: false,
    isLoading: false,
    logout: logoutMock,
  }),
}));

mock.module("@/lib/feature-flags/app.js", () => ({
  useAppFeatureFlags: () => ({
    referralCodes: false,
    referralCodesAdmin: false,
  }),
}));

// PreferencesMenu only consumes `useQuery` for the billing summary balance;
// returning `data: undefined` keeps the credits row hidden so the menu
// renders deterministically without needing a balance fixture.
mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

mock.module("@/clients/platform/@tanstack/react-query.gen", () => ({
  organizationsBillingSummaryRetrieveOptions: () => ({
    queryKey: [{ _id: "organizationsBillingSummaryRetrieve" }],
  }),
}));

// Stub the downstream modals — they pull in form/api dependencies we
// don't need here. The PreferencesMenu open/close logic for them is
// orthogonal to the surface-selection behavior under test.
mock.module("@/components/shared/ShareFeedbackModal/index.js", () => ({
  ShareFeedbackModal: () => null,
}));

mock.module("@/components/shared/UserMenu/EarnCreditsModal.js", () => ({
  EarnCreditsModal: () => null,
}));

// ---------------------------------------------------------------------------
// Subject (imported AFTER mocks)
// ---------------------------------------------------------------------------

import { cleanup, render, screen, userEvent } from "@/test-utils.js";

import { routes } from "@/lib/routes.js";
import { PreferencesMenu } from "@/components/shared/preferences-menu/preferences-menu.js";

beforeEach(() => {
  isMobileRef.value = false;
  routerCalls.pushed = [];
  logoutMock.mockClear();
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

afterEach(cleanup);

describe("PreferencesMenu — desktop (Popover)", () => {
  test("clicking the trigger opens content inside the Radix Popper wrapper", async () => {
    isMobileRef.value = false;
    render(<PreferencesMenu />);

    // Closed state: the body content is not in the DOM.
    expect(screen.queryByText("Settings")).toBeNull();

    const trigger = screen.getByRole("button", { name: /Preferences/i });
    await userEvent.click(trigger);

    // Open state: the body's "Settings" row is rendered.
    const settingsRow = screen.getByText("Settings");
    expect(settingsRow).toBeInTheDocument();

    // The desktop Popover surface is built on Radix Popper, which wraps
    // its Content in a positioned `data-radix-popper-content-wrapper`
    // element. The mobile BottomSheet (Radix Dialog) does not emit this
    // wrapper — its absence on mobile is what differentiates the two
    // surfaces, since both internally set `role=dialog`.
    expect(
      document.querySelector("[data-radix-popper-content-wrapper]"),
    ).not.toBeNull();

    // And no BottomSheet wrapper class appears on any rendered dialog.
    const dialogs = screen.queryAllByRole("dialog");
    for (const d of dialogs) {
      expect(d.className).not.toContain("bottom-0");
    }
  });
});

describe("PreferencesMenu — mobile (BottomSheet)", () => {
  test("clicking the trigger opens the BottomSheet (Dialog) at the bottom of the viewport", async () => {
    isMobileRef.value = true;
    render(<PreferencesMenu />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      document.querySelector("[data-radix-popper-content-wrapper]"),
    ).toBeNull();

    const trigger = screen.getByRole("button", { name: /Preferences/i });
    await userEvent.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-state")).toBe("open");
    // The bottom-sheet positioning class — proves we're inside our
    // BottomSheet wrapper, not a Popover Content.
    expect(dialog.className).toContain("bottom-0");
    // And mobile does NOT use the Popper positioning wrapper.
    expect(
      document.querySelector("[data-radix-popper-content-wrapper]"),
    ).toBeNull();
  });

  test("the bottom sheet does not render an auto × close button (dismissal is via item action / Escape / backdrop)", async () => {
    isMobileRef.value = true;
    render(<PreferencesMenu />);

    await userEvent.click(screen.getByRole("button", { name: /Preferences/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // The BottomSheet primitive intentionally omits the auto-rendered X
    // close button — bottom sheets dismiss via Escape, backdrop tap, or a
    // menu-item action that calls `onClose`.
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  test("menu items remain clickable inside the bottom sheet", async () => {
    isMobileRef.value = true;
    render(<PreferencesMenu />);

    await userEvent.click(screen.getByRole("button", { name: /Preferences/i }));

    const settings = screen.getByRole("button", { name: /Settings/i });
    await userEvent.click(settings);

    // The Settings row's onSelect runs `router.push(routes.settings.root)`
    // and calls onClose, which collapses the sheet.
    expect(routerCalls.pushed).toContain(routes.settings.root);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
