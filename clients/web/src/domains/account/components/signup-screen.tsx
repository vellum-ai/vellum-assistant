import { useState } from "react";

import { AppleLogo } from "@/components/icons/apple-logo";
import { SignupShell } from "@/domains/account/components/signup-shell";
import { RotatingWord } from "@/domains/account/components/rotating-word";
import {
  PROVIDER_ID,
  buildProviderCallbackUrl,
} from "@/domains/account/login-flow";
import { startAuthFlow } from "@/runtime/native-auth";

const HEADLINE_WORDS = [
  "Personal Intelligence",
  "Software Engineer",
  "Finance Ops",
  "Household Manager",
  "GTM Engineer",
  "Product Lead",
];

interface SignupScreenProps {
  returnTo: string | null;
}

/**
 * Branded sign-up screen: a brand-left / full-bleed-video-right layout with a
 * rotating headline and a single CTA that hands off to WorkOS AuthKit via
 * `startAuthFlow` (`intent: "signup"`); the post-OAuth name/occupation step
 * lives in `ProviderSignupPage`.
 */
export function SignupScreen({
  returnTo,
}: SignupScreenProps) {
  const [error, setError] = useState<string | null>(null);
  const callbackUrl = buildProviderCallbackUrl(returnTo, {
    authIntent: "signup",
  });

  const start = () => {
    setError(null);
    startAuthFlow(PROVIDER_ID, callbackUrl, {
      returnTo,
      intent: "signup",
    }).catch((err) => {
      console.error("[signup] auth flow failed:", err);
      setError("Something went wrong. Please try again.");
    });
  };

  // "Sign in" goes straight to AuthKit (login) rather than routing through the
  // /account/login redirect page, which would flash an extra "Redirecting…".
  const signIn = () => {
    setError(null);
    startAuthFlow(PROVIDER_ID, buildProviderCallbackUrl(returnTo), {
      returnTo,
    }).catch((err) => {
      console.error("[signup] sign-in flow failed:", err);
      setError("Something went wrong. Please try again.");
    });
  };

  return (
    <SignupShell>
      <h1 className="signup__title">
        Meet your new
        <br />
        <RotatingWord words={HEADLINE_WORDS} />
      </h1>
      <p className="signup__subtitle">
        The most powerful assistant that can handle your work and life admin
        tasks.
      </p>

      <div className="signup__buttons">
        <button type="button" className="signup__btn" onClick={start}>
          Continue
        </button>
      </div>

      {error && <p className="signup__error">{error}</p>}

      <p className="signup__footer">
        Already have an account?{" "}
        <button type="button" className="signup__link" onClick={signIn}>
          Sign in
        </button>
      </p>

      <a className="signup__download" href="/downloads">
        <AppleLogo size={16} />
        Download for macOS
      </a>
    </SignupShell>
  );
}
