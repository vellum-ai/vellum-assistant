import { describe, expect, test } from "bun:test";

import { parseDuration } from "../cli/commands/conversations-defer.js";

describe("parseDuration", () => {
  test("bare number treated as seconds", () => {
    expect(parseDuration("60")).toBe(60);
  });

  test("seconds suffix", () => {
    expect(parseDuration("60s")).toBe(60);
  });

  test("minutes suffix", () => {
    expect(parseDuration("5m")).toBe(300);
  });

  test("hours suffix", () => {
    expect(parseDuration("1h")).toBe(3600);
  });

  test("composite hours and minutes", () => {
    expect(parseDuration("1h30m")).toBe(5400);
  });

  test("seconds only with suffix", () => {
    expect(parseDuration("90s")).toBe(90);
  });

  test("throws on invalid string", () => {
    expect(() => parseDuration("invalid")).toThrow(
      'Invalid duration: "invalid"',
    );
  });

  test("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow('Invalid duration: ""');
  });
});
