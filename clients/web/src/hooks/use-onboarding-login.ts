import { useRef, useState } from "react";
import { useLocation } from "react-router";

import { t } from "@/i18n";
import {
  PROVIDER_ID,
  buildProviderCallbackUrl,
} from "@/domains/account/login-flow";
import {
  nativeAuthErrorDetail,
  AUTH_ERROR_COMMUNITY_LINK,
  nativeAuthErrorKey,
} from "@/domains/account/native-auth-error";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { captureError } from "@/lib/sentry/capture-error";
import { resolveLoginReturnTo } from "@/lib/navigation/navigation-resolver";
import { isElectron } from "@/runtime/is-electron";
import { startAuthFlow } from "@/runtime/native-auth";

/**
 * Hand off to the OAuth provider and keep the calling screen's button honest
 * while the flow is open — loading, cancellable, and told what went wrong.
 *
 * `returnToOverride` distinguishes "not supplied" from "supplied as nothing":
 * omit it and the destination is derived from the current route, which is what
 * the onboarding funnel wants; pass `null` (as `/account/login` does for a
 * bare visit) and the flow carries no destination at all, leaving the choice
 * to the post-auth fallback. Deriving in that case would send the visitor back
 * to the login screen they just left.
 */
export function useOnboardingLogin(
  returnToOverride?: string | null,
  options: {
    /** Sentry `context` tag, so each entry point's failures stay separable. */
    errorContext?: string;
  } = {},
) {
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flowIdRef = useRef(0);

  const login = async () => {
    const returnTo =
      returnToOverride !== undefined
        ? returnToOverride
        : resolveLoginReturnTo(
            buildNavigationState({ sessionSettled: true, isAuthenticated: true }),
            location.pathname,
          );

    const flowId = ++flowIdRef.current;
    setError(null);
    setLoading(true);
    try {
      const callbackUrl = buildProviderCallbackUrl(returnTo);
      await startAuthFlow(PROVIDER_ID, callbackUrl, { returnTo });
    } catch (err) {
      if (flowId !== flowIdRef.current) {
        return;
      }
      captureError(err, {
        context: options.errorContext ?? "onboarding_login",
        tags: { authError: nativeAuthErrorDetail(err) ?? "unclassified" },
      });
      setError(
        t(`account:${nativeAuthErrorKey(err)}`, {
          community: AUTH_ERROR_COMMUNITY_LINK,
        }),
      );
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
