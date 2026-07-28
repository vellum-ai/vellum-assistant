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
  publishWorkspaceThemeChanged: () => {},
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

  describe("recursive watcher", () => {
    beforeEach(() => {
      recursiveWatchAvailable = true;
    });

    test("reloads on SKILL.md changes", async () => {
      watcher.start();

      const skillsWatcher = findWatcher(SKILLS_DIR);
      expect(skillsWatcher).toBeDefined();
      skillsWatcher!.callback("change", "example-skill/SKILL.md");

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(evictCalls).toBe(1);
      expect(skillsChangedCalls).toBe(1);
    });

    test("reloads on TOOLS.json changes", async () => {
      watcher.start();

      const skillsWatcher = findWatcher(SKILLS_DIR);
      skillsWatcher!.callback("change", "example-skill/TOOLS.json");

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(evictCalls).toBe(1);
      expect(skillsChangedCalls).toBe(1);
    });

    test("ignores non-catalog files (scripts, references, build output)", async () => {
      watcher.start();

      const skillsWatcher = findWatcher(SKILLS_DIR);
      skillsWatcher!.callback("change", "example-skill/references/foo.md");
      skillsWatcher!.callback("change", "example-skill/dist/index.js");
      skillsWatcher!.callback("change", "example-skill/package.json");
      skillsWatcher!.callback("change", "example-skill/scripts/run.py");

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(evictCalls).toBe(0);
      expect(skillsChangedCalls).toBe(0);
    });

    test("ignores catalog files under skipped dependency and staging paths", async () => {
      watcher.start();

      const skillsWatcher = findWatcher(SKILLS_DIR);
      skillsWatcher!.callback(
        "change",
        "example-skill/node_modules/pkg/SKILL.md",
      );
      skillsWatcher!.callback(
        "change",
        ".install-staging/example-skill/SKILL.md",
      );

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(evictCalls).toBe(0);
      expect(skillsChangedCalls).toBe(0);
    });

    test("coalesces multiple catalog changes into one reload", async () => {
      watcher.start();

      const skillsWatcher = findWatcher(SKILLS_DIR);
      skillsWatcher!.callback("change", "example-skill/SKILL.md");
      skillsWatcher!.callback("change", "example-skill/package.json");
      skillsWatcher!.callback("change", "example-skill/TOOLS.json");
      skillsWatcher!.callback("change", "other-skill/SKILL.md");

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(evictCalls).toBe(1);
      expect(skillsChangedCalls).toBe(1);
    });
  });

  describe("per-skill-directory fallback", () => {
    test("watches the root and each immediate skill directory, not nested subdirectories", () => {
      const skillDir = join(SKILLS_DIR, "example-skill");
      mkdirSync(join(skillDir, "references"), { recursive: true });
      mkdirSync(join(skillDir, "dist"), { recursive: true });

      watcher.start();

      expect(findWatcher(SKILLS_DIR)).toBeDefined();
      expect(findWatcher(skillDir)).toBeDefined();
      expect(findWatcher(join(skillDir, "references"))).toBeUndefined();
      expect(findWatcher(join(skillDir, "dist"))).toBeUndefined();
    });

    test("does not watch dependency or staging directories", () => {
      const skillDir = join(SKILLS_DIR, "example-skill");
      mkdirSync(join(skillDir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(SKILLS_DIR, ".install-staging", "staged"), {
        recursive: true,
      });

      watcher.start();

      expect(findWatcher(join(skillDir, "node_modules"))).toBeUndefined();
      expect(findWatcher(join(SKILLS_DIR, ".install-staging"))).toBeUndefined();
      expect(findWatcher(skillDir)).toBeDefined();
    });

    test("reloads on SKILL.md / TOOLS.json edits within a skill directory", async () => {
      const skillDir = join(SKILLS_DIR, "example-skill");
      mkdirSync(skillDir, { recursive: true });

      watcher.start();
      const skillWatcher = findWatcher(skillDir);
      expect(skillWatcher).toBeDefined();

      skillWatcher!.callback("change", "SKILL.md");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(evictCalls).toBe(1);
      expect(skillsChangedCalls).toBe(1);

      skillWatcher!.callback("change", "TOOLS.json");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(evictCalls).toBe(2);
      expect(skillsChangedCalls).toBe(2);
    });

    test("ignores non-catalog file edits within a skill directory", async () => {
      const skillDir = join(SKILLS_DIR, "example-skill");
      mkdirSync(skillDir, { recursive: true });

      watcher.start();
      const skillWatcher = findWatcher(skillDir);

      skillWatcher!.callback("change", "README.md");
      skillWatcher!.callback("change", "package.json");
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(evictCalls).toBe(0);
      expect(skillsChangedCalls).toBe(0);
    });

    test("watches and reloads when a skill is installed", async () => {
      watcher.start();
      const rootWatcher = findWatcher(SKILLS_DIR);
      expect(rootWatcher).toBeDefined();

      const newSkillDir = join(SKILLS_DIR, "new-skill");
      mkdirSync(newSkillDir, { recursive: true });
      rootWatcher!.callback("rename", "new-skill");

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(findWatcher(newSkillDir)).toBeDefined();
      expect(evictCalls).toBe(1);
      expect(skillsChangedCalls).toBe(1);
    });

    test("closes the watcher and reloads when a skill is removed", async () => {
      const skillDir = join(SKILLS_DIR, "example-skill");
      mkdirSync(skillDir, { recursive: true });

      watcher.start();
      expect(findWatcher(skillDir)).toBeDefined();

      rmSync(skillDir, { recursive: true, force: true });
      const rootWatcher = findWatcher(SKILLS_DIR);
      rootWatcher!.callback("rename", "example-skill");

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(findWatcher(skillDir)).toBeUndefined();
      expect(findCapturedWatcher(skillDir)?.closed).toBe(true);
      expect(evictCalls).toBe(1);
      expect(skillsChangedCalls).toBe(1);
    });

    test("does not duplicate a watcher or reload when the root changes but the skill set does not", async () => {
      const skillDir = join(SKILLS_DIR, "example-skill");
      mkdirSync(skillDir, { recursive: true });

      watcher.start();
      expect(capturedWatcherCount(skillDir)).toBe(1);

      // A stray file event at the root: no skill directory added or removed.
      const rootWatcher = findWatcher(SKILLS_DIR);
      rootWatcher!.callback("change", "README.md");
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(capturedWatcherCount(skillDir)).toBe(1);
      expect(evictCalls).toBe(0);
      expect(skillsChangedCalls).toBe(0);
    });
  });
});
