import { describe, expect, test } from "bun:test";

import {
  getChatBillingBannerDecision,
  isCreditsExhaustedProviderError,
  isManagedCredentialChatError,
  resolveComposerBillingBanner,
  shouldShowGenericChatErrorNotice,
  shouldSuppressGenericChatErrorNotice,
} from "@/domains/chat/utils/error-classification";

describe("chat error classification", () => {
  test("classifies provider billing code with credits_exhausted category as managed credits", () => {
    const error = {
      code: "PROVIDER_BILLING",
      errorCategory: "credits_exhausted",
    };

    expect(getChatBillingBannerDecision(error)).toBe("managed_credits");
    expect(shouldSuppressGenericChatErrorNotice(error)).toBe(true);
    expect(shouldShowGenericChatErrorNotice(error)).toBe(false);
  });

  test("classifies provider billing code with provider_billing category as provider billing", () => {
    const error = {
      code: "PROVIDER_BILLING",
      errorCategory: "provider_billing",
    };

    expect(getChatBillingBannerDecision(error)).toBe("provider_billing");
    expect(shouldSuppressGenericChatErrorNotice(error)).toBe(true);
    expect(shouldShowGenericChatErrorNotice(error)).toBe(false);
  });

  test("does not classify provider_billing category as managed credits", () => {
    expect(
      getChatBillingBannerDecision({ errorCategory: "provider_billing" }),
    ).toBe("provider_billing");
  });

  test("classifies daily_limit_reached category as a daily limit banner", () => {
    const error = {
      code: "PROVIDER_BILLING",
      errorCategory: "daily_limit_reached",
    };

    expect(getChatBillingBannerDecision(error)).toBe("daily_limit");
    expect(shouldSuppressGenericChatErrorNotice(error)).toBe(true);
    expect(shouldShowGenericChatErrorNotice(error)).toBe(false);
  });

  test("matches a namespaced daily_limit_reached category suffix", () => {
    expect(
      getChatBillingBannerDecision({
        errorCategory: "billing.daily_limit_reached",
      }),
    ).toBe("daily_limit");
  });

  test("falls back to managed credits for legacy errors with no category", () => {
    const error = { code: "PROVIDER_BILLING" };

    expect(getChatBillingBannerDecision(error)).toBe("managed_credits");
    expect(shouldSuppressGenericChatErrorNotice(error)).toBe(true);
    expect(shouldShowGenericChatErrorNotice(error)).toBe(false);
  });

  test("classifies non-billing provider API errors as generic notices", () => {
    const error = {
      code: "PROVIDER_API_ERROR",
      errorCategory: "provider_api_error",
    };

    expect(getChatBillingBannerDecision(error)).toBeNull();
    expect(shouldSuppressGenericChatErrorNotice(error)).toBe(false);
    expect(shouldShowGenericChatErrorNotice(error)).toBe(true);
  });

  test("routes managed key failures through the generic Doctor-capable notice", () => {
    const error = {
      code: "MANAGED_KEY_INVALID",
      errorCategory: "managed_key_invalid",
    };

    expect(isManagedCredentialChatError(error)).toBe(true);
    expect(shouldSuppressGenericChatErrorNotice(error)).toBe(false);
    expect(shouldShowGenericChatErrorNotice(error)).toBe(true);
  });

  test("suppresses inline notice when displayAs is modal", () => {
    // secret_blocked from a fresh new-conversation POST is surfaced as a
    // dialog, not an inline banner. The inline Notice must stay hidden so
    // the dialog is the only visible error surface.
    const error = {
      code: "secret_blocked",
      displayAs: "modal" as const,
    };

    expect(shouldSuppressGenericChatErrorNotice(error)).toBe(true);
    expect(shouldShowGenericChatErrorNotice(error)).toBe(false);
  });

  test("does not suppress inline notice when displayAs is inline or absent", () => {
    expect(shouldSuppressGenericChatErrorNotice({ displayAs: "inline" })).toBe(
      false,
    );
    expect(shouldSuppressGenericChatErrorNotice({})).toBe(false);
    expect(
      shouldShowGenericChatErrorNotice({ code: "X", displayAs: "inline" }),
    ).toBe(true);
  });
});

describe("resolveComposerBillingBanner", () => {
  test("managed_credits renders no composer banner while the generic notice stays suppressed", () => {
    // The in-transcript credits upsell card is the exhausted-credits surface.
    const error = {
      code: "PROVIDER_BILLING",
      errorCategory: "credits_exhausted",
    };
    const billingBannerDecision = getChatBillingBannerDecision(error);

    expect(billingBannerDecision).toBe("managed_credits");
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision,
        showLowBalanceBanner: false,
      }),
    ).toBeNull();
    expect(shouldShowGenericChatErrorNotice(error)).toBe(false);
  });

  test("managed_credits also wins over a stale low-balance flag", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: "managed_credits",
        showLowBalanceBanner: true,
      }),
    ).toBeNull();
  });

  test("daily-limit and provider-billing errors keep their banners", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: getChatBillingBannerDecision({
          errorCategory: "daily_limit_reached",
        }),
        showLowBalanceBanner: false,
      }),
    ).toBe("daily_limit");
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: getChatBillingBannerDecision({
          errorCategory: "provider_billing",
        }),
        showLowBalanceBanner: false,
      }),
    ).toBe("provider_billing");
  });

  test("with no error-driven decision the slot falls back to the low-balance warning", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        showLowBalanceBanner: true,
      }),
    ).toBe("low_balance");
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        showLowBalanceBanner: false,
      }),
    ).toBeNull();
  });
});

describe("isCreditsExhaustedProviderError", () => {
  test("matches a credits_exhausted category, including namespaced suffixes", () => {
    expect(
      isCreditsExhaustedProviderError({ category: "credits_exhausted" }),
    ).toBe(true);
    expect(
      isCreditsExhaustedProviderError({
        code: "PROVIDER_BILLING",
        category: "billing.credits_exhausted",
      }),
    ).toBe(true);
  });

  test("matches a bare PROVIDER_BILLING code with no category", () => {
    expect(isCreditsExhaustedProviderError({ code: "PROVIDER_BILLING" })).toBe(
      true,
    );
  });

  test("category wins over the code fallback when both are present", () => {
    expect(
      isCreditsExhaustedProviderError({
        code: "PROVIDER_BILLING",
        category: "provider_billing",
      }),
    ).toBe(false);
  });

  test("rejects empty markers, other codes, and absent input", () => {
    // The daemon builds each providerError field conditionally, so a numeric
    // code plus null category persists as an empty object.
    expect(isCreditsExhaustedProviderError({})).toBe(false);
    expect(isCreditsExhaustedProviderError({ code: "PROVIDER_ERROR" })).toBe(
      false,
    );
    expect(isCreditsExhaustedProviderError(undefined)).toBe(false);
    expect(isCreditsExhaustedProviderError(null)).toBe(false);
  });
});
