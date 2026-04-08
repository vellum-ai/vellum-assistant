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

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [WORKSPACE_DIR, join(WORKSPACE_DIR, "data")];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function makeLoggerStub(): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) =>
      prop === "child" ? () => makeLoggerStub() : () => {},
  });
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
  setHostAccess,
} from "../permissions/permission-mode-store.js";

function writeConfig(obj: unknown): void {
  ensureTestDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

beforeEach(() => {
  ensureTestDir();
  resetForTesting();
  invalidateConfigCache();
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

describe("PermissionModeStore", () => {
  test("returns defaults when no config exists", () => {
    expect(getMode()).toEqual({ hostAccess: false });
  });

  test("reads initial state from config", () => {
    writeConfig({
      permissions: {
        hostAccess: true,
      },
    });

    initPermissionModeStore();
    expect(getMode()).toEqual({ hostAccess: true });
  });

  test("returns a defensive copy", () => {
    const mode = getMode();
    mode.hostAccess = true;
    expect(getMode()).toEqual({ hostAccess: false });
  });

  test("persists hostAccess to config.json", () => {
    setHostAccess(true);
    expect(readConfig().permissions).toEqual({
      mode: "workspace",
      hostAccess: true,
    });
  });

  test("persists only hostAccess when saving permission mode", () => {
    writeConfig({
      permissions: {
        mode: "strict",
        legacyMode: true,
        hostAccess: false,
      },
    });

    initPermissionModeStore();
    setHostAccess(true);

    expect(readConfig().permissions).toEqual({
      mode: "strict",
      hostAccess: true,
    });
  });

  test("no-op when value is unchanged", () => {
    const calls: unknown[] = [];
    onModeChanged((mode) => calls.push(mode));

    setHostAccess(false);
    expect(calls).toHaveLength(0);
  });

  test("fires on hostAccess change", () => {
    const received: Array<{ hostAccess: boolean }> = [];
    onModeChanged((mode) => received.push(mode));

    setHostAccess(true);
    expect(received).toEqual([{ hostAccess: true }]);
  });

  test("state survives store reset and re-initialization", () => {
    setHostAccess(true);
    resetForTesting();
    invalidateConfigCache();
    initPermissionModeStore();
    expect(getMode()).toEqual({ hostAccess: true });
  });
});
