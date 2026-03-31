import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Temp directory scaffold
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;

// Use a subdirectory of the test workspace as the mock protected directory
const PROTECTED_DIR = join(WORKSPACE_DIR, "protected");

// ---------------------------------------------------------------------------
// Mock platform paths
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (v: string) => v,
}));

// ---------------------------------------------------------------------------
// Track clearFeatureFlagOverridesCache calls
// ---------------------------------------------------------------------------

let clearCacheCallCount = 0;

mock.module("../config/assistant-feature-flags.js", () => ({
  clearFeatureFlagOverridesCache: () => {
    clearCacheCallCount++;
  },
}));

// ---------------------------------------------------------------------------
// Capture fs.watch calls so we can simulate file system events deterministically
// ---------------------------------------------------------------------------

type WatchCallback = (eventType: string, filename: string | null) => void;

interface CapturedWatcher {
  dir: string;
  callback: WatchCallback;
  options?: { recursive?: boolean };
}

const capturedWatchers: CapturedWatcher[] = [];

const fakeWatcher = {
  close: () => {},
};

mock.module("node:fs", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = require("node:fs");
  return {
    ...actual,
    watch: (dir: string, ...args: unknown[]) => {
      let callback: WatchCallback;
      let options: { recursive?: boolean } | undefined;

      if (typeof args[0] === "function") {
        callback = args[0] as WatchCallback;
      } else {
        options = args[0] as { recursive?: boolean };
        callback = args[1] as WatchCallback;
      }

      capturedWatchers.push({ dir, callback, options });
      return fakeWatcher;
    },
  };
});

// Mock config/loader and other dependencies that ConfigWatcher imports
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
  }),
  invalidateConfigCache: () => {},
}));

mock.module("../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: () => {},
}));

mock.module("../signals/mcp-reload.js", () => ({
  handleMcpReloadSignal: () => {},
}));

mock.module("../signals/conversation-undo.js", () => ({
  handleConversationUndoSignal: () => {},
}));

// Import after mocks are set up
const { ConfigWatcher } = await import("../daemon/config-watcher.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the watcher for a given directory path. */
function findWatcher(dir: string): CapturedWatcher | undefined {
  return capturedWatchers.find((w) => w.dir === dir);
}

/** Simulate a file change event in a watched directory. */
function simulateFileChange(dir: string, filename: string): void {
  const watcher = findWatcher(dir);
  if (!watcher) throw new Error(`No watcher found for ${dir}`);
  watcher.callback("change", filename);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeAll(() => {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  mkdirSync(PROTECTED_DIR, { recursive: true });

  // Point the watcher to our test protected directory
  process.env.GATEWAY_SECURITY_DIR = PROTECTED_DIR;
});

let watcher: InstanceType<typeof ConfigWatcher>;
const onConversationEvict = () => {};

beforeEach(() => {
  capturedWatchers.length = 0;
  clearCacheCallCount = 0;
  watcher = new ConfigWatcher();
});

afterEach(() => {
  watcher.stop();
});

describe("ConfigWatcher feature flags file watcher", () => {
  test("feature-flags.json change triggers clearFeatureFlagOverridesCache", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(PROTECTED_DIR, "feature-flags.json");

    // Wait for the debounce timer to fire (500ms debounce)
    await new Promise((r) => setTimeout(r, 700));
    expect(clearCacheCallCount).toBe(1);
  });

  test("feature-flags-remote.json change triggers clearFeatureFlagOverridesCache", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(PROTECTED_DIR, "feature-flags-remote.json");

    // Wait for the debounce timer to fire (500ms debounce)
    await new Promise((r) => setTimeout(r, 700));
    expect(clearCacheCallCount).toBe(1);
  });

  test("unrelated file change in protected directory does NOT trigger clearFeatureFlagOverridesCache", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(PROTECTED_DIR, "trust.json");

    // Wait for the debounce timer to fire
    await new Promise((r) => setTimeout(r, 700));
    expect(clearCacheCallCount).toBe(0);
  });

  test("unrelated credential key file does NOT trigger clearFeatureFlagOverridesCache", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(PROTECTED_DIR, "actor-token-signing-key");

    await new Promise((r) => setTimeout(r, 700));
    expect(clearCacheCallCount).toBe(0);
  });

  test("both flag files changing are debounced to a single invalidation", async () => {
    watcher.start(onConversationEvict);

    // Rapid fire changes to both flag files
    simulateFileChange(PROTECTED_DIR, "feature-flags.json");
    simulateFileChange(PROTECTED_DIR, "feature-flags-remote.json");

    // Both use the same debounce key "file:feature-flags", so only one call
    await new Promise((r) => setTimeout(r, 700));
    expect(clearCacheCallCount).toBe(1);
  });

  test("protected directory watcher is registered", () => {
    watcher.start(onConversationEvict);
    const protectedWatcher = findWatcher(PROTECTED_DIR);
    expect(protectedWatcher).toBeDefined();
  });
});
