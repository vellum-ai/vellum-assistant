import { t } from "@/i18n";

import type { ManagedOAuthConnectResult } from "@/lib/auth/managed-oauth";

type ManagedOAuthError = Extract<
  ManagedOAuthConnectResult,
  { status: "error" }
>;

/**
 * The user-facing sentence for a failed managed-OAuth connect.
 *
 * `connectManagedOAuthProvider` serves the chat surface, the settings modal and
 * onboarding, so it reports a typed `reason` and leaves copy to its callers.
 * Its own `message` is diagnostic English and must not reach a user. Every
 * entry point goes through here so the three of them cannot drift apart or
 * quietly regress non-English users to English.
 */
export function managedOAuthErrorMessage(
  result: ManagedOAuthError,
  providerLabel: string,
): string {
  switch (result.reason) {
    case "popup-blocked":
      return t("useOauthConnect.popupBlocked");
    case "authorization-failed":
      return result.code
        ? t("useOauthConnect.authorizationError", {
            name: providerLabel,
            code: result.code,
          })
        : t("useOauthConnect.authorizationFailed", { name: providerLabel });
    case "connection-not-found":
      return t("useOauthConnect.connectionNotFound", { name: providerLabel });
    case "scope-conflict":
      return t("useOauthConnect.scopeConflict", { name: providerLabel });
    case "start-failed":
      // The reason ("Sign in to Vellum to register this local assistant") is
      // what makes this actionable, but it is raw error text rather than
      // catalog copy, so it goes inside a localized frame as data instead of
      // becoming the sentence itself.
      return result.detail
        ? t("useOauthConnect.startFailedWithReason", {
            name: providerLabel,
            reason: result.detail,
          })
        : t("useOauthConnect.startFailed", { name: providerLabel });
  }
}
