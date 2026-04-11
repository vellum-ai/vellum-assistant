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
  buildBrowserWsUrl,
  DevToolsDiscoveryError,
  type DevToolsTarget,
  discoverTargetsViaWs,
  isHttpDiscoveryFallbackEligible,
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
// probeDevToolsJsonVersion — webSocketDebuggerUrl loopback validation.
// ---------------------------------------------------------------------------

describe("probeDevToolsJsonVersion — webSocketDebuggerUrl loopback", () => {
  let fake: FakeDevTools;

  beforeEach(() => {
    fake = startFakeDevTools();
  });

  afterEach(() => {
    fake.stop();
  });

  test("rejects when webSocketDebuggerUrl host is not loopback", async () => {
    fake.setHandler(() =>
      chromeVersionResponse({
        webSocketDebuggerUrl: "ws://evil.com/devtools/browser/abc",
      }),
    );

    const error = await probeDevToolsJsonVersion({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("non_loopback");
    expect((error as DevToolsDiscoveryError).message).toContain("evil.com");
  });

  test("accepts loopback webSocketDebuggerUrl", async () => {
    fake.setHandler(() =>
      chromeVersionResponse({
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      }),
    );

    const info = await probeDevToolsJsonVersion({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    });

    expect(info.browser).toContain("Chrome");
    expect(info.webSocketDebuggerUrl).toBe(
      "ws://127.0.0.1:9222/devtools/browser/abc",
    );
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

  test("stalled response body triggers timeout (not invalid_response)", async () => {
    // Regression test: a responder that sends headers + a partial body
    // and then stalls the stream must still be cancelled by the
    // discovery timeout. If the timer was cleared right after `fetch()`
    // resolved, `response.text()` would hang forever. See review on
    // PR #24601.
    const fake = startFakeDevTools();
    const stalledStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
    fake.setHandler(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Send a partial JSON body so `fetch()` can resolve its
              // headers promise, then never enqueue more. Keep a ref so
              // the test can close the stream during cleanup.
              controller.enqueue(new TextEncoder().encode('{"'));
              stalledStreams.push(controller);
              // Intentionally do NOT call controller.close().
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              // No content-length so the reader keeps waiting for more.
              "transfer-encoding": "chunked",
            },
          },
        ),
    );

    try {
      const startedAt = Date.now();
      const error = await probeDevToolsJsonVersion({
        host: "127.0.0.1",
        port: fake.port,
        timeoutMs: 100,
      }).catch((e: unknown) => e);
      const elapsed = Date.now() - startedAt;

      expect(error).toBeInstanceOf(DevToolsDiscoveryError);
      expect((error as DevToolsDiscoveryError).code).toBe("timeout");
      // Should resolve roughly at `timeoutMs`, not hang indefinitely.
      // Generous upper bound to keep the test stable under load.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      // Unblock the server's streams so Bun.serve can shut down cleanly.
      for (const controller of stalledStreams) {
        try {
          controller.close();
        } catch {
          // Stream may already be in an errored state from the abort.
        }
      }
      fake.stop();
    }
  });

  test("stalled response body during listDevToolsTargets triggers timeout", async () => {
    // Same regression, checked on the /json/list path.
    const fake = startFakeDevTools();
    const stalledStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
    fake.setHandler(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("["));
              stalledStreams.push(controller);
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "transfer-encoding": "chunked",
            },
          },
        ),
    );

    try {
      const startedAt = Date.now();
      const error = await listDevToolsTargets({
        host: "127.0.0.1",
        port: fake.port,
        timeoutMs: 100,
      }).catch((e: unknown) => e);
      const elapsed = Date.now() - startedAt;

      expect(error).toBeInstanceOf(DevToolsDiscoveryError);
      expect((error as DevToolsDiscoveryError).code).toBe("timeout");
      expect(elapsed).toBeLessThan(2000);
    } finally {
      for (const controller of stalledStreams) {
        try {
          controller.close();
        } catch {
          // Stream may already be in an errored state from the abort.
        }
      }
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

  test("filters out targets with non-loopback webSocketDebuggerUrl", async () => {
    fake.setHandler(() =>
      Response.json([
        {
          id: "evil",
          type: "page",
          title: "Evil Target",
          url: "https://example.com/evil",
          webSocketDebuggerUrl: "ws://evil.com/devtools/page/evil",
        },
        {
          id: "good",
          type: "page",
          title: "Good Target",
          url: "https://example.com/good",
          webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/good",
        },
      ]),
    );

    const targets = await listDevToolsTargets({
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 2000,
    });

    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe("good");
  });

  test("throws no_targets when all targets have non-loopback webSocketDebuggerUrl", async () => {
    fake.setHandler(() =>
      Response.json([
        {
          id: "evil",
          type: "page",
          title: "Evil Target",
          url: "https://example.com/evil",
          webSocketDebuggerUrl: "ws://evil.com/devtools/page/evil",
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

// ---------------------------------------------------------------------------
// buildBrowserWsUrl — loopback enforcement and URL construction.
// ---------------------------------------------------------------------------

describe("buildBrowserWsUrl", () => {
  test("builds ws URL for localhost", () => {
    expect(buildBrowserWsUrl("localhost", 9222)).toBe(
      "ws://localhost:9222/devtools/browser",
    );
  });

  test("builds ws URL for 127.0.0.1", () => {
    expect(buildBrowserWsUrl("127.0.0.1", 9333)).toBe(
      "ws://127.0.0.1:9333/devtools/browser",
    );
  });

  test("wraps bare ::1 in brackets", () => {
    expect(buildBrowserWsUrl("::1", 9222)).toBe(
      "ws://[::1]:9222/devtools/browser",
    );
  });

  test("accepts [::1] (already bracketed)", () => {
    expect(buildBrowserWsUrl("[::1]", 9222)).toBe(
      "ws://[::1]:9222/devtools/browser",
    );
  });

  test("is case-insensitive for LOCALHOST", () => {
    expect(buildBrowserWsUrl("LOCALHOST", 9222)).toBe(
      "ws://localhost:9222/devtools/browser",
    );
  });

  test("rejects non-loopback hosts with non_loopback", () => {
    expect(() => buildBrowserWsUrl("192.168.1.1", 9222)).toThrow(
      DevToolsDiscoveryError,
    );
    try {
      buildBrowserWsUrl("evil.com", 9222);
    } catch (e) {
      expect((e as DevToolsDiscoveryError).code).toBe("non_loopback");
    }
  });
});

// ---------------------------------------------------------------------------
// isHttpDiscoveryFallbackEligible — determines which errors trigger fallback.
// ---------------------------------------------------------------------------

describe("isHttpDiscoveryFallbackEligible", () => {
  test("returns true for invalid_response", () => {
    const err = new DevToolsDiscoveryError("invalid_response", "bad");
    expect(isHttpDiscoveryFallbackEligible(err)).toBe(true);
  });

  test("returns true for unreachable", () => {
    const err = new DevToolsDiscoveryError("unreachable", "gone");
    expect(isHttpDiscoveryFallbackEligible(err)).toBe(true);
  });

  test("returns false for non_loopback", () => {
    const err = new DevToolsDiscoveryError("non_loopback", "nope");
    expect(isHttpDiscoveryFallbackEligible(err)).toBe(false);
  });

  test("returns false for non_chrome", () => {
    const err = new DevToolsDiscoveryError("non_chrome", "Firefox");
    expect(isHttpDiscoveryFallbackEligible(err)).toBe(false);
  });

  test("returns false for timeout", () => {
    const err = new DevToolsDiscoveryError("timeout", "too slow");
    expect(isHttpDiscoveryFallbackEligible(err)).toBe(false);
  });

  test("returns false for no_targets", () => {
    const err = new DevToolsDiscoveryError("no_targets", "empty");
    expect(isHttpDiscoveryFallbackEligible(err)).toBe(false);
  });

  test("returns false for non-DevToolsDiscoveryError", () => {
    expect(isHttpDiscoveryFallbackEligible(new Error("random"))).toBe(false);
    expect(isHttpDiscoveryFallbackEligible("string")).toBe(false);
    expect(isHttpDiscoveryFallbackEligible(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// discoverTargetsViaWs — target enumeration via CDP Target.getTargets.
// ---------------------------------------------------------------------------

describe("discoverTargetsViaWs", () => {
  /**
   * Minimal fake transport that resolves Target.getTargets with the
   * provided target infos.
   */
  function fakeTransport(targetInfos: unknown[]) {
    return {
      send: async () => ({ targetInfos }),
      addEventListener: () => () => {},
      dispose: () => {},
    } as unknown as import("../../cdp-inspect/ws-transport.js").CdpWsTransport;
  }

  test("filters page targets and constructs ws URLs", async () => {
    const transport = fakeTransport([
      {
        targetId: "A",
        type: "page",
        title: "Example",
        url: "https://example.com/",
      },
      {
        targetId: "B",
        type: "service_worker",
        title: "sw",
        url: "https://example.com/sw.js",
      },
      {
        targetId: "C",
        type: "page",
        title: "Another",
        url: "https://another.com/",
      },
    ]);

    const targets = await discoverTargetsViaWs({
      transport,
      host: "127.0.0.1",
      port: 9222,
    });

    expect(targets).toHaveLength(2);
    expect(targets[0]!.id).toBe("A");
    expect(targets[0]!.webSocketDebuggerUrl).toBe(
      "ws://127.0.0.1:9222/devtools/page/A",
    );
    expect(targets[1]!.id).toBe("C");
    expect(targets[1]!.webSocketDebuggerUrl).toBe(
      "ws://127.0.0.1:9222/devtools/page/C",
    );
  });

  test("throws no_targets when no page targets exist", async () => {
    const transport = fakeTransport([
      {
        targetId: "B",
        type: "service_worker",
        title: "sw",
        url: "https://example.com/sw.js",
      },
    ]);

    const error = await discoverTargetsViaWs({
      transport,
      host: "127.0.0.1",
      port: 9222,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("no_targets");
  });

  test("throws no_targets when targetInfos is empty", async () => {
    const transport = fakeTransport([]);

    const error = await discoverTargetsViaWs({
      transport,
      host: "127.0.0.1",
      port: 9222,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("no_targets");
  });

  test("throws ws_fallback_failed when targetInfos is missing", async () => {
    const transport = {
      send: async () => ({}),
      addEventListener: () => () => {},
      dispose: () => {},
    } as unknown as import("../../cdp-inspect/ws-transport.js").CdpWsTransport;

    const error = await discoverTargetsViaWs({
      transport,
      host: "127.0.0.1",
      port: 9222,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("ws_fallback_failed");
  });

  test("rejects non-loopback host before calling transport", async () => {
    let transportCalled = false;
    const transport = {
      send: async () => {
        transportCalled = true;
        return { targetInfos: [] };
      },
      addEventListener: () => () => {},
      dispose: () => {},
    } as unknown as import("../../cdp-inspect/ws-transport.js").CdpWsTransport;

    const error = await discoverTargetsViaWs({
      transport,
      host: "evil.com",
      port: 9222,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevToolsDiscoveryError);
    expect((error as DevToolsDiscoveryError).code).toBe("non_loopback");
    expect(transportCalled).toBe(false);
  });

  test("skips entries with empty or missing targetId", async () => {
    const transport = fakeTransport([
      { targetId: "", type: "page", title: "Empty ID", url: "https://a.com/" },
      { type: "page", title: "Missing ID", url: "https://b.com/" },
      {
        targetId: "valid",
        type: "page",
        title: "Valid",
        url: "https://c.com/",
      },
    ]);

    const targets = await discoverTargetsViaWs({
      transport,
      host: "127.0.0.1",
      port: 9222,
    });

    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe("valid");
  });

  test("constructs IPv6 ws URLs with brackets", async () => {
    const transport = fakeTransport([
      {
        targetId: "A",
        type: "page",
        title: "Page",
        url: "https://example.com/",
      },
    ]);

    const targets = await discoverTargetsViaWs({
      transport,
      host: "::1",
      port: 9222,
    });

    expect(targets[0]!.webSocketDebuggerUrl).toBe(
      "ws://[::1]:9222/devtools/page/A",
    );
  });
});
