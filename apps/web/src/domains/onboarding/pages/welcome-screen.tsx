import { useRef, useState } from "react";
import { useNavigate } from "react-router";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { isPlatformLocal } from "@/lib/auth/loopback-auth";
import { isLocalMode } from "@/lib/local-mode";
import { isElectron } from "@/runtime/is-electron";
import { startAuthFlow } from "@/runtime/native-auth";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

export function WelcomeScreen() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flowIdRef = useRef(0);

  const handleLogin = async () => {
    if (isLocalMode() && isPlatformLocal()) {
      const returnTo = routes.onboarding.hosting;
      void navigate(`${routes.account.login}?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    const flowId = ++flowIdRef.current;
    setError(null);
    setLoading(true);
    try {
      const returnTo = routes.onboarding.hosting;
      const callbackUrl = `${routes.account.providerCallback}?returnTo=${encodeURIComponent(returnTo)}`;
      await startAuthFlow("workos-oidc", callbackUrl, { returnTo });
    } catch {
      if (flowId !== flowIdRef.current) return;
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  const handleCancel = () => {
    flowIdRef.current++;
    setLoading(false);
    setError(null);
    if (isElectron()) {
      void window.vellum?.auth?.cancelOAuth();
    }
  };

  const handleContinueWithoutAccount = () => {
    if (loading) handleCancel();
    void navigate(routes.onboarding.hosting);
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
              onClick={loading ? handleCancel : () => void handleLogin()}
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
