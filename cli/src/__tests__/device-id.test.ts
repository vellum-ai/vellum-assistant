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

// Bun's os.homedir() ignores runtime HOME changes, so mock it (via the shared
// helper) to keep production-path tests off the real ~/.vellum.
let fakeHome: string | undefined;
await mockOsHomedir((realHomedir) => () => fakeHome ?? realHomedir());

import {
  getOrCreateHostDeviceId,
  resetHostDeviceIdCache,
} from "../lib/device-id.js";
import { snapshotEnv } from "./helpers/env.js";
import { mockOsHomedir } from "./helpers/os-mock.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const restoreEnv = snapshotEnv([
  "XDG_CONFIG_HOME",
  "VELLUM_ENVIRONMENT",
  "VELLUM_DEVICE_ID",
]);

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
    restoreEnv();
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

describe("getOrCreateHostDeviceId (production)", () => {
  let tempHome: string;
  let deviceFile: string;

  beforeEach(() => {
    delete process.env.VELLUM_DEVICE_ID;
    tempHome = mkdtempSync(join(tmpdir(), "cli-device-id-prod-test-"));
    fakeHome = tempHome;
    process.env.XDG_CONFIG_HOME = join(tempHome, ".config");
    process.env.VELLUM_ENVIRONMENT = "production";
    deviceFile = join(tempHome, ".vellum", "device.json");
    resetHostDeviceIdCache();
  });

  afterEach(() => {
    fakeHome = undefined;
    restoreEnv();
    rmSync(tempHome, { recursive: true, force: true });
    resetHostDeviceIdCache();
  });

  test("creates device.json in the shared ~/.vellum dir", () => {
    const id = getOrCreateHostDeviceId();

    expect(id).toMatch(UUID_RE);
    expect(existsSync(deviceFile)).toBe(true);
    expect(JSON.parse(readFileSync(deviceFile, "utf-8")).deviceId).toBe(id);
  });

  test("reuses an existing ~/.vellum/device.json", () => {
    mkdirSync(join(tempHome, ".vellum"), { recursive: true });
    writeFileSync(deviceFile, JSON.stringify({ deviceId: "shared-prod-id" }));

    expect(getOrCreateHostDeviceId()).toBe("shared-prod-id");
    expect(readFileSync(deviceFile, "utf-8")).toBe(
      JSON.stringify({ deviceId: "shared-prod-id" }),
    );
  });
});
