import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Fake CdpClient ───────────────────────────────────────────────────
//
// Programmable send handler + call log shared across tests. Each test
// resets these in `beforeEach` via `resetCdp()`. The mocked
// `getCdpClient` mirrors the real factory's routing decision (local
// vs extension is driven by `context.hostBrowserProxy`) so individual
// tests can exercise either transport without process-wide coupling.
//
// Note: bun's `mock.module` is process-global, but `scripts/test.sh`
// runs each test file in its own bun process so this mock only
// affects this file's tests.

let cdpSendCalls: Array<{ method: string; params?: unknown }> = [];
let cdpSendHandler: (
  method: string,
  params?: Record<string, unknown>,
) => unknown = () => ({});
let cdpDisposed = false;

function makeFakeCdp(kind: "local" | "extension", conversationId: string) {
  return {
    kind,
    conversationId,
    async send<T>(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> {
      cdpSendCalls.push({ method, params });
      const value = cdpSendHandler(method, params);
      return (await value) as T;
    },
    dispose() {
      cdpDisposed = true;
    },
  };
}

mock.module("../tools/browser/cdp-client/factory.js", () => ({
  getCdpClient: (context: {
    hostBrowserProxy?: unknown;
    conversationId: string;
  }) =>
    makeFakeCdp(
      context.hostBrowserProxy ? "extension" : "local",
      context.conversationId,
    ),
}));

// ── Minimal browserManager stub ──────────────────────────────────────
//
// The local path still installs a Playwright route handler via
// browserManager.getOrCreateSessionPage() → page.route(...). We keep
// a tiny stub so the happy path doesn't blow up when the route handler
// is installed/uninstalled; the route logic itself is only exercised
// by the SSRF redirect test below.

let mockPage: {
  url: () => string;
  route: ReturnType<typeof mock>;
  unroute: ReturnType<typeof mock>;
  close: () => Promise<void>;
  isClosed: () => boolean;
};

let getOrCreateSessionPageMock: ReturnType<typeof mock>;
let clearSnapshotBackendNodeMapMock: ReturnType<typeof mock>;
let positionWindowSidebarMock: ReturnType<typeof mock>;

const preferredBackendKinds = new Map<string, string>();

mock.module("../tools/browser/browser-manager.js", () => {
  getOrCreateSessionPageMock = mock(async () => mockPage);
  clearSnapshotBackendNodeMapMock = mock(() => {});
  positionWindowSidebarMock = mock(async () => {});
  preferredBackendKinds.clear();
  return {
    browserManager: {
      getOrCreateSessionPage: getOrCreateSessionPageMock,
      clearSnapshotBackendNodeMap: clearSnapshotBackendNodeMapMock,
      supportsRouteInterception: true,
      isInteractive: () => false,
      positionWindowSidebar: positionWindowSidebarMock,
      getPreferredBackendKind: (conversationId: string) =>
        preferredBackendKinds.get(conversationId) ?? null,
      setPreferredBackendKind: (conversationId: string, kind: string) => {
        preferredBackendKinds.set(conversationId, kind);
      },
      clearPreferredBackendKind: (conversationId: string) => {
        preferredBackendKinds.delete(conversationId);
      },
    },
  };
});

mock.module("../tools/browser/browser-screencast.js", () => ({
  ensureScreencast: async () => {},
  getSender: () => null,
  stopAllScreencasts: async () => {},
  stopBrowserScreencast: async () => {},
}));

// Default url-safety: allow everything
let parseUrlResult: URL | null = null;
let parseUrlMock: (input: unknown) => URL | null = () => parseUrlResult;
let isPrivateResult = false;
let isPrivateHostMock: (hostname: string) => boolean = () => isPrivateResult;
let resolveResult: { blockedAddress?: string } = {};

mock.module("../tools/network/url-safety.js", () => ({
  parseUrl: (input: unknown) => parseUrlMock(input),
  isPrivateOrLocalHost: (hostname: string) => isPrivateHostMock(hostname),
  resolveHostAddresses: async () => [],
  resolveRequestAddress: async () => resolveResult,
  sanitizeUrlForOutput: (url: URL) => url.href,
}));

import { executeBrowserNavigate } from "../tools/browser/browser-execution.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  conversationId: "test-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
};

function resetMockPage() {
  mockPage = {
    url: () => "https://example.com/",
    route: mock(async () => {}),
    unroute: mock(async () => {}),
    close: async () => {},
    isClosed: () => false,
  };
}

