import { describe, expect, test } from "bun:test";

import {
  GOOGLE_MANAGED_FULL_CONNECT_SCOPES,
  resolveManagedOAuthRequestedScopes,
} from "./google-oauth-scopes";

describe("resolveManagedOAuthRequestedScopes", () => {
  test("requests the explicit full Google managed scope set by default", () => {
    expect(resolveManagedOAuthRequestedScopes("google")).toEqual([
      ...GOOGLE_MANAGED_FULL_CONNECT_SCOPES,
    ]);
  });

  test("preserves scoped overrides", () => {
    expect(
      resolveManagedOAuthRequestedScopes("google", [
        "https://www.googleapis.com/auth/calendar.events",
      ]),
    ).toEqual(["https://www.googleapis.com/auth/calendar.events"]);
  });

  test("leaves non-Google providers on their platform defaults", () => {
    expect(resolveManagedOAuthRequestedScopes("slack")).toEqual([]);
  });
});
