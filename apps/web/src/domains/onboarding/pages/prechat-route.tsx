import { Suspense, lazy } from "react";

import { PreChatFlow } from "@/domains/onboarding/pages/pre-chat-flow";
import { useActivationFlowArm } from "@/hooks/use-client-feature-flag-sync";

const CastOnboardingFlow = lazy(() =>
  import("@/domains/onboarding/cast/cast-onboarding-flow").then((m) => ({
    default: m.CastOnboardingFlow,
  })),
);

/**
 * Routing seam for `onboarding/prechat`. Picks the onboarding flow by
 * activation arm: the `experiment-activation-flow-2026-06-03 = personal-page`
 * arm gets the new `CastOnboardingFlow`, everyone else (control / variant-a)
 * keeps the legacy `PreChatFlow`.
 *
 * Nothing renders until the flag has `settled` (server fetch resolved/errored)
 * — otherwise a targeted anonymous visitor would briefly see the control
 * `PreChatFlow` on the registry default before their `personal-page` value
 * arrives. Mirrors the settle-guard in `account/pages/signup-page.tsx`.
 */
export function PreChatRoute() {
  const { arm, settled } = useActivationFlowArm();

  // Hold rendering until the flag resolves to avoid flashing the wrong flow.
  if (!settled) return null;

  if (arm === "personal-page") {
    return (
      <Suspense fallback={null}>
        <CastOnboardingFlow />
      </Suspense>
    );
  }

  return <PreChatFlow />;
}
