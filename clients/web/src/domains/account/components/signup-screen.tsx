import { useMemo, useState } from "react";

import { AppleLogo } from "@/components/icons/apple-logo";
import { Trans, useTranslation } from "@/i18n";
import { SignupShell } from "@/domains/account/components/signup-shell";
import { RotatingWord } from "@/domains/account/components/rotating-word";
import {
  PROVIDER_ID,
  buildProviderCallbackUrl,
} from "@/domains/account/login-flow";
import { startAuthFlow } from "@/runtime/native-auth";

/**
 * Catalog keys for the rotating headline roles. The copy lives in the catalog;
 * this list only fixes the order they cycle in.
 */
const HEADLINE_ROLE_KEYS = [
  "signupScreen.headlineRoles.personalIntelligence",
  "signupScreen.headlineRoles.softwareEngineer",
  "signupScreen.headlineRoles.financeOps",
  "signupScreen.headlineRoles.householdManager",
  "signupScreen.headlineRoles.gtmEngineer",
  "signupScreen.headlineRoles.productLead",
] as const;

interface SignupScreenProps {
  returnTo: string | null;
}

/**
 * Branded sign-up screen: a brand-left / full-bleed-video-right layout with a
 * rotating headline and a single CTA that hands off to WorkOS AuthKit via
 * `startAuthFlow` (`intent: "signup"`); the post-OAuth name/occupation step
 * lives in `ProviderSignupPage`.
 */
export function SignupScreen({ returnTo }: SignupScreenProps) {
  const { t } = useTranslation("account");
  // Whole keys, not a built suffix: `t()` is typed against the English
  // catalog, so only a literal key is checked at compile time.
  const headlineWords = useMemo(
    () => HEADLINE_ROLE_KEYS.map((key) => t(key)),
    [t],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * Hand off to AuthKit, holding the screen's controls until the flow settles.
   * A native start resolves the flow's marketing attribution before the browser
   * auth surface opens, and a second start inside that gap replaces the first,
   * which the plugin rejects as a failure the user never caused.
   *
   * The controls come back however it settles. A flow that reached an account
   * is already navigating away, and a dismissed auth sheet resolves with the
   * screen still up, where these are the only controls on it.
   */
  const startFlow = (intent: "signup" | undefined, logLabel: string) => {
    setError(null);
    setPending(true);
    startAuthFlow(
      PROVIDER_ID,
      buildProviderCallbackUrl(returnTo, { authIntent: intent }),
      { returnTo, intent },
    )
      .catch((err) => {
        console.error(logLabel, err);
        setError(t("authErrors.genericFailure"));
      })
      .finally(() => {
        setPending(false);
      });
  };

  const start = () => {
    startFlow("signup", "[signup] auth flow failed:");
  };

  // "Sign in" goes straight to AuthKit (login) rather than routing through the
  // /account/login redirect page, which would flash an extra "Redirecting…".
  const signIn = () => {
    startFlow(undefined, "[signup] sign-in flow failed:");
  };

  return (
    <SignupShell>
      <h1 className="signup__title">
        {t("signupScreen.headlineLead")}
        <br />
        <RotatingWord words={headlineWords} />
      </h1>
      <p className="signup__subtitle">{t("signupScreen.subtitle")}</p>

      <div className="signup__buttons">
        <button
          type="button"
          className="signup__btn"
          onClick={start}
          disabled={pending}
        >
          {t("signupScreen.continue")}
        </button>
      </div>

      {error && <p className="signup__error">{error}</p>}

      <p className="signup__footer">
        <Trans
          i18nKey="signupScreen.haveAccountPrompt"
          ns="account"
          components={{
            signIn: (
              <button
                type="button"
                className="signup__link"
                onClick={signIn}
                disabled={pending}
              />
            ),
          }}
        />
      </p>

      <a className="signup__download" href="/downloads">
        <AppleLogo size={16} />
        {t("signupScreen.downloadMac")}
      </a>
    </SignupShell>
  );
}
