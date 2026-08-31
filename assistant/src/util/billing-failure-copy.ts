/**
 * User-facing copy for classified billing failures.
 *
 * Shared by the turn classifier and the activity.failed notification
 * fallback so a schedule that dies on credits, a daily limit, or a
 * provider wallet says the same thing whether the turn carried
 * `failureSummary` or only a `failureCode` / `errorCategory`. Category
 * matching is suffix-based so namespaced values such as
 * `billing.credits_exhausted` classify too.
 */

export const CREDITS_EXHAUSTED_USER_MESSAGE =
  "You're out of credits. Add credits in Settings → Billing to continue.";

export const PROVIDER_BILLING_USER_MESSAGE =
  "Your API provider account or key needs credits. Add funds with the provider or update the key in Settings → Models & Services.";

export const DAILY_LIMIT_USER_MESSAGE =
  "You've hit your daily credit limit. Raise the limit in Billing settings to keep going today.";

const PROVIDER_BILLING_CODE = "PROVIDER_BILLING";
const CREDITS_EXHAUSTED_CATEGORY = "credits_exhausted";
const PROVIDER_BILLING_CATEGORY = "provider_billing";
const DAILY_LIMIT_CATEGORY = "daily_limit_reached";

function categoryOf(payload: Record<string, unknown>): string {
  return typeof payload.errorCategory === "string" ? payload.errorCategory : "";
}

function codeOf(payload: Record<string, unknown>): string {
  return typeof payload.failureCode === "string" ? payload.failureCode : "";
}

/**
 * Billing-specific fallback body, or null when the payload is not a
 * classified billing failure.
 *
 * Precedence matches the chat composer: daily limit, then provider-wallet
 * billing, then managed-credits exhaustion. A bare `PROVIDER_BILLING` code
 * with no category is treated as managed-credits exhaustion, the same way
 * persisted provider-error rows classify in the web client.
 */
export function describeBillingFailureCopy(
  payload: Record<string, unknown>,
): string | null {
  const category = categoryOf(payload);
  if (category.endsWith(DAILY_LIMIT_CATEGORY)) {
    return DAILY_LIMIT_USER_MESSAGE;
  }
  if (category.endsWith(PROVIDER_BILLING_CATEGORY)) {
    return PROVIDER_BILLING_USER_MESSAGE;
  }
  if (
    category.endsWith(CREDITS_EXHAUSTED_CATEGORY) ||
    codeOf(payload) === PROVIDER_BILLING_CODE
  ) {
    return CREDITS_EXHAUSTED_USER_MESSAGE;
  }
  return null;
}
