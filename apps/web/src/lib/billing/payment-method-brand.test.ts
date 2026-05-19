/**
 * Tests for the shared payment-method brand+last4 formatting helpers.
 * Both `PaymentMethodsCard` and `AutoTopUpCard.formatSavedPaymentMethodLine`
 * route through `formatBrandLast4`, so the contract is pinned here.
 */

import { describe, expect, test } from "bun:test";

import { brandLabel, formatBrandLast4 } from "@/lib/billing/payment-method-brand.js";

describe("brandLabel", () => {
  test("normalizes lowercase Stripe brand strings to display capitalization", () => {
    expect(brandLabel("visa")).toBe("Visa");
    expect(brandLabel("mastercard")).toBe("Mastercard");
    expect(brandLabel("amex")).toBe("Amex");
  });

  test("falls through to the input verbatim for unknown brands", () => {
    // Lowercase "card" isn't in BRAND_LABELS, so it returns "card" verbatim.
    // formatBrandLast4 relies on this fallback for the brand=null case.
    expect(brandLabel("card")).toBe("card");
    expect(brandLabel("Bogus")).toBe("Bogus");
  });
});

describe("formatBrandLast4", () => {
  test("renders '<brand> •••• <last4>' when both fields are present", () => {
    expect(formatBrandLast4("visa", "4242")).toBe("Visa •••• 4242");
  });

  test("falls back to 'card' when brand is null", () => {
    expect(formatBrandLast4(null, "4242")).toBe("card •••• 4242");
  });

  test("falls back to '????' when last4 is null", () => {
    expect(formatBrandLast4("Mastercard", null)).toBe("Mastercard •••• ????");
  });

  test("applies both fallbacks when brand and last4 are null", () => {
    expect(formatBrandLast4(null, null)).toBe("card •••• ????");
  });
});
