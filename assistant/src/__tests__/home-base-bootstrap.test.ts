import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testRoot = mkdtempSync(join(tmpdir(), "home-base-bootstrap-test-"));
const dataDir = join(testRoot, "data");
const dbPath = join(testRoot, "assistant.db");

mock.module("../util/platform.js", () => ({
  getDataDir: () => dataDir,
  getDbPath: () => dbPath,
  ensureDataDir: () => {
    mkdirSync(dataDir, { recursive: true });
  },
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testRoot, "test.sock"),
  getPidPath: () => join(testRoot, "test.pid"),
  getLogPath: () => join(testRoot, "test.log"),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getHomeBaseAppLink } from "../home-base/app-link-store.js";
import {
  bootstrapHomeBaseAppLink,
  resolveHomeBaseAppId,
} from "../home-base/bootstrap.js";
import { deleteApp } from "../memory/app-store.js";
import { initializeDb, resetDb } from "../memory/db.js";

describe("home base bootstrap", () => {
  beforeEach(() => {
    resetDb();
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(testRoot, { recursive: true });
    initializeDb();
  });

  afterAll(() => {
    resetDb();
    rmSync(testRoot, { recursive: true, force: true });
  });

  test("creates a durable Home Base link on first bootstrap", () => {
    const result = bootstrapHomeBaseAppLink();
    expect(result).not.toBeNull();
    const link = getHomeBaseAppLink();

    expect(result!.linked).toBe(true);
    expect(link).not.toBeNull();
    expect(link?.appId).toBe(result!.appId);
    expect(resolveHomeBaseAppId()).toBe(result!.appId);
  });

  test("reuses existing link on repeated bootstrap calls", () => {
    const first = bootstrapHomeBaseAppLink();
    const second = bootstrapHomeBaseAppLink();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    expect(second!.appId).toBe(first!.appId);
    expect(second!.created).toBe(false);
  });

  test("relinks when stored app id is stale", () => {
    const first = bootstrapHomeBaseAppLink();
    expect(first).not.toBeNull();
    deleteApp(first!.appId);

    const second = bootstrapHomeBaseAppLink();
    expect(second).not.toBeNull();

    expect(second!.appId).not.toBe(first!.appId);
    expect(getHomeBaseAppLink()?.appId).toBe(second!.appId);
  });
});
