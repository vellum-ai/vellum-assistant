import { describe, expect, test } from "bun:test";

import { NOTIFICATION_SOURCE_EVENT_NAMES } from "../signal.js";

describe("NOTIFICATION_SOURCE_EVENT_NAMES", () => {
  test("includes activity.failed", () => {
    expect(
      NOTIFICATION_SOURCE_EVENT_NAMES.some((e) => e.id === "activity.failed"),
    ).toBe(true);
  });

  test("still includes activity.complete (regression guard)", () => {
    expect(
      NOTIFICATION_SOURCE_EVENT_NAMES.some((e) => e.id === "activity.complete"),
    ).toBe(true);
  });
});
