import { describe, expect, test } from "bun:test";

import { ProfileEntry } from "../config/schemas/llm.js";

describe("ProfileEntry status field", () => {
  test("parses a profile with status: disabled", () => {
    const result = ProfileEntry.safeParse({
      status: "disabled",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("disabled");
    }
  });

  test("parses a profile without status — status is undefined (treated as active)", () => {
    const result = ProfileEntry.safeParse({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBeUndefined();
    }
  });

  test("parses a profile with status: active", () => {
    const result = ProfileEntry.safeParse({
      status: "active",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
    }
  });

  test("rejects an invalid status value", () => {
    const result = ProfileEntry.safeParse({
      status: "hidden",
    });
    expect(result.success).toBe(false);
  });
});
