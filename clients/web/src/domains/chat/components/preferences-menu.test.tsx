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

import type { PreferencesUsage } from "@/domains/chat/hooks/use-preferences-usage";
import type { AuthUser } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

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
const obscureCreditsRef = { value: false };

mock.module("@/stores/client-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    velvet: () => false,
    obscureCredits: () => obscureCreditsRef.value,
  };
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
  data: undefined as
    { effective_balance: string; available_usage_balance?: string } | undefined,
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

// Capture navigate() targets so the menu's destinations can be asserted
// without a live Router.
let navigateArgs: unknown[] = [];
mock.module("react-router", () => ({
  useNavigate: () => (to: unknown) => {
    navigateArgs.push(to);
  },
}));

mock.module("@/components/share-feedback-modal", () => ({
  ShareFeedbackModal: () => null,
}));

// The panel owns its own reads (subscription, plan catalog, usage totals),
// which this suite's partial `@tanstack/react-query` mock cannot host. Its
// rendering is covered by `preferences-usage-panel.test.tsx`; what the menu
// owns is where the panel sits and what its two actions do.
const panelPropsRef: { conversationId?: string | null } = {};
mock.module("@/domains/chat/components/preferences-usage-panel", () => ({
  PreferencesUsagePanel: ({
    onOpenBilling,
    onAddCredits,
    conversationId,
  }: {
    onOpenBilling: () => void;
    onAddCredits?: () => void;
    conversationId?: string | null;
  }) => {
    panelPropsRef.conversationId = conversationId;
    return createElement(
      "div",
      { "data-testid": "preferences-usage" },
      createElement("button", { onClick: onOpenBilling }, "Usage settings"),
      // The real panel drops the strip's button with the handler, so the stub
      // has to as well or the Android gate reads as covered when it is not.
      onAddCredits
        ? createElement("button", { onClick: onAddCredits }, "Add usage credits")
        : null,
    );
  },
}));

mock.module("@/components/add-credits-modal", () => ({
  AddCreditsModal: ({ open }: { open: boolean }) =>
    open ? createElement("div", { "data-testid": "add-credits-modal" }) : null,
}));

// The reading itself is composed from three billing queries this suite's
// partial `@tanstack/react-query` mock cannot host, and is covered by
// `preferences-usage-panel.test.tsx`. What the menu owns is the rule it
// applies to the reading, so only the data is stubbed here.
const usageRef: { value: PreferencesUsage | null; opts: unknown } = {
  value: null,
  opts: undefined,
};
mock.module("@/domains/chat/hooks/use-preferences-usage", () => ({
  usePreferencesUsage: (opts?: unknown) => {
    usageRef.opts = opts;
    return usageRef.value;
  },
}));

mock.module("@/domains/chat/components/credits-card", () => ({
  CreditsCard: ({
    balance,
    onAddCredits,
  }: {
    balance: string;
    onAddCredits?: () => void;
  }) =>
    createElement(
      "div",
      { "data-testid": "credits-card" },
      balance,
      onAddCredits
        ? createElement("button", { onClick: onAddCredits }, "Add credits")
        : null,
    ),
}));

const { PreferencesMenu, showsMenuCredits } =
  await import("@/domains/chat/components/preferences-menu");

/** Opens the menu the way a touch user does, and returns the open surface. */
async function openMenu(
  props: { activeConversationId?: string | null } = {},
): Promise<void> {
  isTouchMobileRef.value = true;
  render(<PreferencesMenu {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Preferences/i }));
    await Promise.resolve();
  });
}

/** A reading at `ratio`, with the wallet behind it empty or not. */
function usage(ratio: number, walletEmpty = false): PreferencesUsage {
  const spent = ratio >= 1;
  return {
    ratio,
    resetsAt: "2026-09-01T00:00:00Z",
    spent,
    exhausted: spent && walletEmpty,
  };
}

