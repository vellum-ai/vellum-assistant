import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "vellum-skills-watch-"));
const SKILLS_DIR = join(WORKSPACE_DIR, "skills");
process.env.VELLUM_WORKSPACE_DIR = WORKSPACE_DIR;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (v: string) => v,
}));

type WatchCallback = (eventType: string, filename: string | null) => void;

interface CapturedWatcher {
  dir: string;
  callback: WatchCallback;
  closed: boolean;
}

const capturedWatchers: CapturedWatcher[] = [];
let recursiveWatchAvailable = false;

// The skills watcher reacts by calling these directly; count the calls so tests
// can assert dispatch without driving real eviction or skill-memory reseeding.
let evictCalls = 0;
let skillsChangedCalls = 0;

mock.module("node:fs", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = require("node:fs");
  return {
    ...actual,
    watch: (dir: string, ...args: unknown[]) => {
      let callback: WatchCallback;

      if (typeof args[0] === "function") {
        callback = args[0] as WatchCallback;
      } else {
        if (
          (args[0] as { recursive?: boolean } | undefined)?.recursive &&
          !recursiveWatchAvailable
        ) {
          throw new Error("recursive watch unavailable");
        }
        callback = args[1] as WatchCallback;
      }

      const capturedWatcher: CapturedWatcher = {
        dir,
        callback,
        closed: false,
      };
      capturedWatchers.push(capturedWatcher);
      return {
        close: () => {
          capturedWatcher.closed = true;
        },
        on: () => {},
      };
    },
  };
});

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    memory: { v2: { enabled: false } },
  }),
  invalidateConfigCache: () => {},
}));

mock.module("../persistence/embeddings/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

mock.module("../persistence/cleanup-schedule-state.js", () => ({
  resetCleanupScheduleThrottle: () => {},
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {},
}));

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: async () => {},
}));

mock.module("../signals/bash.js", () => ({
  handleBashSignal: () => {},
}));

mock.module("../signals/cancel.js", () => ({
  handleCancelSignal: () => {},
}));

mock.module("../signals/conversation-undo.js", () => ({
  handleConversationUndoSignal: () => {},
}));

mock.module("../signals/emit-event.js", () => ({
  handleEmitEventSignal: () => {},
}));

mock.module("../signals/user-message.js", () => ({
  handleUserMessageSignal: () => {},
}));

mock.module("../daemon/conversation-store.js", () => ({
  evictConversationsForReload: () => {
    evictCalls++;
  },
}));

mock.module("../daemon/skill-memory-refresh.js", () => ({
  refreshSkillCapabilityMemories: () => {
    skillsChangedCalls++;
  },
}));

mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishIdentityChanged: () => {},
  publishConfigChanged: () => {},
  publishSoundsConfigUpdated: () => {},
  publishAvatarChanged: () => {},
}));

mock.module("../platform/sync-identity.js", () => ({
  syncIdentityNameToPlatform: () => {},
}));

const { ConfigWatcher } = await import("../daemon/config-watcher.js");

function findWatcher(dir: string): CapturedWatcher | undefined {
  return capturedWatchers.find((w) => w.dir === dir && !w.closed);
}

function findCapturedWatcher(dir: string): CapturedWatcher | undefined {
  return capturedWatchers.find((w) => w.dir === dir);
}

function capturedWatcherCount(dir: string): number {
  return capturedWatchers.filter((w) => w.dir === dir).length;
}

