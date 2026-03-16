import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
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

const TEST_DIR = join(tmpdir(), `config-watcher-test-${crypto.randomUUID()}`);
const WORKSPACE_DIR = join(TEST_DIR, "workspace");
const PROTECTED_DIR = join(TEST_DIR, "protected");
const SKILLS_DIR = join(WORKSPACE_DIR, "skills");

// ---------------------------------------------------------------------------
// Mock platform paths
// ---------------------------------------------------------------------------

mock.module("../util/platform.js", () => ({
  getRootDir: () => TEST_DIR,
  getWorkspaceDir: () => WORKSPACE_DIR,
  getWorkspaceSkillsDir: () => SKILLS_DIR,
  getWorkspaceConfigPath: () => join(WORKSPACE_DIR, "config.json"),
  getWorkspacePromptPath: (file: string) => join(WORKSPACE_DIR, file),
  ensureDataDir: () => {},
  getDataDir: () => join(WORKSPACE_DIR, "data"),
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(WORKSPACE_DIR, "data", "assistant.db"),
  getLogPath: () => join(WORKSPACE_DIR, "data", "logs", "vellum.log"),
  getHistoryPath: () => join(WORKSPACE_DIR, "data", "history"),
  getHooksDir: () => join(WORKSPACE_DIR, "hooks"),
  getSignalsDir: () => join(TEST_DIR, "signals"),

  getSandboxRootDir: () => join(WORKSPACE_DIR, "data", "sandbox"),
  getSandboxWorkingDir: () => WORKSPACE_DIR,
  getInterfacesDir: () => join(WORKSPACE_DIR, "data", "interfaces"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
}));

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

let trustClearCacheCallCount = 0;
mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {
    trustClearCacheCallCount++;
  },
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: () => {},
}));

mock.module("../signals/mcp-reload.js", () => ({
  handleMcpReloadSignal: () => {},
}));

mock.module("../signals/confirm.js", () => ({
  handleConfirmationSignal: () => {},
}));

mock.module("../signals/trust-rule.js", () => ({
  handleTrustRuleSignal: () => {},
}));

mock.module("../signals/conversation-undo.js", () => ({
  handleConversationUndoSignal: () => {},
}));

let resetAllowlistCallCount = 0;
mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {
    resetAllowlistCallCount++;
  },
  validateAllowlistFile: () => [],
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

/** Simulate a file change event and flush the debounce timer. */
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
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

let watcher: InstanceType<typeof ConfigWatcher>;
let evictCallCount: number;
const onConversationEvict = () => {
  evictCallCount++;
};

beforeEach(() => {
  capturedWatchers.length = 0;
  evictCallCount = 0;
  trustClearCacheCallCount = 0;
  resetAllowlistCallCount = 0;
  watcher = new ConfigWatcher();
});

afterEach(() => {
  watcher.stop();
});

