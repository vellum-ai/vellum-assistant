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
  // Inputs that would render the low-balance banner absent an error decision.
  const lowBalanceInputs = { isLowBalance: true, dismissed: false };

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
        isLowBalance: false,
        dismissed: false,
      }),
    ).toBeNull();
    expect(shouldShowGenericChatErrorNotice(error)).toBe(false);
  });

  test("managed_credits also wins over a stale low-balance flag", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: "managed_credits",
        ...lowBalanceInputs,
      }),
    ).toBeNull();
  });

  test("daily-limit and provider-billing errors win over the low-balance warning", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: getChatBillingBannerDecision({
          errorCategory: "daily_limit_reached",
        }),
        ...lowBalanceInputs,
      }),
    ).toBe("daily_limit");
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: getChatBillingBannerDecision({
          errorCategory: "provider_billing",
        }),
        ...lowBalanceInputs,
      }),
    ).toBe("provider_billing");
  });

  test("with no error-driven decision the slot falls back to the low-balance warning", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        ...lowBalanceInputs,
      }),
    ).toBe("low_balance");
  });

  test("no low-balance banner when the server flag is off (normal balance, auto-top-up, or gated-off query)", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        isLowBalance: false,
        dismissed: false,
      }),
    ).toBeNull();
  });

  test("no low-balance banner after a session dismissal", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        isLowBalance: true,
        dismissed: true,
      }),
    ).toBeNull();
  });

  test("the summary's daily-limit flag renders the banner with no error at all", () => {
    // The proactive case: background turns exhausted the cap while the user
    // was away, so nothing in this session has failed yet.
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        isLowBalance: false,
        dismissed: false,
        dailyLimitReached: true,
      }),
    ).toBe("daily_limit");
  });

  test("the summary's daily-limit flag outranks the low-balance warning", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        ...lowBalanceInputs,
        dailyLimitReached: true,
      }),
    ).toBe("daily_limit");
  });

  test("an active skip clears the banner the failed send left behind", () => {
    // The stored chat error keeps its daily-limit decision after a successful
    // skip, so without this the banner would sit over a limit that is no
    // longer enforced until the user sends again.
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: "daily_limit",
        isLowBalance: false,
        dismissed: false,
        dailyLimitSnoozed: true,
      }),
    ).toBeNull();
  });

  test("an active skip also clears the state-driven daily-limit banner", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        isLowBalance: false,
        dismissed: false,
        dailyLimitReached: true,
        dailyLimitSnoozed: true,
      }),
    ).toBeNull();
  });

  test("an active skip leaves the other billing banners alone", () => {
    // A skipped daily limit says nothing about the provider account or the
    // credit balance.
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: "provider_billing",
        isLowBalance: false,
        dismissed: false,
        dailyLimitSnoozed: true,
      }),
    ).toBe("provider_billing");
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        ...lowBalanceInputs,
        dailyLimitSnoozed: true,
      }),
    ).toBe("low_balance");
  });

  test("the daily-limit banner ignores the low-balance session dismissal", () => {
    // Dismissal is the low-balance banner's affordance; the daily-limit
    // banner has none, so a latched dismissal must not hide it.
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        isLowBalance: true,
        dismissed: true,
        dailyLimitReached: true,
      }),
    ).toBe("daily_limit");
  });

  test("a provider-billing error still wins over the summary's daily-limit flag", () => {
    // The error describes the send the user just watched fail, so it owns the
    // slot even when the summary independently reports the cap.
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: "provider_billing",
        isLowBalance: false,
        dismissed: false,
        dailyLimitReached: true,
      }),
    ).toBe("provider_billing");
  });

  test("managed_credits still suppresses the slot, summary daily-limit flag included", () => {
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: "managed_credits",
        ...lowBalanceInputs,
        dailyLimitReached: true,
      }),
    ).toBeNull();
  });

  test.each([
    ["false", false],
    ["undefined", undefined],
  ] as const)(
    "a %s daily-limit flag falls through to the low-balance leg",
    (_label, dailyLimitReached) => {
      expect(
        resolveComposerBillingBanner({
          billingBannerDecision: null,
          ...lowBalanceInputs,
          dailyLimitReached,
        }),
      ).toBe("low_balance");
      expect(
        resolveComposerBillingBanner({
          billingBannerDecision: null,
          isLowBalance: false,
          dismissed: false,
          dailyLimitReached,
        }),
      ).toBeNull();
    },
  );
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
