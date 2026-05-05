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
// Capture fs.watch and fs.watchFile calls so we can simulate file system
// events deterministically. Bun's libuv-based fs.watchFile is too unreliable
// on Linux CI to test against directly: first-poll latency is ~5s and
// back-to-back changes to different files frequently miss events. Driving
// the captured listener bypasses libuv entirely while still exercising the
// real ConfigWatcher dispatch logic.
// ---------------------------------------------------------------------------

type WatchCallback = (eventType: string, filename: string | null) => void;
type WatchFileListener = (
  curr: { ino: number; mtimeMs: number },
  prev: { ino: number; mtimeMs: number },
) => void;

interface CapturedWatcher {
  dir: string;
  callback: WatchCallback;
  options?: { recursive?: boolean };
}

interface CapturedFileWatch {
  filePath: string;
  listener: WatchFileListener;
}

const capturedWatchers: CapturedWatcher[] = [];
const capturedFileWatches: CapturedFileWatch[] = [];

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
    watchFile: (filePath: string, ...args: unknown[]) => {
      // Signature is `watchFile(path, [options], listener)` — skip the
      // optional options arg so we always grab the listener.
      const listener = (
        typeof args[0] === "function" ? args[0] : args[1]
      ) as WatchFileListener;
      capturedFileWatches.push({ filePath, listener });
    },
    unwatchFile: (filePath: string) => {
      const idx = capturedFileWatches.findIndex((w) => w.filePath === filePath);
      if (idx !== -1) capturedFileWatches.splice(idx, 1);
    },
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

const TEST_DEBOUNCE_MS = 10;
// Sleep budget to wait out the debouncer + any async handler work.
const WAIT_MS = TEST_DEBOUNCE_MS + 50;

function findWatcher(path: string): CapturedWatcher | undefined {
  return capturedWatchers.find((w) => w.dir === path);
}

function findFileWatch(filePath: string): CapturedFileWatch | undefined {
  return capturedFileWatches.find((w) => w.filePath === filePath);
}

const WORKSPACE_FILES = new Set(["config.json", "SOUL.md", "IDENTITY.md"]);

// Each call advances the inode + mtime so the listener's early-return guard
// (curr.ino === prev.ino && curr.mtimeMs === prev.mtimeMs) doesn't fire.
let mtimeCounter = 1_000;
const inoMap = new Map<string, number>();

function nextStat(filePath: string): { ino: number; mtimeMs: number } {
  const ino = (inoMap.get(filePath) ?? 0) + 1;
  inoMap.set(filePath, ino);
  mtimeCounter += 1;
  return { ino, mtimeMs: mtimeCounter };
}

function simulateFileChange(dir: string, filename: string): void {
  if (dir === WORKSPACE_DIR && WORKSPACE_FILES.has(filename)) {
    const filePath = join(dir, filename);
    const fw = findFileWatch(filePath);
    if (!fw) {
      throw new Error(`No watchFile subscription for ${filePath}`);
    }
    const prev = {
      ino: inoMap.get(filePath) ?? 0,
      mtimeMs: mtimeCounter,
    };
    const curr = nextStat(filePath);
    fw.listener(curr, prev);
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
  capturedFileWatches.length = 0;
  inoMap.clear();
  evictCallCount = 0;
  watcher = new ConfigWatcher(undefined, TEST_DEBOUNCE_MS);
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

  test("UPDATES.md is not subscribed (only the registered handler set is)", () => {
    watcher.start(onConversationEvict);
    // Per-file watching only registers config.json, SOUL.md, IDENTITY.md.
    // The whole workspace dir must not be watched either — that was the
    // ENXIO-on-Unix-sockets bug.
    expect(findFileWatch(join(WORKSPACE_DIR, "UPDATES.md"))).toBeUndefined();
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
    // The per-file watchFile subscriptions are tracked separately from
    // capturedWatchers; assert the expected ones are present.
    expect(findFileWatch(join(WORKSPACE_DIR, "config.json"))).toBeDefined();
    expect(findFileWatch(join(WORKSPACE_DIR, "SOUL.md"))).toBeDefined();
    expect(findFileWatch(join(WORKSPACE_DIR, "IDENTITY.md"))).toBeDefined();
  });

  test("stop cancels pending debounce work, no eviction fires after", async () => {
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

describe("ConfigWatcher per-file polling listener", () => {
  test("ino change is treated as a file change (atomic-rename shape)", async () => {
    // Simulates `writeFile(tmp) + rename(tmp, target)`: the inode at the
    // path is replaced. The listener should fire once per debounced window.
    watcher.refreshConfigFromSources = async () => true;
    watcher.start(onConversationEvict);
    const fw = findFileWatch(join(WORKSPACE_DIR, "config.json"));
    expect(fw).toBeDefined();
    fw!.listener({ ino: 2, mtimeMs: 1_001 }, { ino: 1, mtimeMs: 1_000 });
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(1);
  });

  test("mtime change is treated as a file change (in-place edit)", async () => {
    watcher.refreshConfigFromSources = async () => true;
    watcher.start(onConversationEvict);
    const fw = findFileWatch(join(WORKSPACE_DIR, "config.json"));
    expect(fw).toBeDefined();
    // Same inode, different mtime — what an `echo >> file` produces.
    fw!.listener({ ino: 1, mtimeMs: 2_000 }, { ino: 1, mtimeMs: 1_000 });
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(1);
  });

  test("identical curr/prev does NOT fire (the early-return guard)", async () => {
    // fs.watchFile sometimes invokes the listener with curr === prev
    // (e.g. on initial subscription); the watcher must not re-fire in that case.
    watcher.refreshConfigFromSources = async () => true;
    watcher.start(onConversationEvict);
    const fw = findFileWatch(join(WORKSPACE_DIR, "config.json"));
    expect(fw).toBeDefined();
    fw!.listener({ ino: 1, mtimeMs: 1_000 }, { ino: 1, mtimeMs: 1_000 });
    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(0);
  });
});

describe("ConfigWatcher users directory watcher", () => {
  const USERS_DIR = join(WORKSPACE_DIR, "users");

  test("editing users/<slug>.md triggers onConversationEvict", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(USERS_DIR, "alice.md");

    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(1);
  });

  test("non-.md files in users/ do NOT trigger eviction", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(USERS_DIR, "alice.json");
    simulateFileChange(USERS_DIR, "notes.txt");
    simulateFileChange(USERS_DIR, "README");

    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(0);
  });

  test("null filename in users/ does not trigger eviction", async () => {
    watcher.start(onConversationEvict);
    const usersWatcher = findWatcher(USERS_DIR);
    expect(usersWatcher).toBeDefined();
    usersWatcher!.callback("change", null);

    await new Promise((r) => setTimeout(r, WAIT_MS));
    expect(evictCallCount).toBe(0);
  });

  test("multiple rapid changes to the same persona file are debounced", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(USERS_DIR, "bob.md");
    simulateFileChange(USERS_DIR, "bob.md");
    simulateFileChange(USERS_DIR, "bob.md");

    await new Promise((r) => setTimeout(r, WAIT_MS));
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
