import { describe, expect, test } from "bun:test";

import { orderProfileKeys } from "../profile-order.js";

describe("orderProfileKeys", () => {
  test("orders named keys first, then the rest alphabetically, skipping unknown names", () => {
    const profiles = { zeta: {}, balanced: {}, alpha: {} };
    expect(
      orderProfileKeys(profiles, ["balanced", "ghost", "balanced", "zeta"]),
    ).toEqual(["balanced", "zeta", "alpha"]);
  });

  test("ignores order entries that only resolve through the prototype", () => {
    const profiles = { balanced: {} };
    expect(
      orderProfileKeys(profiles, ["constructor", "toString", "balanced"]),
    ).toEqual(["balanced"]);
  });
});
