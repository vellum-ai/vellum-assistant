/**
 * Tests for the credit figure the balance surfaces name: the wallet less
 * whatever is still unused on the usage grants, since the Usage Balance bar
 * already measures those.
 */

import { describe, expect, test } from "bun:test";

import { displayedCreditsUsd } from "./displayed-credits";

describe("displayedCreditsUsd", () => {
  test("nets the unused usage grants out of the balance", () => {
    expect(displayedCreditsUsd("34.65", "9.10")).toBe("25.55");
  });

  test("a balance that is all usage grant names nothing extra", () => {
    expect(displayedCreditsUsd("5.00", "5.00")).toBe("0.00");
  });

  test("clamps rather than going negative", () => {
    // Pending compute can pull the effective balance below the unused grants;
    // there is still no extra credit to name.
    expect(displayedCreditsUsd("5.00", "9.10")).toBe("0.00");
  });

  test("a platform reporting no grant figure returns the balance untouched", () => {
    // An older self-hosted platform omits the field, and a wrong reduction is
    // worse than no reduction.
    expect(displayedCreditsUsd("34.65", null)).toBe("34.65");
    expect(displayedCreditsUsd("34.65", undefined)).toBe("34.65");
  });

  test("an unreadable amount returns the balance untouched", () => {
    expect(displayedCreditsUsd("not a number", "9.10")).toBe("not a number");
    expect(displayedCreditsUsd("34.65", "nonsense")).toBe("34.65");
  });

  test("a negative balance with no grant left reads as zero extra", () => {
    expect(displayedCreditsUsd("-2.50", "0.00")).toBe("0.00");
  });
});
