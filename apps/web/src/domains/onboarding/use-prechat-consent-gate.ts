/**
 * Consent readiness gate for the pre-chat onboarding flow.
 *
 * Snapshots the user's ToS + AI-data consent status when auth settles,
 * re-checks when the active user changes (logout → login), and
 * navigates away when consent is missing (web only — native handles
 * consent in the downstream privacy screen). Returns a boolean the
 * caller uses to suppress rendering until consent is resolved.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { readAiDataConsent, readTosAccepted } from "@/domains/onboarding/prefs";
import { useIsNativePlatform } from "@/runtime/native-auth";
import {
  useAuthStore,
  useIsAuthenticated,
  useIsSessionInitializing,
} from "@/stores/auth-store";
import { routes } from "@/utils/routes";

type ConsentDecision = "pending" | "ok" | "missing";

interface ConsentSnapshot {
  userId: string | null;
  decision: ConsentDecision;
}

/**
 * Gate the pre-chat flow on auth + consent readiness.
 *
 * Side-effects: redirects to login when unauthenticated, to the privacy
 * screen when consent is missing (web only).
 *
 * @returns `true` when consent checks have settled and the flow may render.
 */
export function usePreChatConsentGate(): boolean {
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const userId = user?.id ?? null;
  const isAuthenticated = useIsAuthenticated();
  const isAuthInitializing = useIsSessionInitializing();
  const isNative = useIsNativePlatform();

  const [consent, setConsent] = useState<ConsentSnapshot>(() => {
    if (isAuthInitializing || !isAuthenticated) {
      return { userId, decision: "pending" };
    }
    return {
      userId,
      decision: readTosAccepted() && readAiDataConsent() ? "ok" : "missing",
    };
  });

  // Re-check consent when the active user changes or auth settles.
  useEffect(() => {
    if (isAuthInitializing || !isAuthenticated) return;
    if (consent.userId === userId && consent.decision !== "pending") return;
    setConsent({
      userId,
      decision: readTosAccepted() && readAiDataConsent() ? "ok" : "missing",
    });
  }, [consent, isAuthInitializing, isAuthenticated, userId]);

  // Redirect when auth or consent is missing.
  useEffect(() => {
    if (isAuthInitializing) return;
    if (!isAuthenticated) {
      void navigate(routes.account.login, { replace: true });
      return;
    }
    if (consent.decision === "missing" && !isNative) {
      void navigate(routes.onboarding.privacy, { replace: true });
    }
  }, [consent.decision, isAuthInitializing, isAuthenticated, isNative, navigate]);

  return isNative || consent.decision === "ok";
}
