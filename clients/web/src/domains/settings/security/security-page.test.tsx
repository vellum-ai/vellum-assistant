import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

let clientFlags: Record<string, boolean> = { hydrated: true };
let gateState = "full";

mock.module("@/stores/client-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    accountMfa: () => clientFlags.accountMfa ?? false,
    hydrated: () => clientFlags.hydrated ?? true,
  };
  return { useClientFeatureFlagStore: store };
});

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => gateState,
}));

mock.module("@/components/platform-login-notice", () => ({
  PlatformLoginNotice: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

mock.module("./two-factor-section", () => ({
  TwoFactorSection: () => <div data-testid="two-factor-section" />,
}));

const { SecurityPage } = await import("./security-page");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/assistant/settings/security"]}>
      <Routes>
        <Route path="/assistant/settings/security" element={<SecurityPage />} />
        <Route
          path="/assistant/settings/general"
          element={<div data-testid="general-page" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  clientFlags = { hydrated: true };
  gateState = "full";
});

describe("SecurityPage", () => {
  test("redirects to general settings when the flag is off after hydration", () => {
    clientFlags = { accountMfa: false, hydrated: true };
    renderPage();

    expect(screen.getByTestId("general-page")).not.toBeNull();
  });

  test("renders nothing (no redirect) while flags are still hydrating", () => {
    clientFlags = { accountMfa: false, hydrated: false };
    renderPage();

    expect(screen.queryByTestId("general-page")).toBeNull();
    expect(screen.queryByTestId("two-factor-section")).toBeNull();
  });

  test("shows a login prompt when there is no platform session", () => {
    clientFlags = { accountMfa: true, hydrated: true };
    gateState = "disabled";
    renderPage();

    expect(
      screen.getByText(/Log in to the Vellum platform/i),
    ).not.toBeNull();
    expect(screen.queryByTestId("two-factor-section")).toBeNull();
  });

  test("renders the two-factor section for a logged-in platform user", () => {
    clientFlags = { accountMfa: true, hydrated: true };
    renderPage();

    expect(screen.getByText("Two-Factor Authentication")).not.toBeNull();
    expect(screen.getByTestId("two-factor-section")).not.toBeNull();
  });
});
