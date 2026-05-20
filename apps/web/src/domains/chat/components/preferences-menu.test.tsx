/**
 * Tests for `PreferencesMenu`.
 *
 * Uses `renderToStaticMarkup` (SSR) so only the trigger and top-level
 * structure are exercisable — Radix Popover/BottomSheet content is not
 * rendered when `open={false}`. Interactive content tests (menu items,
 * admin visibility, credits row) would require a DOM environment with
 * React Testing Library.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile.js", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const authRef = {
  isLoggedIn: true,
  user: { id: "u1", email: "user@example.com", isStaff: false, username: null, firstName: "", lastName: "" },
  logout: async () => {},
};

mock.module("@/stores/auth-store.js", () => {
  const store = () => null;
  store.use = {
    isLoggedIn: () => authRef.isLoggedIn,
    user: () => authRef.user,
    logout: () => authRef.logout,
  };
  store.getState = () => authRef;
  return { useAuthStore: store };
});

const flagsRef = { referralCodes: false, referralCodesAdmin: false };

mock.module("@/lib/feature-flags/app.js", () => ({
  useAppFeatureFlags: () => flagsRef,
}));

const billingRef = { data: undefined as { effective_balance: string } | undefined };

mock.module("@tanstack/react-query", () => ({
  useQuery: () => ({ data: billingRef.data, isLoading: false, isError: false }),
}));

mock.module("@/generated/api/@tanstack/react-query.gen.js", () => ({
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

mock.module("@/components/share-feedback-modal.js", () => ({
  ShareFeedbackModal: () => null,
}));

mock.module("@/components/earn-credits-modal.js", () => ({
  EarnCreditsModal: () => null,
}));

mock.module("@/components/theme-toggle.js", () => ({
  ThemeToggle: () => createElement("div", { "data-testid": "theme-toggle" }, "Theme"),
}));

import { PreferencesMenu } from "@/domains/chat/components/preferences-menu.js";

beforeEach(() => {
  isMobileRef.value = false;
  authRef.isLoggedIn = true;
  authRef.user = { id: "u1", email: "user@example.com", isStaff: false, username: null, firstName: "", lastName: "" };
  flagsRef.referralCodes = false;
  billingRef.data = undefined;
});

describe("PreferencesMenu", () => {
  test("renders nothing when not logged in", () => {
    authRef.isLoggedIn = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toBe("");
  });

  test("renders a Preferences trigger when logged in", () => {
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  test("desktop renders trigger (Popover surface)", () => {
    isMobileRef.value = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  test("mobile renders trigger (BottomSheet surface)", () => {
    isMobileRef.value = true;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });
});
