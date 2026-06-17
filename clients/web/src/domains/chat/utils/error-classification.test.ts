import { describe, expect, test } from "bun:test";

import {
  getChatBillingBannerDecision,
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
    expect(
      shouldSuppressGenericChatErrorNotice({ displayAs: "inline" }),
    ).toBe(false);
    expect(shouldSuppressGenericChatErrorNotice({})).toBe(false);
    expect(
      shouldShowGenericChatErrorNotice({ code: "X", displayAs: "inline" }),
    ).toBe(true);
  });
});
