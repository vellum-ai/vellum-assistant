import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { matchRoutes } from "react-router";

mock.module("@/generated/gateway/@tanstack/react-query.gen", () => ({
  assistantFeatureFlagsGetOptions: () => ({ queryKey: ["assistant-flags"] }),
  assistantFeatureFlagsGetQueryKey: () => ["assistant-flags"],
}));

const originalWarn = console.warn;
console.warn = (...args: Parameters<typeof console.warn>) => {
  if (
    typeof args[0] === "string" &&
    args[0].includes("KaTeX doesn't work in quirks mode")
  ) {
    return;
  }
  originalWarn(...args);
};

const { getRouterBasename, routeTree } = await import("@/routes");

afterAll(() => {
  console.warn = originalWarn;
});

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

function leafRouteComponentName(path: string): string | undefined {
  const matches = matchRoutes(routeTree as never, path) ?? [];
  const leaf = matches.at(-1)?.route as
    | { Component?: { name?: string } }
    | undefined;
  return leaf?.Component?.name;
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

describe("credential entry route", () => {
  // The one-time credential entry page must stay outside the auth-protected
  // assistant app tree: the link recipient may have no Vellum session, and
  // the single-use token in the request body is the only authorization.
  test("matches outside the auth-protected assistant app tree", () => {
    const matches =
      matchRoutes(routeTree as never, "/assistant/credentials/enter") ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.at(-1)?.pathname).toBe("/assistant/credentials/enter");
    expect(hasRouteMiddleware("/assistant/credentials/enter?token=abc")).toBe(
      false,
    );
  });

  test("matches under the remote-gateway public path prefix basename", () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    window.history.pushState(
      null,
      "",
      "/assistant-123/assistant/credentials/enter",
    );

    expect(getRouterBasename()).toBe("/assistant-123");
    expect(
      hasRouteMiddleware(
        "/assistant-123/assistant/credentials/enter",
        "/assistant-123",
      ),
    ).toBe(false);
  });
});

describe("schedules routes", () => {
  // The Schedules tab and per-schedule deep links render the same lazy
  // HomePageRoute as /home, inside the auth-protected assistant tree.
  test.each([
    "/assistant/schedules",
    "/assistant/schedules/sch_123",
  ])("%s matches inside the auth-protected app tree", (path) => {
    const matches = matchRoutes(routeTree as never, path) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.at(-1)?.pathname).toBe(path);
    expect(hasRouteMiddleware(path)).toBe(true);
  });

  test("captures the schedule id as a route param", () => {
    const matches = matchRoutes(routeTree as never, "/assistant/schedules/sch_123") ?? [];
    expect(matches.at(-1)?.params.scheduleId).toBe("sch_123");
  });
});

describe("skills routes", () => {
  test("captures the skill id as a route param", () => {
    const matches =
      matchRoutes(routeTree as never, "/assistant/skills/my-skill") ?? [];
    expect(matches.at(-1)?.params.skillId).toBe("my-skill");
  });

  // Round-trip for namespaced skills.sh catalog ids (`org/repo/skill`):
  // `routes.skills.detail` percent-encodes the id into a single path segment
  // so `skills/:skillId` matches, and React Router decodes the param back to
  // the raw id — the detail page must NOT decode again.
  test("round-trips slash-containing skill ids through detail URLs", async () => {
    const { routes } = await import("@/utils/routes");
    const url = routes.skills.detail("org/repo/shared-skill");
    expect(url).toBe("/assistant/skills/org%2Frepo%2Fshared-skill");

    const matches = matchRoutes(routeTree as never, url) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.at(-1)?.params.skillId).toBe("org/repo/shared-skill");
  });
});

describe("settings route compatibility", () => {
  test("legacy MCP settings URL redirects to the Integrations MCP tab", () => {
    expect(leafRouteComponentName("/assistant/settings/mcp")).toBe(
      "McpSettingsRedirect",
    );
  });
});
