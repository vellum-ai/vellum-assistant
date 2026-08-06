/**
 * The shared auth-entry contract run against the login page, plus the things
 * only this page decides: the native/web split of the waiting shell and of the
 * sign-in screen itself.
 */

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import {
  CHECKOUT,
  authEntry,
  describeAuthEntryContract,
  entryUrl,
  mockAuthStore,
  mockHardNavigate,
  mockNativeAuth,
  renderAuthEntry,
  setupAuthEntry,
} from "./auth-entry-contract-test-helpers";

mock.module("@/stores/auth-store", mockAuthStore);
mock.module("@/runtime/native-auth", mockNativeAuth);
mock.module("@/lib/auth/hard-navigate", mockHardNavigate);

const { LoginPage } = await import("@/domains/account/pages/login-page");

const ROUTE = "/account/login";

describeAuthEntryContract("LoginPage", {
  Page: LoginPage,
  route: ROUTE,
  authScreenText: "Sign in to Vellum",
  oauthTriggerText: "Continue",
});

describe("LoginPage sign-up cross-link", () => {
  setupAuthEntry();

  const signUpLink = () => screen.getByText("Sign up").getAttribute("href");

  // Allowlist filtering and organic/bare behavior are covered by the
  // withPreservedAttribution unit tests; this exercises the page wiring.
  test("carries attribution from the current URL alongside returnTo", () => {
    renderAuthEntry(
      LoginPage,
      ROUTE,
      `${entryUrl(ROUTE, CHECKOUT)}&utm_source=ig&fbclid=abc123`,
    );

    expect(signUpLink()).toBe(
      `/account/signup?returnTo=${encodeURIComponent(CHECKOUT)}&utm_source=ig&fbclid=abc123`,
    );
  });
});

describe("LoginPage native split", () => {
  setupAuthEntry();

  const renderEntry = () =>
    renderAuthEntry(LoginPage, ROUTE, entryUrl(ROUTE, CHECKOUT));

  test("the wait holds the dark login shell in the browser", () => {
    authEntry.initializing = true;
    const { container } = renderEntry();

    expect(container.querySelector(".dark")).toBeTruthy();
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(screen.queryByText("Sign in to Vellum")).toBeNull();
  });

  test("the wait holds the native splash on native", () => {
    authEntry.initializing = true;
    authEntry.native = true;
    const { container } = renderEntry();

    expect(container.querySelector(".dark")).toBeNull();
    expect(screen.getAllByAltText("Vellum").length).toBeGreaterThan(0);
  });

  test("the native sign-in screen offers the splash CTA, not the web card", () => {
    authEntry.native = true;
    renderEntry();

    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.queryByText("Sign in to Vellum")).toBeNull();
  });
});

/**
 * What the user is left looking at when the platform refuses the sign-in — the
 * failure they report as "I tried to log in and it errored right away". The
 * refusal happens in the session exchange that runs after the auth sheet
 * closes, and the native shell names its cause in `data.authError`.
 */
describe("LoginPage native sign-in failures", () => {
  setupAuthEntry();

  const nativeRejection = (code: string, data?: Record<string, unknown>) =>
    Object.assign(new Error("rejected"), { code, ...(data ? { data } : {}) });

  const signIn = () => {
    authEntry.native = true;
    renderAuthEntry(LoginPage, ROUTE, entryUrl(ROUTE, CHECKOUT));
    fireEvent.click(screen.getByText("Sign in"));
  };

  test("a closed signup is explained, not reported as a generic glitch", async () => {
    authEntry.nativeLoginError = nativeRejection("AUTH_ERROR", {
      authError: "signup_closed",
    });
    signIn();

    await waitFor(() => {
      expect(screen.getByText(/Sign-ups are currently closed/)).toBeTruthy();
    });
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });

  test("an unlinked provider account says an account is needed first", async () => {
    authEntry.nativeLoginError = nativeRejection("AUTH_ERROR", {
      authError: "provider_signup",
    });
    signIn();

    await waitFor(() => {
      expect(screen.getByText(/No Vellum account is linked/)).toBeTruthy();
    });
  });

  test("an unclassified failure still falls back to the generic message", async () => {
    authEntry.nativeLoginError = new Error("Failed to fetch");
    signIn();

    await waitFor(() => {
      expect(screen.getByText(/Something went wrong/)).toBeTruthy();
    });
  });

  test("a dismissed auth sheet shows no error at all", async () => {
    authEntry.nativeLoginError = nativeRejection("USER_CANCELLED");
    signIn();

    // The CTA re-enables, so the dismissal has been processed rather than
    // simply not having landed yet.
    await waitFor(() => {
      expect(screen.getByText("Sign in").closest("button")?.disabled).toBe(
        false,
      );
    });
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });
});
