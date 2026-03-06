import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// We need to mock child_process.spawn and execSync, and the global fetch /
// WebSocket so tests don't need a real Chrome process.

const spawnMock = mock(() => {
  const proc = { unref: mock(() => {}) };
  return proc;
});

const execSyncMock = mock(() => "");

mock.module("node:child_process", () => ({
  spawn: spawnMock,
  execSync: execSyncMock,
}));

const {
  ensureChromeWithCdp,
  isCdpReady,
  minimizeChromeWindow,
  restoreChromeWindow,
} = await import("../tools/browser/chrome-cdp.js");

// Track fetch calls so we can assert readiness-check behavior
let fetchImpl: (url: string | URL | Request) => Promise<Response>;

const originalFetch = globalThis.fetch;

/** Helper: a fetchImpl that simulates a CDP endpoint with page targets. */
function cdpReadyFetch(url: string | URL | Request): Promise<Response> {
  const urlStr = String(url);
  if (urlStr.includes("/json/list")) {
    return Promise.resolve(
      new Response(JSON.stringify([{ type: "page" }]), { status: 200 }),
    );
  }
  return Promise.resolve(new Response("{}", { status: 200 }));
}

beforeEach(() => {
  // Default: CDP not ready
  fetchImpl = async () => {
    throw new Error("Connection refused");
  };
  globalThis.fetch = (async (
    input: string | URL | Request,
    _init?: RequestInit,
  ) => {
    return fetchImpl(input);
  }) as typeof globalThis.fetch;
  spawnMock.mockClear();
  execSyncMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// isCdpReady
// ---------------------------------------------------------------------------

describe("isCdpReady", () => {
  test("returns true when the endpoint responds with 200 and has page targets", async () => {
    fetchImpl = cdpReadyFetch;
    expect(await isCdpReady()).toBe(true);
  });

  test("returns false when fetch throws (connection refused)", async () => {
    fetchImpl = async () => {
      throw new Error("Connection refused");
    };
    expect(await isCdpReady()).toBe(false);
  });

  test("returns false when the endpoint responds with non-ok status", async () => {
    fetchImpl = async () => new Response("", { status: 500 });
    expect(await isCdpReady()).toBe(false);
  });

  test("returns false when CDP is up but has no page targets", async () => {
    fetchImpl = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/json/list")) {
        return new Response("[]", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    expect(await isCdpReady()).toBe(false);
  });

  test("uses the provided base URL", async () => {
    const calledUrls: string[] = [];
    fetchImpl = async (url) => {
      const urlStr = String(url);
      calledUrls.push(urlStr);
      if (urlStr.includes("/json/list")) {
        return new Response(JSON.stringify([{ type: "page" }]), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    };
    await isCdpReady("http://localhost:9333");
    expect(calledUrls.some((u) => u.startsWith("http://localhost:9333/"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// ensureChromeWithCdp
// ---------------------------------------------------------------------------

describe("ensureChromeWithCdp", () => {
  test("returns immediately if CDP is already ready (launchedByUs=false)", async () => {
    fetchImpl = cdpReadyFetch;
    const session = await ensureChromeWithCdp();
    expect(session.launchedByUs).toBe(false);
    expect(session.baseUrl).toBe("http://localhost:9222");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("spawns Chrome and retries when CDP is not initially ready", async () => {
    let callCount = 0;
    fetchImpl = async (url) => {
      callCount++;
      // First isCdpReady check fails (2 fetch calls: /json/version + /json/list).
      // Stale-check /json/version also fails.
      // After spawn, successive isCdpReady calls succeed on the 5th overall call.
      if (callCount >= 5) {
        const urlStr = String(url);
        if (urlStr.includes("/json/list")) {
          return new Response(JSON.stringify([{ type: "page" }]), {
            status: 200,
          });
        }
        return new Response("{}", { status: 200 });
      }
      throw new Error("Connection refused");
    };

    const session = await ensureChromeWithCdp({
      startUrl: "https://example.com/",
    });
    expect(session.launchedByUs).toBe(true);
    expect(session.baseUrl).toBe("http://localhost:9222");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Verify spawn was called with the right Chrome path and args
    const spawnArgs = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(spawnArgs[0]).toContain("Google Chrome");
    const flags = spawnArgs[1];
    expect(flags).toContain("--remote-debugging-port=9222");
    expect(flags).toContain("--force-renderer-accessibility");
    expect(flags.some((f: string) => f.includes("Chrome-CDP"))).toBe(true);
    expect(flags).toContain("https://example.com/");
  });

  test("uses custom port when specified", async () => {
    fetchImpl = cdpReadyFetch;
    const session = await ensureChromeWithCdp({ port: 9333 });
    expect(session.baseUrl).toBe("http://localhost:9333");
  });

  test("uses custom userDataDir when specified", async () => {
    fetchImpl = cdpReadyFetch;
    const session = await ensureChromeWithCdp({
      userDataDir: "/tmp/test-chrome",
    });
    expect(session.userDataDir).toBe("/tmp/test-chrome");
  });

  test("throws after exhausting retries", async () => {
    // Never becomes ready
    fetchImpl = async () => {
      throw new Error("Connection refused");
    };

    const promise = ensureChromeWithCdp();
    await expect(promise).rejects.toThrow("CDP endpoint not responding");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Window management (minimize / restore)
// ---------------------------------------------------------------------------

describe("minimizeChromeWindow", () => {
  test("does nothing when no page targets exist", async () => {
    fetchImpl = async () => new Response("[]", { status: 200 });
    // Should not throw
    await minimizeChromeWindow();
  });

  test("sends minimize command via WebSocket", async () => {
    // Track the WebSocket interactions
    const sentMessages: string[] = [];
    let wsOnOpen: (() => void) | undefined;
    let wsOnMessage: ((event: { data: string }) => void) | undefined;

    fetchImpl = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/json/list")) {
        return new Response(
          JSON.stringify([
            {
              type: "page",
              webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/ABC",
            },
          ]),
        );
      }
      return new Response("{}", { status: 200 });
    };

    const OriginalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class MockWebSocket {
      constructor(_url: string) {}
      addEventListener(event: string, handler: (...args: unknown[]) => void) {
        if (event === "open") wsOnOpen = handler as () => void;
        if (event === "message")
          wsOnMessage = handler as (event: { data: string }) => void;
      }
      send(data: string) {
        sentMessages.push(data);
        const msg = JSON.parse(data);
        if (msg.method === "Browser.getWindowForTarget") {
          // Simulate response with windowId
          setTimeout(() => {
            wsOnMessage?.({
              data: JSON.stringify({ id: 1, result: { windowId: 42 } }),
            });
          }, 0);
        } else if (msg.method === "Browser.setWindowBounds") {
          setTimeout(() => {
            wsOnMessage?.({ data: JSON.stringify({ id: 2, result: {} }) });
          }, 0);
        }
      }
      close() {}
    } as unknown as typeof WebSocket;

    const promise = minimizeChromeWindow();

    // Trigger the open event
    await new Promise((r) => setTimeout(r, 10));
    wsOnOpen?.();

    await promise;

    // Verify the setWindowBounds call had windowState: "minimized"
    const boundsMsg = sentMessages.find((m) =>
      m.includes("Browser.setWindowBounds"),
    );
    expect(boundsMsg).toBeDefined();
    const parsed = JSON.parse(boundsMsg!);
    expect(parsed.params.bounds.windowState).toBe("minimized");

    globalThis.WebSocket = OriginalWebSocket;
  });
});

describe("setWindowState error handling", () => {
  test("rejects when Browser.setWindowBounds returns an error", async () => {
    let wsOnOpen: (() => void) | undefined;
    let wsOnMessage: ((event: { data: string }) => void) | undefined;

    fetchImpl = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/json/list")) {
        return new Response(
          JSON.stringify([
            {
              type: "page",
              webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/ABC",
            },
          ]),
        );
      }
      return new Response("{}", { status: 200 });
    };

    const OriginalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class MockWebSocket {
      constructor(_url: string) {}
      addEventListener(event: string, handler: (...args: unknown[]) => void) {
        if (event === "open") wsOnOpen = handler as () => void;
        if (event === "message")
          wsOnMessage = handler as (event: { data: string }) => void;
      }
      send(data: string) {
        const msg = JSON.parse(data);
        if (msg.method === "Browser.getWindowForTarget") {
          setTimeout(() => {
            wsOnMessage?.({
              data: JSON.stringify({ id: 1, result: { windowId: 42 } }),
            });
          }, 0);
        } else if (msg.method === "Browser.setWindowBounds") {
          setTimeout(() => {
            wsOnMessage?.({
              data: JSON.stringify({
                id: 2,
                error: { message: "No window with given id" },
              }),
            });
          }, 0);
        }
      }
      close() {}
    } as unknown as typeof WebSocket;

    const promise = minimizeChromeWindow();
    await new Promise((r) => setTimeout(r, 10));
    wsOnOpen?.();

    await expect(promise).rejects.toThrow("Browser.setWindowBounds failed");

    globalThis.WebSocket = OriginalWebSocket;
  });
});

describe("restoreChromeWindow", () => {
  test("sends restore command via WebSocket", async () => {
    const sentMessages: string[] = [];
    let wsOnOpen: (() => void) | undefined;
    let wsOnMessage: ((event: { data: string }) => void) | undefined;

    fetchImpl = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/json/list")) {
        return new Response(
          JSON.stringify([
            {
              type: "page",
              webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/ABC",
            },
          ]),
        );
      }
      return new Response("{}", { status: 200 });
    };

    const OriginalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class MockWebSocket {
      constructor(_url: string) {}
      addEventListener(event: string, handler: (...args: unknown[]) => void) {
        if (event === "open") wsOnOpen = handler as () => void;
        if (event === "message")
          wsOnMessage = handler as (event: { data: string }) => void;
      }
      send(data: string) {
        sentMessages.push(data);
        const msg = JSON.parse(data);
        if (msg.method === "Browser.getWindowForTarget") {
          setTimeout(() => {
            wsOnMessage?.({
              data: JSON.stringify({ id: 1, result: { windowId: 42 } }),
            });
          }, 0);
        } else if (msg.method === "Browser.setWindowBounds") {
          setTimeout(() => {
            wsOnMessage?.({ data: JSON.stringify({ id: 2, result: {} }) });
          }, 0);
        }
      }
      close() {}
    } as unknown as typeof WebSocket;

    const promise = restoreChromeWindow();
    await new Promise((r) => setTimeout(r, 10));
    wsOnOpen?.();
    await promise;

    const boundsMsg = sentMessages.find((m) =>
      m.includes("Browser.setWindowBounds"),
    );
    expect(boundsMsg).toBeDefined();
    const parsed = JSON.parse(boundsMsg!);
    expect(parsed.params.bounds.windowState).toBe("normal");

    globalThis.WebSocket = OriginalWebSocket;
  });
});
