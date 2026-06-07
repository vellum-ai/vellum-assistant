import { useState } from "react";
import { useNavigate } from "react-router";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { isPlatformLocal } from "@/lib/auth/loopback-auth";
import { hasAssistants, isLocalMode } from "@/lib/local-mode";
import { startAuthFlow } from "@/runtime/native-auth";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

export function WelcomeScreen() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    const returnTo = hasAssistants()
      ? routes.onboarding.selectAssistant
      : routes.onboarding.hosting;

    if (isLocalMode() && isPlatformLocal()) {
      void navigate(`${routes.account.login}?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const callbackUrl = `${routes.account.providerCallback}?returnTo=${encodeURIComponent(returnTo)}`;
      await startAuthFlow("workos-oidc", callbackUrl, { returnTo });
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  const handleContinueWithoutAccount = () => {
    if (hasAssistants()) {
      void navigate(routes.onboarding.selectAssistant);
    } else {
      void navigate(routes.onboarding.hosting);
    }
  };

  return (
    <OnboardingLayout>
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center px-6 pb-40 text-[var(--content-default)]">
        <div className="flex flex-1 flex-col items-center justify-center">
          <h1
            className="text-3xl font-semibold tracking-tight"
            style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
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
            className="mt-10 flex w-full max-w-sm flex-col gap-3"
            style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
          >
            <Button
              variant="primary"
              size="regular"
              fullWidth
              className="h-11 text-base"
              onClick={() => void handleLogin()}
              disabled={loading}
            >
              {loading ? "Logging in…" : "Log In"}
            </Button>
            <Button
              variant="ghost"
              size="regular"
              fullWidth
              className="h-11 text-base"
              onClick={handleContinueWithoutAccount}
              disabled={loading}
            >
              Continue without account
            </Button>
          </div>
        </div>
      </div>
    </OnboardingLayout>
  );
}
