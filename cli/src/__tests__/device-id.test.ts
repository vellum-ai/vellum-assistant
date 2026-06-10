import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  getOrCreateHostDeviceId,
  resetHostDeviceIdCache,
} from "../lib/device-id.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SAVED_ENV_VARS = [
  "XDG_CONFIG_HOME",
  "VELLUM_ENVIRONMENT",
  "VELLUM_DEVICE_ID",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of SAVED_ENV_VARS) {
  savedEnv[key] = process.env[key];
}

describe("getOrCreateHostDeviceId", () => {
  let tempHome: string;
  let deviceFile: string;

  beforeEach(() => {
    delete process.env.VELLUM_DEVICE_ID;
    tempHome = mkdtempSync(join(tmpdir(), "cli-device-id-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    // Non-prod so the resolver targets $XDG_CONFIG_HOME/vellum-dev/
    // instead of the real ~/.config/vellum/.
    process.env.VELLUM_ENVIRONMENT = "dev";
    deviceFile = join(tempHome, "vellum-dev", "device.json");
    resetHostDeviceIdCache();
  });

  afterEach(() => {
    for (const key of SAVED_ENV_VARS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(tempHome, { recursive: true, force: true });
    resetHostDeviceIdCache();
  });

  test("creates device.json with a UUID when missing", () => {
    const id = getOrCreateHostDeviceId();

    expect(id).toMatch(UUID_RE);
    expect(existsSync(deviceFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(deviceFile, "utf-8"));
    expect(parsed.deviceId).toBe(id);
    expect(readFileSync(deviceFile, "utf-8").endsWith("\n")).toBe(true);
  });

  test("returns the existing deviceId without rewriting the file", () => {
    mkdirSync(join(tempHome, "vellum-dev"), { recursive: true });
    writeFileSync(deviceFile, JSON.stringify({ deviceId: "existing-id" }));
    const before = statSync(deviceFile).mtimeMs;

    expect(getOrCreateHostDeviceId()).toBe("existing-id");
    expect(statSync(deviceFile).mtimeMs).toBe(before);
    expect(readFileSync(deviceFile, "utf-8")).toBe(
      JSON.stringify({ deviceId: "existing-id" }),
    );
  });

  test("caches the resolved id until reset", () => {
    const first = getOrCreateHostDeviceId();
    rmSync(deviceFile);

    expect(getOrCreateHostDeviceId()).toBe(first);

    resetHostDeviceIdCache();
    const second = getOrCreateHostDeviceId();
    expect(second).toMatch(UUID_RE);
    expect(second).not.toBe(first);
  });

  test("preserves unrelated fields when adding deviceId", () => {
    mkdirSync(join(tempHome, "vellum-dev"), { recursive: true });
    writeFileSync(deviceFile, JSON.stringify({ other: "kept", deviceId: "" }));

    const id = getOrCreateHostDeviceId();

    expect(id).toMatch(UUID_RE);
    const parsed = JSON.parse(readFileSync(deviceFile, "utf-8"));
    expect(parsed.other).toBe("kept");
    expect(parsed.deviceId).toBe(id);
  });

  test("VELLUM_DEVICE_ID env var wins and skips file access", () => {
    process.env.VELLUM_DEVICE_ID = "env-device-id";

    expect(getOrCreateHostDeviceId()).toBe("env-device-id");
    expect(existsSync(deviceFile)).toBe(false);
  });

  test("malformed JSON regenerates without throwing", () => {
    mkdirSync(join(tempHome, "vellum-dev"), { recursive: true });
    writeFileSync(deviceFile, "{not json");

    const id = getOrCreateHostDeviceId();

    expect(id).toMatch(UUID_RE);
    const parsed = JSON.parse(readFileSync(deviceFile, "utf-8"));
    expect(parsed).toEqual({ deviceId: id });
  });
});
