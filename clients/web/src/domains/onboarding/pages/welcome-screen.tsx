import { useNavigate } from "react-router";

import { AvatarWave } from "@/domains/onboarding/components/avatar-wave";
import { CreatureFooter } from "@/domains/onboarding/components/creature-footer";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { hasAssistants } from "@/lib/local-mode";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

export function WelcomeScreen() {
  const navigate = useNavigate();
  const { loading, error, login, cancel } = useOnboardingLogin();
  // `useIsMobile` tracks the same 768px boundary as the `md:` variants below,
  // so the wave's canvas and its animation loop never mount on the narrow
  // layout that hides it.
  const isMobile = useIsMobile();

  const handleContinueWithoutAccount = () => {
    if (loading) {
      cancel();
    }
    if (hasAssistants()) {
      void navigate(routes.selectAssistant);
    } else {
      void navigate(routes.onboarding.hosting);
    }
  };

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div className="flex min-h-full w-full flex-col md:flex-row">
        <div className="flex min-h-screen w-full flex-col items-center justify-center px-6 pb-40 text-[var(--content-default)] md:min-h-full md:flex-1 md:pb-0">
          {/*
            Only the tablet split is tight enough to wrap the heading: the
            column is widest on the single-column layout, and wide again once
            the wave settles at half width.
          */}
          <h1
            className="text-5xl font-normal tracking-tight md:text-4xl lg:text-5xl"
            style={{
              fontFamily: "var(--font-serif)",
              animation: "fadeInUp 0.5s ease-out 0.1s both",
            }}
          >
            Welcome to Vellum
          </h1>
          <p
            className="mt-3 text-body-medium-lighter text-[var(--content-tertiary)]"
            style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
          >
            Your own personal intelligence is just a step away.
          </p>

          {error && (
            <p className="mt-4 text-body-small-default text-[var(--system-negative-strong)]">
              {error}
            </p>
          )}

          <div
            className="mt-15 flex w-full max-w-sm flex-col gap-3"
            style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
          >
            <Button
              variant="primary"
              size="regular"
              fullWidth
              className="h-11 text-base"
              onClick={loading ? cancel : () => void login()}
            >
              {loading ? "Cancel" : "Log In"}
            </Button>
            <Button
              variant="ghost"
              size="regular"
              fullWidth
              className="h-11 text-base"
              onClick={handleContinueWithoutAccount}
            >
              Continue without account
            </Button>
          </div>
        </div>

        {!isMobile && (
          <div className="relative hidden md:block md:w-[46%] lg:w-1/2">
            <AvatarWave className="absolute inset-0" />
          </div>
        )}
      </div>

      {/*
        The wave is the decoration on the wide layout, so the static creature
        art is kept for the narrow one only, where the wave never mounts.
      */}
      <CreatureFooter className="md:hidden" />
    </OnboardingLayout>
  );
}
