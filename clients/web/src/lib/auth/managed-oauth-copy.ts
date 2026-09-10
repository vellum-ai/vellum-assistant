import { t } from "@/i18n";

import type { ManagedOAuthError } from "@/lib/auth/managed-oauth";

/**
 * The user-facing sentence for a failed managed-OAuth connect.
 *
 * The connect flow reports a typed reason and leaves copy to its callers. The
 * chat card, the settings modal and onboarding all render through here so the
 * three of them cannot drift apart or leave a non-English user on English.
 */
export function managedOAuthErrorMessage(
  error: ManagedOAuthError,
  providerLabel: string,
): string {
  switch (error.reason) {
    case "popup-blocked":
      return t("useOauthConnect.popupBlocked");
    case "authorization-failed":
      return error.code
        ? t("useOauthConnect.authorizationError", {
            name: providerLabel,
            code: error.code,
          })
        : t("useOauthConnect.authorizationFailed", { name: providerLabel });
    case "start-failed":
      // The reason ("Sign in to Vellum to register this local assistant") is
      // what makes this actionable, but it is raw error text rather than
      // catalog copy, so it goes inside a localized frame as data.
      return error.detail
        ? t("useOauthConnect.startFailedWithReason", {
            name: providerLabel,
            reason: error.detail,
          })
        : t("useOauthConnect.startFailed", { name: providerLabel });
  }
}
