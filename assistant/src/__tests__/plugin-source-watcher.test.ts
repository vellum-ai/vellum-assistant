/**
 * Tests for PluginSourceWatcher — filesystem watcher that detects plugin
 * directory changes and triggers debounced reregistration.
 *
 * Key regression: the watcher must survive (and recover from) the Linux/Bun
 * recursive-watch limitation where subdirectories created after watch starts
 * are silently dropped. We test that close→reopen + rescan catches these.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const TEST_PLUGINS_DIR = "/tmp/test-plugins";

let capturedWatchCallback:
  | ((eventType: string, filename: string | null) => void)
  | null = null;
let mockWatchShouldThrow = false;
const mockWatcher = { close: mock(() => {}) };

const mockWatch = mock(
  (
    _path: string,
    _opts: Record<string, unknown>,
    callback: (eventType: string, filename: string | null) => void,
  ) => {
    if (mockWatchShouldThrow) throw new Error("watch failed");
    capturedWatchCallback = callback;
    return mockWatcher;
  },
);

const mockRereadirSync = mock((_path: string): string[] => []);

let mockGetRegisteredPluginImpl: (name: string) => unknown | undefined = (
  _name,
) => undefined;
const mockGetRegisteredPlugin = mock((name: string) =>
  mockGetRegisteredPluginImpl(name),
);

let mockReregisterExternalPluginImpl = mock(async (_name: string) => {});
const mockReregisterExternalPlugin = mock(async (name: string) =>
  mockReregisterExternalPluginImpl(name),
);

mock.module("node:fs", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actualFs = require("node:fs");
  return {
    ...actualFs,
    watch: mockWatch,
    readdirSync: mockRereadirSync,
  };
});

mock.module("../plugins/registry.js", () => ({
  getRegisteredPlugin: mockGetRegisteredPlugin,
}));

mock.module("../util/platform.js", () => ({
  getWorkspacePluginsDir: mock(() => TEST_PLUGINS_DIR),
}));

mock.module("../daemon/external-plugins-bootstrap.js", () => ({
  reregisterExternalPlugin: mockReregisterExternalPlugin,
}));

mock.module("../util/logger.js", () => ({
  getLogger: mock(() => ({
    info: mock(() => {}),
    warn: mock(() => {}),
  })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { PluginSourceWatcher } from "../daemon/plugin-source-watcher.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PluginSourceWatcher", () => {
  beforeEach(() => {
    PluginSourceWatcher.resetForTests();
    capturedWatchCallback = null;
    mockWatchShouldThrow = false;
    mockWatcher.close.mockClear();
    mockWatch.mockClear();
    mockRereadirSync.mockClear();
    mockGetRegisteredPlugin.mockClear();
    mockReregisterExternalPlugin.mockClear();
    mockGetRegisteredPluginImpl = (_name: string) => undefined;
    mockReregisterExternalPluginImpl = mock(async (_name: string) => {});
  });

  afterEach(() => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.stop();
  });

  test("start() creates a recursive watcher on the plugins directory", () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();
    expect(capturedWatchCallback).not.toBeNull();
  });

  test("plugin directory creation triggers rebuild", async () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();

    capturedWatchCallback!("change", "my-plugin");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 600));
    expect(mockReregisterExternalPlugin).toHaveBeenCalledWith("my-plugin");
  });

  test("nested file change within plugin triggers rebuild", async () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();

    capturedWatchCallback!("change", "my-plugin/src/index.ts");

    await new Promise((r) => setTimeout(r, 600));
    expect(mockReregisterExternalPlugin).toHaveBeenCalledWith("my-plugin");
  });

  test("deeply nested file change triggers rebuild", async () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();

    capturedWatchCallback!("change", "my-plugin/src/handlers/util/helper.ts");

    await new Promise((r) => setTimeout(r, 600));
    expect(mockReregisterExternalPlugin).toHaveBeenCalledWith("my-plugin");
  });

  test("dotfiles in plugins root are ignored", async () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();

    capturedWatchCallback!("change", ".DS_Store");

    await new Promise((r) => setTimeout(r, 600));
    expect(mockReregisterExternalPlugin).not.toHaveBeenCalled();
  });

  test("null filename is ignored", async () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();

    capturedWatchCallback!("change", null);

    await new Promise((r) => setTimeout(r, 600));
    expect(mockReregisterExternalPlugin).not.toHaveBeenCalled();
  });

  test("rapid changes to same plugin are debounced into single rebuild", async () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();

    capturedWatchCallback!("change", "my-plugin/src/index.ts");
    capturedWatchCallback!("change", "my-plugin/src/handlers.ts");
    capturedWatchCallback!("change", "my-plugin/package.json");

    await new Promise((r) => setTimeout(r, 600));
    expect(mockReregisterExternalPlugin).toHaveBeenCalledTimes(1);
    expect(mockReregisterExternalPlugin).toHaveBeenCalledWith("my-plugin");
  });

  test("changes to different plugins trigger separate rebuilds (debounced)", async () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();

    capturedWatchCallback!("change", "plugin-a/src/index.ts");
    capturedWatchCallback!("change", "plugin-b/src/index.ts");

    await new Promise((r) => setTimeout(r, 600));
    expect(mockReregisterExternalPlugin).toHaveBeenCalledTimes(2);
    expect(mockReregisterExternalPlugin).toHaveBeenNthCalledWith(1, "plugin-a");
    expect(mockReregisterExternalPlugin).toHaveBeenNthCalledWith(2, "plugin-b");
  });

  test("stop() closes watcher and cancels pending rebuilds", () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();

    capturedWatchCallback!("change", "my-plugin/src/index.ts");
    watcher.stop();

    expect(mockWatcher.close).toHaveBeenCalledTimes(1);
    // No rebuild should fire after stop
    expect(mockReregisterExternalPlugin).not.toHaveBeenCalled();
  });

  test("ensureStarted() initializes watcher after start() if watch coverage was lost", () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();
    expect(capturedWatchCallback).not.toBeNull();

    // Simulate lost coverage while the daemon lifecycle is still started
    // (e.g. a previous watch attempt failed after startup).
    (watcher as unknown as { watcher: unknown }).watcher = null;
    capturedWatchCallback = null;

    watcher.ensureStarted();
    expect(capturedWatchCallback).not.toBeNull();
  });

  test("ensureStarted() is a no-op when watcher is already running", () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();
    const callCountAfterStart = mockWatch.mock.calls.length;

    watcher.ensureStarted();
    expect(mockWatch.mock.calls.length).toBe(callCountAfterStart);
  });

  test("watcher restart keeps the previous watcher active if replacement fails", async () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();
    const firstCallback = capturedWatchCallback;

    mockWatchShouldThrow = true;
    capturedWatchCallback!("change", "my-plugin/src/index.ts");

    await new Promise((r) => setTimeout(r, 600));

    expect(mockWatcher.close).not.toHaveBeenCalled();
    expect((watcher as unknown as { watcher: unknown }).watcher).toBe(
      mockWatcher,
    );
    expect(capturedWatchCallback).toBe(firstCallback);
  });

  test("singleton instance is shared across calls", () => {
    const watcher1 = PluginSourceWatcher.getInstance();
    const watcher2 = PluginSourceWatcher.getInstance();
    expect(watcher1).toBe(watcher2);
  });

  test("resetForTests() clears the singleton", () => {
    const watcher1 = PluginSourceWatcher.getInstance();
    watcher1.start();

    PluginSourceWatcher.resetForTests();
    const watcher2 = PluginSourceWatcher.getInstance();

    expect(watcher1).not.toBe(watcher2);
  });

  /**
   * REGRESSION: When an event arrives during a close→reopen swap, rescan
   * must catch any plugin not yet in the registry.
   *
   * Scenario:
   * 1. Plugin "new-plugin" directory is created
   * 2. Event fires, triggering a watcher restart (close + reopen)
   * 3. Before the old watcher's callback is fully fired, another plugin
   *    "late-plugin" is created
   * 4. The new watcher doesn't yet know about "late-plugin"
   * 5. After the reopen, rescan walks the directory and finds "late-plugin"
   *    not in the registry, and schedules its rebuild
   */
  test("watcher restart + rescan catches plugins created during close→reopen", async () => {
    const watcher = PluginSourceWatcher.getInstance();
    watcher.start();

    // Track which plugins are "registered" at each point
    const registeredPlugins = new Set<string>();
    mockGetRegisteredPluginImpl = (name: string) =>
      registeredPlugins.has(name) ? { name } : undefined;

    // Simulate multiple plugins on disk
    mockRereadirSync.mockImplementation(() => [
      "new-plugin",
      "late-plugin",
      ".DS_Store",
    ]);

    // Fire an event on new-plugin (this will trigger a watcher restart)
    capturedWatchCallback!("change", "new-plugin/src/index.ts");

    // Wait for the direct rebuild debounce, the watcher-restart debounce,
    // and the rescan-triggered rebuild debounce.
    await new Promise((r) => setTimeout(r, 1100));

    // At this point, rescan should have run and discovered late-plugin,
    // even though no direct fs.watch event was delivered for it.
    const calls = mockReregisterExternalPlugin.mock.calls.map((c) => c[0]);
    expect(calls).toContain("new-plugin");
    expect(calls).toContain("late-plugin");
    expect(calls).not.toContain(".DS_Store");
  });
});
