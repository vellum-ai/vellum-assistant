import { describe, expect, test } from "bun:test";

import {
  SETTINGS_SIDEBAR,
  getSettingsRouteForClientTab,
} from "@/utils/settings-navigation";

describe("getSettingsRouteForClientTab — Debug page", () => {
  test("resolves the debug and developer client tabs to the Debug page", () => {
    expect(getSettingsRouteForClientTab("debug")).toBe(
      "/assistant/settings/debug",
    );
    expect(getSettingsRouteForClientTab("developer")).toBe(
      "/assistant/settings/debug",
    );
  });

  test("routes the archive alias to the Debug Archive tab", () => {
    // The bare Debug route opens General, so archive must carry ?tab=archive to
    // land on the Archive tab.
    expect(getSettingsRouteForClientTab("archive")).toBe(
      "/assistant/settings/debug?tab=archive",
    );
    expect(getSettingsRouteForClientTab("Archive")).toBe(
      "/assistant/settings/debug?tab=archive",
    );
  });

  test("resolves the Debug sidebar label to the Debug page without ambiguity", () => {
    expect(getSettingsRouteForClientTab("Debug")).toBe(
      "/assistant/settings/debug",
    );
  });

  test("keeps resolving the legacy Advanced tab name to the Debug page", () => {
    expect(getSettingsRouteForClientTab("Advanced")).toBe(
      "/assistant/settings/debug",
    );
  });

  test("no two sidebar items share a label", () => {
    // The label is a lookup key in the fallback tier, so a duplicate would make
    // resolution order-dependent.
    const labels = SETTINGS_SIDEBAR.map((item) => item.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("returns null for an unknown tab name", () => {
    expect(getSettingsRouteForClientTab("not-a-real-tab")).toBeNull();
  });
});
