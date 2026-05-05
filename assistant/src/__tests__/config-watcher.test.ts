import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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
  on: (_event: string, _handler: (...args: unknown[]) => void) => fakeWatcher,
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
    // watchFile is intentionally NOT mocked — tests exercise the real
    // stat-polling listener. Test poll/debounce intervals are compressed
    // via the ConfigWatcher constructor parameters so the suite stays
    // fast without losing integration coverage.
  };
});

// Mock config/loader and other dependencies that ConfigWatcher imports
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
  }),
  loadConfig: () => ({ ui: {} }),
  invalidateConfigCache: () => {},
}));

mock.module("../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => undefined,
  listProviders: () => [],
  getProviderRoutingSource: () => undefined,
  initializeProviders: () => {},
}));

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: async () => {},
}));

mock.module("../signals/conversation-undo.js", () => ({
  handleConversationUndoSignal: () => {},
}));

mock.module("../signals/user-message.js", () => ({
  handleUserMessageSignal: async () => {},
}));

mock.module("../signals/cancel.js", () => ({
  handleCancelSignal: () => {},
}));

// Import after mocks are set up
const { ConfigWatcher } = await import("../daemon/config-watcher.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Compress both timing knobs in tests so the suite stays fast without
// sacrificing real fs.watchFile integration coverage. Production uses
// 2_000ms / 200ms; tests use ~50ms / ~10ms.
const TEST_POLL_INTERVAL_MS = 50;
const TEST_DEBOUNCE_MS = 10;
// Wait long enough for poll → debounce → handler chain to complete on a
// loaded CI runner. Keep this generous; the cost is bounded because each
// test pays it at most once.
const WAIT_MS = TEST_POLL_INTERVAL_MS + TEST_DEBOUNCE_MS + 500;

function findWatcher(path: string): CapturedWatcher | undefined {
  return capturedWatchers.find((w) => w.dir === path);
}

// Workspace files use real fs.watchFile; other dirs use the captured
// fs.watch callback. For workspace files, simulate a change with an
// atomic rename — same shape as the gateway's mutateConfigFile pattern
// (writeFile tmp + rename), which produces both an inode and mtime
// change so fs.watchFile detects it on the next poll.
const WORKSPACE_FILES = new Set(["config.json", "SOUL.md", "IDENTITY.md"]);

function simulateFileChange(dir: string, filename: string): void {
  if (dir === WORKSPACE_DIR && WORKSPACE_FILES.has(filename)) {
    const target = join(dir, filename);
    const tmp = `${target}.simulate.tmp`;
    writeFileSync(tmp, `simulated change @ ${Date.now()}.${Math.random()}`);
    renameSync(tmp, target);
    return;
  }
  const dirWatcher = findWatcher(dir);
  if (!dirWatcher) {
    throw new Error(`No watcher found for directory ${dir}`);
  }
  dirWatcher.callback("change", filename);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeAll(() => {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
});

let watcher: InstanceType<typeof ConfigWatcher>;
let evictCallCount: number;
const onConversationEvict = () => {
  evictCallCount++;
};

beforeEach(() => {
  capturedWatchers.length = 0;
  evictCallCount = 0;
  watcher = new ConfigWatcher(TEST_POLL_INTERVAL_MS, TEST_DEBOUNCE_MS);
  // Seed the workspace files so fs.watchFile has a real inode to track;
  // simulateFileChange will atomically rename a tmp file over each one
  // to produce the inode/mtime change the watcher detects.
  for (const filename of WORKSPACE_FILES) {
    writeFileSync(join(WORKSPACE_DIR, filename), "");
  }
});

afterEach(() => {
  watcher.stop();
});

describe("ConfigWatcher workspace file handlers", () => {
  test("SOUL.md change triggers onConversationEvict", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(1);
  });

  test("IDENTITY.md change triggers onConversationEvict", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "IDENTITY.md");
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(1);
  });

  test("UPDATES.md is not polled (only the registered handler set is)", async () => {
    watcher.start(onConversationEvict);
    // Per-file watching only registers config.json, SOUL.md, IDENTITY.md.
    // The whole workspace dir must not be watched either — that was the
    // ENXIO-on-Unix-sockets bug. If UPDATES.md were polled, writing to it
    // would eventually trigger an eviction; it should not.
    writeFileSync(join(WORKSPACE_DIR, "UPDATES.md"), "");
    writeFileSync(join(WORKSPACE_DIR, "UPDATES.md"), "changed");
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(0);
    expect(findWatcher(WORKSPACE_DIR)).toBeUndefined();
  });

  test("config.json change calls refreshConfigFromSources", async () => {
    let refreshCalled = false;
    watcher.refreshConfigFromSources = async () => {
      refreshCalled = true;
      return false;
    };
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "config.json");
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(refreshCalled).toBe(true);
    expect(evictCallCount).toBe(0);
  });

  test("config.json change triggers onConversationEvict when config actually changed", async () => {
    watcher.refreshConfigFromSources = async () => true;
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "config.json");
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(1);
  });

  test("config.json change is suppressed when suppressConfigReload is true", async () => {
    let refreshCalled = false;
    watcher.refreshConfigFromSources = async () => {
      refreshCalled = true;
      return true;
    };
    watcher.suppressConfigReload = true;
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "config.json");
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(refreshCalled).toBe(false);
    expect(evictCallCount).toBe(0);
  });
});

