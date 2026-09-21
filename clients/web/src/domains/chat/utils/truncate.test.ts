import { describe, expect, test } from "bun:test";

import { truncate } from "./truncate";

describe("truncate", () => {
  test("leaves text that fits alone", () => {
    expect(truncate("Flights", 10)).toBe("Flights");
  });

  test("ends a cut at the limit with the ellipsis", () => {
    expect(truncate("Flights to Lisbon", 8)).toBe("Flights…");
  });

  test("never leaves half a surrogate pair behind", () => {
    const cut = truncate("abcdef😀xyz", 8);
    expect(cut).toBe("abcdef…");
    expect(/[\uD800-\uDBFF]$/.test(cut.slice(0, -1))).toBe(false);
  });
});
