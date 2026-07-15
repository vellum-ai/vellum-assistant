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

import type { AuthUser } from "@/stores/auth-store";

const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
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
  store.use = {};
  store.getState = () => flagsRef;
  return { useClientFeatureFlagStore: store };
});

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {};
  store.getState = () => flagsRef;
  return { useAssistantFeatureFlagStore: store };
});

const billingRef = { data: undefined as { effective_balance: string } | undefined };

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
  CreditsCard: () => createElement("div", { "data-testid": "credits-card" }, "Credits"),
}));

import { PreferencesMenu } from "@/domains/chat/components/preferences-menu";

beforeEach(() => {
  isMobileRef.value = false;
  authRef.isAuthenticated = true;
  authRef.user = { kind: "platform", id: "u1", email: "user@example.com", isStaff: false, username: null, firstName: "", lastName: "" };
  billingRef.data = undefined;
});

describe("PreferencesMenu", () => {
  test("renders nothing when not logged in", () => {
    authRef.isAuthenticated = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toBe("");
  });

  test("labels the trigger with the account's full name when present", () => {
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
    expect(html).toContain("Jane Doe");
  });

  test("falls back to username, then email, then the generic label", () => {
    // username fallback (no name)
    authRef.user = {
      kind: "platform",
      id: "u1",
      email: "user@example.com",
      isStaff: false,
      username: "jdoe",
      firstName: "",
      lastName: "",
    };
    expect(
      renderToStaticMarkup(createElement(PreferencesMenu)),
    ).toContain("jdoe");

    // email fallback (no name, no username)
    authRef.user = {
      kind: "platform",
      id: "u1",
      email: "user@example.com",
      isStaff: false,
      username: null,
      firstName: "",
      lastName: "",
    };
    expect(
      renderToStaticMarkup(createElement(PreferencesMenu)),
    ).toContain("user@example.com");

    // generic label (nothing identifying)
    authRef.user = {
      kind: "platform",
      id: "u1",
      email: null,
      isStaff: false,
      username: null,
      firstName: "",
      lastName: "",
    };
    expect(
      renderToStaticMarkup(createElement(PreferencesMenu)),
    ).toContain("Preferences");
  });

  test("desktop renders trigger (Popover surface)", () => {
    isMobileRef.value = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("user@example.com");
  });

  test("mobile renders trigger (BottomSheet surface)", () => {
    isMobileRef.value = true;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("user@example.com");
  });
});