describe("ConfigWatcher skills watcher reseeding", () => {
  let watcher: InstanceType<typeof ConfigWatcher>;

  beforeEach(() => {
    capturedWatchers.length = 0;
    recursiveWatchAvailable = false;
    rmSync(SKILLS_DIR, { recursive: true, force: true });
    mkdirSync(SKILLS_DIR, { recursive: true });
    evictCalls = 0;
    skillsChangedCalls = 0;
    watcher = new ConfigWatcher();
  });

  afterEach(() => {
    watcher.stop();
  });

  afterAll(() => {
    rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("watched skill file changes evict conversations and refresh skill memories", async () => {
    watcher.start();

    const skillsWatcher = findWatcher(SKILLS_DIR);
    expect(skillsWatcher).toBeDefined();
    skillsWatcher!.callback("change", "example-skill/SKILL.md");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(1);
    expect(skillsChangedCalls).toBe(1);
  });

  test("recursive watcher ignores skipped dependency and staging paths", async () => {
    recursiveWatchAvailable = true;

    watcher.start();

    const skillsWatcher = findWatcher(SKILLS_DIR);
    expect(skillsWatcher).toBeDefined();
    skillsWatcher!.callback(
      "change",
      "example-skill/node_modules/pkg/index.js",
    );
    skillsWatcher!.callback(
      "change",
      ".install-staging/example-skill/SKILL.md",
    );

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(0);
    expect(skillsChangedCalls).toBe(0);

    skillsWatcher!.callback("change", "example-skill/references/foo.md");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(1);
    expect(skillsChangedCalls).toBe(1);
  });

  test("recursive watcher reloads skill memories for build output changes", async () => {
    recursiveWatchAvailable = true;

    watcher.start();

    const skillsWatcher = findWatcher(SKILLS_DIR);
    expect(skillsWatcher).toBeDefined();
    skillsWatcher!.callback("change", "example-skill/dist/index.js");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(1);
    expect(skillsChangedCalls).toBe(1);
  });

  test("coalesces multiple skill file changes into one catalog refresh", async () => {
    watcher.start();

    const skillsWatcher = findWatcher(SKILLS_DIR);
    expect(skillsWatcher).toBeDefined();
    skillsWatcher!.callback("change", "example-skill/SKILL.md");
    skillsWatcher!.callback("change", "example-skill/package.json");
    skillsWatcher!.callback("change", "other-skill/SKILL.md");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(1);
    expect(skillsChangedCalls).toBe(1);
  });

  test("fallback watches existing nested skill directories", async () => {
    const referencesDir = join(SKILLS_DIR, "example-skill", "references");
    mkdirSync(referencesDir, { recursive: true });

    watcher.start();

    const referencesWatcher = findWatcher(referencesDir);
    expect(referencesWatcher).toBeDefined();
    referencesWatcher!.callback("change", "notes.md");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(1);
    expect(skillsChangedCalls).toBe(1);
  });

  test("fallback skips dependency and staging directories", async () => {
    const skillDir = join(SKILLS_DIR, "example-skill");
    const nodeModulesDir = join(skillDir, "node_modules");
    const dependencyDir = join(nodeModulesDir, "pkg");
    const stagingDir = join(SKILLS_DIR, ".install-staging");
    const stagedSkillDir = join(stagingDir, "example-skill");
    const referencesDir = join(skillDir, "references");
    mkdirSync(dependencyDir, { recursive: true });
    mkdirSync(stagedSkillDir, { recursive: true });
    mkdirSync(referencesDir, { recursive: true });

    watcher.start();

    expect(findWatcher(nodeModulesDir)).toBeUndefined();
    expect(findWatcher(dependencyDir)).toBeUndefined();
    expect(findWatcher(stagingDir)).toBeUndefined();
    expect(findWatcher(stagedSkillDir)).toBeUndefined();

    const skillsWatcher = findWatcher(SKILLS_DIR);
    const skillWatcher = findWatcher(skillDir);
    expect(skillsWatcher).toBeDefined();
    expect(skillWatcher).toBeDefined();

    skillsWatcher!.callback("rename", ".install-staging");
    skillWatcher!.callback("rename", "node_modules");
    skillWatcher!.callback("change", "node_modules/pkg/index.js");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(0);
    expect(skillsChangedCalls).toBe(0);

    const referencesWatcher = findWatcher(referencesDir);
    expect(referencesWatcher).toBeDefined();
    referencesWatcher!.callback("change", "foo.md");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(1);
    expect(skillsChangedCalls).toBe(1);
  });

  test("fallback watches skill build output directories", async () => {
    const distDir = join(SKILLS_DIR, "example-skill", "dist");
    const buildDir = join(SKILLS_DIR, "example-skill", "build");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(buildDir, { recursive: true });

    watcher.start();

    const distWatcher = findWatcher(distDir);
    const buildWatcher = findWatcher(buildDir);
    expect(distWatcher).toBeDefined();
    expect(buildWatcher).toBeDefined();

    distWatcher!.callback("change", "index.js");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(1);
    expect(skillsChangedCalls).toBe(1);

    buildWatcher!.callback("change", "tool.js");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(2);
    expect(skillsChangedCalls).toBe(2);
  });

  test("fallback adds watchers for new nested skill directories without duplicates", () => {
    const skillDir = join(SKILLS_DIR, "example-skill");
    const toolsDir = join(skillDir, "tools");
    const generatedDir = join(toolsDir, "generated");
    mkdirSync(skillDir, { recursive: true });

    watcher.start();

    const skillWatcher = findWatcher(skillDir);
    expect(skillWatcher).toBeDefined();

    mkdirSync(generatedDir, { recursive: true });
    skillWatcher!.callback("rename", "tools");
    skillWatcher!.callback("rename", "tools");

    expect(findWatcher(toolsDir)).toBeDefined();
    expect(findWatcher(generatedDir)).toBeDefined();
    expect(capturedWatcherCount(toolsDir)).toBe(1);
    expect(capturedWatcherCount(generatedDir)).toBe(1);
  });

  test("fallback closes stale nested watchers when directories are removed", () => {
    const skillDir = join(SKILLS_DIR, "example-skill");
    const referencesDir = join(skillDir, "references");
    const deepDir = join(referencesDir, "deep");
    mkdirSync(deepDir, { recursive: true });

    watcher.start();

    expect(findWatcher(referencesDir)).toBeDefined();
    expect(findWatcher(deepDir)).toBeDefined();

    rmSync(referencesDir, { recursive: true, force: true });
    const skillWatcher = findWatcher(skillDir);
    expect(skillWatcher).toBeDefined();
    skillWatcher!.callback("rename", "references");

    expect(findWatcher(referencesDir)).toBeUndefined();
    expect(findWatcher(deepDir)).toBeUndefined();
    expect(findCapturedWatcher(referencesDir)?.closed).toBe(true);
    expect(findCapturedWatcher(deepDir)?.closed).toBe(true);
  });
});
