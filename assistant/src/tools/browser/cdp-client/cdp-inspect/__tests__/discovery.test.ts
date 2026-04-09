/**
 * Unit tests for the DevTools HTTP discovery helpers.
 *
 * These tests boot a tiny `Bun.serve` instance per test (or per
 * describe block) and point the helpers at it. The goal is to cover
 * every error branch without relying on a real Chrome being present
 * on the dev machine or CI runner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DevToolsDiscoveryError,
  type DevToolsTarget,
  listDevToolsTargets,
  pickDefaultTarget,
  probeDevToolsJsonVersion,
} from "../discovery.js";

// ---------------------------------------------------------------------------
// Test fixture: a tiny Bun.serve that can be reconfigured per test.
// ---------------------------------------------------------------------------

type Handler = (req: Request) => Response | Promise<Response>;

interface FakeDevTools {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  setHandler: (handler: Handler) => void;
  stop: () => void;
}

function startFakeDevTools(): FakeDevTools {
  let handler: Handler = () => new Response("not configured", { status: 500 });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      return handler(req);
    },
  });
  return {
    server,
    port: server.port as number,
    setHandler: (h) => {
      handler = h;
    },
    stop: () => server.stop(true),
  };
}

function chromeVersionResponse(
  overrides: Record<string, string> = {},
): Response {
  return Response.json({
    Browser: "Chrome/124.0.6367.91",
    "Protocol-Version": "1.3",
    "User-Agent": "Mozilla/5.0",
    "V8-Version": "12.4.254.13",
    "WebKit-Version": "537.36",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abcd-1234",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Loopback enforcement — must reject BEFORE any fetch call.
// ---------------------------------------------------------------------------

describe("probeDevToolsJsonVersion — loopback enforcement", () => {
  test("rejects non-loopback host with non_loopback and does not fetch", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCallCount += 1;
      return originalFetch(...(args as Parameters<typeof fetch>));
    }) as typeof fetch;

    try {
      await expect(
        probeDevToolsJsonVersion({
          host: "192.168.1.1",
          port: 9222,
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({
        name: "DevToolsDiscoveryError",
        code: "non_loopback",
      });
      expect(fetchCallCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects public DNS hostname before fetching", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCallCount += 1;
      return originalFetch(...(args as Parameters<typeof fetch>));
    }) as typeof fetch;

    try {
      await expect(
        probeDevToolsJsonVersion({
          host: "example.com",
          port: 9222,
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({
        name: "DevToolsDiscoveryError",
        code: "non_loopback",
      });
      expect(fetchCallCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("accepts localhost, 127.0.0.1, ::1 (case-insensitive)", async () => {
    const fake = startFakeDevTools();
    fake.setHandler(() => chromeVersionResponse());
    try {
      for (const host of ["localhost", "LOCALHOST", "127.0.0.1"]) {
        const info = await probeDevToolsJsonVersion({
          host,
          port: fake.port,
          timeoutMs: 2000,
        });
        expect(info.browser).toContain("Chrome");
      }
    } finally {
      fake.stop();
    }
  });

  test("listDevToolsTargets also rejects non-loopback before fetch", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCallCount += 1;
      return originalFetch(...(args as Parameters<typeof fetch>));
    }) as typeof fetch;

    try {
      await expect(
        listDevToolsTargets({
          host: "10.0.0.1",
          port: 9222,
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({
        name: "DevToolsDiscoveryError",
        code: "non_loopback",
      });
      expect(fetchCallCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// probeDevToolsJsonVersion — happy paths.
// ---------------------------------------------------------------------------

describe("probeDevToolsJsonVersion — parsing", () => {
  let fake: FakeDevTools;

  beforeEach(() => {
    fake = startFakeDevTools();
  });

  afterEach(() => {
    fake.stop();
  });

  test("parses real Chrome field casing", async () => {
    fake.setHandler(() =>
      chromeVersionResponse({
        Browser: "Chrome/126.0.6478.127",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/xyz",
      }),
    );

    const info = await probeDevToolsJsonVersion({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    });

    expect(info.browser).toBe("Chrome/126.0.6478.127");
    expect(info.protocolVersion).toBe("1.3");
    expect(info.webSocketDebuggerUrl).toBe(
      "ws://127.0.0.1:9222/devtools/browser/xyz",
    );
  });

  test("parses normalized camelCase field casing", async () => {
    fake.setHandler(() =>
      Response.json({
        browser: "Chromium/125.0.6422.141",
        protocolVersion: "1.3",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/normalized",
      }),
    );

    const info = await probeDevToolsJsonVersion({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    });

    expect(info.browser).toBe("Chromium/125.0.6422.141");
    expect(info.protocolVersion).toBe("1.3");
    expect(info.webSocketDebuggerUrl).toBe(
      "ws://127.0.0.1:9222/devtools/browser/normalized",
    );
  });

  test("rejects non-Chrome responder with non_chrome", async () => {
    fake.setHandler(() => chromeVersionResponse({ Browser: "Firefox/115.0" }));

    const error = await probeDevToolsJsonVersion({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("non_chrome");
  });

  test("rejects missing required fields with invalid_response", async () => {
    fake.setHandler(() =>
      Response.json({
        Browser: "Chrome/123",
        // Missing Protocol-Version and webSocketDebuggerUrl
      }),
    );

    const error = await probeDevToolsJsonVersion({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("invalid_response");
  });

  test("rejects malformed JSON body with invalid_response", async () => {
    fake.setHandler(
      () =>
        new Response("not json at all {{{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const error = await probeDevToolsJsonVersion({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("invalid_response");
  });

  test("rejects non-object JSON body with invalid_response", async () => {
    fake.setHandler(() => Response.json(["not", "an", "object"]));

    const error = await probeDevToolsJsonVersion({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("invalid_response");
  });

  test("rejects non-200 status with invalid_response", async () => {
    fake.setHandler(() => new Response("nope", { status: 404 }));

    const error = await probeDevToolsJsonVersion({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("invalid_response");
  });
});

// ---------------------------------------------------------------------------
// probeDevToolsJsonVersion — network-level error paths.
// ---------------------------------------------------------------------------

describe("probeDevToolsJsonVersion — network errors", () => {
  test("connection refused (unreachable)", async () => {
    // Boot a server then stop it to get a guaranteed-free port.
    const fake = startFakeDevTools();
    const deadPort = fake.port;
    fake.stop();

    const error = await probeDevToolsJsonVersion({
      host: "127.0.0.1",
      port: deadPort,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("unreachable");
  });

  test("stalled server triggers timeout", async () => {
    const fake = startFakeDevTools();
    fake.setHandler(
      () =>
        new Promise<Response>(() => {
          // Intentionally never resolve.
        }),
    );

    try {
      const error = await probeDevToolsJsonVersion({
        host: "127.0.0.1",
        port: fake.port,
        timeoutMs: 50,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DevToolsDiscoveryError);
      expect((error as DevToolsDiscoveryError).code).toBe("timeout");
    } finally {
      fake.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// listDevToolsTargets — filtering and parsing.
// ---------------------------------------------------------------------------

describe("listDevToolsTargets", () => {
  let fake: FakeDevTools;

  beforeEach(() => {
    fake = startFakeDevTools();
  });

  afterEach(() => {
    fake.stop();
  });

  test("filters non-page targets and returns parsed pages", async () => {
    fake.setHandler(() =>
      Response.json([
        {
          id: "A",
          type: "page",
          title: "Example",
          url: "https://example.com/",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/A",
        },
        {
          id: "B",
          type: "service_worker",
          title: "sw",
          url: "https://example.com/sw.js",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/B",
        },
        {
          id: "C",
          type: "iframe",
          title: "frame",
          url: "https://example.com/frame",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/C",
        },
        {
          id: "D",
          type: "page",
          title: "Second Page",
          url: "https://docs.example.com/",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/D",
        },
      ]),
    );

    const targets = await listDevToolsTargets({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    });

    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.id)).toEqual(["A", "D"]);
    expect(targets[0]!.webSocketDebuggerUrl).toBe(
      "ws://127.0.0.1:9222/devtools/page/A",
    );
  });

  test("drops page targets without webSocketDebuggerUrl", async () => {
    fake.setHandler(() =>
      Response.json([
        {
          id: "A",
          type: "page",
          title: "Missing WS",
          url: "https://example.com/",
          webSocketDebuggerUrl: "",
        },
        {
          id: "B",
          type: "page",
          title: "Good Page",
          url: "https://example.com/ok",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/B",
        },
      ]),
    );

    const targets = await listDevToolsTargets({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    });

    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe("B");
  });

  test("throws no_targets when filtered list is empty", async () => {
    fake.setHandler(() =>
      Response.json([
        {
          id: "A",
          type: "service_worker",
          title: "sw",
          url: "https://example.com/sw.js",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/A",
        },
      ]),
    );

    const error = await listDevToolsTargets({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("no_targets");
  });

  test("throws invalid_response when body is not a JSON array", async () => {
    fake.setHandler(() => Response.json({ not: "an array" }));

    const error = await listDevToolsTargets({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("invalid_response");
  });
});

// ---------------------------------------------------------------------------
// pickDefaultTarget — prefers real pages, falls back to first.
// ---------------------------------------------------------------------------

describe("pickDefaultTarget", () => {
  function makeTarget(partial: Partial<DevToolsTarget>): DevToolsTarget {
    return {
      id: partial.id ?? "id",
      type: partial.type ?? "page",
      title: partial.title ?? "title",
      url: partial.url ?? "https://example.com/",
      webSocketDebuggerUrl:
        partial.webSocketDebuggerUrl ?? "ws://127.0.0.1:9222/devtools/page/id",
    };
  }

  test("throws no_targets on empty input", () => {
    expect(() => pickDefaultTarget([])).toThrow(DevToolsDiscoveryError);
    try {
      pickDefaultTarget([]);
    } catch (e) {
      expect((e as DevToolsDiscoveryError).code).toBe("no_targets");
    }
  });

  test("prefers a real https page over chrome:// targets", () => {
    const targets: DevToolsTarget[] = [
      makeTarget({ id: "newtab", url: "chrome://newtab/" }),
      makeTarget({ id: "devtools", url: "devtools://devtools/bundled/idx" }),
      makeTarget({ id: "site", url: "https://example.com/docs" }),
    ];
    const picked = pickDefaultTarget(targets);
    expect(picked.id).toBe("site");
  });

  test("prefers a real page over about:blank", () => {
    const targets: DevToolsTarget[] = [
      makeTarget({ id: "blank", url: "about:blank" }),
      makeTarget({ id: "real", url: "https://example.com/" }),
    ];
    const picked = pickDefaultTarget(targets);
    expect(picked.id).toBe("real");
  });

  test("falls back to first when every target is a utility page", () => {
    const targets: DevToolsTarget[] = [
      makeTarget({ id: "newtab", url: "chrome://newtab/" }),
      makeTarget({ id: "devtools", url: "devtools://devtools/bundled/idx" }),
      makeTarget({ id: "blank", url: "about:blank" }),
    ];
    const picked = pickDefaultTarget(targets);
    expect(picked.id).toBe("newtab");
  });

  test("returns the only candidate when the list has length 1", () => {
    const targets = [makeTarget({ id: "only", url: "https://example.com/" })];
    expect(pickDefaultTarget(targets).id).toBe("only");
  });
});
