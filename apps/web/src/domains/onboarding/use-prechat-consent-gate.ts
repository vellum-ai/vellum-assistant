/**
 * Consent readiness gate for the pre-chat onboarding flow.
 *
 * Derives consent from localStorage reads (ToS + AI-data consent) and
 * redirects when auth or consent is missing. Returns a boolean the
 * caller uses to suppress rendering until ready.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router";

import { readAiDataConsent, readTosAccepted } from "@/domains/onboarding/prefs";
import { useIsNativePlatform } from "@/runtime/native-auth";
import {
  useIsAuthenticated,
  useIsSessionInitializing,
} from "@/stores/auth-store";
import { routes } from "@/utils/routes";

/**
 * Gate the pre-chat flow on auth + consent readiness.
 *
 * Side-effects: redirects to login when unauthenticated, to the privacy
 * screen when consent is missing (web only).
 *
 * @returns `true` when auth has settled, user is authenticated, and
 *   consent is satisfied (or native, which defers consent to the
 *   downstream privacy screen).
 */
export function usePreChatConsentGate(): boolean {
  const navigate = useNavigate();
  const isAuthenticated = useIsAuthenticated();
  const isAuthInitializing = useIsSessionInitializing();
  const isNative = useIsNativePlatform();

  // Consent is derived directly from localStorage — no React state needed.
  // These reads are synchronous and sub-millisecond; the values only change
  // on a different page (privacy screen), so the component remounts with
  // fresh values after consent is granted.
  const consentOk = readTosAccepted() && readAiDataConsent();

  // Redirect when auth or consent is missing.
  useEffect(() => {
    if (isAuthInitializing) return;
    if (!isAuthenticated) {
      void navigate(routes.account.login, { replace: true });
      return;
    }
    if (!consentOk && !isNative) {
      void navigate(routes.onboarding.privacy, { replace: true });
    }
  }, [isAuthInitializing, isAuthenticated, consentOk, isNative, navigate]);

  if (isAuthInitializing || !isAuthenticated) return false;
  return isNative || consentOk;
}
