import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  deviceKey,
  getDeviceBool,
  getDeviceSetting,
  setDeviceSetting,
} from "./device-settings";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("deviceKey", () => {
  test("returns device:-prefixed key", () => {
    expect(deviceKey("theme")).toBe("device:theme");
    expect(deviceKey("shareAnalytics")).toBe("device:share_analytics");
    expect(deviceKey("biometricEnabled")).toBe("device:biometric_enabled");
    expect(deviceKey("dockBadgesEnabled")).toBe("device:dock_badges_enabled");
    expect(deviceKey("lastUserId")).toBe("device:last_user_id");
  });
});

describe("getDeviceSetting / setDeviceSetting", () => {
  test("reads and writes device-prefixed keys", () => {
    setDeviceSetting("theme", "dark");
    expect(getDeviceSetting("theme", "system")).toBe("dark");
    expect(localStorage.getItem("device:theme")).toBe("dark");
  });

  test("returns fallback when key is absent", () => {
    expect(getDeviceSetting("theme", "system")).toBe("system");
  });

  test("ignores the pre-migration vellum_ key", () => {
    localStorage.setItem("vellum_theme", "dark");
    expect(getDeviceSetting("theme", "system")).toBe("system");
  });
});

describe("getDeviceBool", () => {
  test("reads device: key as boolean", () => {
    localStorage.setItem("device:share_analytics", "true");
    expect(getDeviceBool("shareAnalytics", false)).toBe(true);
  });

  test("returns fallback when absent", () => {
    expect(getDeviceBool("shareAnalytics", true)).toBe(true);
    expect(getDeviceBool("shareAnalytics", false)).toBe(false);
  });

  test("ignores the pre-migration vellum_ key", () => {
    localStorage.setItem("vellum_share_analytics", "false");
    expect(getDeviceBool("shareAnalytics", true)).toBe(true);
  });
});
