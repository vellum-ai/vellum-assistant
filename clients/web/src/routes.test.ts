import { afterEach, describe, expect, mock, test } from "bun:test";
import { matchRoutes } from "react-router";

mock.module("@/generated/gateway/@tanstack/react-query.gen", () => ({
  assistantFeatureFlagsGetOptions: () => ({ queryKey: ["assistant-flags"] }),
  assistantFeatureFlagsGetQueryKey: () => ["assistant-flags"],
}));

const { getRouterBasename, routeTree } = await import("@/routes");

afterEach(() => {
  window.__VELLUM_CONFIG__ = undefined;
  window.history.pushState(null, "", "/");
});

// Walk the matched route chain for `path` and report whether `AccountLayout`
// is one of its layout components. Matching runs against the raw `routeTree`
// (not the constructed `router`) because `createBrowserRouter` consumes the
// `Component` field, leaving nothing to inspect.
function isUnderAccountLayout(path: string): boolean {
  const matches = matchRoutes(routeTree as never, path) ?? [];
  return matches.some(
    (m) =>
      (m.route as { Component?: { name?: string } }).Component?.name ===
      "AccountLayout",
  );
}

function hasRouteMiddleware(path: string, basename?: string): boolean {
  const matches = matchRoutes(routeTree as never, path, basename) ?? [];
  return matches.some((m) =>
    Array.isArray((m.route as { middleware?: unknown }).middleware),
  );
}

describe("account route compact-window grouping", () => {
  // The auth screens that render in the main window opt into the compact
  // (440×630) window via AccountLayout's sizing hook.
  test.each([
    "/account",
    "/account/login",
    "/account/signup",
    "/account/provider/callback",
    "/account/provider/signup",
    "/account/password/reset",
    "/account/password/reset/key/abc123",
  ])("%s is sized by AccountLayout", (path) => {
    expect(isUnderAccountLayout(path)).toBe(true);
  });

  // The OAuth completion / loopback pages render inside a popup child window
  // (or are transient redirects). They must stay OUT of AccountLayout — the
  // resize IPC targets the main window, so sizing from a popup would shrink
  // the wrong window and persist `onboardingActive`.
  test.each([
    "/account/oauth/popup-complete",
    "/account/oauth/complete",
    "/account/oauth/desktop-complete",
    "/account/platform-callback",
  ])("%s is NOT sized by AccountLayout", (path) => {
    expect(isUnderAccountLayout(path)).toBe(false);
  });
});

describe("remote web pairing route", () => {
  test("stays outside the auth-protected assistant app tree", () => {
    expect(hasRouteMiddleware("/assistant/pair?deviceCode=abc")).toBe(false);
  });

  test("uses the remote-gateway public path prefix as the router basename", () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    window.history.pushState(
      null,
      "",
      "/assistant-123/assistant/pair?deviceCode=abc",
    );

    expect(getRouterBasename()).toBe("/assistant-123");
    expect(
      hasRouteMiddleware(
        "/assistant-123/assistant/pair?deviceCode=abc",
        "/assistant-123",
      ),
    ).toBe(false);
  });
});
