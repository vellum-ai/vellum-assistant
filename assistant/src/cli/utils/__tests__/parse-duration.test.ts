import { describe, expect, test } from "bun:test";

import { parseDuration } from "../parse-duration.js";

describe("parseDuration", () => {
  test('"30s" → 30', () => {
    expect(parseDuration("30s")).toBe(30);
  });

  test('"5m" → 300', () => {
    expect(parseDuration("5m")).toBe(300);
  });

  test('"1h" → 3600', () => {
    expect(parseDuration("1h")).toBe(3600);
  });

  test('"1h30m" → 5400', () => {
    expect(parseDuration("1h30m")).toBe(5400);
  });

  test('"90m" → 5400', () => {
    expect(parseDuration("90m")).toBe(5400);
  });

  test('"60" (bare number) → 60', () => {
    expect(parseDuration("60")).toBe(60);
  });

  test("invalid string → throws Error", () => {
    expect(() => parseDuration("abc")).toThrow('Invalid duration: "abc"');
  });

  test("empty string → throws Error", () => {
    expect(() => parseDuration("")).toThrow();
  });

  test('"1hxyz" (partial parse) → throws with "Invalid duration"', () => {
    expect(() => parseDuration("1hxyz")).toThrow("Invalid duration");
  });

  test('"1h-30m" (partial parse with dash) → throws with "Invalid duration"', () => {
    expect(() => parseDuration("1h-30m")).toThrow("Invalid duration");
  });

  test('"30mxyz" (partial parse) → throws with "Invalid duration"', () => {
    expect(() => parseDuration("30mxyz")).toThrow("Invalid duration");
  });
});
