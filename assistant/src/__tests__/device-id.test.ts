import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Suppress logger output before importing the module under test.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDeviceId, resetDeviceIdCache } from "../util/device-id.js";

const originalVellumEnvironment = process.env.VELLUM_ENVIRONMENT;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalIsContainerized = process.env.IS_CONTAINERIZED;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "vellum-device-id-test-"));
  resetDeviceIdCache();
});

afterEach(() => {
  resetDeviceIdCache();

  if (originalVellumEnvironment == null) {
    delete process.env.VELLUM_ENVIRONMENT;
  } else {
    process.env.VELLUM_ENVIRONMENT = originalVellumEnvironment;
  }
  if (originalXdgConfigHome == null) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalIsContainerized == null) {
    delete process.env.IS_CONTAINERIZED;
  } else {
    process.env.IS_CONTAINERIZED = originalIsContainerized;
  }

  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("getDeviceId env-awareness", () => {
  test("non-prod (dev) writes device.json under $XDG_CONFIG_HOME/vellum-dev", () => {
    // Guarantee we're not containerized — the test-preload deletes this,
    // but be defensive.
    delete process.env.IS_CONTAINERIZED;
    process.env.VELLUM_ENVIRONMENT = "dev";
    process.env.XDG_CONFIG_HOME = tempDir;

    const id = getDeviceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const expectedPath = join(tempDir, "vellum-dev", "device.json");
    expect(existsSync(expectedPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(parsed.deviceId).toBe(id);
  });

  test("staging environment writes under $XDG_CONFIG_HOME/vellum-staging", () => {
    delete process.env.IS_CONTAINERIZED;
    process.env.VELLUM_ENVIRONMENT = "staging";
    process.env.XDG_CONFIG_HOME = tempDir;

    getDeviceId();

    const expectedPath = join(tempDir, "vellum-staging", "device.json");
    expect(existsSync(expectedPath)).toBe(true);
  });

  test("unknown environment does NOT write under $XDG_CONFIG_HOME/vellum-<unknown>", () => {
    // Unknown env names fall back to the legacy production behavior.
    // We can't assert the exact legacy path without mocking homedir(),
    // but we can assert that the XDG env-scoped dir is NOT created.
    delete process.env.IS_CONTAINERIZED;
    process.env.VELLUM_ENVIRONMENT = "no-such-env";
    process.env.XDG_CONFIG_HOME = tempDir;

    getDeviceId();

    // No `vellum-no-such-env` directory created under our XDG tempdir.
    const envScopedPath = join(tempDir, "vellum-no-such-env", "device.json");
    expect(existsSync(envScopedPath)).toBe(false);
    // Legacy fallback would write under `${homedir()}/.vellum` — not touched.
    const productionXdgPath = join(tempDir, "vellum", "device.json");
    expect(existsSync(productionXdgPath)).toBe(false);
  });

  test("production does NOT write under $XDG_CONFIG_HOME/vellum", () => {
    // Production path is ~/.vellum/device.json, never XDG_CONFIG_HOME.
    delete process.env.IS_CONTAINERIZED;
    delete process.env.VELLUM_ENVIRONMENT;
    process.env.XDG_CONFIG_HOME = tempDir;

    getDeviceId();

    const xdgPath = join(tempDir, "vellum", "device.json");
    expect(existsSync(xdgPath)).toBe(false);
  });
});
