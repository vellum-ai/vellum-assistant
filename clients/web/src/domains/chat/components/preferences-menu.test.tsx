/**
 * Tests for `PreferencesMenu`.
 *
 * Uses `renderToStaticMarkup` (SSR) so only the trigger and top-level
 * structure are exercisable — Radix Popover/BottomSheet content is not
 * rendered when `open={false}`. Interactive content tests (menu items,
 * admin visibility, credits row) would require a DOM environment with
 * React Testing Library.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { SideMenu } from "@vellumai/design-library";

import type { AuthUser } from "@/stores/auth-store";

const isTouchMobileRef = { value: false };
const nativeAndroidRef = { value: false };

mock.module("@/hooks/use-touch-mobile", () => ({
  useTouchMobile: () => isTouchMobileRef.value,
  TOUCH_MOBILE_MEDIA_QUERY: "(width < 48rem) and (pointer: coarse)",
}));

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => nativeAndroidRef.value,
}));

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsPlatformHosted: () => true,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

// The BYOK gate pulls the daemon generated client (and its real
// `queryOptions` import) into the graph; this suite's partial
// `@tanstack/react-query` mock cannot host that, and the menu only reads
// `enabled`/`balance`, which the gate never touches.
mock.module("@/hooks/use-byok-credit-banner-gate", () => ({
  useSuppressCreditBannersForByok: () => false,
}));

const authRef: {
  isAuthenticated: boolean;
  user: AuthUser;
  logout: () => Promise<void>;
} = {
  isAuthenticated: true,
  user: {
    kind: "platform",
    id: "u1",
    email: "user@example.com",
    isStaff: false,
    username: null,
    firstName: "",
    lastName: "",
  },
  logout: async () => {},
};

mock.module("@/stores/auth-store", () => {
  const store = () => null;
  store.use = {
    user: () => authRef.user,
    logout: () => authRef.logout,
  };
  store.getState = () => authRef;
  return {
    useAuthStore: store,
    useIsAuthenticated: () => authRef.isAuthenticated,
  };
});

const flagsRef = {};

mock.module("@/stores/client-feature-flag-store", () => {
  const store = () => null;
  store.use = { velvet: () => false };
  store.getState = () => flagsRef;
  return { useClientFeatureFlagStore: store };
});

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {};
  store.getState = () => flagsRef;
  return { useAssistantFeatureFlagStore: store };
});

const billingRef = {
  data: undefined as { effective_balance: string } | undefined,
};

mock.module("@tanstack/react-query", () => ({
  useQuery: () => ({ data: billingRef.data, isLoading: false, isError: false }),
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  organizationsBillingSummaryRetrieveOptions: () => ({
    queryKey: [{ _id: "organizationsBillingSummaryRetrieve" }],
  }),
  referralCodesMeRetrieveOptions: () => ({
    queryKey: [{ _id: "referralCodesMeRetrieve" }],
  }),
}));

mock.module("react-router", () => ({
  useNavigate: () => () => {},
}));

mock.module("@/components/share-feedback-modal", () => ({
  ShareFeedbackModal: () => null,
}));

mock.module("@/domains/chat/components/credits-card", () => ({
  CreditsCard: ({ onAddCredits }: { onAddCredits?: () => void }) =>
    createElement(
      "div",
      { "data-testid": "credits-card" },
      "Credits",
      onAddCredits
        ? createElement("button", { onClick: onAddCredits }, "Add credits")
        : null,
    ),
}));

const { PreferencesMenu } =
  await import("@/domains/chat/components/preferences-menu");

beforeEach(() => {
  isTouchMobileRef.value = false;
  nativeAndroidRef.value = false;
  authRef.isAuthenticated = true;
  authRef.user = {
    kind: "platform",
    id: "u1",
    email: "user@example.com",
    isStaff: false,
    username: null,
    firstName: "",
    lastName: "",
  };
  billingRef.data = undefined;
});

afterEach(() => {
  cleanup();
});

describe("PreferencesMenu", () => {
  test("renders nothing when not logged in", () => {
    authRef.isAuthenticated = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toBe("");
  });

  // A platform account with every identity field populated is the case most
  // able to leak one into the trigger, so it is the one asserted against.
  test("labels the trigger 'Preferences', never the account identity", () => {
    authRef.user = {
      kind: "platform",
      id: "u1",
      email: "user@example.com",
      isStaff: false,
      username: "jdoe",
      firstName: "Jane",
      lastName: "Doe",
    };
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
    expect(html).not.toContain("Jane Doe");
    expect(html).not.toContain("jdoe");
    expect(html).not.toContain("user@example.com");
  });

  test("labels the trigger 'Preferences' for the local gateway user", () => {
    // Mirrors GATEWAY_LOCAL_USER: name fields are populated but identify no
    // real account, so they must not surface as a profile.
    authRef.user = {
      kind: "local",
      id: "gateway-local",
      email: null,
      isStaff: false,
      username: "local",
      firstName: "Local",
      lastName: "User",
    };
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
    expect(html).not.toContain("Local User");
  });

  test("desktop renders trigger (Popover surface)", () => {
    isTouchMobileRef.value = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  test("mobile renders trigger (BottomSheet surface)", () => {
    isTouchMobileRef.value = true;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  /* The collapsed rail fits one tile and a pill is sized by its content, so a
     labelled trigger rendered there is clipped mid-word. The tile is not that
     pill with `display:none` on its label: it is a fixed square centring its
     glyph, the same affordance the pinned apps and section tiles reduce to.

     The collapsed `SideMenu` is the whole input: the trigger reads the rail's
     state from that context and takes no prop for it, so this renders the
     component the way the sidebar does and cannot pass a value the menu
     disagrees with. Outside a rail it is an ordinary row, so a bare render
     would assert nothing. */
  function collapsedRailMarkup(): string {
    return renderToStaticMarkup(
      <SideMenu ariaLabel="Assistant navigation" variant="rail" collapsed>
        <SideMenu.Footer>
          <PreferencesMenu />
        </SideMenu.Footer>
      </SideMenu>,
    );
  }

  /** Text a sighted user would read, with every tag and attribute stripped. */
  function visibleText(html: string): string {
    return html.replace(/<[^>]*>/g, "").trim();
  }

  test("collapsed rail drops the label and centers the glyph in a fixed tile", () => {
    const html = collapsedRailMarkup();

    // Fixed square, centered in the rail column, fully rounded - not a
    // content-width capsule that the rail then crops.
    expect(html).toContain("size-[var(--side-menu-tile-size)]");
    expect(html).toContain("mx-auto");
    // Nothing to clip: the label is not rendered at all.
    expect(visibleText(html)).toBe("");
    // …and the control is still named, for assistive tech and the tooltip.
    expect(html).toContain('aria-label="Preferences"');
  });

  test("collapsed trigger stays a keyboard-reachable menu control", () => {
    const html = collapsedRailMarkup();

    // A real tab stop that announces what it opens. The rail's own
    // `aria-current` is for destinations; this opens a menu over the rail.
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('aria-current="page"');
    expect(html).not.toContain('tabindex="-1"');
  });

  test("expanded rail keeps the labeled pill", () => {
    const html = renderToStaticMarkup(
      <SideMenu ariaLabel="Assistant navigation" variant="rail">
        <SideMenu.Footer>
          <PreferencesMenu />
        </SideMenu.Footer>
      </SideMenu>,
    );

    // The label is visible text here, not just an accessible name, and the
    // trigger is the content-sized pill it shares with the pinned apps.
    expect(visibleText(html)).toContain("Preferences");
    expect(html).toContain("w-fit");
    expect(html).not.toContain("size-[var(--side-menu-tile-size)]");
  });

  test("native Android shows the balance without an add-credits action", async () => {
    nativeAndroidRef.value = true;
    isTouchMobileRef.value = true;
    billingRef.data = { effective_balance: "60" };
    render(<PreferencesMenu />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Preferences/i }));
      await Promise.resolve();
    });

    expect(screen.getByTestId("credits-card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add credits" })).toBeNull();
  });
});
