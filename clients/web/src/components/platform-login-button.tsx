import { LogIn } from "lucide-react";
import { useLocation } from "react-router";

import { Button } from "@vellumai/design-library/components/button";

import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { useTranslation } from "@/i18n";

type ButtonProps = Parameters<typeof Button>[0];

interface PlatformLoginButtonProps {
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
}

/**
 * The "Log In" affordance for a surface `usePlatformGate()` reports as
 * `"disabled"`: meaningful, but without a platform session. Starts the shared
 * `useOnboardingLogin` flow and turns into "Cancel" while it is open, so the
 * prompt is never a dead end and never a stuck spinner.
 *
 * Returns to the full current URL (including query and hash) after login so
 * params the surface depends on survive the auth round-trip;
 * `useOnboardingLogin` otherwise derives the return target from `pathname`
 * alone.
 */
export function PlatformLoginButton({
  variant = "ghost",
  size,
}: PlatformLoginButtonProps) {
  const { t } = useTranslation();
  const { pathname, search, hash } = useLocation();
  const { loading, login, cancel } = useOnboardingLogin(
    `${pathname}${search}${hash}`,
  );
  return (
    <Button
      variant={variant}
      size={size}
      leftIcon={loading ? undefined : <LogIn className="h-4 w-4" />}
      onClick={loading ? cancel : () => void login()}
    >
      {loading
        ? t("platformLoginNotice.cancel")
        : t("platformLoginNotice.logIn")}
    </Button>
  );
}
