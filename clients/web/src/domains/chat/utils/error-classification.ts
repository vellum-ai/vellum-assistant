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

/** Whether a classified error category denotes managed-credits exhaustion
 *  (suffix match, so namespaced categories like `billing.credits_exhausted`
 *  classify too). */
function isCreditsExhaustedCategory(category: string | undefined): boolean {
  return category?.endsWith(MANAGED_CREDITS_EXHAUSTED_CATEGORY) ?? false;
}

/**
 * Whether a provider-error marker denotes managed-credits exhaustion. The
 * category decides when present; a bare `PROVIDER_BILLING` code with no
 * category also classifies (the daemon builds `providerError` with each field
 * conditional on being a string, so persisted rows can carry a code alone).
 * Shared by the live composer-banner classification and the transcript's
 * persisted-row substitution so the two surfaces never disagree.
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
  return isCreditsExhaustedCategory(providerError.category);
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
