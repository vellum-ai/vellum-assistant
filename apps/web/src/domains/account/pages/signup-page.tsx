import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { PersonalPageSignupScreen } from "@/domains/account/components/personal-page-signup-screen";
import {
  PROVIDER_ID,
  buildProviderCallbackUrl,
} from "@/domains/account/login-flow";
import { useActivationFlowArm } from "@/hooks/use-client-feature-flag-sync";
import { startAuthFlow } from "@/runtime/native-auth";

/**
 * Signup entry. By default (control / variant-a) it triggers the auth flow with
 * `intent: "signup"` so WorkOS opens the sign-up screen. When the
 * `experiment-activation-flow-2026-06-03` flag serves `personal-page`, it
 * renders the branded video sign-up screen instead (its buttons hand off to the
 * same WorkOS flow on click; the post-OAuth name/occupation step lives in
 * `ProviderSignupPage`, gated by the same flag).
 *
 * The redirect is held until the flag value has `settled` (server fetch
 * resolved/errored) — otherwise a first-time anonymous visitor would be
 * redirected on the registry default (`control`) before their targeted
 * `personal-page` value arrives, and never see the new screen.
 *
 * `startAuthFlow` routes through the native `ASWebAuthenticationSession` path on
 * Capacitor iOS (the signup link on `/account/login` is reachable inside the
 * shell, so this page must not hit the embedded WKWebView OAuth flow that
 * Google blocks).
 */
export function SignupPage() {
  const [searchParams] = useSearchParams();
  const { arm, settled } = useActivationFlowArm();
  const personalPage = arm === "personal-page";

  const didRedirect = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const returnTo = searchParams.get("returnTo");

  useEffect(() => {
    // The personal-page variant renders an interactive screen; it must NOT
    // auto-redirect — the user picks a provider there.
    if (personalPage) return;
    // Wait for the flag to resolve before redirecting, so a targeted anonymous
    // visitor isn't bounced to WorkOS on the default arm before their value loads.
    if (!settled) return;
    if (didRedirect.current) return;
    didRedirect.current = true;

    const callbackUrl = buildProviderCallbackUrl(returnTo, {
      authIntent: "signup",
    });

    startAuthFlow(PROVIDER_ID, callbackUrl, {
      intent: "signup",
      returnTo,
    }).catch((err) => {
      console.error("[signup] auth flow failed:", err);
      setError("Something went wrong. Please try again.");
    });
  }, [personalPage, settled, returnTo]);

  if (personalPage) {
    return <PersonalPageSignupScreen returnTo={returnTo} onError={setError} />;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-[var(--system-negative-strong)]">{error}</p>
      </div>
    );
  }

  // Blank while the flag resolves / the control redirect kicks off.
  return null;
}
