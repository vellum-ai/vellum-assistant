import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const appPath = mkdtempSync(path.join(tmpdir(), "vellum-notifier-"));

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appPath,
  },
}));

const warnings: unknown[][] = [];
const infos: unknown[][] = [];
mock.module("./logger", () => ({
  default: {
    info: (...args: unknown[]) => infos.push(args),
    warn: (...args: unknown[]) => warnings.push(args),
  },
}));

const { __resetNotifierForTesting, getNotifier, isNotifierAvailable } =
  await import("./notifier");

const addonPath = path.join(
  appPath,
  "resources",
  "notifier",
  process.arch,
  "vellum-notifier.node",
);

afterAll(() => {
  rmSync(appPath, { recursive: true, force: true });
});

describe("notifier addon loading", () => {
  beforeEach(() => {
    __resetNotifierForTesting();
    warnings.length = 0;
    infos.length = 0;
    rmSync(path.join(appPath, "resources"), { recursive: true, force: true });
  });

  test("reports unavailable without throwing when the addon is missing", () => {
    expect(isNotifierAvailable()).toBe(false);
    expect(getNotifier()).toBeNull();
    expect(infos.length).toBe(1);
  });

  test("resolves the addon under resources/notifier/<arch> in a dev build", () => {
    isNotifierAvailable();
    expect(String(infos[0]?.[0])).toContain(addonPath);
  });

  test("reports unavailable without throwing when the file is not an addon", () => {
    mkdirSync(path.dirname(addonPath), { recursive: true });
    writeFileSync(addonPath, "not a mach-o dylib");

    expect(isNotifierAvailable()).toBe(false);
    expect(warnings.length).toBe(1);
  });

  test("caches the load result so a failure is not retried per call", () => {
    isNotifierAvailable();
    isNotifierAvailable();
    isNotifierAvailable();
    expect(infos.length).toBe(1);
  });
});