describe("ConfigWatcher watcher lifecycle", () => {
  test("start does NOT subscribe to /workspace as a directory (regression: ENXIO on Unix sockets)", () => {
    watcher.start(onConversationEvict);
    expect(findWatcher(WORKSPACE_DIR)).toBeUndefined();
    expect(findWatcher(join(WORKSPACE_DIR, "config.json"))).toBeUndefined();
    expect(findWatcher(join(WORKSPACE_DIR, "SOUL.md"))).toBeUndefined();
    expect(findWatcher(join(WORKSPACE_DIR, "IDENTITY.md"))).toBeUndefined();
  });

  test("stop cancels pending debounce + poll work, no eviction fires after", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");
    watcher.stop();
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(0);
  });

  test("multiple rapid changes to the same workspace file are coalesced to one eviction", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(1);
  });

  test("changes to different files each trigger their own handler", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");
    simulateFileChange(WORKSPACE_DIR, "IDENTITY.md");
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(2);
  });
});

describe("ConfigWatcher users directory watcher", () => {
  const USERS_DIR = join(WORKSPACE_DIR, "users");

  test("editing users/<slug>.md triggers onConversationEvict", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(USERS_DIR, "alice.md");

    await new Promise((r) => setTimeout(r, 300));
    expect(evictCallCount).toBe(1);
  });

  test("non-.md files in users/ do NOT trigger eviction", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(USERS_DIR, "alice.json");
    simulateFileChange(USERS_DIR, "notes.txt");
    simulateFileChange(USERS_DIR, "README");

    await new Promise((r) => setTimeout(r, 300));
    expect(evictCallCount).toBe(0);
  });

  test("null filename in users/ does not trigger eviction", async () => {
    watcher.start(onConversationEvict);
    const usersWatcher = findWatcher(USERS_DIR);
    expect(usersWatcher).toBeDefined();
    usersWatcher!.callback("change", null);

    await new Promise((r) => setTimeout(r, 300));
    expect(evictCallCount).toBe(0);
  });

  test("multiple rapid changes to the same persona file are debounced", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(USERS_DIR, "bob.md");
    simulateFileChange(USERS_DIR, "bob.md");
    simulateFileChange(USERS_DIR, "bob.md");

    await new Promise((r) => setTimeout(r, 300));
    expect(evictCallCount).toBe(1);
  });
});

describe("ConfigWatcher fingerprinting", () => {
  test("configFingerprint returns JSON string of config", () => {
    const config = { foo: "bar" } as any;
    expect(watcher.configFingerprint(config)).toBe(JSON.stringify(config));
  });

  test("initFingerprint sets lastFingerprint", () => {
    const config = { key: "value" } as any;
    watcher.initFingerprint(config);
    expect(watcher.lastFingerprint).toBe(JSON.stringify(config));
  });
});
