import { type ReactNode } from "react";
import { Link } from "react-router";

import { AppleLogo } from "@/components/icons/apple-logo";
import { GoogleLogo } from "@/components/icons/google-logo";
import { PersonalPageShell } from "@/domains/account/components/personal-page-shell";
import { RotatingWord } from "@/domains/account/components/rotating-word";
import {
  PROVIDER_ID,
  buildProviderCallbackUrl,
} from "@/domains/account/login-flow";
import { startAuthFlow } from "@/runtime/native-auth";
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
  /** Surfaces an auth-flow failure to the host page. */
  onError?: (message: string) => void;
}

/**
 * Personal-page activation sign-up screen, matching the cast prototype demo: a
 * brand-left / full-bleed-video-right layout with a rotating headline and
 * Google / Apple / Email buttons. Unlike the prototype's mock buttons, each
 * hands off to the real WorkOS `startAuthFlow` (`intent: "signup"`); the
 * post-OAuth name/occupation step lives in `ProviderSignupPage` (same flag).
 */
export function PersonalPageSignupScreen({
  returnTo,
  onError,
}: PersonalPageSignupScreenProps) {
  const callbackUrl = buildProviderCallbackUrl(returnTo, {
    authIntent: "signup",
  });

  const start = (providerHint?: string) => {
    startAuthFlow(PROVIDER_ID, callbackUrl, {
      intent: "signup",
      returnTo,
      ...(providerHint ? { providerHint } : {}),
    }).catch((err) => {
      console.error("[signup] auth flow failed:", err);
      onError?.("Something went wrong. Please try again.");
    });
  };

  return (
    <PersonalPageShell>
      <h1 className="cast-login__title">
        Meet your own
        <br />
        <RotatingWord words={HEADLINE_WORDS} />
      </h1>
      <p className="cast-login__subtitle">
        The most powerful assistant that can handle your work and life admin
        tasks.
      </p>

      <div className="cast-login__buttons">
        {BUTTONS.map((btn, i) => (
          <button
            key={btn.label}
            type="button"
            className="cast-login__btn"
            onClick={() => start(btn.providerHint)}
          >
            {i === 0 && <span className="cast-login__tag">Most used</span>}
            {btn.icon}
            {btn.label}
          </button>
        ))}
      </div>

      <p className="cast-login__footer">
        Already have an account?{" "}
        <Link to={routes.account.login} className="cast-login__link">
          Sign in
        </Link>
      </p>

      <a className="cast-login__download" href="/downloads">
        <AppleLogo size={16} />
        Download for macOS
      </a>
    </PersonalPageShell>
  );
}