/**
 * Default CDP handler. Returns values in the CDP response shape
 * (`{ result: { value } }`) for `Runtime.evaluate` calls and resolves
 * with `{}` for other methods.
 *
 * navigateAndWait now reads the pre-nav URL, then polls readyState +
 * href in a single combined evaluate. The default flow:
 *
 *   1. Pre-nav `document.location.href` → "about:blank" (the baseline
 *      used by navigateAndWait's commit detection).
 *   2. `Page.navigate`
 *   3. Combined poll `({ readyState, href })` → `{ readyState:
 *      "complete", href: "https://example.com/page" }`. Because the
 *      href changed from the pre-nav value, commit detection fires
 *      on the first poll.
 *   4. `document.title` → "Example".
 */
function defaultCdpHandler(
  method: string,
  params?: Record<string, unknown>,
): unknown {
  if (method === "Page.navigate") return { frameId: "f1" };
  if (method === "Runtime.evaluate") {
    const expression = String(params?.["expression"] ?? "");
    if (expression === "document.location.href") {
      return { result: { value: "about:blank" } };
    }
    if (expression === "document.title") {
      return { result: { value: "Example" } };
    }
    // Combined readyState + href polling expression from
    // navigateAndWait. The commit-detection logic requires a
    // different href from the pre-nav baseline so we return the
    // requested page URL here.
    if (
      expression.includes("readyState") &&
      expression.includes("document.location.href")
    ) {
      return {
        result: {
          value: {
            readyState: "complete",
            href: "https://example.com/page",
          },
        },
      };
    }
    // DOM_DETECT / CAPTCHA_DETECT / DISMISS_MODALS IIFEs fall through
    // to a generic "no challenge" result. The auth-detector IIFE
    // expects `{result: {value: null | {...}}}` shape.
    return { result: { value: null } };
  }
  return {};
}

function resetCdp() {
  cdpSendCalls = [];
  cdpDisposed = false;
  cdpSendHandler = defaultCdpHandler;
}

