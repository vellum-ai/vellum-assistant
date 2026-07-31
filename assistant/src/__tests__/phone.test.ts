import { describe, expect, test } from "bun:test";

import { normalizePhoneNumber } from "../util/phone.js";

describe("normalizePhoneNumber", () => {
  test("already E.164 — returned as-is", () => {
    expect(normalizePhoneNumber("+15551234567")).toBe("+15551234567");
  });

  test("10-digit US number — prepends +1", () => {
    expect(normalizePhoneNumber("5551234567")).toBe("+15551234567");
  });

  test("11-digit number starting with 1 — prepends +", () => {
    expect(normalizePhoneNumber("15551234567")).toBe("+15551234567");
  });

  test("strips parentheses and spaces", () => {
    expect(normalizePhoneNumber("(555) 123-4567")).toBe("+15551234567");
  });

  test("strips dots", () => {
    expect(normalizePhoneNumber("555.123.4567")).toBe("+15551234567");
  });

  test("strips dashes", () => {
    expect(normalizePhoneNumber("555-123-4567")).toBe("+15551234567");
  });

  test("international with spaces", () => {
    expect(normalizePhoneNumber("+44 20 7946 0958")).toBe("+442079460958");
  });

  test("international with trunk-zero (0) — UK format", () => {
    expect(normalizePhoneNumber("+44 (0)20 7946 0958")).toBe("+442079460958");
  });

  test("international with trunk-zero (0) — German format", () => {
    expect(normalizePhoneNumber("+49 (0)30 1234 5678")).toBe("+493012345678");
  });

  test("international with trunk-zero (0) — no spaces", () => {
    expect(normalizePhoneNumber("+44(0)2079460958")).toBe("+442079460958");
  });

  test("too short — returns null", () => {
    expect(normalizePhoneNumber("123")).toBeNull();
  });

  test("non-numeric — returns null", () => {
    expect(normalizePhoneNumber("abc")).toBeNull();
  });

  test("empty string — returns null", () => {
    expect(normalizePhoneNumber("")).toBeNull();
  });
});
