import { describe, expect, test } from "bun:test";

import { advanceAuthFlow, decideNavigation } from "./auth-nav";

const APP = { protocol: "http:", host: "localhost:3000" } as const;

describe("decideNavigation", () => {
  test("allows same-origin navigation", () => {
    expect(
      decideNavigation("http://localhost:3000/account/login", APP, false),
    ).toEqual({ kind: "allow" });
  });

  test("ejects cross-origin http(s) to the system browser when not signing in", () => {
    expect(
      decideNavigation("https://accounts.google.com/signin", APP, false),
    ).toEqual({ kind: "external", url: "https://accounts.google.com/signin" });
  });

  test("allows cross-origin http(s) in-window during a sign-in", () => {
    expect(
      decideNavigation("https://accounts.google.com/signin", APP, true),
    ).toEqual({ kind: "allow" });
    expect(
      decideNavigation("https://auth.dev-platform.vellum.ai/x", APP, true),
    ).toEqual({ kind: "allow" });
  });

  test("blocks non-http schemes regardless of sign-in state", () => {
    expect(decideNavigation("mailto:hi@vellum.ai", APP, false)).toEqual({
      kind: "block",
    });
    expect(decideNavigation("file:///etc/passwd", APP, true)).toEqual({
      kind: "block",
    });
  });

  test("blocks unparseable URLs", () => {
    expect(decideNavigation("::::", APP, true)).toEqual({ kind: "block" });
  });

  test("always allows the app origin even mid-sign-in (the callback)", () => {
    expect(
      decideNavigation(
        "http://localhost:3000/account/provider/callback",
        APP,
        true,
      ),
    ).toEqual({ kind: "allow" });
  });
});

describe("advanceAuthFlow", () => {
  test("marks sawExternal when navigating to a provider domain", () => {
    expect(
      advanceAuthFlow("https://accounts.google.com/o/oauth2", APP, false),
    ).toEqual({ end: false, sawExternal: true });
  });

  test("does NOT end on the initial same-origin POST (before any provider visit)", () => {
    // The flow kicks off with a same-origin POST to /accounts/oidc/redirect/;
    // returning false here keeps the guard relaxed for the provider hops.
    expect(
      advanceAuthFlow("http://localhost:3000/accounts/oidc/redirect/", APP, false),
    ).toEqual({ end: false, sawExternal: false });
  });

  test("ends once back on the app origin after a provider visit", () => {
    expect(
      advanceAuthFlow(
        "http://localhost:3000/account/provider/callback",
        APP,
        true,
      ),
    ).toEqual({ end: true, sawExternal: true });
  });

  test("leaves state unchanged on an unparseable URL", () => {
    expect(advanceAuthFlow("::::", APP, true)).toEqual({
      end: false,
      sawExternal: true,
    });
  });
});
