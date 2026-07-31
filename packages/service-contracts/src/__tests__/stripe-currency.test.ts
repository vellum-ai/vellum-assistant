import { describe, expect, test } from "bun:test";

import {
  STRIPE_THREE_DECIMAL_CURRENCIES,
  STRIPE_ZERO_DECIMAL_CURRENCIES,
  stripeScaleDigits,
} from "../stripe-currency.js";

describe("stripeScaleDigits", () => {
  test("zero-decimal currencies scale to 0 digits", () => {
    expect(stripeScaleDigits("JPY")).toBe(0);
    expect(stripeScaleDigits("KRW")).toBe(0);
  });

  test("three-decimal currencies scale to 3 digits", () => {
    expect(stripeScaleDigits("BHD")).toBe(3);
    expect(stripeScaleDigits("KWD")).toBe(3);
  });

  test("everything else scales to 2 digits", () => {
    expect(stripeScaleDigits("USD")).toBe(2);
    expect(stripeScaleDigits("EUR")).toBe(2);
    expect(stripeScaleDigits("XYZ")).toBe(2);
  });

  test("Stripe's charge-side two-decimal special cases stay at 2 digits", () => {
    for (const code of ["ISK", "HUF", "TWD", "UGX"]) {
      expect(stripeScaleDigits(code)).toBe(2);
    }
  });

  test("the currency sets do not overlap", () => {
    for (const code of STRIPE_ZERO_DECIMAL_CURRENCIES) {
      expect(STRIPE_THREE_DECIMAL_CURRENCIES.has(code)).toBe(false);
    }
  });
});
