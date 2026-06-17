import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  deviceKey,
  getDeviceBool,
  getDeviceSetting,
  migrateDeviceSettings,
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

  test("falls back to legacy key when device: key is absent", () => {
    localStorage.setItem("vellum_theme", "dark");
    expect(getDeviceSetting("theme", "system")).toBe("dark");
  });

  test("prefers device: key over legacy key", () => {
    localStorage.setItem("device:theme", "light");
    localStorage.setItem("vellum_theme", "dark");
    expect(getDeviceSetting("theme", "system")).toBe("light");
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

  test("falls back to legacy key when device: key is absent", () => {
    localStorage.setItem("vellum_share_analytics", "false");
    expect(getDeviceBool("shareAnalytics", true)).toBe(false);
  });

  test("prefers device: key over legacy key", () => {
    localStorage.setItem("device:share_analytics", "true");
    localStorage.setItem("vellum_share_analytics", "false");
    expect(getDeviceBool("shareAnalytics", false)).toBe(true);
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
    localStorage.setItem("vellum_dock_badges_enabled", "false");
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
    expect(localStorage.getItem("device:dock_badges_enabled")).toBe("false");
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

  test("preserves legacy key when storage write fails", () => {
    localStorage.setItem("vellum_theme", "dark");

    // Bun's localStorage is native — prototype overrides don't intercept.
    // Object.defineProperty on the instance works.
    const originalSetItem = localStorage.setItem;
    Object.defineProperty(localStorage, "setItem", {
      value(key: string, value: string) {
        if (key.startsWith("device:")) {
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        }
        originalSetItem.call(localStorage, key, value);
      },
      configurable: true,
    });

    try {
      migrateDeviceSettings();
    } finally {
      Object.defineProperty(localStorage, "setItem", {
        value: originalSetItem,
        configurable: true,
      });
    }

    // Legacy key should still exist — the write failed so we must not delete it
    expect(localStorage.getItem("vellum_theme")).toBe("dark");
    // New key was never written
    expect(localStorage.getItem("device:theme")).toBeNull();
  });

  test("dispatches vellum:pref-changed for each migrated key", () => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("vellum_share_diagnostics", "true");

    const dispatched: Array<{ key: string; value: string }> = [];
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; value: string }>).detail;
      dispatched.push(detail);
    };
    window.addEventListener("vellum:pref-changed", handler);

    migrateDeviceSettings();

    window.removeEventListener("vellum:pref-changed", handler);

    expect(dispatched).toEqual([
      { key: "device:theme", value: "dark" },
      { key: "device:share_diagnostics", value: "true" },
    ]);
  });
});
