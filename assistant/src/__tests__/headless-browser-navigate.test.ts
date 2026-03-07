import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp/headless-browser-test",
}));

// Track calls to browserManager and url-safety helpers
let mockPage: {
  goto: ReturnType<typeof mock>;
  title: ReturnType<typeof mock>;
  url: ReturnType<typeof mock>;
  route: ReturnType<typeof mock>;
  unroute: ReturnType<typeof mock>;
  close: () => Promise<void>;
  isClosed: () => boolean;
};

let getOrCreateSessionPageMock: ReturnType<typeof mock>;

mock.module("../tools/browser/browser-manager.js", () => {
  getOrCreateSessionPageMock = mock(async () => mockPage);
  return {
    browserManager: {
      getOrCreateSessionPage: getOrCreateSessionPageMock,
      clearSnapshotMap: mock(() => {}),
      supportsRouteInterception: true,
      isInteractive: () => false,
      positionWindowSidebar: () => {},
    },
  };
});

// Default url-safety: allow everything
let parseUrlResult: URL | null = null;
let isPrivateResult = false;
let resolveResult: { blockedAddress?: string } = {};

mock.module("../tools/network/url-safety.js", () => ({
  parseUrl: (_input: unknown) => parseUrlResult,
  isPrivateOrLocalHost: () => isPrivateResult,
  resolveHostAddresses: async () => [],
  resolveRequestAddress: async () => resolveResult,
  sanitizeUrlForOutput: (url: URL) => url.href,
}));

import { executeBrowserNavigate } from "../tools/browser/browser-execution.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  sessionId: "test-session",
  conversationId: "test-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
};

function resetMockPage() {
  mockPage = {
    goto: mock(async () => ({
      status: () => 200,
      url: () => "https://example.com/",
    })),
    title: mock(async () => "Example"),
    url: mock(() => "https://example.com/"),
    route: mock(async () => {}),
    unroute: mock(async () => {}),
    close: async () => {},
    isClosed: () => false,
  };
}

describe("executeBrowserNavigate", () => {
  beforeEach(() => {
    parseUrlResult = null;
    isPrivateResult = false;
    resolveResult = {};
    resetMockPage();
  });

  // ── Input validation ───────────────────────────────────────────

  test("rejects missing or invalid url", async () => {
    const result = await executeBrowserNavigate({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("url is required");
  });

  test("rejects non-http(s) protocols", async () => {
    parseUrlResult = new URL("ftp://example.com");
    const result = await executeBrowserNavigate(
      { url: "ftp://example.com" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("http or https");
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
  });

  test("allows private hosts with allow_private_network=true", async () => {
    parseUrlResult = new URL("http://localhost:3000");
    isPrivateResult = true;
    const result = await executeBrowserNavigate(
      { url: "http://localhost:3000", allow_private_network: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Status: 200");
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
    expect(result.content).toContain("Status: 200");
  });

  // ── Successful navigation ──────────────────────────────────────

  test("returns structured result on success", async () => {
    parseUrlResult = new URL("https://example.com/page");
    const result = await executeBrowserNavigate(
      { url: "https://example.com/page" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Requested URL:");
    expect(result.content).toContain("Final URL:");
    expect(result.content).toContain("Status: 200");
    expect(result.content).toContain("Title: Example");
  });

  test("notes redirect when final URL differs", async () => {
    parseUrlResult = new URL("https://example.com/old");
    mockPage.url = mock(() => "https://example.com/new");
    const result = await executeBrowserNavigate(
      { url: "https://example.com/old" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("redirected");
  });

  test("handles null response status", async () => {
    parseUrlResult = new URL("https://example.com");
    mockPage.goto = mock(async () => null);
    const result = await executeBrowserNavigate(
      { url: "https://example.com" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Status: unknown");
  });

  // ── Error handling ─────────────────────────────────────────────

  test("catches navigation errors", async () => {
    parseUrlResult = new URL("https://example.com");
    mockPage.goto = mock(async () => {
      throw new Error("net::ERR_CONNECTION_REFUSED");
    });
    const result = await executeBrowserNavigate(
      { url: "https://example.com" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigation failed");
    expect(result.content).toContain("ERR_CONNECTION_REFUSED");
  });

  test("returns security message when route handler blocks a redirect and goto throws", async () => {
    parseUrlResult = new URL("https://public.example.com");
    isPrivateResult = false;

    // Capture the route handler when page.route is called
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

    // Make goto invoke the captured handler with a private redirect target, then throw
    mockPage.goto = mock(async () => {
      if (capturedHandler) {
        // Temporarily make isPrivateOrLocalHost return true for the redirect target
        isPrivateResult = true;
        const mockRoute = {
          abort: mock(async () => {}),
          continue: mock(async () => {}),
        };
        const mockRequest = { url: () => "http://169.254.169.254/metadata" };
        await capturedHandler(mockRoute, mockRequest);
        isPrivateResult = false;
      }
      throw new Error("net::ERR_BLOCKED_BY_CLIENT");
    });

    const result = await executeBrowserNavigate(
      { url: "https://public.example.com" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Navigation blocked");
    expect(result.content).toContain("allow_private_network=true");
    // Should NOT contain the raw Playwright error
    expect(result.content).not.toContain("ERR_BLOCKED_BY_CLIENT");
  });
});
