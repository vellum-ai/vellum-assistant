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
}

const capturedWatchers: CapturedWatcher[] = [];

const fakeWatcher = {
  close: () => {},
  on: () => {},
};

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
        callback = args[1] as WatchCallback;
      }

      capturedWatchers.push({ dir, callback });
      return fakeWatcher;
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

mock.module("../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

mock.module("../memory/cleanup-schedule-state.js", () => ({
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

const { ConfigWatcher } = await import("../daemon/config-watcher.js");

function findWatcher(dir: string): CapturedWatcher | undefined {
  return capturedWatchers.find((w) => w.dir === dir);
}

describe("ConfigWatcher skills watcher reseeding", () => {
  let watcher: InstanceType<typeof ConfigWatcher>;
  let evictCalls: number;
  let skillsChangedCalls: number;

  beforeEach(() => {
    capturedWatchers.length = 0;
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
    watcher.start(
      () => {
        evictCalls++;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        skillsChangedCalls++;
      },
    );

    const skillsWatcher = findWatcher(SKILLS_DIR);
    expect(skillsWatcher).toBeDefined();
    skillsWatcher!.callback("change", "example-skill/SKILL.md");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(evictCalls).toBe(1);
    expect(skillsChangedCalls).toBe(1);
  });
});
