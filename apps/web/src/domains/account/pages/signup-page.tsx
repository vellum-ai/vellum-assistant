import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { PROVIDER_CALLBACK_URL, PROVIDER_ID } from "@/domains/account/login-flow";
import { startAuthFlow } from "@/runtime/native-auth";

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (didRedirect.current) return;
    didRedirect.current = true;

    const returnTo = searchParams.get("returnTo");
    const callbackUrl = returnTo
      ? `${PROVIDER_CALLBACK_URL}?returnTo=${encodeURIComponent(returnTo)}`
      : PROVIDER_CALLBACK_URL;

    startAuthFlow(PROVIDER_ID, callbackUrl, {
      intent: "signup",
      returnTo,
    }).catch((err) => {
      console.error("[signup] auth flow failed:", err);
      setError("Something went wrong. Please try again.");
    });
  }, [searchParams]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-[var(--system-negative-strong)]">{error}</p>
      </div>
    );
  }

  return null;
}
