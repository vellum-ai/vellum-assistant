/**
 * Tests for shared `nudge-prefs` helpers — currently focused on the
 * `computeNudgeSidebarVisible` cascade gate, which encodes the
 * banner-then-sidebar surface ordering used by every app-nudge module.
 */

import { describe, expect, test } from "bun:test";

import { computeNudgeSidebarVisible } from "@/lib/nudge-prefs.js";

describe("computeNudgeSidebarVisible", () => {
  test("hidden when the user has converted, regardless of dismiss flags", () => {
    expect(
      computeNudgeSidebarVisible({
        converted: true,
        bannerDismissed: false,
        sidebarDismissed: false,
      }),
    ).toBe(false);
    expect(
      computeNudgeSidebarVisible({
        converted: true,
        bannerDismissed: true,
        sidebarDismissed: true,
      }),
    ).toBe(false);
  });

  test("hidden when the user has explicitly dismissed the sidebar entry", () => {
    expect(
      computeNudgeSidebarVisible({
        converted: false,
        bannerDismissed: true,
        sidebarDismissed: true,
      }),
    ).toBe(false);
  });

  test("hidden by default before the banner has been dismissed", () => {
    // First-render state: no flags set yet. Sidebar must wait for the
    // banner to be the first surface the user sees.
    expect(
      computeNudgeSidebarVisible({
        converted: false,
        bannerDismissed: false,
        sidebarDismissed: false,
      }),
    ).toBe(false);
  });

  test("visible after the banner has been dismissed and sidebar is still active", () => {
    expect(
      computeNudgeSidebarVisible({
        converted: false,
        bannerDismissed: true,
        sidebarDismissed: false,
      }),
    ).toBe(true);
  });

  test("`converted` short-circuits over a stale `bannerDismissed` flag", () => {
    // A user who dismissed the banner and later converted via the
    // settings card or another surface must not see the sidebar.
    expect(
      computeNudgeSidebarVisible({
        converted: true,
        bannerDismissed: true,
        sidebarDismissed: false,
      }),
    ).toBe(false);
  });
});
