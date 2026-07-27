import { describe, expect, test } from "bun:test";

import { creditRowLabel, storageRowLabel } from "./plan-row-labels";

describe("storageRowLabel", () => {
  test("spells out the storage row", () => {
    expect(storageRowLabel(30)).toBe("30 GB storage");
  });
});

describe("creditRowLabel", () => {
  test("drops the cents on a whole-dollar amount", () => {
    expect(creditRowLabel(45)).toBe("$45 of bundled credits");
  });

  test("keeps the cents on a sub-dollar amount", () => {
    expect(creditRowLabel(0.5)).toBe("$0.50 of bundled credits");
  });
});
