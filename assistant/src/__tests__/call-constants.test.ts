import { describe, expect, test } from "bun:test";

import {
  getEndCallListenWindowMs,
  isDeniedNumber,
} from "../calls/call-constants.js";

describe("isDeniedNumber", () => {
  // Numbers that MUST be blocked
  const blocked = [
    "911",
    "112",
    "999",
    "000",
    "110",
    "119",
    "+112", // '+' stripped → '112' exact match
    "+911", // '+' stripped → '911' exact match
    "+1911", // country code 1 + 911
    "+44999", // country code 44 + 999
    "+61000", // country code 61 + 000
    "+49110", // country code 49 + 110
    "+81119", // country code 81 + 119
  ];

  for (const num of blocked) {
    test(`blocks ${num}`, () => {
      expect(isDeniedNumber(num)).toBe(true);
    });
  }

  // Numbers that MUST be allowed (legitimate phone numbers)
  const allowed = [
    "+14155551212", // US number — digits after any CC split don't match short codes
    "+442071234567", // UK number
    "+15559998888", // US number
  ];

  for (const num of allowed) {
    test(`allows ${num}`, () => {
      expect(isDeniedNumber(num)).toBe(false);
    });
  }
});

describe("getEndCallListenWindowMs", () => {
  test("leaves a brief response window before task-complete hangup", () => {
    expect(getEndCallListenWindowMs()).toBe(15_000);
  });
});
