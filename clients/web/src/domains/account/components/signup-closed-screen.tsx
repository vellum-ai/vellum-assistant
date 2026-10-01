import { Link } from "react-router";

import { Trans, useTranslation } from "@/i18n";
import { SignupShell } from "@/domains/account/components/signup-shell";
import { routes } from "@/utils/routes";

/**
 * Shown on `/account/signup` while the platform is not accepting new
 * accounts. Existing users keep their way in through the sign-in link.
 */
export function SignupClosedScreen() {
  const { t } = useTranslation("account");

  return (
    <SignupShell>
      <h1 className="signup__title">{t("signupClosedScreen.title")}</h1>
      <p className="signup__subtitle">{t("signupClosedScreen.message")}</p>

      <p className="signup__footer">
        <Trans
          i18nKey="signupClosedScreen.haveAccountPrompt"
          ns="account"
          components={{
            signIn: <Link className="signup__link" to={routes.account.login} />,
          }}
        />
      </p>
    </SignupShell>
  );
}
