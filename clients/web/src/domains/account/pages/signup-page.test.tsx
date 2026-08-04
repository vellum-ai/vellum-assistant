/**
 * The shared auth-entry contract run against the signup page, plus the one
 * thing only this page decides: which shell covers the waiting state.
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
