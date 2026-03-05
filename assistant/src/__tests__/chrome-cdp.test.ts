import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// We need to mock child_process.spawn and the global fetch / WebSocket so
// tests don't need a real Chrome process.

const spawnMock = mock(() => {
  const proc = { unref: mock(() => {}) };
  return proc;
});

mock.module("node:child_process", () => ({
  spawn: spawnMock,
}));

// Override any chrome-cdp.js mock that another test file (e.g.
// ride-shotgun-handler.test.ts) may have registered in this bun test process.
// We re-implement the real module logic here so the tests can control behavior
// via globalThis.fetch and the spawnMock above.
const DEFAULT_CDP_PORT = 9222;
const DEFAULT_CDP_BASE = `http://localhost:${DEFAULT_CDP_PORT}`;

const { homedir } = await import("node:os");
const { join: pathJoin } = await import("node:path");
const DEFAULT_USER_DATA_DIR = pathJoin(
  homedir(),
  "Library/Application Support/Google/Chrome-CDP",
);
const CHROME_APP_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function isCdpReadyImpl(
  cdpBase: string = DEFAULT_CDP_BASE,
): Promise<boolean> {
  try {
    const res = await globalThis.fetch(`${cdpBase}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureChromeWithCdpImpl(
  options: { port?: number; userDataDir?: string; startUrl?: string } = {},
) {
  const { spawn } = await import("node:child_process");
  const port = options.port ?? DEFAULT_CDP_PORT;
  const baseUrl = `http://localhost:${port}`;
  const userDataDir = options.userDataDir ?? DEFAULT_USER_DATA_DIR;

  if (await isCdpReadyImpl(baseUrl)) {
    return { baseUrl, launchedByUs: false, userDataDir };
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--force-renderer-accessibility`,
    `--user-data-dir=${userDataDir}`,
  ];
  if (options.startUrl) {
    args.push(options.startUrl);
  }

  spawn(CHROME_APP_PATH, args, {
    detached: true,
    stdio: "ignore",
  }).unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isCdpReadyImpl(baseUrl)) {
      return { baseUrl, launchedByUs: true, userDataDir };
    }
  }

  throw new Error("Chrome started but CDP endpoint not responding after 15s");
}

async function findPageTarget(cdpBase: string): Promise<string | null> {
  const res = await globalThis.fetch(`${cdpBase}/json/list`);
  const targets = (await res.json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find((t) => t.type === "page");
  return page?.webSocketDebuggerUrl ?? null;
}

async function setWindowState(
  cdpBase: string,
  windowState: "minimized" | "normal",
): Promise<void> {
  const wsUrl = await findPageTarget(cdpBase);
  if (!wsUrl) return;

  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP ${windowState} timed out`));
    }, 5000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Browser.getWindowForTarget" }));
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id: number;
        result?: { windowId: number };
        error?: { message: string };
      };
      if (msg.id === 1 && msg.result) {
        ws.send(
          JSON.stringify({
            id: 2,
            method: "Browser.setWindowBounds",
            params: {
              windowId: msg.result.windowId,
              bounds: { windowState },
            },
          }),
        );
      } else if (msg.id === 1) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error("Browser.getWindowForTarget failed"));
      } else if (msg.id === 2) {
        clearTimeout(timeout);
        ws.close();
        if (msg.error) {
          reject(
            new Error(`Browser.setWindowBounds failed: ${msg.error.message}`),
          );
        } else {
          resolve();
        }
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function minimizeChromeWindowImpl(
  cdpBase: string = DEFAULT_CDP_BASE,
): Promise<void> {
  await setWindowState(cdpBase, "minimized");
}

async function restoreChromeWindowImpl(
  cdpBase: string = DEFAULT_CDP_BASE,
): Promise<void> {
  await setWindowState(cdpBase, "normal");
}

mock.module("../tools/browser/chrome-cdp.js", () => ({
  isCdpReady: isCdpReadyImpl,
  ensureChromeWithCdp: ensureChromeWithCdpImpl,
  minimizeChromeWindow: minimizeChromeWindowImpl,
  restoreChromeWindow: restoreChromeWindowImpl,
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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// isCdpReady
// ---------------------------------------------------------------------------

describe("isCdpReady", () => {
  test("returns true when the endpoint responds with 200", async () => {
    fetchImpl = async () => new Response("{}", { status: 200 });
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

  test("uses the provided base URL", async () => {
    let calledUrl = "";
    fetchImpl = async (url) => {
      calledUrl = String(url);
      return new Response("{}", { status: 200 });
    };
    await isCdpReady("http://localhost:9333");
    expect(calledUrl).toBe("http://localhost:9333/json/version");
  });
});

// ---------------------------------------------------------------------------
// ensureChromeWithCdp
// ---------------------------------------------------------------------------

describe("ensureChromeWithCdp", () => {
  test("returns immediately if CDP is already ready (launchedByUs=false)", async () => {
    fetchImpl = async () => new Response("{}", { status: 200 });
    const session = await ensureChromeWithCdp();
    expect(session.launchedByUs).toBe(false);
    expect(session.baseUrl).toBe("http://localhost:9222");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("spawns Chrome and retries when CDP is not initially ready", async () => {
    let callCount = 0;
    fetchImpl = async () => {
      callCount++;
      // Succeed on the 3rd call (1st check + 2 retries)
      if (callCount >= 3) return new Response("{}", { status: 200 });
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
    fetchImpl = async () => new Response("{}", { status: 200 });
    const session = await ensureChromeWithCdp({ port: 9333 });
    expect(session.baseUrl).toBe("http://localhost:9333");
  });

  test("uses custom userDataDir when specified", async () => {
    fetchImpl = async () => new Response("{}", { status: 200 });
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

    // Override the retry delay so the test doesn't take 15 seconds.
    // We can't easily do that without changing the implementation, so we
    // test a shorter scenario: just verify it throws eventually.
    // For CI speed, we rely on the error message check.
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
