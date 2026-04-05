import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

afterAll(() => {
  mock.restore();
});

import { invalidateConfigCache } from "../config/loader.js";
import {
  getMode,
  initPermissionModeStore,
  onModeChanged,
  resetForTesting,
  setAskBeforeActing,
  setHostAccess,
} from "../permissions/permission-mode-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  ensureTestDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ensureTestDir();
  resetForTesting();
  invalidateConfigCache();
  // Remove config file to start clean
  try {
    rmSync(CONFIG_PATH, { force: true });
  } catch {
    /* noop */
  }
});

afterEach(() => {
  resetForTesting();
  invalidateConfigCache();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PermissionModeStore", () => {
  describe("getMode", () => {
    test("returns defaults when no config exists", () => {
      const mode = getMode();
      expect(mode.askBeforeActing).toBe(true);
      expect(mode.hostAccess).toBe(false);
    });

    test("reads initial state from config", () => {
      writeConfig({
        permissions: {
          askBeforeActing: false,
          hostAccess: true,
        },
      });

      initPermissionModeStore();
      const mode = getMode();
      expect(mode.askBeforeActing).toBe(false);
      expect(mode.hostAccess).toBe(true);
    });

    test("returns a defensive copy (mutations do not affect store)", () => {
      const mode = getMode();
      mode.askBeforeActing = false;
      mode.hostAccess = true;

      const fresh = getMode();
      expect(fresh.askBeforeActing).toBe(true);
      expect(fresh.hostAccess).toBe(false);
    });
  });

  describe("setAskBeforeActing", () => {
    test("updates in-memory state", () => {
      expect(getMode().askBeforeActing).toBe(true);

      setAskBeforeActing(false);
      expect(getMode().askBeforeActing).toBe(false);
    });

    test("persists to config.json", () => {
      setAskBeforeActing(false);

      const raw = readConfig();
      const permissions = raw.permissions as Record<string, unknown>;
      expect(permissions.askBeforeActing).toBe(false);
    });

    test("no-op when value is unchanged", () => {
      const calls: unknown[] = [];
      onModeChanged((mode) => calls.push(mode));

      // Default is true; setting to true should not fire
      setAskBeforeActing(true);
      expect(calls).toHaveLength(0);
    });
  });

  describe("setHostAccess", () => {
    test("updates in-memory state", () => {
      expect(getMode().hostAccess).toBe(false);

      setHostAccess(true);
      expect(getMode().hostAccess).toBe(true);
    });

    test("persists to config.json", () => {
      setHostAccess(true);

      const raw = readConfig();
      const permissions = raw.permissions as Record<string, unknown>;
      expect(permissions.hostAccess).toBe(true);
    });

    test("no-op when value is unchanged", () => {
      const calls: unknown[] = [];
      onModeChanged((mode) => calls.push(mode));

      // Default is false; setting to false should not fire
      setHostAccess(false);
      expect(calls).toHaveLength(0);
    });
  });

  describe("onModeChanged", () => {
    test("fires on askBeforeActing change", () => {
      const received: Array<{ askBeforeActing: boolean; hostAccess: boolean }> =
        [];
      onModeChanged((mode) => received.push(mode));

      setAskBeforeActing(false);
      expect(received).toHaveLength(1);
      expect(received[0].askBeforeActing).toBe(false);
      expect(received[0].hostAccess).toBe(false);
    });

    test("fires on hostAccess change", () => {
      const received: Array<{ askBeforeActing: boolean; hostAccess: boolean }> =
        [];
      onModeChanged((mode) => received.push(mode));

      setHostAccess(true);
      expect(received).toHaveLength(1);
      expect(received[0].askBeforeActing).toBe(true);
      expect(received[0].hostAccess).toBe(true);
    });

    test("unsubscribe stops notifications", () => {
      const received: unknown[] = [];
      const unsubscribe = onModeChanged((mode) => received.push(mode));

      setAskBeforeActing(false);
      expect(received).toHaveLength(1);

      unsubscribe();
      setHostAccess(true);
      expect(received).toHaveLength(1); // no new notification
    });

    test("listener errors do not break other listeners", () => {
      const received: unknown[] = [];
      onModeChanged(() => {
        throw new Error("boom");
      });
      onModeChanged((mode) => received.push(mode));

      setAskBeforeActing(false);
      expect(received).toHaveLength(1);
    });
  });

  describe("persistence round-trip", () => {
    test("state survives store reset and re-initialization", () => {
      setAskBeforeActing(false);
      setHostAccess(true);

      // Simulate daemon restart: reset store and re-init from config
      resetForTesting();
      invalidateConfigCache();
      initPermissionModeStore();

      const mode = getMode();
      expect(mode.askBeforeActing).toBe(false);
      expect(mode.hostAccess).toBe(true);
    });

    test("preserves other config fields when persisting", () => {
      writeConfig({
        maxTokens: 8000,
        permissions: {
          mode: "strict",
          askBeforeActing: true,
          hostAccess: false,
        },
      });

      initPermissionModeStore();
      setHostAccess(true);

      const raw = readConfig();
      expect(raw.maxTokens).toBe(8000);
      const permissions = raw.permissions as Record<string, unknown>;
      expect(permissions.mode).toBe("strict");
      expect(permissions.hostAccess).toBe(true);
    });
  });
});
