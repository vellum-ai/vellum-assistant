/**
 * Consent readiness gate for the pre-chat onboarding flow.
 *
 * Auth is already enforced by `authMiddleware` on the `/assistant` route
 * tree, so this hook only handles consent: it reads ToS + AI-data consent
 * from localStorage and redirects to the privacy screen when missing
 * (web only — native defers consent to the downstream privacy screen).
 */
import { useEffect } from "react";
import { useNavigate } from "react-router";

import { readAiDataConsent, readTosAccepted } from "@/domains/onboarding/prefs";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { routes } from "@/utils/routes";

/**
 * Gate the pre-chat flow on consent readiness.
 *
 * Auth is guaranteed by route middleware — this hook only checks consent.
 * On web, redirects to the privacy screen when consent is missing.
 *
 * @returns `true` when the flow may render (consent satisfied or native).
 */
export function usePreChatConsentGate(): boolean {
  const navigate = useNavigate();
  const isNative = useIsNativePlatform();

  const consentOk = readTosAccepted() && readAiDataConsent();

  useEffect(() => {
    if (!consentOk && !isNative) {
      void navigate(routes.onboarding.privacy, { replace: true });
    }
  }, [consentOk, isNative, navigate]);

  return isNative || consentOk;
}
