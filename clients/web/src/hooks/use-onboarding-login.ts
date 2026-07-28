import { useRef, useState } from "react";
import { useLocation } from "react-router";

import { PROVIDER_ID } from "@/domains/account/login-flow";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { resolveLoginReturnTo } from "@/lib/navigation/navigation-resolver";
import { isElectron } from "@/runtime/is-electron";
import { startAuthFlow } from "@/runtime/native-auth";
import { routes } from "@/utils/routes";

export function useOnboardingLogin(returnToOverride?: string) {
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
