import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { PROVIDER_ID } from "@/domains/account/login-flow";
import { isPlatformLocal } from "@/lib/auth/loopback-auth";
import { isLocalMode } from "@/lib/local-mode";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { resolveLoginReturnTo } from "@/lib/navigation/navigation-resolver";
import { isElectron } from "@/runtime/is-electron";
import { startAuthFlow } from "@/runtime/native-auth";
import { routes } from "@/utils/routes";

export function useOnboardingLogin(returnToOverride?: string) {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flowIdRef = useRef(0);

  const login = async () => {
    const returnTo =
      returnToOverride ??
      resolveLoginReturnTo(
        buildNavigationState({ sessionSettled: true, isAuthenticated: true }),
        location.pathname,
      );

    if (isLocalMode() && isPlatformLocal()) {
      void navigate(
        `${routes.account.login}?returnTo=${encodeURIComponent(returnTo)}`,
      );
      return;
    }
    const flowId = ++flowIdRef.current;
    setError(null);
    setLoading(true);
    try {
      const callbackUrl = `${routes.account.providerCallback}?returnTo=${encodeURIComponent(returnTo)}`;
      await startAuthFlow(PROVIDER_ID, callbackUrl, { returnTo });
    } catch {
      if (flowId !== flowIdRef.current) return;
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  const cancel = () => {
    flowIdRef.current++;
    setLoading(false);
    setError(null);
    if (isElectron()) {
      void window.vellum?.auth?.cancelOAuth();
    }
  };

  return { loading, error, login, cancel };
}
