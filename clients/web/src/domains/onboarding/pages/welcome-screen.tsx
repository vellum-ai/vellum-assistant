import { useNavigate } from "react-router";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { SETUP_NAVIGATE } from "@/domains/onboarding/onboarding-navigation";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { hasAssistants } from "@/lib/local-mode";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

export function WelcomeScreen() {
  const navigate = useNavigate();
  const { loading, error, login, cancel } = useOnboardingLogin();

  const handleContinueWithoutAccount = () => {
    if (loading) {
      cancel();
    }
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
    <OnboardingLayout showAvatarWave animateAvatarWaveIn>
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center px-6 pb-40 text-[var(--content-default)] md:pb-0">
        <div className="flex flex-1 flex-col items-center justify-center">
          {/*
            Only the tablet split is tight enough to wrap the heading: the
            column is widest on the single-column layout, and wide again once
            the wave settles at half width.
          */}
          <h1
            className="text-5xl font-normal tracking-tight md:text-4xl lg:text-5xl xl:text-6xl"
            style={{
              fontFamily: "var(--font-serif)",
              animation: "fadeInUp 0.5s ease-out 0.1s both",
            }}
          >
            Welcome to Vellum
          </h1>
          <p
            className="mt-3 text-body-large-lighter text-[var(--content-tertiary)]"
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
      </div>
    </OnboardingLayout>
  );
}
