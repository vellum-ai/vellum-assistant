import { describe, expect, test } from "bun:test";

import { routes } from "@/lib/routes.js";

import {
  buildProviderCallbackUrl,
  resolvePostLoginDestination,
} from "@/lib/account/login-flow.js";

describe("account login flow helpers", () => {
  test("buildProviderCallbackUrl threads returnTo through provider callback", () => {
    const returnTo =
      "/accounts/chrome-extension/start" +
      "?redirect_uri=https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/cloud-auth" +
      "&client_id=vellum-chrome-extension" +
      "&assistant_id=00000000-0000-4000-8000-000000000001";

    expect(buildProviderCallbackUrl(returnTo)).toBe(
      `${routes.account.providerCallback}?returnTo=${encodeURIComponent(returnTo)}`,
    );
  });

  test("resolvePostLoginDestination preserves chrome-extension returnTo path", () => {
    const returnTo =
      "/accounts/chrome-extension/start" +
      "?redirect_uri=https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/cloud-auth" +
      "&client_id=vellum-chrome-extension" +
      "&assistant_id=00000000-0000-4000-8000-000000000001";

    const resolved = resolvePostLoginDestination(returnTo, routes.assistant);
    expect(resolved.destination).toBe(returnTo);
    expect(resolved.requiresFullPageNavigation).toBe(true);
  });

  test("resolvePostLoginDestination falls back for invalid returnTo", () => {
    const resolved = resolvePostLoginDestination("javascript:alert(1)", routes.assistant);
    expect(resolved.destination).toBe(routes.assistant);
    expect(resolved.requiresFullPageNavigation).toBe(false);
  });
});
