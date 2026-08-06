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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { AuthUser } from "@/stores/auth-store";

const isMobileRef = { value: false };
const nativeAndroidRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
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

const { PreferencesMenu } = await import(
  "@/domains/chat/components/preferences-menu"
);

beforeEach(() => {
  isMobileRef.value = false;
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
    isMobileRef.value = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  test("mobile renders trigger (BottomSheet surface)", () => {
    isMobileRef.value = true;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  test("native Android shows the balance without an add-credits action", async () => {
    nativeAndroidRef.value = true;
    isMobileRef.value = true;
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
