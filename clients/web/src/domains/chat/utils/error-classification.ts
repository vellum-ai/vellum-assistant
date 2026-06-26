export interface ChatErrorLike {
  code?: string;
  errorCategory?: string;
  /**
   * When set to "modal" the error is rendered as a blocking dialog instead
   * of an inline banner. Suppress the generic inline Notice in that case.
   */
  displayAs?: "inline" | "modal";
}

export type ChatBillingBannerDecision = "managed_credits" | "provider_billing";

const PROVIDER_BILLING_CODE = "PROVIDER_BILLING";
const PROVIDER_NOT_CONFIGURED_CODE = "PROVIDER_NOT_CONFIGURED";
const MANAGED_KEY_INVALID_CODE = "MANAGED_KEY_INVALID";
const MANAGED_CREDITS_EXHAUSTED_CATEGORY = "credits_exhausted";
const PROVIDER_BILLING_CATEGORY = "provider_billing";

function isManagedCreditsExhausted(
  error: ChatErrorLike | null | undefined,
): boolean {
  if (!error?.errorCategory) {
    return error?.code === PROVIDER_BILLING_CODE;
  }

  return error.errorCategory.endsWith(MANAGED_CREDITS_EXHAUSTED_CATEGORY);
}

function isProviderBilling(
  error: ChatErrorLike | null | undefined,
): boolean {
  if (!error?.errorCategory) {
    return false;
  }

  return error.errorCategory.endsWith(PROVIDER_BILLING_CATEGORY);
}

export function getChatBillingBannerDecision(
  error: ChatErrorLike | null | undefined,
): ChatBillingBannerDecision | null {
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
