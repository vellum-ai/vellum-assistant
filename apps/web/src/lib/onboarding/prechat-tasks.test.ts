import { describe, expect, it } from "bun:test";

import { PRECHAT_TASKS } from "@/lib/onboarding/prechat-tasks.js";

describe("PRECHAT_TASKS", () => {
  it("contains exactly 6 entries matching the macOS catalog", () => {
    expect(PRECHAT_TASKS.length).toBe(6);
  });

  it("has non-empty fields on every entry", () => {
    for (const entry of PRECHAT_TASKS) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.iconKey.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.sublabel.length).toBeGreaterThan(0);
    }
  });

  it("has unique ids", () => {
    const ids = PRECHAT_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
