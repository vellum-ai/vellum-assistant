import { describe, expect, test } from "bun:test";

import { releaseBucketSegment } from "./auto-update";

describe("releaseBucketSegment", () => {
  test("resolves the macOS release bucket on darwin", () => {
    expect(releaseBucketSegment("darwin")).toBe("mac-electron");
  });

  test("resolves the Linux release bucket on linux", () => {
    // Regression: the shared updater previously hard-coded `mac-electron`, so
    // the Linux app checked the macOS release feed and never saw its updates.
    expect(releaseBucketSegment("linux")).toBe("linux-electron");
  });

  test("falls back to the Linux bucket for other non-darwin platforms", () => {
    expect(releaseBucketSegment("win32")).toBe("linux-electron");
  });
});
