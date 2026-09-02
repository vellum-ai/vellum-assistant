/**
 * Brand labelling is the one place a raw Stripe enum could reach the screen:
 * the platform passes `card.brand` through untouched, and Stripe sends values
 * with no label of ours, so this pins that every one of them reads as no brand,
 * and that the display label falls back to the generic copy.
 */

import { describe, expect, test } from "bun:test";

import { fixedT } from "@/i18n";

import { brandDisplayLabel, brandLabel } from "./payment-method-brand";

const t = fixedT("settings");

const UNLABELLED_BRANDS = [
  ["Stripe's own no-network value", "unknown"],
  ["a network we hold no label for", "eftpos_au"],
  ["an empty brand", ""],
  ["a null brand", null],
  ["an absent brand", undefined],
] as const;

describe("brandLabel", () => {
  test.each([
    ["a lowercase brand", "visa", "Visa"],
    ["a brand Stripe already cased", "Visa", "Visa"],
    ["a two-word brand", "diners", "Diners Club"],
  ] as const)("names %s", (_label, brand, expected) => {
    expect(brandLabel(brand)).toBe(expected);
  });

  test.each(UNLABELLED_BRANDS)("reads %s as no brand", (_label, brand) => {
    expect(brandLabel(brand)).toBeNull();
  });
});

describe("brandDisplayLabel", () => {
  test("names a brand the map knows", () => {
    expect(brandDisplayLabel(t, "visa")).toBe("Visa");
  });

  // The literal, not the catalog lookup: comparing `t()` against itself would
  // pass just as well with the key missing from the catalog.
  test("falls back to the saved-card label for a brand with no label", () => {
    expect(brandDisplayLabel(t, "unknown")).toBe("Saved card");
  });
});
