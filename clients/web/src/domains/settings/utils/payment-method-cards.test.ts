/**
 * The backend stores at most one payment method and has no list endpoint, so
 * the multi-card shape `PaymentMethodsCard` renders is only reachable through
 * this pure helper.
 */

import { describe, expect, test } from "bun:test";

import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

import { paymentMethodCards } from "./payment-method-cards";

// Local rather than the `DISABLED_CONFIG` the card tests share: that one lives
// in a component module, which pulls Stripe.js into this otherwise pure test.
const NO_CARD: AutoTopUpConfigResponse = {
  enabled: false,
  threshold_usd: null,
  amount_usd: null,
  monthly_cap_usd: null,
  has_payment_method: false,
  payment_method_brand: null,
  payment_method_last4: null,
  payment_method_exp_month: null,
  payment_method_exp_year: null,
  billing_address: null,
  stripe_payment_method_updated_at: null,
  last_charge_at: null,
  last_failure_at: null,
  last_failure_reason: null,
  paused_until: null,
  current_month_credits_purchased_usd: "0.00",
  current_month_charged_usd: "0.00",
  next_trigger_amount_usd: null,
  disabled_due_to_repeated_failures: false,
  stubbed: false,
};

const WITH_CARD: AutoTopUpConfigResponse = {
  ...NO_CARD,
  has_payment_method: true,
  payment_method_brand: "visa",
  payment_method_last4: "4242",
};

const WITH_EXPIRY: AutoTopUpConfigResponse = {
  ...WITH_CARD,
  payment_method_exp_month: 4,
  payment_method_exp_year: 2042,
};

describe("paymentMethodCards", () => {
  test("maps a saved card onto a single stably-keyed entry", () => {
    expect(paymentMethodCards(WITH_CARD)).toEqual([
      {
        id: "primary",
        brand: "visa",
        last4: "4242",
        expMonth: null,
        expYear: null,
      },
    ]);
  });

  test("reads the expiry the platform sends", () => {
    expect(paymentMethodCards(WITH_EXPIRY)).toEqual([
      {
        id: "primary",
        brand: "visa",
        last4: "4242",
        expMonth: 4,
        expYear: 2042,
      },
    ]);
  });

  test("maps no card and a missing config onto an empty list", () => {
    expect(paymentMethodCards(NO_CARD)).toEqual([]);
    expect(paymentMethodCards(undefined)).toEqual([]);
  });
});
