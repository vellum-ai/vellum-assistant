/**
 * Tests for AppSourceWatcher — filesystem watcher that detects app source
 * file changes and triggers debounced recompile + surface refresh.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const TEST_APPS_DIR = "/tmp/test-apps";
const testDirNameMap = new Map<string, string>([["my-app", "app-id-1"]]);

let capturedWatchCallback:
  | ((eventType: string, filename: string | null) => void)
  | null = null;
let capturedErrorHandler: ((err: unknown) => void) | null = null;
const mockWatcher = {
  close: mock(() => {}),
  on: mock((event: string, handler: (err: unknown) => void) => {
    if (event === "error") capturedErrorHandler = handler;
  }),
};
const mockExistsSync = mock((p: string): boolean => p === TEST_APPS_DIR);
const mockWatch = mock(
  (
    _path: string,
    _opts: Record<string, unknown>,
    callback: (eventType: string, filename: string | null) => void,
  ) => {
    capturedWatchCallback = callback;
    return mockWatcher;
  },
);

mock.module("node:fs", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actualFs = require("node:fs");
  return {
    ...actualFs,
    existsSync: mockExistsSync,
    watch: mockWatch,
  };
});

mock.module("../apps/app-store.js", () => ({
  getAppsDir: mock(() => TEST_APPS_DIR),
  resolveAppIdByDirName: mock(
    (dirName: string) => testDirNameMap.get(dirName) ?? null,
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AppSourceWatcher } from "../daemon/app-source-watcher.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AppSourceWatcher", () => {
  let watcher: AppSourceWatcher;
  let onChangeSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    watcher = new AppSourceWatcher();
    onChangeSpy = mock(() => {});
    capturedWatchCallback = null;
    capturedErrorHandler = null;
    mockWatcher.close.mockClear();
    mockWatcher.on.mockClear();
    // Reset existsSync to default behavior for each test
    mockExistsSync.mockImplementation((p: string) => p === TEST_APPS_DIR);
  });

  afterEach(() => {
    watcher.stop();
  });

  test("start() creates a recursive watcher on the apps directory", () => {
    watcher.start(onChangeSpy);
    expect(capturedWatchCallback).not.toBeNull();
  });

  test("source file change triggers callback with resolved appId", async () => {
    watcher.start(onChangeSpy);
    capturedWatchCallback!("change", "my-app/src/main.tsx");

    // Wait for debounce (500ms + margin)
    await new Promise((r) => setTimeout(r, 600));
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    expect(onChangeSpy).toHaveBeenCalledWith("app-id-1");
  });

  test("root-level app file triggers callback", async () => {
    watcher.start(onChangeSpy);
    capturedWatchCallback!("change", "my-app/index.html");

    await new Promise((r) => setTimeout(r, 600));
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    expect(onChangeSpy).toHaveBeenCalledWith("app-id-1");
  });

  test("dist/ files are filtered out", async () => {
    watcher.start(onChangeSpy);
    capturedWatchCallback!("change", "my-app/dist/index.html");

    await new Promise((r) => setTimeout(r, 600));
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  test("records/ files are filtered out", async () => {
    watcher.start(onChangeSpy);
    capturedWatchCallback!("change", "my-app/records/rec-1.json");

    await new Promise((r) => setTimeout(r, 600));
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  test(".git/ files are filtered out (apps-directory git repo churn)", async () => {
    watcher.start(onChangeSpy);
    capturedWatchCallback!("change", ".git/objects/ab/cdef");
    capturedWatchCallback!("change", ".git/index");
    capturedWatchCallback!("change", ".git/refs/heads/main");
    capturedWatchCallback!("change", ".git/logs/HEAD");

    await new Promise((r) => setTimeout(r, 600));
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  test("files directly in apps/ (no subdirectory) are filtered out", async () => {
    watcher.start(onChangeSpy);
    capturedWatchCallback!("change", "my-app.json");

    await new Promise((r) => setTimeout(r, 600));
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  test("unknown app directory is filtered out", async () => {
    watcher.start(onChangeSpy);
    capturedWatchCallback!("change", "unknown-app/src/main.tsx");

    await new Promise((r) => setTimeout(r, 600));
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  test("null filename is ignored", async () => {
    watcher.start(onChangeSpy);
    capturedWatchCallback!("change", null);

    await new Promise((r) => setTimeout(r, 600));
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  test("rapid changes to same app are debounced into single callback", async () => {
    watcher.start(onChangeSpy);

    capturedWatchCallback!("change", "my-app/src/main.tsx");
    capturedWatchCallback!("change", "my-app/src/styles.css");
    capturedWatchCallback!("change", "my-app/src/utils.ts");

    await new Promise((r) => setTimeout(r, 600));
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
  });

  test("stop() closes watcher and cancels pending timers", () => {
    watcher.start(onChangeSpy);
    capturedWatchCallback!("change", "my-app/src/main.tsx");

    watcher.stop();

    expect(mockWatcher.close).toHaveBeenCalledTimes(1);
  });

  test("ensureStarted() initializes watcher after apps directory is created", () => {
    // Simulate apps dir not existing at start time
    mockExistsSync.mockImplementation((_p: string) => false);

    watcher.start(onChangeSpy);
    expect(capturedWatchCallback).toBeNull(); // watcher didn't start

    // Simulate apps dir now existing (e.g. after app_create)
    mockExistsSync.mockImplementation((p: string) => p === TEST_APPS_DIR);

    watcher.ensureStarted();
    expect(capturedWatchCallback).not.toBeNull(); // watcher started
  });

  test("ensureStarted() is a no-op when watcher is already running", () => {
    watcher.start(onChangeSpy);
    const callCountAfterStart = mockWatch.mock.calls.length;

    watcher.ensureStarted();
    expect(mockWatch.mock.calls.length).toBe(callCountAfterStart); // no extra watch call
  });

  /**
   * REGRESSION: a recursive watch over a large app tree (node_modules) can
   * exhaust the inotify watch limit and emit ENOSPC asynchronously as an
   * 'error' event. Without an 'error' listener that rethrows as an
   * uncaughtException and crashes the daemon. The watcher must swallow it.
   */
  test("attaches an 'error' handler that does not rethrow on async ENOSPC", () => {
    watcher.start(onChangeSpy);

    expect(capturedErrorHandler).not.toBeNull();
    const enospc = Object.assign(
      new Error("ENOSPC: no space left on device, watch"),
      { code: "ENOSPC", errno: -28, syscall: "watch" },
    );
    expect(() => capturedErrorHandler!(enospc)).not.toThrow();
  });
});
