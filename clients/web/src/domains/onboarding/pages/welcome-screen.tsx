import { useNavigate } from "react-router";

import { AuthWelcomeScreen } from "@/components/auth-welcome-screen";
import { SETUP_NAVIGATE } from "@/domains/onboarding/onboarding-navigation";
import { hasAssistants } from "@/lib/local-mode";
import { useTranslation } from "@/i18n";
import { routes } from "@/utils/routes";

/**
 * `/assistant/welcome` — the local client's front door. Shares its screen with
 * `/account/login`; the account this build doesn't require is what makes the
 * difference, so the second button walks past the login entirely.
 */
export function WelcomeScreen() {
  const { t } = useTranslation("onboarding");
  const navigate = useNavigate();

  const handleContinueWithoutAccount = () => {
    // `replace`, like every other step of the setup flow: the funnel occupies a
    // single history entry so a Back press can never re-enter it (see
    // `SETUP_NAVIGATE` in `onboarding-navigation.ts`).
    if (hasAssistants()) {
      void navigate(routes.selectAssistant, SETUP_NAVIGATE);
    } else {
      void navigate(routes.onboarding.hosting, SETUP_NAVIGATE);
    }
  };

  return (
    <AuthWelcomeScreen
      secondary={{
        label: t("welcome.continueWithoutAccount"),
        onSelect: handleContinueWithoutAccount,
      }}
    />
  );
}
