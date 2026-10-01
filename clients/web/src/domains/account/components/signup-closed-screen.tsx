import { Link, useLocation } from "react-router";

import { Trans, useTranslation } from "@/i18n";
import { SignupShell } from "@/domains/account/components/signup-shell";
import { withPreservedAttribution } from "@/domains/account/social-auth";
import { routes } from "@/utils/routes";

interface SignupClosedScreenProps {
  returnTo: string | null;
}

/**
 * Shown on `/account/signup` while the platform is not accepting new
 * accounts. Existing users keep their way in through the sign-in link, which
 * carries the sanitized `returnTo` and the URL-borne attribution params, so
 * signing in still lands where the visit was headed and stays attributed.
 */
export function SignupClosedScreen({ returnTo }: SignupClosedScreenProps) {
  const { t } = useTranslation("account");
  const { search } = useLocation();
  const loginUrl = withPreservedAttribution(
    returnTo
      ? `${routes.account.login}?returnTo=${encodeURIComponent(returnTo)}`
      : routes.account.login,
    search,
  );

  return (
    <SignupShell>
      <h1 className="signup__title">{t("signupClosedScreen.title")}</h1>
      <p className="signup__subtitle">{t("signupClosedScreen.message")}</p>

      <p className="signup__footer">
        <Trans
          i18nKey="signupClosedScreen.haveAccountPrompt"
          ns="account"
          components={{
            signIn: <Link className="signup__link" to={loginUrl} />,
          }}
        />
      </p>
    </SignupShell>
  );
}
