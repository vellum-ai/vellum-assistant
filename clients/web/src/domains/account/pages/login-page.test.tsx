/**
 * Tests for the login entry gate: an existing session plus a `returnTo`
 * skips OAuth and lands on the sanitized destination.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import * as authStore from "@/stores/auth-store";
import * as nativeAuth from "@/runtime/native-auth";
import type { PlatformSessionStatus } from "@/stores/session-status";

const CHECKOUT = "/assistant/checkout?package=super";
const LOCAL_DESTINATION = "/assistant/settings/general";

let authenticated = false;
let initializing = false;
let authFlowCalls: { callbackUrl: string; returnTo: string | null }[] = [];

const setPlatformSession = (platformSession: PlatformSessionStatus) => {
  authStore.useAuthStore.setState({ platformSession });
};

mock.module("@/stores/auth-store", () => ({
  ...authStore,
  useIsAuthenticated: () => authenticated,
  useIsSessionInitializing: () => initializing,
}));

mock.module("@/runtime/native-auth", () => ({
  ...nativeAuth,
  startAuthFlow: (
    _provider: string,
    callbackUrl: string,
    options?: { returnTo?: string | null },
  ) => {
    authFlowCalls.push({ callbackUrl, returnTo: options?.returnTo ?? null });
    return Promise.resolve();
  },
  startNativeLogin: () => Promise.resolve(),
  useIsNativePlatform: () => false,
}));

const { LoginPage } = await import("@/domains/account/pages/login-page");

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <LocationProbe />
      <Routes>
        <Route path="/account/login" element={<LoginPage />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId("location").textContent;

describe("LoginPage", () => {
  beforeEach(() => {
    authenticated = false;
    initializing = false;
    authFlowCalls = [];
    setPlatformSession("present");
  });

  afterEach(cleanup);

  test("an authenticated visitor with returnTo lands there without OAuth", () => {
    authenticated = true;
    renderAt(`/account/login?returnTo=${encodeURIComponent(CHECKOUT)}`);

    expect(location()).toBe(CHECKOUT);
    expect(screen.queryByText("Sign in to Vellum")).toBeNull();
    expect(authFlowCalls).toHaveLength(0);
  });

  test("a platform-dependent returnTo without a platform session still signs in", () => {
    authenticated = true;
    setPlatformSession("absent");
    const entry = `/account/login?returnTo=${encodeURIComponent(CHECKOUT)}`;
    renderAt(entry);

    expect(location()).toBe(entry);
    expect(screen.getByText("Sign in to Vellum")).toBeTruthy();
  });

  test("a platform-dependent returnTo waits out the platform-session probe", () => {
    authenticated = true;
    setPlatformSession("unknown");
    const entry = `/account/login?returnTo=${encodeURIComponent(CHECKOUT)}`;
    renderAt(entry);

    expect(location()).toBe(entry);
    expect(screen.queryByText("Sign in to Vellum")).toBeNull();
  });

  test("a local-only returnTo skips OAuth without a platform session", () => {
    authenticated = true;
    setPlatformSession("absent");
    renderAt(
      `/account/login?returnTo=${encodeURIComponent(LOCAL_DESTINATION)}`,
    );

    expect(location()).toBe(LOCAL_DESTINATION);
    expect(authFlowCalls).toHaveLength(0);
  });

  test("an unauthenticated visitor with returnTo still gets the sign-in screen", () => {
    const entry = `/account/login?returnTo=${encodeURIComponent(CHECKOUT)}`;
    renderAt(entry);

    expect(screen.getByText("Sign in to Vellum")).toBeTruthy();
    expect(location()).toBe(entry);
  });

  test("an authenticated visitor with no returnTo still gets the sign-in screen", () => {
    authenticated = true;
    renderAt("/account/login");

    expect(screen.getByText("Sign in to Vellum")).toBeTruthy();
    expect(location()).toBe("/account/login");
  });

  test("a hostile returnTo falls back to the assistant", () => {
    authenticated = true;
    renderAt("/account/login?returnTo=https%3A%2F%2Fevil.example");

    expect(location()).toBe("/assistant");
  });

  test("a hostile returnTo is sanitized before it reaches the auth flow", () => {
    renderAt("/account/login?returnTo=https%3A%2F%2Fevil.example");
    fireEvent.click(screen.getByText("Continue"));

    expect(authFlowCalls).toHaveLength(1);
    expect(authFlowCalls[0]?.returnTo).toBe("/assistant");
    expect(authFlowCalls[0]?.callbackUrl).not.toContain("evil.example");
  });

  test("an unsettled session with returnTo neither redirects nor offers OAuth", () => {
    authenticated = true;
    initializing = true;
    const entry = `/account/login?returnTo=${encodeURIComponent(CHECKOUT)}`;
    renderAt(entry);

    expect(location()).toBe(entry);
    expect(screen.queryByText("Sign in to Vellum")).toBeNull();
  });
});