describe("executeBrowserNavigate", () => {
  beforeEach(() => {
    parseUrlResult = null;
    parseUrlMock = () => parseUrlResult;
    isPrivateResult = false;
    isPrivateHostMock = () => isPrivateResult;
    resolveResult = {};
    resetMockPage();
    resetCdp();
  });

  // ── Input validation ───────────────────────────────────────────
  //
  // These run entirely within the upfront validation block and do
  // not touch CDP. The tests intentionally do not assert anything
  // about the CdpClient — the factory should never be called.

  test("rejects missing or invalid url", async () => {
    const result = await executeBrowserNavigate({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("url is required");
    expect(cdpSendCalls).toEqual([]);
  });

  test("rejects non-http(s) protocols", async () => {
    parseUrlResult = new URL("ftp://example.com");
    const result = await executeBrowserNavigate(
      { url: "ftp://example.com" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("http or https");
    expect(cdpSendCalls).toEqual([]);
  });

  // ── Private network blocking ───────────────────────────────────

  test("blocks private/local hosts by default", async () => {
    parseUrlResult = new URL("http://localhost:3000");
    isPrivateResult = true;
    const result = await executeBrowserNavigate(
      { url: "http://localhost:3000" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Refusing to navigate");
    expect(result.content).toContain("localhost");
    expect(cdpSendCalls).toEqual([]);
  });

  test("allows private hosts with allow_private_network=true", async () => {
    parseUrlResult = new URL("http://localhost:3000");
    isPrivateResult = true;
    const result = await executeBrowserNavigate(
      { url: "http://localhost:3000", allow_private_network: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Status: unknown");
  });

  test("blocks DNS-resolved private addresses by default", async () => {
    parseUrlResult = new URL("https://internal.corp.example.com");
    isPrivateResult = false;
    resolveResult = { blockedAddress: "10.0.0.1" };
    const result = await executeBrowserNavigate(
      { url: "https://internal.corp.example.com" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("10.0.0.1");
    expect(cdpSendCalls).toEqual([]);
  });

  test("skips DNS check with allow_private_network=true", async () => {
    parseUrlResult = new URL("https://internal.corp.example.com");
    isPrivateResult = false;
    resolveResult = { blockedAddress: "10.0.0.1" };
    const result = await executeBrowserNavigate(
      { url: "https://internal.corp.example.com", allow_private_network: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Status: unknown");
  });

  // ── Happy path (CDP navigate) ──────────────────────────────────

  test("calls Page.navigate with the requested URL and returns URL+title", async () => {
    parseUrlResult = new URL("https://example.com/page");
    const result = await executeBrowserNavigate(
      { url: "https://example.com/page" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Requested URL:");
    expect(result.content).toContain("Final URL:");
    expect(result.content).toContain("Status: unknown");
    expect(result.content).toContain("Title: Example");

    // Page.navigate was called with the expected URL
    const navigateCall = cdpSendCalls.find((c) => c.method === "Page.navigate");
    expect(navigateCall).toBeDefined();
    expect(navigateCall!.params).toEqual({ url: "https://example.com/page" });

    // navigateAndWait polls readyState+href in a single combined
    // evaluate and also reads `document.location.href` pre-nav; the
    // caller separately reads `document.title` after the nav.
    const evaluateCalls = cdpSendCalls.filter(
      (c) => c.method === "Runtime.evaluate",
    );
    const expressions = evaluateCalls.map(
      (c) => (c.params as Record<string, unknown>)["expression"] as string,
    );
    expect(expressions.some((e) => e.includes("readyState"))).toBe(true);
    expect(expressions).toContain("document.location.href");
    expect(expressions).toContain("document.title");

    // The CdpClient was disposed in the finally block.
    expect(cdpDisposed).toBe(true);
  });

  test("notes redirect when final URL differs", async () => {
    parseUrlResult = new URL("https://example.com/old");
    // Pre-nav URL is about:blank so commit detection fires on the
    // first poll. The combined poll returns a different href than
    // the requested URL — that's what triggers the "redirected" note.
    cdpSendHandler = (method, params) => {
      if (method === "Page.navigate") return { frameId: "f1" };
      if (method === "Runtime.evaluate") {
        const expression = String(params?.["expression"] ?? "");
        if (expression === "document.location.href") {
          return { result: { value: "about:blank" } };
        }
        if (expression === "document.title") {
          return { result: { value: "New" } };
        }
        if (
          expression.includes("readyState") &&
          expression.includes("document.location.href")
        ) {
          return {
            result: {
              value: {
                readyState: "complete",
                href: "https://example.com/new",
              },
            },
          };
        }
        return { result: { value: null } };
      }
      return {};
    };

    const result = await executeBrowserNavigate(
      { url: "https://example.com/old" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("redirected");
  });

  // ── Timeout / readyState stays "loading" ───────────────────────

  test("reports a timeout note when document.readyState never completes", async () => {
    parseUrlResult = new URL("https://example.com/slow");
    cdpSendHandler = (method, params) => {
      if (method === "Page.navigate") return { frameId: "f1" };
      if (method === "Runtime.evaluate") {
        const expression = String(params?.["expression"] ?? "");
        if (expression === "document.location.href") {
          // Pre-nav URL read. Returning the same URL as the target
          // would trigger the same-URL reload fallback; using
          // about:blank keeps the cross-URL commit-detection path
          // active so the polling loop actually exercises readyState.
          return { result: { value: "about:blank" } };
        }
        if (expression === "document.title") {
          return { result: { value: "Loading" } };
        }
        if (
          expression.includes("readyState") &&
          expression.includes("document.location.href")
        ) {
          // Stuck in "loading" — forces navigateAndWait to exhaust
          // its timeout budget (or get aborted by the test's signal).
          return {
            result: {
              value: {
                readyState: "loading",
                href: "https://example.com/slow",
              },
            },
          };
        }
        return { result: { value: null } };
      }
      return {};
    };

    // Use a short deadline for the test — the NAVIGATE_TIMEOUT_MS
    // const is 15s which is too slow for a unit test. We bound this
    // by aborting after ~200ms so the helper surfaces a CdpError
    // with code "aborted" rather than waiting the full 15s.
    //
    // The in-function `navigationTimedOut` branch is NOT the path
    // exercised here (aborts throw instead of returning timedOut).
    // The happy-path timeout is simulated by the other timeout
    // behavior test below.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 200);
    const result = await executeBrowserNavigate(
      { url: "https://example.com/slow" },
      { ...ctx, signal: ctrl.signal },
    );
    clearTimeout(timer);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigation failed");
    expect(cdpDisposed).toBe(true);
  });

  // ── Pre-aborted signal ─────────────────────────────────────────

  test("returns early-abort error when signal is already aborted", async () => {
    parseUrlResult = new URL("https://example.com/page");
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await executeBrowserNavigate(
      { url: "https://example.com/page" },
      { ...ctx, signal: ctrl.signal },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("operation was cancelled");
    // Pre-abort short-circuits before any CDP call is made.
    expect(cdpSendCalls).toEqual([]);
  });

  // ── Navigation errors ──────────────────────────────────────────

  test("catches navigation errors from Page.navigate", async () => {
    parseUrlResult = new URL("https://example.com");
    cdpSendHandler = (method) => {
      if (method === "Page.navigate") {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: "https://example.com/" } };
      }
      return {};
    };

    const result = await executeBrowserNavigate(
      { url: "https://example.com" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigation failed");
    expect(result.content).toContain("ERR_CONNECTION_REFUSED");
    expect(cdpDisposed).toBe(true);
  });

  test("surfaces Page.navigate errorText as a navigation failure", async () => {
    // CDP signals DNS / connection errors via the response's
    // `errorText` field rather than throwing. Without this, the
    // navigate helper would poll readyState on the OLD page (which is
    // "complete") and report success with the stale URL — leaking
    // potentially sensitive content the agent never asked for.
    parseUrlResult = new URL("https://nope.invalid");
    cdpSendHandler = (method, params) => {
      if (method === "Page.navigate") {
        return { frameId: "f1", errorText: "net::ERR_NAME_NOT_RESOLVED" };
      }
      if (method === "Runtime.evaluate") {
        const expression = String(params?.["expression"] ?? "");
        if (expression === "document.location.href") {
          return { result: { value: "https://example.com/old" } };
        }
        return { result: { value: null } };
      }
      return {};
    };

    const result = await executeBrowserNavigate(
      { url: "https://nope.invalid" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigation failed");
    expect(result.content).toContain("ERR_NAME_NOT_RESOLVED");
    expect(cdpDisposed).toBe(true);

    // Should NOT have polled readyState — navigate failed before the
    // wait loop ran. navigateAndWait combines readyState + href into a
    // single evaluate, so we look for any expression containing both.
    const readyStateCalls = cdpSendCalls.filter((c) => {
      if (c.method !== "Runtime.evaluate") return false;
      const expr = (c.params as { expression?: string } | undefined)
        ?.expression;
      return (
        typeof expr === "string" &&
        expr.includes("readyState") &&
        expr.includes("document.location.href")
      );
    });
    expect(readyStateCalls).toHaveLength(0);
  });

  // ── SSRF route interception (local path only) ─────────────────

  test("returns security message when route handler blocks a redirect", async () => {
    parseUrlResult = new URL("https://public.example.com");
    isPrivateResult = false;

    // Capture the installed route handler.
    let capturedHandler:
      | ((route: unknown, request: unknown) => Promise<void>)
      | null = null;
    mockPage.route = mock(
      async (
        _pattern: string,
        handler: (route: unknown, request: unknown) => Promise<void>,
      ) => {
        capturedHandler = handler;
      },
    );

    // When Page.navigate is called, simulate a private redirect by
    // invoking the captured route handler, then throw to mirror how
    // the Playwright route interceptor signals blockage to the caller.
    cdpSendHandler = (method) => {
      if (method === "Page.navigate") {
        if (capturedHandler) {
          const origPrivate = isPrivateResult;
          isPrivateResult = true;
          const mockRoute = {
            abort: mock(async () => {}),
            continue: mock(async () => {}),
          };
          const mockRequest = { url: () => "http://169.254.169.254/metadata" };
          // Invoke the captured handler. Intentionally fire-and-forget
          // because Page.navigate is synchronous from the test's
          // perspective — the handler only mutates `blockedUrl` in the
          // closed-over scope.
          void capturedHandler(mockRoute, mockRequest);
          isPrivateResult = origPrivate;
        }
        throw new Error("net::ERR_BLOCKED_BY_CLIENT");
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: "https://public.example.com/" } };
      }
      return {};
    };

    const result = await executeBrowserNavigate(
      { url: "https://public.example.com" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigation blocked");
    expect(result.content).toContain("allow_private_network=true");
    // Should NOT contain the raw underlying error
    expect(result.content).not.toContain("ERR_BLOCKED_BY_CLIENT");
    expect(cdpDisposed).toBe(true);
  });

  // ── Extension path (no Playwright route interception) ──────────

  test("extension path skips Playwright route interception", async () => {
    parseUrlResult = new URL("https://example.com/page");
    // Supplying a non-null hostBrowserProxy on the context routes the
    // mocked getCdpClient to the extension path (it mirrors the real
    // factory's routing logic).
    const extensionCtx: ToolContext = {
      ...ctx,
      hostBrowserProxy: {} as unknown as ToolContext["hostBrowserProxy"],
    };
    // Reset page call trackers to verify they are not touched.
    const routeCallsBefore = mockPage.route.mock.calls.length;
    const unrouteCallsBefore = mockPage.unroute.mock.calls.length;

    const result = await executeBrowserNavigate(
      { url: "https://example.com/page" },
      extensionCtx,
    );

    expect(result.isError).toBe(false);
    // Extension path never installs or removes a Playwright route
    // (route interception only works on the local Playwright path).
    expect(mockPage.route.mock.calls.length).toBe(routeCallsBefore);
    expect(mockPage.unroute.mock.calls.length).toBe(unrouteCallsBefore);
    // Page.navigate still goes through the CdpClient.
    expect(cdpSendCalls.some((c) => c.method === "Page.navigate")).toBe(true);
    expect(cdpDisposed).toBe(true);
  });

  test("extension path blocks redirects via post-navigation final URL check", async () => {
    // The initial URL is public and passes pre-flight checks. The
    // extension path has no Playwright route interception, but the
    // post-navigation defense-in-depth check catches the private final URL.
    parseUrlResult = new URL("https://public.example.com/start");
    isPrivateResult = false;

    // Configure mocks to return different results for the initial URL
    // vs. the final URL returned by navigateAndWait.
    parseUrlMock = (input: unknown) => {
      if (typeof input === "string" && input.includes("127.0.0.1")) {
        return new URL(input);
      }
      return parseUrlResult;
    };
    isPrivateHostMock = (hostname: string) => {
      return hostname === "127.0.0.1";
    };

    // navigateAndWait returns a private final URL (simulating a
    // server-side redirect).
    cdpSendHandler = (method, params) => {
      if (method === "Page.navigate") return { frameId: "f1" };
      if (method === "Runtime.evaluate") {
        const expression = String(params?.["expression"] ?? "");
        if (expression === "document.location.href") {
          return { result: { value: "about:blank" } };
        }
        if (
          expression.includes("readyState") &&
          expression.includes("document.location.href")
        ) {
          return {
            result: {
              value: {
                readyState: "complete",
                href: "http://127.0.0.1/admin",
              },
            },
          };
        }
        return { result: { value: null } };
      }
      return {};
    };

    const extensionCtx: ToolContext = {
      ...ctx,
      hostBrowserProxy: {} as unknown as ToolContext["hostBrowserProxy"],
    };
    const result = await executeBrowserNavigate(
      { url: "https://public.example.com/start" },
      extensionCtx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigation blocked");
    expect(result.content).toContain("Final URL resolved to a local/private");
    expect(result.content).toContain("allow_private_network=true");
    expect(cdpDisposed).toBe(true);
  });

  // ── Defense-in-depth: post-navigation final URL check ─────────

  test("post-nav check blocks when final URL resolves to private target", async () => {
    // The initial URL is public and passes pre-flight checks, but the
    // final URL (after redirect) resolves to a private address. The
    // route handler is NOT triggered (navigation succeeds), so only the
    // post-navigation defense-in-depth check catches it.
    parseUrlResult = new URL("https://public.example.com/redirect");
    isPrivateResult = false;

    // Configure parseUrlMock to return different results for the initial
    // URL vs. the final URL returned by navigateAndWait.
    parseUrlMock = (input: unknown) => {
      if (typeof input === "string" && input.includes("192.168")) {
        return new URL(input);
      }
      return parseUrlResult;
    };
    isPrivateHostMock = (hostname: string) => {
      return hostname === "192.168.1.1";
    };

    // navigateAndWait returns a private final URL (simulating a
    // server-side redirect that the route handler didn't catch).
    cdpSendHandler = (method, params) => {
      if (method === "Page.navigate") return { frameId: "f1" };
      if (method === "Runtime.evaluate") {
        const expression = String(params?.["expression"] ?? "");
        if (expression === "document.location.href") {
          return { result: { value: "about:blank" } };
        }
        if (
          expression.includes("readyState") &&
          expression.includes("document.location.href")
        ) {
          return {
            result: {
              value: {
                readyState: "complete",
                href: "http://192.168.1.1/admin",
              },
            },
          };
        }
        return { result: { value: null } };
      }
      return {};
    };

    const result = await executeBrowserNavigate(
      { url: "https://public.example.com/redirect" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigation blocked");
    expect(result.content).toContain("Final URL resolved to a local/private");
    expect(result.content).toContain("allow_private_network=true");
    expect(cdpDisposed).toBe(true);
  });
});
