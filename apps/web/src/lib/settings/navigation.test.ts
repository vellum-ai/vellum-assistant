import { describe, expect, test } from "bun:test";

import {
  getSettingsRouteForClientTab,
  PANEL_IDS,
  SETTINGS_SIDEBAR,
} from "@/lib/settings/navigation.js";
import { routes } from "@/lib/routes.js";

// ---------------------------------------------------------------------------
// SETTINGS_SIDEBAR structure (flat list)
// ---------------------------------------------------------------------------

describe("SETTINGS_SIDEBAR", () => {
  const ids = SETTINGS_SIDEBAR.map((item) => item.id);

  test("includes assistant-status item", () => {
    expect(ids).toContain("assistant-status");
  });

  test("includes assistant-debug item", () => {
    expect(ids).toContain("assistant-debug");
  });

  test("assistant-status appears before assistant-debug", () => {
    expect(ids.indexOf("assistant-status")).toBeLessThan(
      ids.indexOf("assistant-debug"),
    );
  });

  test("includes billing item", () => {
    expect(ids).toContain("billing");
  });

  test("includes devices item", () => {
    expect(ids).toContain("devices");
  });

  test("devices item links to the devices route", () => {
    const devices = SETTINGS_SIDEBAR.find((item) => item.id === "devices");
    expect(devices?.href).toBe(routes.settings.devices);
  });

  test("every item id is a valid PanelId", () => {
    for (const item of SETTINGS_SIDEBAR) {
      expect((PANEL_IDS as readonly string[]).includes(item.id)).toBe(true);
    }
  });

  test("every item has an icon", () => {
    for (const item of SETTINGS_SIDEBAR) {
      expect(item.icon).toBeDefined();
    }
  });
});

describe("getSettingsRouteForClientTab", () => {
  test("resolves settings sidebar labels", () => {
    expect(getSettingsRouteForClientTab("Integrations")).toBe(
      routes.settings.integrations,
    );
    expect(getSettingsRouteForClientTab("Models & Services")).toBe(
      routes.settings.ai,
    );
  });

  test("resolves client compatibility aliases", () => {
    expect(getSettingsRouteForClientTab("Developer")).toBe(
      routes.settings.debug,
    );
    expect(getSettingsRouteForClientTab("privacy")).toBe(
      routes.settings.privacy,
    );
  });

  test("returns null for unknown tabs", () => {
    expect(getSettingsRouteForClientTab("Unknown")).toBeNull();
  });
});
