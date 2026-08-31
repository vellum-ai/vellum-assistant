import { describe, expect, test } from "bun:test";

import {
  CREDITS_EXHAUSTED_USER_MESSAGE,
  DAILY_LIMIT_USER_MESSAGE,
  describeBillingFailureCopy,
  PROVIDER_BILLING_USER_MESSAGE,
} from "../billing-failure-copy.js";

describe("describeBillingFailureCopy", () => {
  test("a bare PROVIDER_BILLING code is managed-credits exhaustion", () => {
    expect(
      describeBillingFailureCopy({ failureCode: "PROVIDER_BILLING" }),
    ).toBe(CREDITS_EXHAUSTED_USER_MESSAGE);
  });

  test("daily_limit_reached wins over a bare PROVIDER_BILLING code", () => {
    expect(
      describeBillingFailureCopy({
        failureCode: "PROVIDER_BILLING",
        errorCategory: "daily_limit_reached",
      }),
    ).toBe(DAILY_LIMIT_USER_MESSAGE);
  });

  test("provider_billing wins over a bare PROVIDER_BILLING code", () => {
    expect(
      describeBillingFailureCopy({
        failureCode: "PROVIDER_BILLING",
        errorCategory: "provider_billing",
      }),
    ).toBe(PROVIDER_BILLING_USER_MESSAGE);
  });

  test("namespaced categories classify by suffix", () => {
    expect(
      describeBillingFailureCopy({
        errorCategory: "billing.credits_exhausted",
      }),
    ).toBe(CREDITS_EXHAUSTED_USER_MESSAGE);
  });

  test("unrelated failures stay unclassified", () => {
    expect(
      describeBillingFailureCopy({
        failureCode: "PROVIDER_RATE_LIMIT",
        errorKind: "model_provider",
      }),
    ).toBeNull();
  });
});
