import { describe, expect, test } from "bun:test";

import { getSettingsRouteForClientTab } from "@/utils/settings-navigation";

describe("getSettingsRouteForClientTab — Advanced merge", () => {
  test("resolves the debug and developer client tabs to the Advanced page", () => {
    expect(getSettingsRouteForClientTab("debug")).toBe(
      "/assistant/settings/advanced",
    );
    expect(getSettingsRouteForClientTab("developer")).toBe(
      "/assistant/settings/advanced",
    );
  });

  test("routes the archive alias to the Advanced Archive tab", () => {
    // The bare Advanced route opens General, so archive must carry ?tab=archive
    // to land on the Archive tab.
    expect(getSettingsRouteForClientTab("archive")).toBe(
      "/assistant/settings/advanced?tab=archive",
    );
    expect(getSettingsRouteForClientTab("Archive")).toBe(
      "/assistant/settings/advanced?tab=archive",
    );
  });

  test("resolves the Advanced sidebar label to the Advanced page without ambiguity", () => {
    expect(getSettingsRouteForClientTab("Advanced")).toBe(
      "/assistant/settings/advanced",
    );
  });

  test("returns null for an unknown tab name", () => {
    expect(getSettingsRouteForClientTab("not-a-real-tab")).toBeNull();
  });
});
