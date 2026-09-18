import { describe, expect, test } from "bun:test";

import { isRecord } from "@/utils/is-record";

describe("isRecord", () => {
  test("accepts plain objects, empty or not", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  test("rejects null, arrays and scalars", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("a")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
