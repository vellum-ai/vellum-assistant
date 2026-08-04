export interface ChatErrorLike {
  code?: string;
  errorCategory?: string;
  /**
   * When set to "modal" the error is rendered as a blocking dialog instead
   * of an inline banner. Suppress the generic inline Notice in that case.
   */
  displayAs?: "inline" | "modal";
}

export type ChatBillingBannerDecision =
  "managed_credits" | "provider_billing" | "daily_limit";

const PROVIDER_BILLING_CODE = "PROVIDER_BILLING";
const PROVIDER_NOT_CONFIGURED_CODE = "PROVIDER_NOT_CONFIGURED";
const MANAGED_KEY_INVALID_CODE = "MANAGED_KEY_INVALID";
const MANAGED_CREDITS_EXHAUSTED_CATEGORY = "credits_exhausted";
const PROVIDER_BILLING_CATEGORY = "provider_billing";
const DAILY_LIMIT_REACHED_CATEGORY = "daily_limit_reached";

/**
 * Whether a provider-error marker denotes managed-credits exhaustion. The
 * category decides when present (suffix match, so namespaced categories like
 * `billing.credits_exhausted` classify too); a bare `PROVIDER_BILLING` code
 * with no category also classifies (the daemon builds `providerError` with
 * each field conditional on being a string, so persisted rows can carry a
 * code alone). Shared by the live error classification
 * (`getChatBillingBannerDecision`) and the transcript's persisted-row
 * substitution so the two never disagree.
 */
export function isCreditsExhaustedProviderError(
  providerError: { code?: string; category?: string } | null | undefined,
): boolean {
  if (!providerError) {
    return false;
  }
  if (!providerError.category) {
    return providerError.code === PROVIDER_BILLING_CODE;
  }
  return providerError.category.endsWith(MANAGED_CREDITS_EXHAUSTED_CATEGORY);
}

function isManagedCreditsExhausted(
  error: ChatErrorLike | null | undefined,
): boolean {
  if (!error) {
    return false;
  }
  return isCreditsExhaustedProviderError({
    code: error.code,
    category: error.errorCategory,
  });
}

function isProviderBilling(error: ChatErrorLike | null | undefined): boolean {
  if (!error?.errorCategory) {
    return false;
  }

  return error.errorCategory.endsWith(PROVIDER_BILLING_CATEGORY);
}

function isDailyLimitReached(error: ChatErrorLike | null | undefined): boolean {
  if (!error?.errorCategory) {
    return false;
  }

  return error.errorCategory.endsWith(DAILY_LIMIT_REACHED_CATEGORY);
}

/**
 * Classifies a chat error into a billing-surface decision. `managed_credits`
 * renders no composer banner (the in-transcript credits upsell card is the
 * surface for an exhausted balance) but still suppresses the generic error
 * notice via `shouldSuppressGenericChatErrorNotice`.
 */
export function getChatBillingBannerDecision(
  error: ChatErrorLike | null | undefined,
): ChatBillingBannerDecision | null {
  if (isDailyLimitReached(error)) {
    return "daily_limit";
  }

  if (isManagedCreditsExhausted(error)) {
    return "managed_credits";
  }

  if (isProviderBilling(error)) {
    return "provider_billing";
  }

  return null;
}

export type ComposerBillingBanner =
  "daily_limit" | "provider_billing" | "low_balance";

/**
 * Which banner the composer's billing slot renders. Error-driven banners take
 * precedence over the proactive low-balance warning. `managed_credits` maps
 * to no banner: the in-transcript credits upsell card owns that state, while
 * the classified error keeps the generic notice suppressed.
 *
 * The low-balance warning renders only when no error-driven decision is
 * active, the server reports `low_balance_warning` (`isLowBalance`), and the
 * user has not dismissed the banner this session. The exhausted-credits
 * surfaces never overlap with it: the server keeps `low_balance_warning`
 * false while the balance is exhausted, and it is false for auto-top-up orgs
 * and whenever the billing query is gated off.
 */
export function resolveComposerBillingBanner(args: {
  billingBannerDecision: ChatBillingBannerDecision | null;
  isLowBalance: boolean;
  dismissed: boolean;
}): ComposerBillingBanner | null {
  if (args.billingBannerDecision === "daily_limit") {
    return "daily_limit";
  }
  if (args.billingBannerDecision === "provider_billing") {
    return "provider_billing";
  }
  if (args.billingBannerDecision === "managed_credits") {
    return null;
  }
  return args.isLowBalance && !args.dismissed ? "low_balance" : null;
}

export function shouldSuppressGenericChatErrorNotice(
  error: ChatErrorLike | null | undefined,
): boolean {
  return (
    getChatBillingBannerDecision(error) !== null ||
    error?.code === PROVIDER_NOT_CONFIGURED_CODE ||
    error?.displayAs === "modal"
  );
}

export function shouldShowGenericChatErrorNotice(
  error: ChatErrorLike | null | undefined,
): boolean {
  return !!error && !shouldSuppressGenericChatErrorNotice(error);
}

export function isManagedCredentialChatError(
  error: ChatErrorLike | null | undefined,
): boolean {
  return error?.code === MANAGED_KEY_INVALID_CODE;
}
