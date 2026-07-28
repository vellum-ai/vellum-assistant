/**
 * The shared auth-entry contract run against the login page, plus the things
 * only this page decides: the native/web split of the waiting shell and of the
 * sign-in screen itself.
 */

import { describe, expect, mock, test } from "bun:test";
import { screen } from "@testing-library/react";

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
