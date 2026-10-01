/**
 * The shared auth-entry contract run against the signup page, plus the one
 * thing only this page decides: which shell covers the waiting state.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { screen } from "@testing-library/react";

import type { SignupAvailability } from "@/domains/account/hooks/use-signup-availability";

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

/** What the platform reports about accepting new accounts. */
const signupAvailability = { value: "open" as SignupAvailability };
mock.module("@/domains/account/hooks/use-signup-availability", () => ({
  useSignupAvailability: () => signupAvailability.value,
}));

beforeEach(() => {
  signupAvailability.value = "open";
});

const { SignupPage } = await import("@/domains/account/pages/signup-page");

const ROUTE = "/account/signup";

describeAuthEntryContract("SignupPage", {
  Page: SignupPage,
  route: ROUTE,
  authScreenText: "Continue",
  oauthTriggerText: "Continue",
});

describe("SignupPage waiting shell", () => {
  setupAuthEntry();

  test("the wait holds the branded sign-up shell", () => {
    authEntry.initializing = true;
    const { container } = renderAuthEntry(
      SignupPage,
      ROUTE,
      entryUrl(ROUTE, CHECKOUT),
    );

    expect(container.querySelector(".signup")).toBeTruthy();
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(screen.queryByText("Continue")).toBeNull();
  });
});

describe("SignupPage availability", () => {
  setupAuthEntry();

  test("the shell holds until the platform says whether signups are open", () => {
    signupAvailability.value = "pending";
    const { container } = renderAuthEntry(SignupPage, ROUTE, ROUTE);

    expect(container.querySelector(".signup")).toBeTruthy();
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(screen.queryByText("Continue")).toBeNull();
  });

  test("a closed platform explains itself instead of offering OAuth", () => {
    signupAvailability.value = "closed";
    renderAuthEntry(SignupPage, ROUTE, ROUTE);

    expect(screen.getByText(/not accepting new signups/)).toBeTruthy();
    expect(screen.queryByText("Continue")).toBeNull();
    expect(screen.getByText("Sign in").getAttribute("href")).toBe(
      "/account/login",
    );
  });

  test("a signed-in visitor with returnTo still lands there while signups are closed", () => {
    signupAvailability.value = "closed";
    authEntry.authenticated = true;
    renderAuthEntry(SignupPage, ROUTE, entryUrl(ROUTE, CHECKOUT));

    expect(screen.getByTestId("location").textContent).toBe(CHECKOUT);
    expect(screen.queryByText(/not accepting new signups/)).toBeNull();
  });
});
