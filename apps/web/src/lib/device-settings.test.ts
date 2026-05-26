import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  deviceKey,
  getDeviceSetting,
  migrateDeviceSettings,
  setDeviceSetting,
} from "./device-settings.js";

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
});

describe("migrateDeviceSettings", () => {
  test("migrates legacy keys to device: prefix", () => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("vellum_share_analytics", "true");
    localStorage.setItem("vellum_share_diagnostics", "false");
    localStorage.setItem("vellum_biometric_enabled", "false");
    localStorage.setItem("vellum_llm_log_retention", "dontRetain");
    localStorage.setItem("vellum_timezone", "America/New_York");
    localStorage.setItem("vellum_media_embeds_enabled", "true");
    localStorage.setItem("vellum_media_embed_domains", '["youtube.com"]');
    localStorage.setItem("onboarding.lastUserId", "user-123");

    migrateDeviceSettings();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("device:share_analytics")).toBe("true");
    expect(localStorage.getItem("device:share_diagnostics")).toBe("false");
    expect(localStorage.getItem("device:biometric_enabled")).toBe("false");
    expect(localStorage.getItem("device:llm_log_retention")).toBe("dontRetain");
    expect(localStorage.getItem("device:timezone")).toBe("America/New_York");
    expect(localStorage.getItem("device:media_embeds_enabled")).toBe("true");
    expect(localStorage.getItem("device:media_embed_domains")).toBe('["youtube.com"]');
    expect(localStorage.getItem("device:last_user_id")).toBe("user-123");
  });

  test("removes legacy keys after migration", () => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("onboarding.lastUserId", "user-123");

    migrateDeviceSettings();

    expect(localStorage.getItem("vellum_theme")).toBeNull();
    expect(localStorage.getItem("onboarding.lastUserId")).toBeNull();
  });

  test("does not overwrite new keys if they already exist", () => {
    localStorage.setItem("vellum_theme", "light");
    localStorage.setItem("device:theme", "dark");

    migrateDeviceSettings();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("vellum_theme")).toBeNull();
  });

  test("is idempotent — safe to run multiple times", () => {
    localStorage.setItem("vellum_theme", "dark");

    migrateDeviceSettings();
    migrateDeviceSettings();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("vellum_theme")).toBeNull();
  });

  test("handles absence of legacy keys gracefully", () => {
    migrateDeviceSettings();

    expect(localStorage.getItem("device:theme")).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
