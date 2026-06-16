import { type ReactNode, useState } from "react";
import { Link } from "react-router";

import { AppleLogo } from "@/components/icons/apple-logo";
import { GoogleLogo } from "@/components/icons/google-logo";
import { PersonalPageShell } from "@/domains/account/components/personal-page-shell";
import { RotatingWord } from "@/domains/account/components/rotating-word";
import {
  PROVIDER_ID,
  buildProviderCallbackUrl,
} from "@/domains/account/login-flow";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform, startAuthFlow } from "@/runtime/native-auth";
import { routes } from "@/utils/routes";

const HEADLINE_WORDS = [
  "Personal Intelligence",
  "Software Engineer",
  "Finance Ops",
  "Household Manager",
  "GTM Engineer",
  "Product Lead",
];

const EmailIcon = (
  <svg
    width={18}
    height={18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
  </svg>
);

interface ProviderButton {
  icon: ReactNode;
  label: string;
  providerHint?: string;
}

const BUTTONS: ProviderButton[] = [
  { icon: <GoogleLogo size={18} />, label: "Continue with Google", providerHint: "GoogleOAuth" },
  { icon: <AppleLogo size={18} />, label: "Continue with Apple", providerHint: "AppleOAuth" },
  { icon: EmailIcon, label: "Continue with Email" },
];

interface PersonalPageSignupScreenProps {
  returnTo: string | null;
}

/**
 * Branded sign-up screen: a brand-left / full-bleed-video-right layout with a
 * rotating headline and Google / Apple / Email buttons. Each button hands off
 * to the real WorkOS `startAuthFlow` (`intent: "signup"`); the post-OAuth
 * name/occupation step lives in `ProviderSignupPage`.
 */
export function PersonalPageSignupScreen({
  returnTo,
}: PersonalPageSignupScreenProps) {
  const [error, setError] = useState<string | null>(null);
  const callbackUrl = buildProviderCallbackUrl(returnTo, {
    authIntent: "signup",
  });

  const start = (providerHint?: string) => {
    setError(null);
    // On WEB, a direct provider hint (Apple/Google) goes straight to the social
    // connection and must NOT also send the signup `intent` — WorkOS hosted
    // AuthKit rejects a sign-up screen_hint combined with a direct provider
    // redirect (error.workos.com/sso); post-OAuth signup routing is driven by
    // `authIntent=signup` in `callbackUrl` instead. Native (Capacitor) and
    // Electron, however, pick the signup destination from `options.intent`, not
    // the callback URL, so they must send `intent` even alongside a provider
    // hint or the user lands in the login destination. Email (no hint) always
    // sends `intent` so AuthKit shows its hosted sign-up screen.
    const omitIntent = !!providerHint && !isNativePlatform() && !isElectron();
    startAuthFlow(PROVIDER_ID, callbackUrl, {
      returnTo,
      ...(providerHint ? { providerHint } : {}),
      ...(omitIntent ? {} : { intent: "signup" }),
    }).catch((err) => {
      console.error("[signup] auth flow failed:", err);
      setError("Something went wrong. Please try again.");
    });
  };

  return (
    <PersonalPageShell>
      <h1 className="signup__title">
        Meet your own
        <br />
        <RotatingWord words={HEADLINE_WORDS} />
      </h1>
      <p className="signup__subtitle">
        The most powerful assistant that can handle your work and life admin
        tasks.
      </p>

      <div className="signup__buttons">
        {BUTTONS.map((btn, i) => (
          <button
            key={btn.label}
            type="button"
            className="signup__btn"
            onClick={() => start(btn.providerHint)}
          >
            {i === 0 && <span className="signup__tag">Most used</span>}
            {btn.icon}
            {btn.label}
          </button>
        ))}
      </div>

      {error && <p className="signup__error">{error}</p>}

      <p className="signup__footer">
        Already have an account?{" "}
        <Link to={routes.account.login} className="signup__link">
          Sign in
        </Link>
      </p>

      <a className="signup__download" href="/downloads">
        <AppleLogo size={16} />
        Download for macOS
      </a>
    </PersonalPageShell>
  );
}
