/**
 * The auth-entry contract shared by `/account/signup` and `/account/login`:
 * both delegate to `useReturnToShortCircuit`, so an existing session plus a
 * `returnTo` skips OAuth and lands on the sanitized destination. The scenarios
 * live here once and run against each page.
 *
 * Bun's `mock.module()` only takes effect from the file that installs it, so
 * each test file registers the factories below itself and then dynamically
 * imports its page — this module supplies the mock bodies and the state they
 * read, never the registration.
 */

import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import * as authStore from "@/stores/auth-store";
import * as nativeAuth from "@/runtime/native-auth";
import type { PlatformSessionStatus } from "@/stores/session-status";

export const CHECKOUT = "/assistant/checkout?package=super";
const HOSTILE_DESTINATION = "https://evil.example";
/** Served by the platform's Next.js app — a `<Navigate>` here dead-ends. */
const IMPORT_FUNNEL = "/import?foo=1";
const VELLUM_URL = "https://app.vellum.ai/x";

interface AuthFlowCall {
  callbackUrl: string;
  returnTo: string | null;
}

/** Session and platform inputs the mocked modules read on every render. */
export const authEntry = {
  authenticated: false,
  initializing: false,
  native: false,
  authFlowCalls: [] as AuthFlowCall[],
  hardNavigateCalls: [] as string[],
  /** When set, `startNativeLogin` rejects with it instead of resolving. */
  nativeLoginError: null as unknown,
};

export const mockAuthStore = () => ({
  ...authStore,
  useIsAuthenticated: () => authEntry.authenticated,
  useIsSessionInitializing: () => authEntry.initializing,
});

export const mockNativeAuth = () => ({
  ...nativeAuth,
  startAuthFlow: (
    _provider: string,
    callbackUrl: string,
    options?: { returnTo?: string | null },
  ) => {
    authEntry.authFlowCalls.push({
      callbackUrl,
      returnTo: options?.returnTo ?? null,
    });
    return Promise.resolve();
  },
  startNativeLogin: () =>
    authEntry.nativeLoginError
      ? Promise.reject(authEntry.nativeLoginError)
      : Promise.resolve(),
  useIsNativePlatform: () => authEntry.native,
});

export const mockHardNavigate = () => ({
  hardNavigate: (url: string) => {
    authEntry.hardNavigateCalls.push(url);
  },
});

function setPlatformSession(platformSession: PlatformSessionStatus) {
  authStore.useAuthStore.setState({ platformSession });
}

/** Registers the per-scenario reset and teardown the helpers below assume. */
export function setupAuthEntry() {
  beforeEach(() => {
    authEntry.authenticated = false;
    authEntry.initializing = false;
    authEntry.native = false;
    authEntry.authFlowCalls = [];
    authEntry.hardNavigateCalls = [];
    authEntry.nativeLoginError = null;
    setPlatformSession("present");
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "loading" },
    });
  });

  afterEach(cleanup);
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

export function renderAuthEntry(
  Page: ComponentType,
  route: string,
  url: string,
) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <LocationProbe />
      <Routes>
        <Route path={route} element={<Page />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

export function entryUrl(route: string, returnTo: string) {
  return `${route}?returnTo=${encodeURIComponent(returnTo)}`;
}

const currentLocation = () => screen.getByTestId("location").textContent;

interface AuthEntryPage {
  /** The page component, dynamically imported after the module mocks land. */
  Page: ComponentType;
  /** Route the page is mounted at. */
  route: string;
  /** Text that renders only once the auth screen itself is on screen. */
  authScreenText: string;
  /** The control that hands off to OAuth. */
  oauthTriggerText: string;
}

export function describeAuthEntryContract(
  name: string,
  { Page, route, authScreenText, oauthTriggerText }: AuthEntryPage,
) {
  const renderEntry = (url: string) => renderAuthEntry(Page, route, url);
  const authScreen = () => screen.queryByText(authScreenText);

  describe(name, () => {
    setupAuthEntry();

    test("an authenticated visitor with returnTo lands there without OAuth", () => {
      authEntry.authenticated = true;
      renderEntry(entryUrl(route, CHECKOUT));

      expect(currentLocation()).toBe(CHECKOUT);
      expect(authScreen()).toBeNull();
      expect(authEntry.hardNavigateCalls).toHaveLength(0);
    });

    test("a platform-dependent returnTo without a platform session still signs in", () => {
      authEntry.authenticated = true;
      setPlatformSession("absent");
      const entry = entryUrl(route, CHECKOUT);
      renderEntry(entry);

      expect(currentLocation()).toBe(entry);
      expect(authScreen()).toBeTruthy();
    });

    test("a self-hosted assistant with no platform session still signs in", () => {
      authEntry.authenticated = true;
      setPlatformSession("absent");
      useAssistantLifecycleStore.setState({
        assistantState: { kind: "self_hosted" },
      });
      const entry = entryUrl(route, CHECKOUT);
      renderEntry(entry);

      expect(currentLocation()).toBe(entry);
      expect(authScreen()).toBeTruthy();
    });

    test("a platform-dependent returnTo waits out the platform-session probe", () => {
      authEntry.authenticated = true;
      setPlatformSession("unknown");
      const entry = entryUrl(route, CHECKOUT);
      renderEntry(entry);

      expect(currentLocation()).toBe(entry);
      expect(authScreen()).toBeNull();
    });

    test("an out-of-SPA returnTo gets a real page load, not a router navigation", () => {
      authEntry.authenticated = true;
      const entry = entryUrl(route, IMPORT_FUNNEL);
      renderEntry(entry);

      expect(authEntry.hardNavigateCalls).toEqual([IMPORT_FUNNEL]);
      expect(currentLocation()).toBe(entry);
    });

    test("a vellum.ai returnTo gets a real page load, not a router navigation", () => {
      authEntry.authenticated = true;
      const entry = entryUrl(route, VELLUM_URL);
      renderEntry(entry);

      expect(authEntry.hardNavigateCalls).toEqual([VELLUM_URL]);
      expect(currentLocation()).toBe(entry);
    });

    test("an unauthenticated visitor with returnTo still gets the auth screen", () => {
      const entry = entryUrl(route, CHECKOUT);
      renderEntry(entry);

      expect(authScreen()).toBeTruthy();
      expect(currentLocation()).toBe(entry);
    });

    test("an authenticated visitor with no returnTo still gets the auth screen", () => {
      authEntry.authenticated = true;
      renderEntry(route);

      expect(authScreen()).toBeTruthy();
      expect(currentLocation()).toBe(route);
    });

    test("a hostile returnTo falls back to the assistant", () => {
      authEntry.authenticated = true;
      renderEntry(entryUrl(route, HOSTILE_DESTINATION));

      expect(currentLocation()).toBe("/assistant");
    });

    test("a hostile returnTo is sanitized before it reaches the auth flow", () => {
      renderEntry(entryUrl(route, HOSTILE_DESTINATION));
      fireEvent.click(screen.getByText(oauthTriggerText));

      expect(authEntry.authFlowCalls).toHaveLength(1);
      expect(authEntry.authFlowCalls[0]?.returnTo).toBe("/assistant");
    });

    test("an unsettled session with returnTo neither redirects nor offers OAuth", () => {
      authEntry.authenticated = true;
      authEntry.initializing = true;
      const entry = entryUrl(route, CHECKOUT);
      renderEntry(entry);

      expect(currentLocation()).toBe(entry);
      expect(authScreen()).toBeNull();
    });
  });
}
