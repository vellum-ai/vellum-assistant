import { useNavigate } from "react-router";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

/**
 * Platform onboarding welcome / front door.
 *
 * This is the in-SPA landing spot for "Back" out of the privacy screen in
 * platform mode. Privacy is the onboarding entrypoint there and its only
 * happy-path predecessor (hosting) is local-only, so before this screen a
 * platform Back had nowhere in-SPA to go — sending it to the marketing host
 * (`/`) would have navigated a Capacitor staging/dev shell onto production
 * (its CTA points at `www.vellum.ai/assistant`). Keeping Back inside the SPA
 * preserves the running environment on every platform.
 *
 * It is deliberately a single-CTA welcome: the button re-enters the funnel at
 * privacy (consent), which then hatches the assistant. Not wired as the funnel
 * entrypoint — reached only via Back — so the happy path is unchanged.
 */
export function StartScreen() {
  const navigate = useNavigate();

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
            className="mt-3 text-center text-body-medium-lighter text-[var(--content-tertiary)]"
            style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
          >
            Your own personal intelligence is just a step away.
          </p>

          <div
            className="mt-10 flex w-full max-w-sm flex-col"
            style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
          >
            <Button
              variant="primary"
              size="regular"
              fullWidth
              className="h-11 text-base"
              onClick={() => void navigate(routes.onboarding.privacy)}
            >
              Create your assistant
            </Button>
          </div>
        </div>
      </div>
    </OnboardingLayout>
  );
}