beforeEach(() => {
  navigateArgs = [];
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
  obscureCreditsRef.value = false;
  usageRef.value = null;
  usageRef.opts = undefined;
  panelPropsRef.conversationId = undefined;
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

  test("the usage panel sits above the menu's destinations", async () => {
    await openMenu();

    const panel = screen.getByTestId("preferences-usage");
    const settings = screen.getByText("Settings");
    // The panel reads the plan; the rows below it go somewhere.
    expect(
      panel.compareDocumentPosition(settings) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("the open conversation reaches both readings of the usage", async () => {
    await openMenu({ activeConversationId: "conv-7" });

    // The row's rule and the panel's bar have to classify the wallet against
    // the same chat, or one of them calls it exhausted while the other does
    // not.
    expect(usageRef.opts).toEqual({ conversationId: "conv-7" });
    expect(panelPropsRef.conversationId).toBe("conv-7");
  });

  test("the panel's gear opens the Billing tab and closes the menu", async () => {
    await openMenu();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Usage settings" }));
      await Promise.resolve();
    });

    expect(navigateArgs).toEqual([routes.settings.usageBilling]);
    expect(screen.queryByTestId("preferences-usage")).toBeNull();
  });

  test("the panel's add-credits action opens the checkout", async () => {
    await openMenu();
    expect(screen.queryByTestId("add-credits-modal")).toBeNull();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Add usage credits" }),
      );
      await Promise.resolve();
    });

    // The menu closes as it goes, so the modal has to outlive the surface it
    // was opened from.
    expect(await screen.findByTestId("add-credits-modal")).toBeTruthy();
    expect(screen.queryByTestId("preferences-usage")).toBeNull();
  });

  test("native Android leaves the panel with nothing to buy", async () => {
    nativeAndroidRef.value = true;
    await openMenu();

    // Consumption-only: the panel is still the reading, but no surface in the
    // menu may offer a purchase.
    expect(screen.getByTestId("preferences-usage")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Add usage credits" }),
    ).toBeNull();
  });

  test("off native Android the panel keeps its add-credits action", async () => {
    await openMenu();

    expect(
      screen.getByRole("button", { name: "Add usage credits" }),
    ).toBeTruthy();
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

describe("PreferencesMenu credits row under obscure-credits", () => {
  test("the flag off keeps the row exactly as it is today", async () => {
    billingRef.data = { effective_balance: "60.4" };
    // No reading at all, which is what an org with nothing to measure has.
    await openMenu();

    expect(screen.getByTestId("credits-card")).toBeTruthy();
  });

  test("the row is hidden while the bundle still has room", async () => {
    obscureCreditsRef.value = true;
    billingRef.data = { effective_balance: "60.4" };
    usageRef.value = usage(0.68);
    await openMenu();

    expect(screen.queryByTestId("credits-card")).toBeNull();
  });

  test("a spent bundle with credits left surfaces the row", async () => {
    obscureCreditsRef.value = true;
    billingRef.data = { effective_balance: "60.4" };
    usageRef.value = usage(1);
    await openMenu();

    // The usage panel is red at this point; the wallet is what the next turn
    // spends, so the row that names it belongs on screen.
    expect(screen.getByTestId("preferences-usage")).toBeTruthy();
    expect(screen.getByTestId("credits-card")).toBeTruthy();
  });

  test("the row names only the credit held on top of the usage grants", async () => {
    obscureCreditsRef.value = true;
    billingRef.data = {
      effective_balance: "34.65",
      available_usage_balance: "9.10",
    };
    usageRef.value = usage(1);
    await openMenu();

    // The grants are what the bar above measures, so the row states the
    // bought-and-earned credit alone.
    expect(screen.getByTestId("credits-card").textContent).toContain("25.55");
  });

  test("the flag off names the whole balance", async () => {
    billingRef.data = {
      effective_balance: "34.65",
      available_usage_balance: "9.10",
    };
    await openMenu();

    expect(screen.getByTestId("credits-card").textContent).toContain("34.65");
  });

  test("a free plan's used-up grant with credits left surfaces the row", async () => {
    obscureCreditsRef.value = true;
    billingRef.data = { effective_balance: "12.00" };
    // A wallet reading never resets. The whole usage grant is gone, so the
    // bar is red, while purchased credits still cover the next turn.
    usageRef.value = {
      ratio: 1,
      resetsAt: null,
      spent: true,
      exhausted: false,
    };
    await openMenu();

    expect(screen.getByTestId("preferences-usage")).toBeTruthy();
    expect(screen.getByTestId("credits-card")).toBeTruthy();
  });

  test("a spent bundle with an empty wallet leaves the strip to say it", async () => {
    obscureCreditsRef.value = true;
    billingRef.data = { effective_balance: "0" };
    usageRef.value = usage(1, true);
    await openMenu();

    expect(screen.queryByTestId("credits-card")).toBeNull();
  });

  test("the flag on with nothing to measure keeps the row", async () => {
    obscureCreditsRef.value = true;
    billingRef.data = { effective_balance: "60.4" };
    await openMenu();

    // The real panel renders nothing without a reading, so the row is the only
    // balance and the only way to buy more.
    expect(screen.getByTestId("credits-card")).toBeTruthy();
  });
});

describe("showsMenuCredits", () => {
  test("the flag off always shows the row", () => {
    expect(showsMenuCredits(false, null)).toBe(true);
    expect(showsMenuCredits(false, usage(0.4))).toBe(true);
    expect(showsMenuCredits(false, usage(1, true))).toBe(true);
  });

  test("the flag on shows it only for a spent bundle with credits left", () => {
    expect(showsMenuCredits(true, usage(0.99))).toBe(false);
    expect(showsMenuCredits(true, usage(1))).toBe(true);
    expect(showsMenuCredits(true, usage(1, true))).toBe(false);
  });

  test("an unmeasurable reading falls back to showing the row", () => {
    expect(showsMenuCredits(true, null)).toBe(true);
  });
});
