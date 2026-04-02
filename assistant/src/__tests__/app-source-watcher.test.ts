/**
 * Tests for AppSourceWatcher — filesystem watcher that detects app source
 * file changes and triggers debounced recompile + surface refresh.
 */

import * as actualFs from "node:fs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const TEST_APPS_DIR = "/tmp/test-apps";
const testDirNameMap = new Map<string, string>([["my-app", "app-id-1"]]);

let capturedWatchCallback: ((eventType: string, filename: string | null) => void) | null = null;
const mockWatcher = { close: mock(() => {}) };

mock.module("node:fs", () => {
  return {
    ...actualFs,
    existsSync: mock((p: string) => p === TEST_APPS_DIR),
    watch: mock(
      (
        _path: string,
        _opts: Record<string, unknown>,
        callback: (eventType: string, filename: string | null) => void,
      ) => {
        capturedWatchCallback = callback;
        return mockWatcher;
      },
    ),
  };
});

mock.module("../memory/app-store.js", () => ({
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
    mockWatcher.close.mockClear();
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
});
