import { describe, expect, test } from "bun:test";

import {
  creditRowLabel,
  formatDelta,
  formatMonthly,
  storageRowLabel,
} from "./tier-pricing";

describe("formatMonthly", () => {
  test("renders whole-dollar amounts without cents", () => {
    expect(formatMonthly(5000)).toBe("$50/mo");
  });

  test("renders sub-dollar cents with two decimals", () => {
    expect(formatMonthly(995)).toBe("$9.95/mo");
  });

  test("renders zero as $0/mo", () => {
    expect(formatMonthly(0)).toBe("$0/mo");
  });
});

describe("formatDelta", () => {
  test("prefixes a positive delta with +", () => {
    expect(formatDelta(2500)).toBe("+$25/mo");
  });

  test("prefixes a negative delta with the U+2212 minus sign", () => {
    expect(formatDelta(-5000)).toBe("−$50/mo");
  });

  test("keeps cents on a fractional delta", () => {
    expect(formatDelta(-1050)).toBe("−$10.50/mo");
  });

  test("treats a zero delta as non-positive (minus prefix)", () => {
    expect(formatDelta(0)).toBe("−$0/mo");
  });
});

describe("storageRowLabel", () => {
  test("spells out the storage row", () => {
    expect(storageRowLabel(30)).toBe("30 GB storage");
  });
});

describe("creditRowLabel", () => {
  test("drops the cents on a whole-dollar amount", () => {
    expect(creditRowLabel(45)).toBe("$45 of bundled credits");
  });

  // The label takes dollars but formats through the cents-aware helper, so the
  // conversion has to survive a fractional bundle.
  test("keeps the cents on a sub-dollar amount", () => {
    expect(creditRowLabel(0.5)).toBe("$0.50 of bundled credits");
  });
});
