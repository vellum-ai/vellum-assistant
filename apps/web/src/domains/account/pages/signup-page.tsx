import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

import { PROVIDER_CALLBACK_URL, PROVIDER_ID } from "@/lib/account/login-flow.js";
import { startAuthFlow } from "@/runtime/native-auth.js";

/**
 * Signup redirect page. Immediately triggers the auth flow with
 * `intent: "signup"` so WorkOS opens the sign-up screen.
 *
 * `startAuthFlow` routes through the native `ASWebAuthenticationSession`
 * path on Capacitor iOS (the signup link on `/account/login` is
 * reachable inside the shell, so this page must not hit the embedded
 * WKWebView OAuth flow that Google blocks).
 */
export function SignupPage() {
  const didRedirect = useRef(false);
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (didRedirect.current) return;
    didRedirect.current = true;

    const returnTo = searchParams.get("returnTo");
    const callbackUrl = returnTo
      ? `${PROVIDER_CALLBACK_URL}?returnTo=${encodeURIComponent(returnTo)}`
      : PROVIDER_CALLBACK_URL;

    void startAuthFlow(PROVIDER_ID, callbackUrl, {
      intent: "signup",
      returnTo,
    });
  }, [searchParams]);

  return null;
}