describe("ConfigWatcher workspace file handlers", () => {
  test("SOUL.md change triggers onConversationEvict", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");

    // Wait for the debounce timer to fire (default 200ms)
    await new Promise((r) => setTimeout(r, 300));
    expect(evictCallCount).toBe(1);
  });

  test("IDENTITY.md change triggers onConversationEvict", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "IDENTITY.md");

    await new Promise((r) => setTimeout(r, 300));
    expect(evictCallCount).toBe(1);
  });

  test("USER.md change triggers onConversationEvict", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "USER.md");

    await new Promise((r) => setTimeout(r, 300));
    expect(evictCallCount).toBe(1);
  });

  test("UPDATES.md change triggers onConversationEvict", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "UPDATES.md");

    await new Promise((r) => setTimeout(r, 300));
    expect(evictCallCount).toBe(1);
  });

  test("config.json change calls refreshConfigFromSources", async () => {
    let refreshCalled = false;
    watcher.refreshConfigFromSources = async () => {
      refreshCalled = true;
      return false; // no change, so onConversationEvict should NOT be called
    };

    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "config.json");

    await new Promise((r) => setTimeout(r, 300));
    expect(refreshCalled).toBe(true);
    // Config didn't change (returned false), so no eviction
    expect(evictCallCount).toBe(0);
  });

  test("config.json change triggers onConversationEvict when config actually changed", async () => {
    watcher.refreshConfigFromSources = async () => true;

    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "config.json");

    await new Promise((r) => setTimeout(r, 300));
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

    await new Promise((r) => setTimeout(r, 300));
    expect(refreshCalled).toBe(false);
    expect(evictCallCount).toBe(0);
  });

  test("unknown file does not trigger any handler", async () => {
    watcher.start(onConversationEvict);
    simulateFileChange(WORKSPACE_DIR, "UNKNOWN.md");

    await new Promise((r) => setTimeout(r, 300));
    expect(evictCallCount).toBe(0);
  });

  test("null filename does not trigger any handler", async () => {
    watcher.start(onConversationEvict);
    const wsWatcher = findWatcher(WORKSPACE_DIR);
    expect(wsWatcher).toBeDefined();
    wsWatcher!.callback("change", null);

    await new Promise((r) => setTimeout(r, 300));
    expect(evictCallCount).toBe(0);
  });
});

describe("ConfigWatcher protected directory handlers", () => {
  test("trust.json change calls clearTrustCache", async () => {
    watcher.start(onConversationEvict);
    const protectedWatcher = findWatcher(PROTECTED_DIR);
    expect(protectedWatcher).toBeDefined();
    protectedWatcher!.callback("change", "trust.json");

    await new Promise((r) => setTimeout(r, 300));
    // trust.json should NOT trigger session eviction
    expect(evictCallCount).toBe(0);
    // but clearCache should have been called
    expect(trustClearCacheCallCount).toBe(1);
  });

  test("secret-allowlist.json change calls resetAllowlist", async () => {
    watcher.start(onConversationEvict);
    const protectedWatcher = findWatcher(PROTECTED_DIR);
    expect(protectedWatcher).toBeDefined();
    protectedWatcher!.callback("change", "secret-allowlist.json");

    await new Promise((r) => setTimeout(r, 300));
    // secret-allowlist.json should NOT trigger session eviction
    expect(evictCallCount).toBe(0);
    // but resetAllowlist should have been called
    expect(resetAllowlistCallCount).toBe(1);
  });
});

describe("ConfigWatcher watcher lifecycle", () => {
  test("start registers watchers for workspace and protected dirs", () => {
    watcher.start(onConversationEvict);
    const wsWatcher = findWatcher(WORKSPACE_DIR);
    const protWatcher = findWatcher(PROTECTED_DIR);
    expect(wsWatcher).toBeDefined();
    expect(protWatcher).toBeDefined();
  });

  test("stop cancels all debounce timers and clears watchers", () => {
    watcher.start(onConversationEvict);
    // Trigger a file change but don't wait for the debounce
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");
    watcher.stop();

    // The debounce should have been cancelled, so no eviction
    expect(evictCallCount).toBe(0);
  });

  test("multiple prompt file changes are debounced", async () => {
    watcher.start(onConversationEvict);

    // Rapid fire multiple changes to the same file
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");
    simulateFileChange(WORKSPACE_DIR, "SOUL.md");

    await new Promise((r) => setTimeout(r, 300));
    // Despite 3 events, debouncing should collapse them to 1 call
    expect(evictCallCount).toBe(1);
  });

  test("changes to different files each trigger their own handler", async () => {
    watcher.start(onConversationEvict);

    simulateFileChange(WORKSPACE_DIR, "SOUL.md");
    simulateFileChange(WORKSPACE_DIR, "IDENTITY.md");

    await new Promise((r) => setTimeout(r, 300));
    // Each file has its own debounce key, so both should fire
    expect(evictCallCount).toBe(2);
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
